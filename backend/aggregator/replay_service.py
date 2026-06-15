import asyncio
import logging
import json
import os
import random
from datetime import datetime, timedelta
from typing import List, Dict, Any, Optional
from backend.core.redis_bus import redis_bus
from backend.aggregator.duckdb_adapter import duckdb_replay_adapter
from backend.external.tv_api import tv_api

logger = logging.getLogger(__name__)

class ReplayService:
    """
    Module R: Data Replay & Backtesting Engine (1-Min Resolution).
    Synchronizes Spot and Options chains from historical sources.
    """
    def __init__(self):
        self.is_replaying = False
        self.is_paused = False
        self.replay_task = None
        self.playback_speed = 1.0
        self.current_underlying = None
        self.selected_symbols = [] # [Spot, Option1, Option2...]
        self.current_ts = 0

    async def start_replay(self, underlying: str, symbols: List[str], start_time: str, end_time: str, speed: float = 1.0):
        if self.is_replaying:
            await self.stop_replay()

        self.current_underlying = underlying
        # Ensure at least the underlying is selected
        if not symbols:
            symbols = [underlying]
        self.selected_symbols = symbols
        self.playback_speed = speed
        self.is_replaying = True
        self.is_paused = False
        self.replay_task = asyncio.create_task(self._replay_loop(underlying, symbols, start_time, end_time))
        logger.info(f"Replay started for {underlying} with {len(symbols)} symbols at {speed}x")

    async def pause_replay(self):
        self.is_paused = True
        logger.info("Replay paused")

    async def resume_replay(self):
        self.is_paused = False
        logger.info("Replay resumed")

    async def stop_replay(self):
        self.is_replaying = False
        self.is_paused = False
        if self.replay_task:
            self.replay_task.cancel()
            try:
                await self.replay_task
            except asyncio.CancelledError:
                pass
        self.replay_task = None
        logger.info("Replay stopped")

    async def _fetch_with_fallback(self, symbol: str, start_dt: datetime, end_dt: datetime):
        """Fetch data for a symbol from DuckDB or fallback to APIs."""
        start_ts = int(start_dt.timestamp() * 1000)
        end_ts = int(end_dt.timestamp() * 1000)

        # 1. Try DuckDB / Cache via Adapter
        data = duckdb_replay_adapter.query_historical(symbol, start_ts, end_ts, start_dt.strftime("%Y-%m-%d"))

        # 2. Fallback to APIs if missing
        if not data:
            logger.info(f"Data missing in local DB for {symbol}. Triggering fallback fetching...")
            n_bars = int((end_dt - start_dt).total_seconds() / 60) + 60

            candles = None

            # Fallback 1: Upstox (Primary)
            try:
                from backend.core.provider_registry import live_stream_registry
                upstox = live_stream_registry.get_provider("upstox")
                if upstox:
                    logger.info(f"Trying Upstox history for {symbol}")
                    # Map to Upstox key if it's an index
                    fetch_sym = symbol
                    if symbol == "NSE:NIFTY": fetch_sym = "NSE_INDEX|Nifty 50"
                    elif symbol == "NSE:BANKNIFTY": fetch_sym = "NSE_INDEX|Nifty Bank"

                    candles = await upstox.get_hist_candles(fetch_sym, "1", n_bars)
            except Exception as e:
                logger.error(f"Upstox fallback failed: {e}")

            # Fallback 2: TradingView (Secondary)
            if not candles:
                try:
                    logger.info(f"Trying TradingView history for {symbol}")
                    candles = tv_api.get_hist_candles(symbol, interval_min='1', n_bars=n_bars)
                except Exception as e:
                    logger.error(f"TradingView fallback failed: {e}")

            if candles:
                api_data = []
                for c in candles:
                    # Support both [ts, o, h, l, c, v] and dict formats
                    if isinstance(c, list):
                        ts_ms = c[0] * 1000
                        api_data.append({
                            'timestamp': ts_ms,
                            'symbol': symbol,
                            'type': 'OPTION' if any(x in symbol for x in ['CE', 'PE', 'CALL', 'PUT']) else 'SPOT',
                            'open': c[1], 'high': c[2], 'low': c[3], 'close': c[4], 'volume': c[5],
                            'oi': 0, 'source': 'API_FALLBACK'
                        })

                # Filter by range and cache
                filtered_data = [d for d in api_data if start_ts <= d['timestamp'] <= end_ts]
                duckdb_replay_adapter.cache_historical_data(filtered_data)
                data = filtered_data

        return sorted(data, key=lambda x: x['timestamp'])

    async def _replay_loop(self, underlying: str, symbols: List[str], start_time: str, end_time: str):
        try:
            start_dt = datetime.fromisoformat(start_time.replace('Z', '+00:00'))
            end_dt = datetime.fromisoformat(end_time.replace('Z', '+00:00'))

            # Load data for all symbols
            symbol_data = {}
            for sym in symbols:
                symbol_data[sym] = await self._fetch_with_fallback(sym, start_dt, end_dt)
                logger.info(f"Loaded {len(symbol_data[sym])} bars for {sym}")

            # Get unique timestamps across all symbols to sync
            all_timestamps = sorted(list(set([d['timestamp'] for sym_list in symbol_data.values() for d in sym_list])))

            if not all_timestamps:
                logger.warning("No data found for the requested range/symbols")
                return

            for ts in all_timestamps:
                while self.is_paused and self.is_replaying:
                    await asyncio.sleep(0.5)

                if not self.is_replaying:
                    break

                # Module S: Synthetic Tick Generation for Microstructure Simulation
                sub_ticks = []
                for sym, data_list in symbol_data.items():
                    point = next((p for p in data_list if p['timestamp'] == ts), None)
                    if point:
                        sub_ticks.extend(self._generate_synthetic_ticks(sym, point))

                # Sort sub-ticks by their simulated relative offset
                sub_ticks.sort(key=lambda x: x['offset'])

                for i, tick in enumerate(sub_ticks):
                    if not self.is_replaying: break

                    # Inter-tick delay
                    prev_offset = sub_ticks[i-1]['offset'] if i > 0 else 0
                    current_delay = (tick['offset'] - prev_offset) / self.playback_speed
                    if current_delay > 0:
                        await asyncio.sleep(min(current_delay, 1.0))

                    # Emit standardized tick
                    redis_bus.add_to_stream("STREAM:TICK:REPLAY", {
                        'symbol': tick['symbol'],
                        'price': tick['price'],
                        'open': tick['open'],
                        'size': tick['size'],
                        'source': 'REPLAY',
                        'ts_ms': ts + int(tick['offset'] * 1000),
                        'aggressor': tick['aggressor'],
                        'flags': tick['flags']
                    })

                self.current_ts = ts

            logger.info("Replay loop finished")
            self.is_replaying = False

        except Exception as e:
            logger.error(f"Replay loop error: {e}")
            self.is_replaying = False

    def _generate_synthetic_ticks(self, symbol: str, point: Dict[str, Any]) -> List[Dict[str, Any]]:
        """
        Decomposes a 1-min candle into a sequence of sub-ticks simulating price action.
        Injects markers for Absorption and Sweeps.
        """
        o, h, l, c = point['open'], point['high'], point['low'], point['close']
        vol = point['volume']

        # Determine path: O -> L -> H -> C (bullish) or O -> H -> L -> C (bearish)
        path = [o, l, h, c] if c >= o else [o, h, l, c]

        ticks = []
        num_ticks = 8 # Simulate 8 ticks per minute

        for i in range(num_ticks):
            # Interpolate price along path
            segment = i // 2
            segment_progress = (i % 2) / 2.0

            p1 = path[segment]
            p2 = path[min(segment + 1, 3)]
            price = p1 + (p2 - p1) * segment_progress + (random.random() - 0.5) * (h-l)*0.05

            size = (vol / num_ticks) * (0.5 + random.random())
            offset = (60.0 / num_ticks) * i + random.random() * 2.0

            # Aggressor Logic
            aggressor = 'ask' if price > p1 else 'bid'

            flags = []
            # Absorption Check: High volume at extremes
            if (abs(price - h) < (h-l)*0.05 or abs(price - l) < (h-l)*0.05) and size > (vol/num_ticks)*1.5:
                flags.append('ABSORPTION')

            # Sweep Check: Last move is strong
            if i > num_ticks - 3 and abs(c - o) > (h-l)*0.6:
                flags.append('SWEEP')

            ticks.append({
                'symbol': symbol,
                'price': price,
                'open': o, # Include candle open for IAF
                'size': size,
                'offset': offset,
                'aggressor': aggressor,
                'flags': flags
            })

        return ticks

replay_service = ReplayService()
