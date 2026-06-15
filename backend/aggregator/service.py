import asyncio
import json
import logging
from datetime import datetime
from backend.core.redis_bus import redis_bus
from backend.db.local_db import db

logger = logging.getLogger(__name__)

class Aggregator:
    """
    Module B: The Aggregator & Sync (The Heart).
    Responsibility: Temporal synchronization, volume proxying, and validation.
    """
    def __init__(self):
        self.running = False
        self.last_tick_ids = {
            'STREAM:TICK:UPSTOX': '0',
            'STREAM:TICK:TV': '0',
            'STREAM:TICK:REPLAY': '0'
        }

    async def start(self):
        self.running = True
        logger.info("Aggregator started")
        while self.running:
            await self.process_streams()
            await asyncio.sleep(0.01)

    async def process_streams(self):
        for stream, last_id in self.last_tick_ids.items():
            messages = redis_bus.read_stream(stream, last_id=last_id, count=50)
            if not messages:
                continue

            for stream_name, msgs in messages:
                for msg_id, data in msgs:
                    self.last_tick_ids[stream] = msg_id
                    await self.sync_and_validate(data)

    async def sync_and_validate(self, raw_data):
        """Temporal merging and SSOT update."""
        symbol = raw_data.get('symbol')
        if not symbol: return

        source = raw_data.get('source', 'UNKNOWN')
        price = float(raw_data.get('price', 0))

        # Get existing state for cross-provider validation
        current_state_raw = redis_bus.get_latest_state(f"LATEST:{symbol}")
        status = "OK"
        confidence = 1.0
        variance = 0.0

        if current_state_raw:
            try:
                # Metadata is stored as JSON string in Hash
                metadata = json.loads(current_state_raw.get('metadata', '{}'))
                data_points = json.loads(current_state_raw.get('data_points', '{}'))

                prev_source = metadata.get('source')
                prev_price = float(data_points.get('ltp', 0))

                if prev_source and prev_source != source and prev_price > 0:
                    variance = abs(price - prev_price) / prev_price * 100
                    if variance > 0.10:
                        status = "DISCREPANCY"
                        confidence = 0.5
            except Exception as e:
                logger.error(f"Validation error: {e}")

        # Module B: Intraday Regime & Structure Calculation
        regime = "CHOPPY"
        # Logic: if volume spikes or price trends, set TRENDING
        if float(raw_data.get('size', 0)) > 500: regime = "TRENDING"

        # Structural Wall Logic (Module G/I: Proxy Levels)
        proxy_levels = []
        if price > 0:
            # Query recent high-volume nodes from DuckDB
            try:
                res = db.query(
                    "SELECT price, SUM(qty) as vol FROM ticks WHERE instrumentKey = ? AND date = CURRENT_DATE GROUP BY price ORDER BY vol DESC LIMIT 3",
                    (symbol,)
                )
                if res:
                    for r in res:
                        proxy_levels.append({"price": r['price'], "strength": 3, "type": "WALL"})
                else:
                    raise ValueError("No tick data for walls")
            except Exception as e:
                logger.debug(f"Wall calculation fallback: {e}")
                # Fallback to nearest psychological levels
                proxy_levels = [
                    {"price": (price // 100) * 100, "strength": 2, "type": "LEVEL"},
                    {"price": (price // 100) * 100 + 100, "strength": 2, "type": "LEVEL"}
                ]

        # Underlying Index Matrix & IAF Calculation (Module C)
        # For Nifty, we track top heavyweights.
        heavyweights = [
            {"symbol": "NSE:HDFCBANK", "weight": 0.15},
            {"symbol": "NSE:RELIANCE", "weight": 0.12},
            {"symbol": "NSE:ICICIBANK", "weight": 0.08},
            {"symbol": "NSE:INFY", "weight": 0.06},
            {"symbol": "NSE:TCS", "weight": 0.05}
        ]
        bullish_count = 0
        total_tracked = 0
        iaf_score = 60 # Default
        heavyweight_data = []

        for hw in heavyweights:
            hw_state = redis_bus.get_latest_state(f"LATEST:{hw['symbol']}")
            if hw_state:
                total_tracked += 1
                hw_data_points = json.loads(hw_state.get('data_points', '{}'))
                hw_ltp = float(hw_data_points.get('ltp', 0))

                # Module C: IAF Baseline Calculation
                # During Replay, we use the 'open' price from the replay tick metadata if available
                hw_metadata = json.loads(hw_state.get('metadata', '{}'))
                hw_open = float(hw_metadata.get('open', hw_ltp))

                # If we are in Replay mode, the source of the tick might provide the minute-open
                if source.startswith('REPLAY'):
                     # Replay ticks for heavyweights will also be pushed via replay loop
                     pass

                is_bullish = hw_ltp >= hw_open
                if is_bullish: bullish_count += 1
                heavyweight_data.append({
                    "symbol": hw['symbol'].split(':')[-1],
                    "price": hw_ltp,
                    "change": 0.5 if is_bullish else -0.5,
                    "weight": hw['weight']
                })

        if total_tracked > 0:
            iaf_score = (bullish_count / total_tracked) * 100

        # VIX Discovery
        vix = 14.2
        vix_state = redis_bus.get_latest_state("LATEST:NSE:INDIAVIX")
        if vix_state:
            vix = float(json.loads(vix_state.get('data_points', '{}')).get('ltp', 14.2))

        # ATM Premium Extraction (Module D)
        from backend.core.options_manager import options_manager
        chain = options_manager.get_chain_with_greeks(symbol)
        atm_call_price = 0
        atm_put_price = 0
        if chain.get('chain'):
            # Find closest strikes
            for item in chain['chain']:
                if abs(item['strike'] - price) < 25:
                    if item['option_type'] == 'call': atm_call_price = item['ltp']
                    else: atm_put_price = item['ltp']

        # Standardized Universal Record
        unified_record = {
            "timestamp": datetime.now().isoformat(),
            "symbol": symbol,
            "data_points": {
                "ltp": price,
                "volume": float(raw_data.get('size', 0)),
                "pcr": float(raw_data.get('pcr', 0)),
                "delta_oi": float(raw_data.get('oi_change', 0))
            },
            "metadata": {
                "source": source,
                "confidence": confidence,
                "variance": variance,
                "regime": regime,
                "proxy_levels": proxy_levels,
                "iaf_score": iaf_score,
                "heavyweights": heavyweight_data,
                "atm_call_price": atm_call_price,
                "atm_put_price": atm_put_price,
                "status": status,
                "open": float(raw_data.get('open', price)) # Persist open for IAF
            }
        }

        # Update Golden Record in Redis Hash
        redis_bus.set_latest_state(f"LATEST:{symbol}", unified_record)

        # Push to Aggregated Stream for Brain/UI
        redis_bus.add_to_stream("STREAM:AGGREGATED:GOLDEN", unified_record)

        # Notify Brain to process new Golden Record
        from backend.core.brain_manager import brain_manager
        brain_manager.process_from_redis(symbol)

        # Emit to UI via Socket.IO
        from backend.core.data_engine import emit_event
        emit_event('agg_tick', {
            'symbol': symbol,
            'price': price,
            'size': float(raw_data.get('size', 0)),
            'timestamp': int(datetime.now().timestamp() * 1000),
            'regime': regime,
            'confidence': confidence,
            'variance': variance,
            'source': source,
            'fidelity_status': status,
            'atm_call_price': atm_call_price or (200 + (price - 24500) * 0.5), # Fallback to dummy only if chain missing
            'atm_put_price': atm_put_price or (200 - (price - 24500) * 0.5),
            'heavyweights': heavyweight_data,
            'iaf_score': iaf_score,
            'vix': vix,
            'proxy_levels': proxy_levels
        }, room=symbol.upper())

    def stop(self):
        self.running = False

aggregator = Aggregator()
