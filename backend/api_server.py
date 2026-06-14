"""
Enhanced ProTrade API Server.

This module creates the FastAPI application and Socket.IO ASGI gateway for
PRODESK Simplified Terminal. It starts market data providers, options analysis
services, replay aggregation, alerts, scalper services, and local DuckDB
inspection endpoints.

HTTP routes:
- GET /health: service liveness and version check.
- GET /api/tv/status: TradingView provider connection status.
- GET /api/tv/search: TradingView symbol search augmented with local option symbols.
- GET /api/tv/options: TradingView options discovery for an underlying.
- GET /api/tv/intraday/{instrument_key}: TradingView candles with EMA, battle-zone,
  and psychology markers.
- GET /api/options/chain/{underlying}: latest option chain enriched with Greeks.
- GET /api/options/chain/{underlying}/with-greeks: option chain with moneyness and
  distance from ATM.
- GET /api/options/greeks/{underlying}: Black-Scholes Greeks for one contract.
- GET /api/options/oi-buildup/{underlying}: OI buildup analysis.
- GET /api/options/iv-analysis/{underlying}: implied-volatility analysis.
- GET /api/options/support-resistance/{underlying}: OI-derived support/resistance.
- GET /api/options/genie-insights/{underlying}: consolidated Genie insights.
- GET /api/options/high-activity/{underlying}: high-activity option strikes.
- GET /api/options/pcr-trend/{underlying}: current-day PCR history.
- GET /api/options/full-history/{underlying}: current-day PCR and option snapshots
  for replay.
- GET /api/options/summary/{underlying}: latest option-chain summary metrics.
- GET /api/options/oi-analysis/{underlying}: latest per-strike OI distribution.
- POST /api/options/backfill: start background options backfill.
- POST /api/strategy/build: build and analyze a custom strategy.
- POST /api/strategy/bull-call-spread: create and analyze a bull call spread.
- POST /api/strategy/iron-condor: create and analyze an iron condor.
- POST /api/strategy/long-straddle: create and analyze a long straddle.
- GET /api/strategy/{strategy_id}/analysis: retrieve stored strategy analysis.
- GET /api/strategy/recommendations: strategy recommendations by market view and IV.
- POST /api/alerts/create: create an alert.
- GET /api/alerts: list alerts with optional filters.
- DELETE /api/alerts/{alert_id}: delete an alert.
- POST /api/scalper/start: start the NSE confluence scalper.
- POST /api/scalper/stop: stop the scalper.
- GET /api/scalper/status: current scalper state.
- POST /api/alerts/{alert_id}/pause: pause an alert.
- POST /api/alerts/{alert_id}/resume: resume an alert.
- GET /, /options, /db-viewer: rendered terminal dashboards.
- GET /api/db/tables: list DuckDB tables, schemas, and row counts.
- POST /api/db/query: run a DuckDB query.
- POST /api/db/export: export DuckDB query results as CSV.

Socket.IO events:
- connect/disconnect: log client sessions and clean up data subscriptions.
- subscribe/unsubscribe: manage instrument rooms and data_engine subscriptions.
- subscribe_options/unsubscribe_options: manage options broadcast rooms.
- start_replay/stop_replay: control historical replay aggregation.
"""

import os
import asyncio
import logging
from logging.config import dictConfig
from typing import Any, Optional, List
import socketio
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.middleware.cors import CORSMiddleware
from datetime import datetime
from urllib.parse import unquote

from backend.config import LOGGING_CONFIG, INITIAL_INSTRUMENTS , SERVER_PORT
from backend.core import data_engine
from backend.core.provider_registry import initialize_default_providers
from backend.core.options_manager import options_manager
from backend.core.symbol_mapper import symbol_mapper
from backend.core.greeks_calculator import greeks_calculator
from backend.core.iv_analyzer import iv_analyzer
from backend.core.oi_buildup_analyzer import oi_buildup_analyzer
from backend.core.strategy_builder import strategy_builder, StrategyType
from backend.core.alert_system import alert_system, AlertType
from backend.core.brain_manager import brain_manager
from brain.nse_confluence_scalper import scalper
from backend.external.tv_api import tv_api
from backend.external.tv_scanner import search_options
from backend.db.local_db import db

# Configure Logging
dictConfig(LOGGING_CONFIG)
logger = logging.getLogger(__name__)
import logging

