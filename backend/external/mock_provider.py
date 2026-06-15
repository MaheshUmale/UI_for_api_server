import asyncio
import logging
import json
import time
from typing import Dict, Any, List, Optional, Callable
from datetime import datetime
from backend.core.interfaces import ILiveStreamProvider, IOptionsDataProvider, IHistoricalDataProvider
from backend.db.local_db import db

logger = logging.getLogger(__name__)

class MockProvider(ILiveStreamProvider, IOptionsDataProvider, IHistoricalDataProvider):
    """
    Mock Provider that uses historical data from DuckDB to simulate live market.
    """
    def __init__(self, callback: Callable = None):
        self.callback = callback
        self.symbols = []
        self.running = False
        self.loop_task = None

    def subscribe(self, symbols: List[str], interval: str = "1"):
        self.symbols.extend([s.upper() for s in symbols if s.upper() not in self.symbols])
        logger.info(f"MockProvider subscribed to {symbols}")

    def unsubscribe(self, symbol: str, interval: str = "1"):
        symbol = symbol.upper()
        if symbol in self.symbols:
            self.symbols.remove(symbol)
        logger.info(f"MockProvider unsubscribed from {symbol}")

    def set_callback(self, callback: Callable):
        self.callback = callback

    def start(self):
        if not self.running:
            self.running = True
            self.loop_task = asyncio.create_task(self._simulation_loop())
            logger.info("MockProvider simulation loop started")

    def stop(self):
        self.running = False
        if self.loop_task:
            self.loop_task.cancel()
        logger.info("MockProvider simulation loop stopped")

    def is_connected(self) -> bool:
        return self.running

    async def _simulation_loop(self):
        """Streams historical data from DuckDB sequentially to simulate real-time."""
        while self.running:
            if not self.symbols:
                await asyncio.sleep(1)
                continue

            for symbol in self.symbols:
                try:
                    # Get latest ticks for this symbol from DuckDB
                    ticks = db.query(
                        "SELECT * FROM ticks WHERE instrumentKey = ? ORDER BY ts_ms DESC LIMIT 1",
                        (symbol,)
                    )

                    if ticks:
                        t = ticks[0]
                        # Simulate a price wiggle around historical price
                        import random
                        price = t['price'] + (random.random() - 0.5) * 2

                        feed_msg = {
                            'type': 'live_feed',
                            'feeds': {
                                symbol: {
                                    'last_price': float(price),
                                    'ts_ms': int(time.time() * 1000),
                                    'tv_volume': t.get('qty', 100),
                                    'source': 'mock_provider'
                                }
                            }
                        }
                        if self.callback:
                            self.callback(feed_msg)
                except Exception as e:
                    logger.error(f"Mock simulation error for {symbol}: {e}")

            await asyncio.sleep(1) # Emit every second

    async def get_option_chain(self, underlying: str) -> Dict[str, Any]:
        """Fetch chain from DuckDB snapshots."""
        try:
            res = db.query(
                "SELECT * FROM options_snapshots WHERE underlying = ? ORDER BY timestamp DESC LIMIT 50",
                (underlying,)
            )
            standardized_chain = []
            spot_price = 0

            if res:
                # Use latest price from ticks for spot
                ticks = db.query("SELECT price FROM ticks WHERE instrumentKey = ? ORDER BY ts_ms DESC LIMIT 1", (underlying,))
                if ticks: spot_price = ticks[0]['price']

                for item in res:
                    standardized_chain.append({
                        "strike": item['strike'],
                        "option_type": item['option_type'],
                        "instrument_key": item['symbol'],
                        "trading_symbol": item['symbol'],
                        "expiry": str(item['expiry']),
                        "ltp": item['ltp'],
                        "oi": item['oi'],
                        "oi_change": item['oi_change'],
                        "volume": item['volume']
                    })

            return {
                "underlying": underlying,
                "spot_price": spot_price,
                "chain": standardized_chain,
                "source": "mock_db"
            }
        except Exception as e:
            logger.error(f"Error fetching mock option chain: {e}")
            return {"underlying": underlying, "spot_price": 0, "chain": [], "source": "mock_db"}

    async def get_expiry_dates(self, underlying: str) -> List[str]:
        try:
            res = db.query("SELECT DISTINCT expiry FROM options_snapshots WHERE underlying = ?", (underlying,))
            return [str(r['expiry']) for r in res]
        except:
            return []

    async def get_oi_data(self, underlying: str, expiry: str, time_str: str) -> Dict[str, Any]:
        return {"timestamp": time_str, "oi_data": {}}

    async def get_hist_candles(self, symbol: str, interval: str, count: int) -> List[List]:
        """Simulate historical candles by aggregating ticks from DuckDB."""
        try:
            # Simple aggregation
            res = db.query(
                f"SELECT floor(ts_ms/60000)*60 as ts, first(price) as o, max(price) as h, min(price) as l, last(price) as c, sum(qty) as v "
                f"FROM ticks WHERE instrumentKey = ? GROUP BY ts ORDER BY ts DESC LIMIT ?",
                (symbol, count)
            )
            return [[r['ts'], r['o'], r['h'], r['l'], r['c'], r['v']] for r in reversed(res)]
        except Exception as e:
            logger.error(f"Error fetching mock candles: {e}")
            return []
