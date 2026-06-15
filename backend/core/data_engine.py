"""
ProTrade Data Engine
Manages real-time data ingestion and OHLC aggregation.
Ensures consistency across multiple providers and the UI.
"""
import asyncio
import json
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from typing import Dict, Any, List, Optional, Union
from backend.db.local_db import  db, LocalDBJSONEncoder
from backend.core.symbol_mapper import symbol_mapper

logger = logging.getLogger(__name__)

# Configuration
try:
    from backend.config import INITIAL_INSTRUMENTS
except ImportError:
    INITIAL_INSTRUMENTS = ["NSE:NIFTY"]

socketio_instance = None
main_event_loop = None
latest_total_volumes = {}
room_subscribers = {} # (instrumentKey, interval) -> set of sids
last_processed_ticks = {} # instrumentKey -> {source, ts_ms, priority}

# Priority Mapping
SOURCE_PRIORITY = {
    'upstox': 20,
    'tradingview': 10,
    'tradingview_wss': 10,
    'unknown': 0
}

TICK_BATCH_SIZE = 100
tick_buffer = []
buffer_lock = threading.Lock()

# Pooled executor for DB flushes (replaces unbounded daemon threads)
flush_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="db_flush")

def set_socketio(sio: Any, loop: Optional[asyncio.AbstractEventLoop] = None):
    global socketio_instance, main_event_loop
    socketio_instance = sio
    main_event_loop = loop

def emit_event(event: str, data: Any, room: Optional[str] = None):
    global socketio_instance, main_event_loop
    if not socketio_instance: return
    if isinstance(data, (dict, list)):
        data = json.loads(json.dumps(data, cls=LocalDBJSONEncoder))
    try:
        if main_event_loop and main_event_loop.is_running():
            asyncio.run_coroutine_threadsafe(socketio_instance.emit(event, data, to=room), main_event_loop)
    except Exception as e:
        logger.error(f"Emit Error: {e}")

def flush_tick_buffer(ticks: Optional[List[Dict[str, Any]]] = None):
    """Flush tick batch to DuckDB. Pass ticks directly when using executor."""
    if ticks is None:
        global tick_buffer
        ticks = []
        with buffer_lock:
            if tick_buffer:
                ticks = tick_buffer
                tick_buffer = []
    if ticks:
        try:
            db.insert_ticks(ticks)
        except Exception as e:
            logger.error(f"DB Insert Error: {e}")

# Per-instrument tick throttling (10 Hz max)
last_tick_emit = {}
# Per-instrument chart-update throttling (10 Hz max)
last_chart_emit = {}

def on_message(message: Union[Dict, str]):
    logger.debug(f"data_engine received: {message}")
    """Standardized message handler for all ILiveStreamProviders."""
    global tick_buffer, last_processed_ticks
    try:
        data = json.loads(message) if isinstance(message, str) else message

        # Handle Chart/OHLCV Updates
        if data.get('type') == 'chart_update':
            instrument_key = data.get('instrumentKey')
            interval = data.get('interval')
            if instrument_key:
                payload = data['data']
                payload['instrumentKey'] = instrument_key
                payload['interval'] = interval

                # Standardize payload structure
                payload = normalize_ohlcv(payload)

                # Update Brain (Legacy: OHLC updates now handled via agg_tick stream)
                # from backend.core.brain_manager import brain_manager
                # brain_manager.process_from_redis(instrument_key)

                # Wrap for UI: Frontend expects data.ohlcv = [[ts, o, h, l, c, v], ...]
                ui_payload = {
                    'instrumentKey': instrument_key,
                    'interval': interval,
                    'ohlcv': [[payload['ts'], payload['o'], payload['h'], payload['l'], payload['c'], payload['v']]]
                }
                chart_key = f"{instrument_key}:{interval}"
                now_ch = time.time()
                if now_ch - last_chart_emit.get(chart_key, 0) > 0.1:
                    emit_event('chart_update', ui_payload, room=instrument_key.upper())
                    last_chart_emit[chart_key] = now_ch
            return

        # Handle Live Feed (Ticks)
        feeds_map = data.get('feeds', {})
        if not feeds_map: return

        current_time = datetime.now()
        sym_feeds = {}
        today_str = current_time.strftime("%Y-%m-%d")

        for inst_key, feed_datum in feeds_map.items():
            source = feed_datum.get('source', 'unknown')
            priority = SOURCE_PRIORITY.get(source, 0)
            ts_val = feed_datum.get('ts_ms', int(time.time() * 1000))
            if 0 < ts_val < 10000000000: ts_val *= 1000

            # Reconciliation Logic: Skip if we have better data for this instrument
            last = last_processed_ticks.get(inst_key)
            if last:
                # 1. Monotonicity: Skip if tick is from the past
                if ts_val < last['ts_ms']:
                    continue
                # 2. Priority: If same timestamp, only accept higher or equal priority
                if ts_val == last['ts_ms'] and priority < last['priority']:
                    continue
                # 3. Aggressive Suppression: If high priority tick exists for same 50ms window
                if last['priority'] >= 20 and priority < 20 and (ts_val - last['ts_ms']) < 50:
                    continue

            feed_datum.update({
                'instrumentKey': inst_key,
                'date': today_str,
                'last_price': float(feed_datum.get('last_price', 0)),
                'source': source
            })
            feed_datum['ts_ms'] = ts_val

            # Track last processed state
            last_processed_ticks[inst_key] = {
                'source': source,
                'ts_ms': ts_val,
                'priority': priority
            }

            delta_vol = 0
            curr_vol = feed_datum.get('tv_volume', 0)
            if curr_vol is not None:
                curr_vol = float(curr_vol)
                if inst_key in latest_total_volumes:
                    delta_vol = max(0, curr_vol - latest_total_volumes[inst_key])
                latest_total_volumes[inst_key] = curr_vol
            feed_datum['ltq'] = int(feed_datum.get('ltq', delta_vol))

            sym_feeds[inst_key] = feed_datum

        now = time.time()
        for inst_key, feed in sym_feeds.items():
            # Module C: Redis Message Bus. Every worker converts source-specific JSON into UniversalTick
            from backend.core.redis_bus import redis_bus
            redis_bus.add_to_stream(f"STREAM:TICK:{source.upper()}", {
                'symbol': inst_key,
                'price': feed.get('last_price', 0),
                'size': feed.get('ltq', 0),
                'source': source
            })

            if now - last_tick_emit.get(inst_key, 0) > 0.1:
                emit_event('raw_tick', {inst_key: feed}, room=inst_key.upper())
                last_tick_emit[inst_key] = now

        with buffer_lock:
            tick_buffer.extend(list(sym_feeds.values()))
            if len(tick_buffer) >= TICK_BATCH_SIZE:
                to_insert = tick_buffer[:]
                tick_buffer = []
                flush_executor.submit(flush_tick_buffer, to_insert)
    except Exception as e:
        logger.error(f"Error in data_engine on_message: {e}")

