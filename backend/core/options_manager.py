"""
Enhanced Options Manager Module
Integrates Greeks, IV Analysis, OI Buildup, Strategy Builder, and Alerts
"""

import asyncio
import logging
import json
import pytz
import time
from datetime import datetime, timedelta
from typing import Dict, Any, List, Optional
import pandas as pd

from backend.config import OPTIONS_UNDERLYINGS, SNAPSHOT_CONFIG
from backend.db.local_db import  db
from backend.core.interfaces import ILiveStreamProvider
from backend.core.provider_registry import options_data_registry, historical_data_registry
from backend.external.tv_options_wss import OptionsWSS

# Import new modules
from backend.core.greeks_calculator import greeks_calculator
from backend.core.iv_analyzer import iv_analyzer
from backend.core.oi_buildup_analyzer import oi_buildup_analyzer
from backend.core.strategy_builder import strategy_builder
from backend.core.alert_system import alert_system

logger = logging.getLogger(__name__)


class OptionsManager:
    """
    Orchestrates options data lifecycle and advanced technical analysis.
    Now standardized to consume unified data schemas.
    """

    def __init__(self):
        self.active_underlyings = OPTIONS_UNDERLYINGS
        self.tl_symbol_map = {
            "NSE:NIFTY": "NIFTY 50",
            "NSE:BANKNIFTY": "BANKNIFTY",
            "NSE:FINNIFTY": "FINNIFTY"
        }
        self.running = False
        self._task = None
        self.wss_clients: Dict[str, ILiveStreamProvider] = {}
        self.latest_chains: Dict[str, Dict[str, Any]] = {}
        self.symbol_map_cache: Dict[str, Dict[str, str]] = {}
        self.sio = None
        self.loop = None
        self.tv_manager = None

        # New feature: Store previous chain data for buildup analysis
        self.previous_chains: Dict[str, List[Dict[str, Any]]] = {}

        # New feature: IV tracking per underlying
        self.iv_history: Dict[str, List[float]] = {}

    def set_socketio(self, sio: Any, loop: Optional[asyncio.AbstractEventLoop] = None):
        self.sio = sio
        self.loop = loop
        alert_system.register_callback(self._on_alert_triggered)

    def set_tv_manager(self, tv_manager):
        self.tv_manager = tv_manager

    def _on_alert_triggered(self, alert_data: Dict[str, Any]):
        if self.sio:
            asyncio.run_coroutine_threadsafe(
                self.sio.emit('options_alert', alert_data),
                self.loop
            )

    async def start(self):
        if self.running:
            return
        self.running = True

        # Initialize symbols cache
        for underlying in self.active_underlyings:
            try:
                await self._refresh_wss_symbols(underlying)
            except Exception as e:
                logger.error(f"Error initializing symbols for {underlying}: {e}")

        # Trigger backfill and repair in background
        async def backfill_and_repair():
            await self.backfill_today()
            await self.repair_zero_spot_prices()

        asyncio.create_task(backfill_and_repair())
        self._task = asyncio.create_task(self._snapshot_loop())

        # Start WSS for active underlyings
        for underlying in self.active_underlyings:
            self.start_wss(underlying)

        # Create preset alerts
        for underlying in self.active_underlyings:
            alert_system.create_preset_alerts(underlying)

        logger.info("Enhanced Standardized Options management started")

    async def backfill_today(self):
        """Standardized backfill logic."""
        logger.info("Starting standardized options backfill...")

        ist = pytz.timezone('Asia/Kolkata')
        now_ist = datetime.now(ist)

        # Determine the trading day to backfill (today or last trading day)
        target_day = now_ist
        if target_day.weekday() == 5: target_day -= timedelta(days=1) # Saturday -> Friday
        elif target_day.weekday() == 6: target_day -= timedelta(days=2) # Sunday -> Friday

        market_open = target_day.replace(hour=9, minute=15, second=0, microsecond=0)
        market_close = target_day.replace(hour=15, minute=30, second=0, microsecond=0)

        if now_ist < market_open:
            target_day -= timedelta(days=1)
            if target_day.weekday() == 5: target_day -= timedelta(days=1)
            if target_day.weekday() == 6: target_day -= timedelta(days=2)
            market_open = target_day.replace(hour=9, minute=15, second=0, microsecond=0)
            market_close = target_day.replace(hour=15, minute=30, second=0, microsecond=0)

        # Only backfill up to market close or "now" if within market hours
        end_time = market_close
        if target_day.date() == now_ist.date():
            end_time = min(now_ist, market_close)

        current = market_open
        time_slots = []
        backfill_interval = SNAPSHOT_CONFIG.get('backfill_interval_minutes', 5)
        while current <= end_time:
            time_slots.append(current.strftime("%H:%M"))
            current += timedelta(minutes=backfill_interval)

        target_date_str = target_day.strftime('%Y-%m-%d')

        # Pre-identify providers that support historical time_str (Trendlyne)
        hist_opt_providers = [p for name, p in options_data_registry.providers.items() if name == "trendlyne"]
        # Fallback to primary if no specific historical provider
        primary_opt_provider = options_data_registry.get_primary()

        for underlying in self.active_underlyings:
            try:
                # Get historical spot prices
                hist_provider = historical_data_registry.get_primary()
                hist_spot = await hist_provider.get_hist_candles(underlying, '1', 1000)
                spot_map = {c[0]: c[4] for c in hist_spot} if hist_spot else {}

                expiries = await primary_opt_provider.get_expiry_dates(underlying)
                if not expiries: continue
                default_expiry = expiries[0]

                previous_oi_map = {} # strike -> {call_oi, put_oi}

                for ts_str in time_slots:
                    data = None
                    slot_dt = target_day.replace(hour=int(ts_str.split(':')[0]), minute=int(ts_str.split(':')[1]))

                    # Try historical providers (Trendlyne)
                    for p in hist_opt_providers:
                        try:
                            data = await p.get_oi_data(underlying, default_expiry, ts_str)
                            if data and data.get('oi_data'):
                                logger.info(f"Backfill: Got historical data for {underlying} @ {ts_str} from {p.__class__.__name__}")
                                break
                            else:
                                logger.debug(f"Backfill: No data from {p.__class__.__name__} for {underlying} @ {ts_str}")
                        except Exception as e:
                            logger.error(f"Backfill error from {p.__class__.__name__}: {e}")
                            continue

                    # If no historical data and it's near "now", use primary provider
                    if not data:
                        if abs((now_ist - slot_dt).total_seconds()) < 900:
                            data = await primary_opt_provider.get_oi_data(underlying, default_expiry, ts_str)

                    if not data or not data.get('oi_data'):
                        continue

                    oi_data = data['oi_data']
                    ist_dt = target_day.replace(
                        hour=int(ts_str.split(':')[0]),
                        minute=int(ts_str.split(':')[1]),
                        second=0, microsecond=0
                    )
                    snapshot_time = ist_dt.astimezone(pytz.utc)
                    unix_ts = int(ist_dt.timestamp())

                    spot_price = spot_map.get(unix_ts, 0)
                    if not spot_price:
                        potential_ts = sorted([t for t in spot_map.keys() if t <= unix_ts])
                        if potential_ts: spot_price = spot_map[potential_ts[-1]]

                    # Calculate OI Change manually if not provided and we have previous slot
                    for strike_str, strike_data in oi_data.items():
                        strike = float(strike_str)
                        if strike in previous_oi_map:
                            # Only calculate change if provided change is 0 (missing)
                            # and current OI is different from previous
                            if strike_data.get('callOiChange', 0) == 0:
                                strike_data['callOiChange'] = strike_data['callOi'] - previous_oi_map[strike]['call_oi']
                            if strike_data.get('putOiChange', 0) == 0:
                                strike_data['putOiChange'] = strike_data['putOi'] - previous_oi_map[strike]['put_oi']

                        previous_oi_map[strike] = {
                            'call_oi': strike_data['callOi'],
                            'put_oi': strike_data['putOi']
                        }

                    rows = self._process_standard_oi_data(
                        oi_data, underlying, snapshot_time, default_expiry, spot_price,
                        source=data.get('source', 'backfill')
                    )

                    if rows:
                        db.insert_options_snapshot(rows)
                        await self._calculate_pcr(underlying, snapshot_time, rows, spot_price)

            except Exception as e:
                logger.error(f"Error backfilling {underlying}: {e}")

    def _process_standard_oi_data(
        self,
        oi_data: Dict[str, Any],
        underlying: str,
        timestamp: datetime,
        expiry: str,
        spot_price: float,
        source: str = "standard"
    ) -> List[Dict[str, Any]]:
        """Process OI data using the uniform OIDataSnapshot schema."""
        rows = []
        expiry_date = None
        if isinstance(expiry, str):
            for fmt in ("%Y-%m-%d", "%d-%b-%Y", "%d-%m-%Y"):
                try:
                    expiry_date = datetime.strptime(expiry, fmt).date()
                    break
                except: continue

        if not expiry_date: return []

        today = datetime.now(pytz.timezone('Asia/Kolkata')).date()
        days_to_expiry = max((expiry_date - today).days, 0)
        time_to_expiry = days_to_expiry / 365.0

        for strike_str, strike_data in oi_data.items():
            strike = float(strike_str)

            # Map Call and Put
            for opt_type in ['call', 'put']:
                prefix = 'call' if opt_type == 'call' else 'put'
                sym = self.symbol_map_cache.get(underlying, {}).get(f"{strike}_{opt_type}")

                ltp = float(strike_data.get(f'{prefix}Ltp', 0))
                oi = int(strike_data.get(f'{prefix}Oi', 0))
                oi_chg = int(strike_data.get(f'{prefix}OiChange', 0))
                vol = int(strike_data.get(f'{prefix}Vol', 0))

                greeks = greeks_calculator.calculate_all_greeks(
                    spot_price, strike, time_to_expiry, 0.20, opt_type, ltp
                )

                rows.append({
                    'timestamp': timestamp,
                    'underlying': underlying,
                    'symbol': sym,
                    'expiry': expiry_date,
                    'strike': strike,
                    'option_type': opt_type,
                    'oi': oi,
                    'oi_change': oi_chg,
                    'volume': vol,
                    'ltp': ltp,
                    'iv': greeks['implied_volatility'],
                    'delta': greeks['delta'],
                    'gamma': greeks['gamma'],
                    'theta': greeks['theta'],
                    'vega': greeks['vega'],
                    'intrinsic_value': greeks['intrinsic_value'],
                    'time_value': greeks['time_value'],
                    'source': source
                })
        return rows

    async def stop(self):
        self.running = False
        if self._task:
            self._task.cancel()
        for wss in self.wss_clients.values():
            wss.stop()
        self.wss_clients.clear()
        logger.info("Options management stopped")

    def start_wss(self, underlying: str):
        if underlying in self.wss_clients: return
        def on_data(data): self.handle_wss_data(underlying, data)
        wss = OptionsWSS(underlying, on_data)
        wss.start()
        self.wss_clients[underlying] = wss

    def handle_wss_data(self, underlying: str, data: Any):
        symbol = data.get('symbol')
        if not symbol: return
        if underlying not in self.latest_chains: self.latest_chains[underlying] = {}
        existing = self.latest_chains[underlying].get(symbol, {})
        for k, v in data.items():
            if v is not None: existing[k] = v
        self.latest_chains[underlying][symbol] = existing
        if self.sio:
            async def emit():
                await self.sio.emit('options_quote_update', {
                    'underlying': underlying, 'symbol': symbol, 'lp': data.get('lp'),
                    'volume': data.get('volume'), 'bid': data.get('bid'), 'ask': data.get('ask')
                }, room=f"options_{underlying}")
            if self.loop: asyncio.run_coroutine_threadsafe(emit(), self.loop)

    _last_snapshot_emit = {}

    def _emit_snapshot_update(self, underlying: str, rows: list, spot_price: float):
        """Emit incremental options snapshot via Socket.IO (throttled to 1Hz per underlying)."""
        if not self.sio or not self.loop:
            return
        now = time.time()
        if now - self._last_snapshot_emit.get(underlying, 0) < 1.0:
            return
        self._last_snapshot_emit[underlying] = now
        updates = [
            {
                'symbol': r.get('symbol'),
                'strike': r.get('strike'),
                'option_type': r.get('option_type'),
                'ltp': r.get('ltp'),
                'oi': r.get('oi'),
                'oi_change': r.get('oi_change'),
                'volume': r.get('volume'),
                'iv': r.get('iv'),
                'delta': r.get('delta'),
                'theta': r.get('theta'),
            }
            for r in rows
        ]
        payload = {
            'underlying': underlying,
            'spot_price': spot_price,
            'updates': updates,
        }
        async def _emit():
            await self.sio.emit('options_snapshot_update', payload, room=f"options_{underlying}")
        asyncio.run_coroutine_threadsafe(_emit(), self.loop)

    def is_market_open(self):
        ist = pytz.timezone('Asia/Kolkata')
        now = datetime.now(ist)
        if now.weekday() >= 5: return False
        return now.replace(hour=9, minute=15) <= now <= now.replace(hour=15, minute=30)

    async def _snapshot_loop(self):
        while self.running:
            if self.is_market_open():
                for underlying in self.active_underlyings:
                    try: await self.take_snapshot(underlying)
                    except Exception as e: logger.error(f"Snapshot failed for {underlying}: {e}")
            await asyncio.sleep(180)

    async def take_snapshot(self, underlying: str):
        """Standardized snapshot logic."""
        spot_price = await self.get_spot_price(underlying)
        try:
            if underlying not in self.symbol_map_cache or not self.symbol_map_cache[underlying]:
                await self._refresh_wss_symbols(underlying)

            # Get unified OI data
            opt_provider = options_data_registry.get_primary()
            expiries = await opt_provider.get_expiry_dates(underlying)
            if not expiries: return
            default_expiry = expiries[0]

            ts_str = datetime.now(pytz.timezone('Asia/Kolkata')).strftime("%H:%M")
            data = await opt_provider.get_oi_data(underlying, default_expiry, ts_str)

            if not data or 'oi_data' not in data:
                return # Fallback logic could be added here

            oi_data = data['oi_data']
            timestamp = datetime.now(pytz.utc)

            # Enrich with real-time WSS data if available
            wss_data = self.latest_chains.get(underlying, {})

            rows = self._process_standard_oi_data(
                oi_data, underlying, timestamp, default_expiry, spot_price,
                source=getattr(opt_provider, 'name', 'primary')
            )

            if rows:
                self.previous_chains[underlying] = rows.copy()
                db.insert_options_snapshot(rows)
                await self._calculate_pcr(underlying, timestamp, rows, spot_price)
                self._check_alerts(underlying, rows, spot_price)
                self._emit_snapshot_update(underlying, rows, spot_price)
                logger.info(f"Saved standardized snapshot for {underlying} ({len(rows)} rows)")

        except Exception as e:
            logger.error(f"Snapshot error for {underlying}: {e}")

    def get_spot_price_sync(self, underlying: str) -> float:
        """Synchronous layer of spot price discovery (Layers 1 & 2)."""
        try:
            # Layer 1: Ticks Table (Live Feed) - Filter by priority if possible, or just latest
            # Since ticks table might not have priority, we prefer the primary provider cache first

            # Layer 2: Live Provider Discovery (Highest priority cache)
            provider = options_data_registry.get_primary()
            if hasattr(provider, 'spot_prices'):
                symbol = underlying.split(':')[-1]
                price = provider.spot_prices.get(symbol, 0)
                if price > 0: return price

            # Layer 1 Fallback: Ticks Table
            target_keys = [underlying, underlying.replace(':', '|')]
            res = db.query(f"SELECT price FROM ticks WHERE instrumentKey IN ({','.join(['?']*len(target_keys))}) ORDER BY ts_ms DESC LIMIT 1", tuple(target_keys))
            if res and res[0]['price'] > 0: return res[0]['price']
        except Exception as e:
            logger.debug(f"Sync spot discovery fallback for {underlying}: {e}")
        return 0

    async def get_spot_price(self, underlying: str) -> float:
        """Robust spot price discovery with async Layer 3 fallback."""
        price = self.get_spot_price_sync(underlying)
        if price > 0: return price

        try:
            # Layer 3: Historical Candles
            hist_provider = historical_data_registry.get_primary()
            hist = await hist_provider.get_hist_candles(underlying, '1', 5)
            if hist: return hist[0][4]
        except Exception as e:
            logger.error(f"Spot discovery error: {e}")
        return 0

    def _check_alerts(self, underlying: str, rows: List[Dict[str, Any]], spot_price: float):
        calls = [r for r in rows if r['option_type'] == 'call']
        total_call_oi = sum(r['oi'] for r in calls)
        total_put_oi = sum(r['oi'] for r in [r for r in rows if r['option_type'] == 'put'])
        pcr = total_put_oi / total_call_oi if total_call_oi > 0 else 0

        # Prepare alert data
        alert_data = {
            'underlying': underlying,
            'price': spot_price,
            'pcr': round(pcr, 2),
            'timestamp': datetime.now(pytz.utc).isoformat()
        }

        # Check alerts
        triggered = alert_system.check_alerts(underlying, alert_data)

        if triggered:
            logger.info(f"Triggered {len(triggered)} alerts for {underlying}")

    async def _take_snapshot_tv(self, underlying: str, wss_data: Dict[str, Any] = None):
        """Fallback to TradingView data via Registry."""
        from backend.external.tv_options_scanner import fetch_option_chain
        data = await fetch_option_chain(underlying)
        if not data or 'symbols' not in data:
            logger.warning(f"TV scanner returned no data for {underlying}")
            return

        spot_price = await self.get_spot_price(underlying)
        timestamp = datetime.now(pytz.utc)
        rows = []

        if underlying not in self.symbol_map_cache:
            self.symbol_map_cache[underlying] = {}

        for item in data['symbols']:
            f = item['f']
            try:
                symbol = f[0]
                strike = float(f[3]) if f[3] is not None else 0
                opt_type = str(f[2]).lower()
                # Use WSS data for OI/volume/LTP if available, otherwise fallback to TV scanner
                wss_opt = wss_data.get(symbol, {}) if wss_data else {}
                oi = int(wss_opt.get('oi', 0)) if wss_opt.get('oi') else 0
                volume = int(wss_opt.get('volume', f[4])) if wss_opt.get('volume') else (int(f[4]) if f[4] is not None else 0)
                ltp = float(wss_opt.get('lp', f[5])) if wss_opt.get('lp') else (float(f[5]) if f[5] is not None else 0)

                # Expiration and Greeks from augmented TV scanner columns
                expiration_val = f[6] if len(f) > 6 else None

                expiry_date = None
                time_to_expiry = 0.01 # Default ~4 days
                if expiration_val:
                    if isinstance(expiration_val, int) and expiration_val > 20000000:
                        try:
                            expiry_date = datetime.strptime(str(expiration_val), "%Y%m%d").date()
                        except:
                            pass

                    if not expiry_date:
                        try:
                            expiry_date = datetime.fromtimestamp(expiration_val, pytz.utc).date()
                        except:
                            pass

                    if expiry_date:
                        days_to_expiry = max((expiry_date - timestamp.date()).days, 0)
                        time_to_expiry = days_to_expiry / 365.0

                # Use Greeks from TV if available, else calculate
                # Indices matching tv_options_scanner columns (no rho):
                # 9: delta, 10: gamma, 11: iv, 12: theta, 13: vega
                tv_delta = f[9] if len(f) > 9 else None
                tv_gamma = f[10] if len(f) > 10 else None
                tv_iv = f[11] if len(f) > 11 else None
                tv_theta = f[12] if len(f) > 12 else None
                tv_vega = f[13] if len(f) > 13 else None

                if tv_iv is not None and tv_iv > 0:
                    greeks = {
                        'implied_volatility': tv_iv,
                        'delta': tv_delta or 0,
                        'gamma': tv_gamma or 0,
                        'theta': tv_theta or 0,
                        'vega': tv_vega or 0,
                        'intrinsic_value': 0, # Not provided by TV directly
                        'time_value': 0
                    }
                else:
                    greeks = greeks_calculator.calculate_all_greeks(
                        spot_price, strike, time_to_expiry, 0.20, opt_type, ltp
                    )

                self.symbol_map_cache[underlying][f"{strike}_{opt_type}"] = symbol

                rows.append({
                    'timestamp': timestamp,
                    'underlying': underlying,
                    'symbol': symbol,
                    'expiry': expiry_date,
                    'strike': strike,
                    'option_type': opt_type,
                    'oi': oi,
                    'oi_change': 0,
                    'volume': volume,
                    'ltp': ltp,
                    'iv': greeks['implied_volatility'],
                    'delta': greeks['delta'],
                    'gamma': greeks['gamma'],
                    'theta': greeks['theta'],
                    'vega': greeks['vega'],
                    'intrinsic_value': greeks.get('intrinsic_value', 0),
                    'time_value': greeks.get('time_value', 0),
                    'source': 'tradingview_fallback'
                })
            except Exception as e:
                logger.debug(f"Error parsing TV symbol {item}: {e}")
                continue

        if rows:
            db.insert_options_snapshot(rows)
            await self._calculate_pcr(underlying, timestamp, rows, spot_price)
            logger.info(f"Saved TV snapshot for {underlying} with {len(rows)} rows")

            if underlying in self.wss_clients:
                atm_strike = sum(r['strike'] for r in rows) / len(rows) if rows else 0
                filtered_symbols = [
                    r['symbol'] for r in rows
                    if r['symbol'] and (atm_strike == 0 or abs(r['strike'] - atm_strike) / atm_strike < 0.05)
                ]
                self.wss_clients[underlying].add_symbols(filtered_symbols[:400])

    async def _refresh_wss_symbols(self, underlying: str):
        """Refreshes the symbol map and adds to WSS clients using TV Scanner."""
        from backend.external.tv_options_scanner import fetch_option_chain
        data = await fetch_option_chain(underlying)

        if underlying not in self.symbol_map_cache: self.symbol_map_cache[underlying] = {}

        if not data: return

        all_symbols = []
        # Support both 'symbols' (TV Scanner) and 'chain' formats
        if 'symbols' in data:
            for item in data['symbols']:
                f = item.get('f', [])
                if len(f) < 4: continue
                symbol = f[0]
                strike = float(f[3])
                opt_type = str(f[2]).lower()
                all_symbols.append(symbol)
                self.symbol_map_cache[underlying][f"{strike}_{opt_type}"] = symbol
        elif 'chain' in data:
            for item in data['chain']:
                sym = item.get('instrument_key') or item.get('symbol')
                strike = item.get('strike')
                opt_type = str(item.get('option_type')).lower()
                if sym and strike:
                    all_symbols.append(sym)
                    self.symbol_map_cache[underlying][f"{strike}_{opt_type}"] = sym

        if all_symbols and underlying in self.wss_clients:
            self.wss_clients[underlying].add_symbols(list(set(all_symbols))[:400])

    async def _calculate_pcr(self, underlying, timestamp, rows, spot_price=0):
        calls = [r for r in rows if r['option_type'] == 'call']
        puts = [r for r in rows if r['option_type'] == 'put']
        tc_oi, tp_oi = sum(r['oi'] for r in calls), sum(r['oi'] for r in puts)
        tc_vol, tp_vol = sum(r['volume'] for r in calls), sum(r['volume'] for r in puts)
        tc_oi_chg, tp_oi_chg = sum(r['oi_change'] for r in calls), sum(r['oi_change'] for r in puts)

        db.insert_pcr_history({
            'timestamp': timestamp, 'underlying': underlying,
            'pcr_oi': tp_oi / tc_oi if tc_oi > 0 else 0,
            'pcr_vol': tp_vol / tc_vol if tc_vol > 0 else 0,
            'pcr_oi_change': tp_oi_chg / tc_oi_chg if tc_oi_chg != 0 else 0,
            'underlying_price': spot_price, 'max_pain': 0, # Simplify for now
            'spot_price': spot_price, 'total_oi': tc_oi + tp_oi, 'total_oi_change': tc_oi_chg + tp_oi_chg
        })

        avg_iv = sum(r.get('iv', 0) for r in rows) / len(rows) if rows else 0
        if underlying not in self.iv_history: self.iv_history[underlying] = []
        self.iv_history[underlying].append(avg_iv)
        self.iv_history[underlying] = self.iv_history[underlying][-252:]

    def get_chain_with_greeks(self, underlying: str) -> Dict[str, Any]:
        latest_ts_res = db.query("SELECT MAX(timestamp) as ts FROM options_snapshots WHERE underlying = ?", (underlying,))
        if not latest_ts_res or latest_ts_res[0]['ts'] is None: return {"chain": []}
        latest_ts = latest_ts_res[0]['ts']

        # Get spot price first for filtering
        spot_res = db.query("SELECT spot_price FROM pcr_history WHERE underlying = ? AND timestamp <= ? ORDER BY timestamp DESC LIMIT 1", (underlying, latest_ts))
        spot_price = spot_res[0]['spot_price'] if spot_res else 0
        if spot_price == 0:
            # Try to get very latest spot price synchronously (Layers 1 & 2)
            spot_price = self.get_spot_price_sync(underlying)

        # Query all strikes for the latest timestamp
        all_chain = db.query("SELECT * FROM options_snapshots WHERE underlying = ? AND timestamp = ? ORDER BY strike ASC", (underlying, latest_ts), json_serialize=True)

        # Filter to ATM ± 7 strikes
        if spot_price > 0 and all_chain:
            strikes = sorted(list(set(item['strike'] for item in all_chain)))
            # Find the closest strike to spot_price
            closest_strike = min(strikes, key=lambda x: abs(x - spot_price))
            idx = strikes.index(closest_strike)

            start_idx = max(0, idx - 7)
            end_idx = min(len(strikes) - 1, idx + 7)
            target_strikes = strikes[start_idx:end_idx + 1]

            chain = [item for item in all_chain if item['strike'] in target_strikes]
        else:
            chain = all_chain

        return {
            "timestamp": latest_ts,
            "chain": chain,
            "spot_price": spot_price,
            "source": chain[0].get('source', 'unknown') if chain else 'unknown'
        }

    def get_oi_buildup_analysis(self, underlying: str) -> Dict[str, Any]:
        return oi_buildup_analyzer.analyze_chain_buildup(self.get_chain_with_greeks(underlying).get('chain', []), self.previous_chains.get(underlying, []))

    def get_iv_analysis(self, underlying: str) -> Dict[str, Any]:
        iv = self.iv_history[underlying][-1] if underlying in self.iv_history and self.iv_history[underlying] else 20.0
        m = iv_analyzer.get_iv_metrics(underlying, iv)
        return {'current_iv': m.current_iv, 'iv_rank': m.iv_rank, 'iv_percentile': m.iv_percentile, 'signal': iv_analyzer.get_iv_signal(m.iv_rank, m.iv_percentile)}

    def get_support_resistance(self, underlying: str) -> Dict[str, Any]:
        return oi_buildup_analyzer.get_support_resistance_from_oi(self.get_chain_with_greeks(underlying).get('chain', []))

    async def get_genie_insights(self, underlying: str) -> Dict[str, Any]:
        res = self.get_chain_with_greeks(underlying)
        chain, spot = res.get('chain', []), res.get('spot_price', 0)
        control = oi_buildup_analyzer.detect_market_control(chain)
        return {"distribution": oi_buildup_analyzer.detect_institutional_distribution(chain, spot), "control": control, "sentiment": "BULLISH" if control == "BUYERS_IN_CONTROL" else "BEARISH" if control == "SELLERS_IN_CONTROL" else "NEUTRAL"}

    def get_high_activity_strikes(self, underlying: str) -> List[Dict[str, Any]]:
        """Identify strikes with highest volume in latest snapshot."""
        latest_ts_res = db.query("SELECT MAX(timestamp) as ts FROM options_snapshots WHERE underlying = ?", (underlying,))
        if not latest_ts_res or latest_ts_res[0]['ts'] is None: return []
        latest_ts = latest_ts_res[0]['ts']

        return db.query(
            "SELECT strike, SUM(volume) as total_volume FROM options_snapshots WHERE underlying = ? AND timestamp = ? GROUP BY strike ORDER BY total_volume DESC LIMIT 5",
            (underlying, latest_ts)
        )

    async def repair_zero_spot_prices(self):
        # Implementation remains similar but uses standardized hist provider
        pass

options_manager = OptionsManager()