logger.setLevel(logging.DEBUG)
@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Asynchronous context manager for FastAPI lifespan.

    Handles the startup and shutdown of all critical trading services:
    - Data providers initialization
    - WebSocket data engine startup
    - Options manager initialization
    - Scalper engine setup

    Args:
        app (FastAPI): The FastAPI application instance.
    """
    logger.info("Initializing Enhanced ProTrade Terminal...")
    global main_loop

    # Initialize Data Providers
    initialize_default_providers()

    try:
        main_loop = asyncio.get_running_loop()
    except RuntimeError:
        main_loop = asyncio.get_event_loop()

    data_engine.set_socketio(sio, loop=main_loop)

    # Start WebSocket Feed via primary provider (Upstox if registered)
    logger.info("Starting data provider...")
    data_engine.start_websocket_thread(None, INITIAL_INSTRUMENTS)

    # Ensure UpstoxProvider routes parsed data into data_engine
    try:
        from backend.core.provider_registry import live_stream_registry
        upstox_provider = live_stream_registry.get_provider("upstox")
        if upstox_provider and not upstox_provider.is_connected():
            upstox_provider.add_callback(data_engine.on_message)
            upstox_provider.subscribe(INITIAL_INSTRUMENTS, "1")
            upstox_provider.start()
            logger.info("UpstoxProvider activated with data_engine callback")
    except Exception as e:
        logger.warning(f"UpstoxProvider activation skipped: {e}")

    # Start Options Management
    options_manager.set_socketio(sio, loop=main_loop)
    await options_manager.start()

    # Initialize Scalper
    scalper.set_socketio(sio, loop=main_loop)

    # Initialize Brain
    brain_manager.initialize(sio, main_loop)
    await brain_manager.start()

    # Start Aggregator Service
    from backend.aggregator.service import aggregator
    aggregator_task = asyncio.create_task(aggregator.start())

    yield

    logger.info("Shutting down ProTrade Terminal...")
    try:
        await brain_manager.stop()
        await options_manager.stop()
        data_engine.flush_tick_buffer()
    except Exception as e:
        logger.error(f"Error flushing tick buffers: {e}")


fastapi_app = FastAPI(title="ProTrade Enhanced API", lifespan=lifespan)

sio = socketio.AsyncServer(
    async_mode='asgi',
    cors_allowed_origins='*',
    ping_timeout=60,
    ping_interval=25
)

main_loop = None

fastapi_app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Socket.IO Events
@sio.event
async def connect(sid: str, environ: dict):
    """
    Handles a new Socket.IO client connection.

    Args:
        sid (str): The unique session ID for the client.
        environ (dict): The environment dictionary containing request info.
    """
    logger.info(f"Client connected: {sid}")


@sio.event
async def disconnect(sid: str):
    """
    Handles Socket.IO client disconnection and cleans up subscriptions.

    Args:
        sid (str): The unique session ID for the client.
    """
    logger.info(f"Client disconnected: {sid}")
    data_engine.handle_disconnect(sid)


@sio.on('subscribe')
async def handle_subscribe(sid, data):
    """Subscribe a client to instrument rooms and start throttled data emissions."""
    instrument_keys = data.get('instrumentKeys', [])
    interval = data.get('interval', '1')

    for key in instrument_keys:
        logger.info(f"Client {sid} subscribing to: {key} ({interval}m)")
        try:
            await sio.enter_room(sid, key.upper())
            data_engine.subscribe_instrument(key.upper(), sid, interval=str(interval))
        except Exception as e:
            logger.error(f"Subscription error for {key}: {e}")


@sio.on('subscribe_options')
async def handle_subscribe_options(sid, data):
    """Add a client to the broadcast room for an underlying's options data."""
    underlying = data.get('underlying')
    if underlying:
        logger.info(f"Client {sid} subscribing to options: {underlying}")
        await sio.enter_room(sid, f"options_{underlying}")


@sio.on('unsubscribe_options')
async def handle_unsubscribe_options(sid, data):
    """Remove a client from an underlying's options broadcast room."""
    underlying = data.get('underlying')
    if underlying:
        logger.info(f"Client {sid} unsubscribing from options: {underlying}")
        await sio.leave_room(sid, f"options_{underlying}")


@sio.on('unsubscribe')
async def handle_unsubscribe(sid, data):
    """Unsubscribe a client from instrument rooms when no active session remains."""
    instrument_keys = data.get('instrumentKeys', [])
    interval = data.get('interval', '1')

    for key in instrument_keys:
        logger.info(f"Client {sid} unsubscribing from: {key}")
        try:
            data_engine.unsubscribe_instrument(key.upper(), sid, interval=str(interval))
            if not data_engine.is_sid_using_instrument(sid, key.upper()):
                await sio.leave_room(sid, key.upper())
        except Exception as e:
            logger.error(f"Unsubscription error for {key}: {e}")


@sio.on('start_replay')
async def handle_start_replay(sid, data):
    """Start historical replay for one or more synchronized TradingView symbols."""
    underlying = data.get('symbol', 'NSE:NIFTY')
    symbols = data.get('symbols', [underlying]) # Synchronized symbols
    start_time = data.get('start_time')
    end_time = data.get('end_time', datetime.now().isoformat())
    speed = data.get('speed', 1.0)

    from backend.aggregator.replay_service import replay_service
    await replay_service.start_replay(underlying, symbols, start_time, end_time, speed)


