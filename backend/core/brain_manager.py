import logging
import asyncio
import pandas as pd
import os
import sys
import json

# Standardize path addition to support BRAIN as a package
ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../'))
if ROOT_DIR not in sys.path:
    sys.path.append(ROOT_DIR)

# Also add BRAIN directory itself for flat imports within BRAIN modules
BRAIN_DIR = os.path.join(ROOT_DIR, 'BRAIN')
if BRAIN_DIR not in sys.path:
    sys.path.append(BRAIN_DIR)

try:
    from BRAIN.brain import Brain
    from BRAIN.strategy import StrategyEngine
    from BRAIN.memory import BayesianMemory
    from BRAIN.models import Candle
except ImportError:
    # Fallback if the package structure is not recognized
    from brain import Brain
    from strategy import StrategyEngine
    from memory import BayesianMemory
    from models import Candle

logger = logging.getLogger(__name__)

class BrainManager:
    """
    Centralized bridge between the quantitative engine and the backend.
    Now standardized to consume unified data schemas.
    """
    def __init__(self):
        self.brain = None
        self.strategy = None
        self.memory = None
        self.sio = None
        self.loop = None
        self.is_running = False

    def initialize(self, sio=None, loop=None):
        self.sio = sio
        self.loop = loop
        self.strategy = StrategyEngine()
        self.memory = BayesianMemory()
        self.brain = Brain(strategy_engine=self.strategy, memory=self.memory)
        logger.info("Brain Engine Initialized")

    async def start(self):
        if self.brain and not self.is_running:
            self.is_running = True
            asyncio.create_task(self.brain.start())
            asyncio.create_task(self._signal_monitor_loop())
            logger.info("Brain Engine Started")

    async def stop(self):
        self.is_running = False
        if self.brain:
            self.brain.stop()
            logger.info("Brain Engine Stopped")

    def process_from_redis(self, symbol: str):
        """ Module D: The Brain (The Judge). Read-only from Redis Hash. """
        if not self.brain: return

        try:
            from backend.core.redis_bus import redis_bus
            state = redis_bus.get_latest_state(f"LATEST:{symbol}")
            if not state: return

            # Mandatory Confidence check per architectural contract
            # confidence = float(state.get('metadata.confidence', 0))
            # status = state.get('metadata.status', 'UNKNOWN')

            # Simple deserialization as aggregator sends unified record
            data_points = json.loads(state.get('data_points', '{}'))
            metadata = json.loads(state.get('metadata', '{}'))

            # Mandatory Intraday Gate: Veto if confidence < 80% or status != OK
            if metadata.get('confidence', 0) < 0.80 or metadata.get('status') != "OK":
                logger.warning(f"Brain Veto: Low confidence ({metadata.get('confidence')}) or bad status for {symbol}")
                # We could emit a veto event here for the UI
                return

            candle = Candle(
                instrument_token=symbol,
                timestamp=pd.Timestamp.now(), # Use system time as per SSOT
                open=float(data_points.get('ltp', 0)),
                high=float(data_points.get('ltp', 0)),
                low=float(data_points.get('ltp', 0)),
                close=float(data_points.get('ltp', 0)),
                volume=int(data_points.get('volume', 0))
            )

            asyncio.run_coroutine_threadsafe(
                self.brain.submit_candle(candle, option_chain=[]),
                self.loop
            )
        except Exception as e:
            logger.error(f"Error processing from Redis for Brain: {e}")

    async def _signal_monitor_loop(self):
        while self.is_running:
            if self.brain:
                try:
                    signal = await self.brain.get_signal()
                    if signal:
                        if self.sio:
                            await self.sio.emit('brain_signal', {
                                'type': signal.signal_type,
                                'token': signal.instrument_token,
                                'price': signal.entry_price,
                                'sl': signal.stop_loss,
                                'tp': signal.take_profit,
                                'reason': signal.reason,
                                'confidence': signal.confidence,
                                'timestamp': str(signal.timestamp)
                            })
                except Exception as e:
                    logger.error(f"Error in signal monitor loop: {e}")
            await asyncio.sleep(0.1)

brain_manager = BrainManager()