def normalize_ohlcv(data: dict) -> dict:
    """Standardize OHLCV keys across all sources."""
    ts = data.get('ts') or data.get('time') or data.get('ts_ms')
    # Convert large timestamps (ms) to seconds for Lightweight Charts
    if ts and ts > 1e11:
        ts = ts / 1000

    return {
        'ts': ts,
        'o': float(data.get('o') or data.get('open') or 0),
        'h': float(data.get('h') or data.get('high') or 0),
        'l': float(data.get('l') or data.get('low') or 0),
        'c': float(data.get('c') or data.get('close') or data.get('last_price') or 0),
        'v': int(data.get('v') or data.get('volume') or data.get('ltq') or data.get('vtt') or 0),
        'instrumentKey': data.get('instrumentKey'),
        'interval': data.get('interval')
    }

def subscribe_instrument(instrument_key: str, sid: str, interval: str = "1"):
    instrument_key = instrument_key.upper()
    key = (instrument_key, str(interval))
    if key not in room_subscribers: room_subscribers[key] = set()
    if sid not in room_subscribers[key]:
        room_subscribers[key].add(sid)
        logger.info(f"Room {instrument_key} ({interval}m) now has {len(room_subscribers[key])} subscribers")

    from backend.core.provider_registry import live_stream_registry

    for provider in live_stream_registry.get_all():
        try:
            provider.set_callback(on_message)
            provider.subscribe([instrument_key], interval=interval)
            provider.start()
        except Exception as e:
            logger.error(f"Error subscribing {type(provider).__name__} to {instrument_key}: {e}")


def is_sid_using_instrument(sid: str, instrument_key: str) -> bool:
    instrument_key = instrument_key.upper()
    for (r_key, r_interval), sids in room_subscribers.items():
        if r_key == instrument_key and sid in sids: return True
    return False

def unsubscribe_instrument(instrument_key: str, sid: str, interval: str = "1"):
    instrument_key = instrument_key.upper()
    key = (instrument_key, str(interval))
    if key in room_subscribers and sid in room_subscribers[key]:
        room_subscribers[key].remove(sid)
        if len(room_subscribers[key]) == 0:
            from backend.core.provider_registry import live_stream_registry
            for provider in live_stream_registry.get_all():
                try: provider.unsubscribe(instrument_key, interval=interval)
                except: pass
            del room_subscribers[key]

def handle_disconnect(sid: str):
    to_cleanup = []
    for (key, interval), sids in room_subscribers.items():
        if sid in sids: to_cleanup.append((key, interval))
    for key, interval in to_cleanup:
        unsubscribe_instrument(key, sid, interval)

def start_websocket_thread(token: str, keys: List[str]):
    from backend.core.provider_registry import live_stream_registry
    for provider in live_stream_registry.get_all():
        try:
            provider.set_callback(on_message)
            provider.subscribe(keys)
            provider.start()
        except Exception as e:
            logger.error(f"Error starting provider {type(provider).__name__}: {e}")