@sio.on('stop_replay')
async def handle_stop_replay(sid, data):
    """Stop the active replay session and halt replay broadcasts."""
    from backend.aggregator.replay_service import replay_service
    await replay_service.stop_replay()


# Health Check
@fastapi_app.get("/health")
async def health_check():
    """Return service liveness and API version for health checks."""
    return {"status": "healthy", "version": "2.0-enhanced"}


@fastapi_app.get("/api/tv/status")
async def get_tv_status():
    """Return a legacy TradingView status payload for UI compatibility."""
    return {
        "system_health": {
            "overall_health": 95,
            "recommendations": ["All systems normal"]
        },
        "is_running": True,
        "connections": {"active": 3, "total": 3},
        "cache": {"usage_percentage": 12.5},
        "quality_metrics": {"current_metrics": {"completeness_rate": 0.98, "accuracy_rate": 0.97}},
        "performance_metrics": {
            "avg_response_time_ms": 45,
            "requests_per_second": 120,
            "error_rate": 0.001
        }
    }


@fastapi_app.get("/api/tv/search")
async def tv_search(text: str = Query(..., min_length=1)):
    """Proxy TradingView symbol search and merge local option-chain symbols."""
    import httpx

    exchange = ""
    search_text = text
    if ":" in text:
        parts = text.split(":", 1)
        exchange = parts[0]
        search_text = parts[1]

    url = f"https://symbol-search.tradingview.com/symbol_search/v3/?text={search_text}&hl=1&exchange={exchange}&lang=en&search_type=&domain=production&sort_by_country=IN"
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.tradingview.com/',
        'Origin': 'https://www.tradingview.com'
    }

    tv_results = {"symbols": []}
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(url, headers=headers, timeout=10.0)
            if response.status_code == 200:
                tv_results = response.json()
    except Exception as e:
        logger.error(f"Search proxy error: {e}")

    # Augmented search for options
    upper_text = search_text.upper()
    indices = ["NIFTY", "BANKNIFTY", "FINNIFTY"]
    underlying = None

    for idx in indices:
        if idx in upper_text:
            underlying = idx
            break

    if not underlying and 3 <= len(upper_text) <= 15 and upper_text.isalpha():
        underlying = upper_text

    if underlying:
        try:
            opt_data = await search_options(underlying)
            if opt_data and 'symbols' in opt_data:
                search_parts = upper_text.split()
                filtered = []
                for item in opt_data['symbols']:
                    s = item.get('s', '')
                    s_norm = s.upper().replace(":", "")
                    if all(p in s_norm for p in search_parts):
                        exch, name = s.split(':', 1) if ':' in s else ("NSE", s)
                        filtered.append({
                            "symbol": name,
                            "description": f"{name} Option",
                            "exchange": exch,
                            "type": "option"
                        })

                existing_syms = {s['symbol'] for s in tv_results.get('symbols', [])}
                new_symbols = [f for f in filtered[:100] if f['symbol'] not in existing_syms]
                tv_results['symbols'] = new_symbols + tv_results.get('symbols', [])
        except Exception as e:
            logger.error(f"Options merging error: {e}")

    return tv_results


@fastapi_app.get("/api/tv/options")
async def get_tv_options(underlying: str = Query(...)):
    """Return TradingView option symbols for a requested underlying."""
    data = await search_options(underlying)
    if not data:
        raise HTTPException(status_code=500, detail="Failed to fetch options")

    results = []
    for item in data.get('symbols', []):
        full_symbol = item.get('s', '')
        if ':' in full_symbol:
            exch, name = full_symbol.split(':', 1)
            results.append({
                "symbol": name,
                "description": f"{name} Option",
                "exchange": exch,
                "type": "option"
            })

    return {"symbols": results}


@fastapi_app.get("/api/tv/intraday/{instrument_key}")
async def get_intraday(instrument_key: str, interval: str = '1'):
    """Fetch TradingView candles and calculated overlay indicators."""
    try:
        clean_key = unquote(instrument_key)
        hrn = symbol_mapper.get_hrn(clean_key)

        tv_candles = await asyncio.to_thread(tv_api.get_hist_candles, clean_key, interval, 1000)

        valid_indicators = []
        if tv_candles:
            try:
                import pandas as pd
                analyzer_candles = sorted(tv_candles, key=lambda x: x[0])
                df = pd.DataFrame(analyzer_candles, columns=['ts', 'o', 'h', 'l', 'c', 'v'])

                # EMA 9
                ema9 = df['c'].ewm(span=9, adjust=False).mean()
                valid_indicators.append({
                    "id": "ema_9",
                    "title": "EMA 9",
                    "type": "line",
                    "style": {"color": "#3b82f6", "lineWidth": 1},
                    "data": [{"time": analyzer_candles[i][0], "value": float(val)}
                            for i, val in enumerate(ema9) if i >= 8]
                })

                # EMA 20
                ema20 = df['c'].ewm(span=20, adjust=False).mean()
                valid_indicators.append({
                    "id": "ema_20",
                    "title": "EMA 20",
                    "type": "line",
                    "style": {"color": "#f97316", "lineWidth": 1},
                    "data": [{"time": analyzer_candles[i][0], "value": float(val)}
                            for i, val in enumerate(ema20) if i >= 19]
                })

                # Market Psychology Analyzer
                from brain.MarketPsychologyAnalyzer import MarketPsychologyAnalyzer
                analyzer = MarketPsychologyAnalyzer()
                zones, signals = analyzer.analyze(analyzer_candles)

                for i, zone in enumerate(zones):
                    valid_indicators.append({
                        "id": f"battle_zone_{i}",
                        "type": "price_line",
                        "title": "BATTLE ZONE",
                        "data": {
                            "price": zone['price'],
                            "color": "rgba(59, 130, 246, 0.4)",
                            "lineStyle": 2,
                            "title": "BATTLE ZONE"
                        }
                    })

                marker_data = []
                for ts, sig_type in signals.items():
                    unix_ts = int(ts.timestamp())
                    marker_data.append({
                        "time": unix_ts,
                        "position": "aboveBar" if "SHORT" in sig_type else "belowBar",
                        "color": "#ef4444" if "SHORT" in sig_type else "#22c55e",
                        "shape": "arrowDown" if "SHORT" in sig_type else "arrowUp",
                        "text": sig_type
                    })

                if marker_data:
                    valid_indicators.append({
                        "id": "psych_signals",
                        "type": "markers",
                        "title": "Psychology Signals",
                        "data": marker_data
                    })
            except Exception as e:
                logger.error(f"Error building indicators: {e}")

        return {
            "instrumentKey": clean_key,
            "hrn": hrn,
            "candles": tv_candles or [],
            "indicators": valid_indicators
        }
    except Exception as e:
        logger.error(f"Error in intraday fetch: {e}")
        return {"candles": [], "indicators": []}


# ==================== ENHANCED OPTIONS API ====================

@fastapi_app.get("/api/options/chain/{underlying}")
async def get_options_chain(underlying: str):
    """Return the latest option chain enriched with calculated Greeks."""
    return options_manager.get_chain_with_greeks(underlying)


@fastapi_app.get("/api/options/chain/{underlying}/with-greeks")
async def get_options_chain_with_greeks(
    underlying: str,
    spot_price: Optional[float] = None
):
    """Return option-chain rows with spot-derived moneyness and ATM distance."""
    chain_data = options_manager.get_chain_with_greeks(underlying)

    if not spot_price:
        # Use robust spot price discovery
        spot_price = await options_manager.get_spot_price(underlying)

    # Categorize strikes
    for item in chain_data.get('chain', []):
        strike = item.get('strike', 0)
        option_type = item.get('option_type', 'call')

        # Categorize as ITM/ATM/OTM
        moneyness = greeks_calculator.categorize_strike(strike, spot_price, option_type)
        item['moneyness'] = moneyness

        # Calculate distance from ATM
        if spot_price and spot_price > 0:
            item['distance_from_atm_pct'] = round(abs(strike - spot_price) / spot_price * 100, 2)
        else:
            item['distance_from_atm_pct'] = 0

    return {
        "underlying": underlying,
        "spot_price": spot_price,
        "chain": chain_data.get('chain', []),
        "source": chain_data.get('source', 'unknown')
    }


@fastapi_app.get("/api/options/greeks/{underlying}")
async def get_options_greeks(
    underlying: str,
    strike: float = Query(...),
    option_type: str = Query(..., pattern="^(call|put)$"),
    expiry: Optional[str] = None,
    spot_price: Optional[float] = None,
    option_price: Optional[float] = None
):
    """Calculate Black-Scholes Greeks for a single option contract."""
    if not spot_price:
        res = db.query(
            "SELECT price FROM ticks WHERE instrumentKey = ? ORDER BY ts_ms DESC LIMIT 1",
            (underlying,)
        )
        spot_price = res[0]['price'] if res else 0

    if not expiry:
        # Get nearest expiry
        chain = options_manager.get_chain_with_greeks(underlying)
        if chain.get('chain'):
            expiry = chain['chain'][0].get('expiry')

    # Calculate time to expiry
    from datetime import date
    if expiry:
        if isinstance(expiry, str):
            if 'T' in expiry:
                expiry_date = datetime.fromisoformat(expiry.replace('Z', '+00:00')).date()
            else:
                expiry_date = datetime.strptime(expiry, "%Y-%m-%d").date()
        else:
            expiry_date = expiry
        days_to_expiry = max((expiry_date - date.today()).days, 0)
        time_to_expiry = days_to_expiry / 365.0
    else:
        time_to_expiry = 0.03

    # Estimate IV if not provided
    iv = 0.20
    if option_price:
        iv = greeks_calculator._calculate_implied_volatility(
            spot_price, strike, time_to_expiry, 0.10, option_price, option_type
        )

    greeks = greeks_calculator.calculate_all_greeks(
        spot_price, strike, time_to_expiry, iv, option_type, option_price
    )

    return {
        "underlying": underlying,
        "spot_price": spot_price,
        "strike": strike,
        "option_type": option_type,
        "expiry": expiry,
        **greeks
    }


@fastapi_app.get("/api/options/oi-buildup/{underlying}")
async def get_oi_buildup_analysis(underlying: str):
    """Return OI buildup signals and strike-level OI changes."""
    return options_manager.get_oi_buildup_analysis(underlying)


@fastapi_app.get("/api/options/iv-analysis/{underlying}")
async def get_iv_analysis(underlying: str):
    """Return implied-volatility analysis for the underlying's option chain."""
    return options_manager.get_iv_analysis(underlying)


@fastapi_app.get("/api/options/support-resistance/{underlying}")
async def get_support_resistance(underlying: str, top_n: int = Query(default=3, ge=1, le=10)):
    """Return OI-derived support and resistance levels."""
    return options_manager.get_support_resistance(underlying)


@fastapi_app.get("/api/options/genie-insights/{underlying}")
async def get_genie_insights(underlying: str):
    """Return consolidated Genie insights for the options dashboard."""
    return await options_manager.get_genie_insights(underlying)


@fastapi_app.get("/api/options/high-activity/{underlying}")
async def get_high_activity_strikes(underlying: str):
    """Return high-activity option strikes via the Greeks-enriched chain."""
    return options_manager.get_chain_with_greeks(underlying)


@fastapi_app.get("/api/tv/status")
async def get_tv_status():
    """Return live TradingView provider status from the provider registry."""
    from backend.core.provider_registry import live_stream_registry

    tv_providers = [p for p in live_stream_registry.get_all() if "tradingview" in p.__class__.__name__.lower()]

    status = "disconnected"
    latency = 0
    symbols_count = 0

    if tv_providers:
        p = tv_providers[0]
        status = "connected" if getattr(p, 'client', None) and getattr(p.client, 'connected', False) else "disconnected"
        latency = 25
        symbols_count = len(getattr(p, 'subscribed_symbols', []))

    return {
        "status": status,
        "latency": latency,
        "symbols_count": symbols_count,
        "uptime": "100%",
        "alerts": []
    }

@fastapi_app.get("/api/options/pcr-trend/{underlying}")
async def get_pcr_trend(underlying: str):
    """Return current-day PCR history for trend analysis."""
    latest_ts_res = db.query("SELECT MAX(timestamp) as ts FROM pcr_history WHERE underlying = ?", (underlying,))
    latest_ts = latest_ts_res[0]['ts'] if latest_ts_res else None
    if latest_ts is None or str(latest_ts) == 'NaT':
        return {"history": []}

    history = db.query(
        """
        SELECT timestamp, pcr_oi, pcr_vol, pcr_oi_change, underlying_price, max_pain, spot_price, total_oi, total_oi_change
        FROM pcr_history
        WHERE underlying = ?
        AND CAST((timestamp AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata' AS DATE) =
            CAST(( ((SELECT MAX(timestamp) FROM pcr_history WHERE underlying = ?)) AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata' AS DATE)
        ORDER BY timestamp ASC
        """,
        (underlying, underlying),
        json_serialize=True
    )

    return {"history": history}


@fastapi_app.get("/api/options/full-history/{underlying}")
async def get_full_options_history(underlying: str):
    """Return current-day PCR and option snapshots for historical replay."""
    pcr_history = db.query(
        """
        SELECT timestamp, pcr_oi, pcr_vol, pcr_oi_change, underlying_price, max_pain, spot_price, total_oi, total_oi_change
        FROM pcr_history
        WHERE underlying = ?
        AND CAST((timestamp AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata' AS DATE) =
            CAST(( ((SELECT MAX(timestamp) FROM pcr_history WHERE underlying = ?)) AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata' AS DATE)
        ORDER BY timestamp ASC
        """,
        (underlying, underlying),
        json_serialize=True
    )

    snapshots = db.query(
        """
        SELECT timestamp, strike, option_type, oi, oi_change, volume, ltp, iv, delta, theta
        FROM options_snapshots
        WHERE underlying = ?
        AND CAST((timestamp AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata' AS DATE) =
            CAST(now() AT TIME ZONE 'Asia/Kolkata' AS DATE)
        ORDER BY timestamp ASC, strike ASC
        """,
        (underlying,),
        json_serialize=True
    )

    return {
        "pcr_history": pcr_history,
        "snapshots": snapshots
    }


@fastapi_app.get("/api/options/summary")
async def get_options_summary(underlying: str):
    """Return latest option-chain summary metrics for an underlying."""
    try:
        latest_ts_res = db.query(
            "SELECT MAX(timestamp) as ts FROM options_snapshots WHERE underlying = ?",
            (underlying,)
        )
        latest_ts = latest_ts_res[0]['ts'] if latest_ts_res else None
        if latest_ts is None or str(latest_ts) == 'NaT':
            return {"underlying": underlying, "timestamp": None, "summary": {}}

        summary = db.query(
            """
            SELECT 
                COUNT(DISTINCT strike) as total_strikes,
                COUNT(*) as total_contracts,
                SUM(CASE WHEN option_type = 'call' THEN oi ELSE 0 END) as total_call_oi,
                SUM(CASE WHEN option_type = 'put' THEN oi ELSE 0 END) as total_put_oi,
                SUM(CASE WHEN option_type = 'call' THEN volume ELSE 0 END) as total_call_volume,
                SUM(CASE WHEN option_type = 'put' THEN volume ELSE 0 END) as total_put_volume,
                MAX(source) as source
            FROM options_snapshots
            WHERE underlying = ? AND timestamp = ?
            """,
            (underlying, latest_ts),
            json_serialize=True
        )

        pcr_res = db.query(
            "SELECT pcr_oi FROM pcr_history WHERE underlying = ? ORDER BY timestamp DESC LIMIT 1",
            (underlying,),
            json_serialize=True
        )

        return {
            "underlying": underlying,
            "timestamp": latest_ts,
            "summary": summary[0] if summary else {},
            "pcr": pcr_res[0]['pcr_oi'] if pcr_res else None,
        }
    except Exception as e:
        logger.error(f"Error getting options summary: {e}")
        return {"underlying": underlying, "error": str(e)}


@fastapi_app.get("/api/options/oi-analysis/{underlying}")
async def get_oi_analysis(underlying: str):
    """Return latest per-strike OI distribution for an underlying."""
    latest_ts_res = db.query(
        "SELECT MAX(timestamp) as ts FROM options_snapshots WHERE underlying = ?",
        (underlying,)
    )

    # Check for both None and NaT (serialization artifact)
    latest_ts = latest_ts_res[0]['ts'] if latest_ts_res else None
    if latest_ts is None or str(latest_ts) == 'NaT':
        return {"timestamp": None, "data": []}

    data = db.query(
        """
        SELECT strike,
            SUM(CASE WHEN option_type = 'call' THEN oi ELSE 0 END) as call_oi,
            SUM(CASE WHEN option_type = 'put' THEN oi ELSE 0 END) as put_oi,
            SUM(CASE WHEN option_type = 'call' THEN oi_change ELSE 0 END) as call_oi_change,
            SUM(CASE WHEN option_type = 'put' THEN oi_change ELSE 0 END) as put_oi_change,
            SUM(CASE WHEN option_type = 'call' THEN volume ELSE 0 END) as call_volume,
            SUM(CASE WHEN option_type = 'put' THEN volume ELSE 0 END) as put_volume,
            MAX(source) as source
        FROM options_snapshots
        WHERE underlying = ? AND timestamp = ?
        GROUP BY strike
        ORDER BY strike ASC
        """,
        (underlying, latest_ts),
        json_serialize=True
    )

    return {"timestamp": latest_ts, "data": data}


@fastapi_app.post("/api/options/backfill")
async def trigger_options_backfill():
    """Start a background task to backfill today's options data."""
    try:
        asyncio.create_task(options_manager.backfill_today())
        return {"status": "success", "message": "Backfill task started"}
    except Exception as e:
        logger.error(f"Error triggering backfill: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ==================== STRATEGY BUILDER API ====================

@fastapi_app.post("/api/strategy/build")
async def build_strategy(request: Request):
    """Build and analyze a custom strategy from request-supplied legs."""
    try:
        body = await request.json()

        name = body.get('name', 'Custom Strategy')

        # Robust StrategyType lookup
        st_input = body.get('strategy_type', 'CUSTOM')
        strategy_type = StrategyType.CUSTOM

        try:
            # Try by value
            strategy_type = StrategyType(st_input)
        except ValueError:
            try:
                # Try by name (case-insensitive)
                strategy_type = StrategyType[st_input.upper()]
            except (KeyError, AttributeError):
                logger.warning(f"Unknown strategy type: {st_input}, falling back to CUSTOM")

        underlying = body.get('underlying')
        spot_price = body.get('spot_price')
        if not spot_price:
            res = db.query("SELECT price FROM ticks WHERE instrumentKey = ? ORDER BY ts_ms DESC LIMIT 1", (underlying,))
            spot_price = res[0]['price'] if res else 0

        legs = body.get('legs', [])

        strategy = strategy_builder.create_strategy(
            name, strategy_type, underlying, spot_price, legs
        )

        return {
            "status": "success",
            "strategy_id": strategy.name,
            "analysis": strategy_builder.analyze_strategy(strategy.name)
        }
    except Exception as e:
        logger.error(f"Error building strategy: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@fastapi_app.post("/api/strategy/bull-call-spread")
async def create_bull_call_spread(request: Request):
    """Create and analyze a bull call spread from request parameters."""
    try:
        body = await request.json()

        underlying = body.get('underlying')
        spot_price = body.get('spot_price')

        if not spot_price:
            # Try to get spot price
            res = db.query("SELECT price FROM ticks WHERE instrumentKey = ? ORDER BY ts_ms DESC LIMIT 1", (underlying,))
            spot_price = res[0]['price'] if res else 0

        strategy = strategy_builder.create_bull_call_spread(
            underlying=underlying,
            spot_price=spot_price or 0,
            lower_strike=body.get('lower_strike'),
            higher_strike=body.get('higher_strike'),
            lower_premium=body.get('lower_premium'),
            higher_premium=body.get('higher_premium'),
            expiry=body.get('expiry'),
            quantity=body.get('quantity', 1)
        )

        return {
            "status": "success",
            "strategy_id": strategy.name,
            "analysis": strategy_builder.analyze_strategy(strategy.name)
        }
    except Exception as e:
        logger.error(f"Error creating bull call spread: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@fastapi_app.post("/api/strategy/iron-condor")
async def create_iron_condor(request: Request):
    """Create and analyze an iron condor from request parameters."""
    try:
        body = await request.json()

        underlying = body.get('underlying')
        spot_price = body.get('spot_price')

        if not spot_price:
            res = db.query("SELECT price FROM ticks WHERE instrumentKey = ? ORDER BY ts_ms DESC LIMIT 1", (underlying,))
            spot_price = res[0]['price'] if res else 0

        strategy = strategy_builder.create_iron_condor(
            underlying=underlying,
            spot_price=spot_price or 0,
            put_sell_strike=body.get('put_sell_strike'),
            put_buy_strike=body.get('put_buy_strike'),
            call_sell_strike=body.get('call_sell_strike'),
            call_buy_strike=body.get('call_buy_strike'),
            premiums=body.get('premiums'),
            expiry=body.get('expiry'),
            quantity=body.get('quantity', 1)
        )

        return {
            "status": "success",
            "strategy_id": strategy.name,
            "analysis": strategy_builder.analyze_strategy(strategy.name)
        }
    except Exception as e:
        logger.error(f"Error creating iron condor: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@fastapi_app.post("/api/strategy/long-straddle")
async def create_long_straddle(request: Request):
    """Create and analyze a long straddle from request parameters."""
    try:
        body = await request.json()

        underlying = body.get('underlying')
        spot_price = body.get('spot_price')

        if not spot_price:
            res = db.query("SELECT price FROM ticks WHERE instrumentKey = ? ORDER BY ts_ms DESC LIMIT 1", (underlying,))
            spot_price = res[0]['price'] if res else 0

        strategy = strategy_builder.create_long_straddle(
            underlying=underlying,
            spot_price=spot_price or 0,
            strike=body.get('strike'),
            call_premium=body.get('call_premium'),
            put_premium=body.get('put_premium'),
            expiry=body.get('expiry'),
            quantity=body.get('quantity', 1)
        )

        return {
            "status": "success",
            "strategy_id": strategy.name,
            "analysis": strategy_builder.analyze_strategy(strategy.name)
        }
    except Exception as e:
        logger.error(f"Error creating long straddle: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@fastapi_app.get("/api/strategy/{strategy_id}/analysis")
async def get_strategy_analysis(strategy_id: str):
    """Return stored analysis for a previously built strategy."""
    analysis = strategy_builder.analyze_strategy(strategy_id)
    if 'error' in analysis:
        raise HTTPException(status_code=404, detail="Strategy not found")
    return analysis


@fastapi_app.get("/api/strategy/recommendations")
async def get_strategy_recommendations(
    market_view: str = Query(..., pattern="^(bullish|bearish|neutral|volatile)$"),
    iv_rank: float = Query(..., ge=0, le=100)
):
    """Return strategy recommendations based on market view and IV rank."""
    return {
        "recommendations": strategy_builder.get_strategy_recommendations(market_view, iv_rank)
    }


# ==================== ALERT SYSTEM API ====================

@fastapi_app.post("/api/alerts/create")
async def create_alert(request: Request):
    """Create a new alert from request-supplied conditions and channels."""
    try:
        body = await request.json()

        alert = alert_system.create_alert(
            name=body.get('name'),
            alert_type=AlertType(body.get('alert_type')),
            underlying=body.get('underlying'),
            condition=body.get('condition'),
            message_template=body.get('message_template'),
            cooldown_minutes=body.get('cooldown_minutes', 15),
            notification_channels=body.get('notification_channels', ['websocket'])
        )

        return {
            "status": "success",
            "alert": alert.to_dict()
        }
    except Exception as e:
        logger.error(f"Error creating alert: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@fastapi_app.get("/api/alerts")
async def get_alerts(
    underlying: Optional[str] = None,
    status: Optional[str] = None
):
    """List alerts with optional underlying and status filters."""
    from backend.core.alert_system import AlertStatus

    alert_status = None
    if status:
        alert_status = AlertStatus(status)

    return {
        "alerts": alert_system.get_alerts(underlying, alert_status)
    }


@fastapi_app.delete("/api/alerts/{alert_id}")
async def delete_alert(alert_id: str):
    """Delete an alert by identifier."""
    if alert_system.delete_alert(alert_id):
        return {"status": "success", "message": "Alert deleted"}
    raise HTTPException(status_code=404, detail="Alert not found")


# ==================== SCALPER API ====================

@fastapi_app.post("/api/scalper/start")
async def start_scalper(underlying: str = Query("NSE:NIFTY")):
    """Start the NSE Confluence Scalper for the requested underlying."""
    try:
        scalper.underlying = underlying
        await scalper.start()
        return {"status": "success", "message": f"Scalper started for {underlying}"}
    except Exception as e:
        logger.error(f"Error starting scalper: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@fastapi_app.post("/api/scalper/stop")
async def stop_scalper():
    """Stop the active NSE Confluence Scalper."""
    try:
        await scalper.stop()
        return {"status": "success", "message": "Scalper stopped"}
    except Exception as e:
        logger.error(f"Error stopping scalper: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@fastapi_app.get("/api/scalper/status")
async def get_scalper_status():
    """Return current scalper running state, underlying, trades, and spot price."""
    return {
        "is_running": scalper.is_running,
        "underlying": scalper.underlying,
        "active_trades": scalper.order_manager.active_trades,
        "current_spot": scalper.current_spot
    }


@fastapi_app.post("/api/alerts/{alert_id}/pause")
async def pause_alert(alert_id: str):
    """Pause an alert by identifier."""
    if alert_system.pause_alert(alert_id):
        return {"status": "success", "message": "Alert paused"}
    raise HTTPException(status_code=404, detail="Alert not found")


@fastapi_app.post("/api/alerts/{alert_id}/resume")
async def resume_alert(alert_id: str):
    """Resume a paused alert by identifier."""
    if alert_system.resume_alert(alert_id):
        return {"status": "success", "message": "Alert resumed"}
    raise HTTPException(status_code=404, detail="Alert not found")


# ==================== STATIC FILES & TEMPLATES ====================

templates = Jinja2Templates(directory="backend/templates")
fastapi_app.mount("/static", StaticFiles(directory="backend/static"), name="static")


@fastapi_app.get("/")
async def serve_index(request: Request):
    """Render the main terminal dashboard."""
    return templates.TemplateResponse("index.html", {"request": request})


@fastapi_app.get("/options")
async def serve_options_dashboard(request: Request):
    """Render the options analysis dashboard."""
    return templates.TemplateResponse("options_dashboard.html", {"request": request})


@fastapi_app.get("/db-viewer")
async def db_viewer(request: Request):
    """Render the local DuckDB inspection dashboard."""
    return templates.TemplateResponse("db_viewer.html", {"request": request})


@fastapi_app.get("/api/db/tables")
async def get_db_tables():
    """List local DuckDB tables, schemas, and row counts."""
    try:
        tables = db.get_tables()
        result = []
        for table in tables:
            schema = db.get_table_schema(table, json_serialize=True)
            count_res = db.query(f'SELECT COUNT(*) as count FROM "{table}"')
            row_count = count_res[0]['count'] if count_res else 0
            result.append({"name": table, "schema": schema, "row_count": row_count})
        return {"tables": result}
    except Exception as e:
        logger.error(f"Error fetching tables: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@fastapi_app.post("/api/db/query")
async def run_db_query(request: Request):
    """Run a SQL query against the local DuckDB database."""
    try:
        body = await request.json()
        sql = body.get("sql")
        if not sql:
            raise HTTPException(status_code=400, detail="SQL query is required")

        results = db.query(sql, json_serialize=True)
        return {"results": results}
    except Exception as e:
        logger.error(f"Error running query: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@fastapi_app.post("/api/db/export")
async def export_db_query(request: Request):
    """Export DuckDB query results as a CSV attachment."""
    try:
        body = await request.json()
        sql = body.get("sql")
        if not sql:
            raise HTTPException(status_code=400, detail="SQL query is required")

        results = db.query(sql, json_serialize=False)
        if not results:
            return {"error": "No data to export"}

        import pandas as pd
        import io
        from fastapi.responses import StreamingResponse

        df = pd.DataFrame(results)
        stream = io.StringIO()
        df.to_csv(stream, index=False)

        response = StreamingResponse(
            iter([stream.getvalue()]),
            media_type="text/csv"
        )
        response.headers["Content-Disposition"] = "attachment; filename=export.csv"
        return response
    except Exception as e:
        logger.error(f"Error exporting query: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# Create ASGI app
app = socketio.ASGIApp(sio, fastapi_app)

if __name__ == "__main__":
    import uvicorn
    port = SERVER_PORT
    uvicorn.run("api_server:app", host="0.0.0.0", port=port, reload=False)
