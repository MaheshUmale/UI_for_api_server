import asyncio
import logging
import json
import threading
import time
import requests
import gzip
import io
import os
import re
import pandas as pd
from typing import Dict, Any, List, Optional, Callable
from datetime import datetime
import upstox_client
from backend.core.interfaces import ILiveStreamProvider, IOptionsDataProvider, IHistoricalDataProvider
from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger(__name__)

# Provided Access Token from environment
UPSTOX_ACCESS_TOKEN = os.getenv("UPSTOX_ACCESS_TOKEN")

class UpstoxProvider(ILiveStreamProvider, IOptionsDataProvider, IHistoricalDataProvider):
    """
    Upstox Data Provider integrating live streaming, options data, and historical data.
    Implements the Active Zone (ATM ± 5 strikes) logic and schema-compliant methods.
    """

    def __init__(self, access_token: str = UPSTOX_ACCESS_TOKEN):
        self.access_token = access_token
        self.configuration = upstox_client.Configuration()
        self.configuration.access_token = access_token
        self.api_client = upstox_client.ApiClient(self.configuration)

        self.streamer = None
        self.callbacks = []
        self._subscribed_keys = set()
        self._running = False
        self._connected = False

        self.instruments_df = None
        self.last_update_time = 0
        self.symbol_mapping = {} # underlying -> {future: key, options: [...], all_keys: [...]}
        self.spot_prices = {}

    # --- ILiveStreamProvider Implementation ---

    def subscribe(self, symbols: List[str], interval: str = "1"):
        for sym in symbols:
            self._subscribed_keys.add(sym)

        if self.streamer and self._connected:
            self.streamer.subscribe(list(symbols), "full")
            logger.info(f"Upstox subscribed to: {symbols}")

    def unsubscribe(self, symbol: str, interval: str = "1"):
        if symbol in self._subscribed_keys:
            self._subscribed_keys.remove(symbol)
            if self.streamer and self._connected:
                self.streamer.unsubscribe([symbol])
                logger.info(f"Upstox unsubscribed from: {symbol}")

    def add_callback(self, callback: Callable[[Dict[str, Any]], None]):
        self.callbacks.append(callback)

    def set_callback(self, callback: Callable[[Dict[str, Any]], None]):
        self.add_callback(callback)

    def start(self):
        if self._running:
            return
        if not self.access_token:
            logger.error("Upstox Access Token missing. Cannot start streamer.")
            return
        self._running = True
        threading.Thread(target=self._run_streamer, daemon=True).start()
        logger.info("Upstox streamer thread started")

    def stop(self):
        self._running = False
        if self.streamer:
            self.streamer.disconnect()
        self._connected = False

    def is_connected(self) -> bool:
        return self._connected

    def _run_streamer(self):
        try:
            self.streamer = upstox_client.MarketDataStreamerV3(self.api_client)

            def on_message(message):
                parsed = self._parse_message(message)
                if parsed:
                    for cb in self.callbacks:
                        try:
                            cb(parsed)
                        except Exception as e:
                            logger.error(f"UpstoxProvider callback error: {e}")

            def on_open():
                self._connected = True
                logger.info("Upstox WebSocket connected")
                if self._subscribed_keys:
                    self.streamer.subscribe(list(self._subscribed_keys), "full")

            def on_error(error):
                logger.error(f"Upstox WebSocket error: {error}")
                self._connected = False

            def on_close(ws=None, code=None, reason=None):
                logger.info(f"Upstox WebSocket closed: {code} - {reason}")
                self._connected = False

            self.streamer.on("message", on_message)
            self.streamer.on("open", on_open)
            self.streamer.on("error", on_error)
            self.streamer.on("close", on_close)

            self.streamer.connect()

            while self._running:
                time.sleep(1)
        except Exception as e:
            logger.error(f"Error in Upstox streamer loop: {e}")
            self._connected = False

    def _parse_message(self, message) -> Optional[Dict[str, Any]]:
        try:
            data = json.loads(message) if isinstance(message, str) else message
            feeds = data.get("feeds", {}) if isinstance(data, dict) else getattr(data, "feeds", {})

            if not feeds:
                return None

            normalized_feeds = {}
            for key, tick in feeds.items():
                # Map Upstox key to standardized Technical Key (EXCHANGE:SYMBOL)
                tech_key = self._map_to_tech_key(key)
                if not tech_key:
                    continue

                full_feed = tick.get("fullFeed", {})
                market_ff = full_feed.get("marketFF")
                index_ff = full_feed.get("indexFF")

                tick_data = {
                    "last_price": 0,
                    "tv_volume": 0,
                    "oi": 0,
                    "coi": 0,
                    "ts_ms": int(time.time() * 1000),
                    "source": "upstox"
                }

                if index_ff:
                    ltpc = index_ff.get("ltpc", {})
                    price = float(ltpc.get("ltp", 0))

                    # Layer 1.3: Bad Tick Filtering (Rolling Median)
                    if not self._is_valid_tick(tech_key, price):
                        continue

                    tick_data["last_price"] = price

                    # Update internal spot price for Active Zone logic
                    symbol_name = tech_key.split(':')[-1]
                    if symbol_name in ["NIFTY", "BANKNIFTY", "FINNIFTY"]:
                        self.spot_prices[symbol_name] = tick_data["last_price"]

                elif market_ff:
                    ltpc = market_ff.get("ltpc", {})
                    price = float(ltpc.get("ltp", 0))

                    # Layer 1.3: Bad Tick Filtering
                    if not self._is_valid_tick(tech_key, price):
                        continue

                    tick_data["last_price"] = price
                    tick_data["tv_volume"] = float(market_ff.get("vtt", 0))
                    tick_data["oi"] = int(market_ff.get("oi", 0))
                    tick_data["coi"] = int(market_ff.get("coi", 0))

                normalized_feeds[tech_key] = tick_data

            return {
                "type": "live_feed",
                "feeds": normalized_feeds
            }
        except Exception as e:
            logger.error(f"Upstox message parsing error: {e}")
            return None

    # --- IOptionsDataProvider Implementation ---

    async def get_expiry_dates(self, underlying: str) -> List[str]:
        if not self.access_token:
            return []

        symbol_name = underlying.split(':')[-1]
        instrument_key = f"NSE_INDEX|{self._get_index_name(symbol_name)}"

        api = upstox_client.OptionsApi(self.api_client)
        try:
            res = await asyncio.to_thread(api.get_option_contracts, instrument_key=instrument_key)
            if res.data:
                expiries = sorted(list(set(c.expiry for c in res.data if c.expiry)))
                return [d.strftime('%Y-%m-%d') for d in expiries]
        except Exception as e:
            logger.error(f"Upstox get_expiry_dates failed for {underlying}: {e}")

        mapping = await self._get_active_zone_mapping(underlying)
        if mapping and "expiry" in mapping:
            return [mapping["expiry"]]
        return []

    async def get_option_chain(self, underlying: str) -> Dict[str, Any]:
        mapping = await self._get_active_zone_mapping(underlying)
        if not mapping:
            return {"underlying": underlying, "spot_price": 0, "chain": [], "source": "upstox"}

        chain = []
        for opt in mapping.get("options", []):
            # Call side
            chain.append({
                "strike": opt["strike"],
                "option_type": "call",
                "instrument_key": opt["ce"],
                "trading_symbol": opt["ce_trading_symbol"],
                "expiry": mapping["expiry"]
            })
            # Put side
            chain.append({
                "strike": opt["strike"],
                "option_type": "put",
                "instrument_key": opt["pe"],
                "trading_symbol": opt["pe_trading_symbol"],
                "expiry": mapping["expiry"]
            })

        symbol = underlying.split(':')[-1]
        return {
            "underlying": underlying,
            "spot_price": self.spot_prices.get(symbol, 0),
            "chain": chain,
            "source": "upstox"
        }

    async def get_oi_data(self, underlying: str, expiry: str, time_str: str) -> Dict[str, Any]:
        """Fetch OI data using Upstox Option Chain API."""
        if not self.access_token:
            return {"timestamp": time_str, "oi_data": {}}

        symbol_name = underlying.split(':')[-1]
        instrument_key = f"NSE_INDEX|{self._get_index_name(symbol_name)}"

        api = upstox_client.OptionsApi(self.api_client)
        try:
            res = await asyncio.to_thread(
                api.get_put_call_option_chain,
                instrument_key=instrument_key,
                expiry_date=expiry
            )

            if not res.data:
                return {"timestamp": time_str, "oi_data": {}}

            unified_oi = {}
            for item in res.data:
                strike = str(float(item.strike_price))

                # Upstox OptionChain API v2 sometimes includes oi_change in market_data
                c_md = item.call_options.market_data if item.call_options else None
                p_md = item.put_options.market_data if item.put_options else None

                # Calculate OI change from prev_oi if available
                call_oi = int(getattr(c_md, 'oi', 0)) if c_md else 0
                call_prev_oi = int(getattr(c_md, 'prev_oi', 0)) if c_md else 0
                call_oi_chg = call_oi - call_prev_oi if call_prev_oi > 0 else 0

                put_oi = int(getattr(p_md, 'oi', 0)) if p_md else 0
                put_prev_oi = int(getattr(p_md, 'prev_oi', 0)) if p_md else 0
                put_oi_chg = put_oi - put_prev_oi if put_prev_oi > 0 else 0

                unified_oi[strike] = {
                    'callOi': call_oi,
                    'callOiChange': call_oi_chg,
                    'callVol': int(getattr(c_md, 'volume', 0)) if c_md else 0,
                    'callLtp': float(getattr(c_md, 'ltp', 0)) if c_md else 0,
                    'putOi': put_oi,
                    'putOiChange': put_oi_chg,
                    'putVol': int(getattr(p_md, 'volume', 0)) if p_md else 0,
                    'putLtp': float(getattr(p_md, 'ltp', 0)) if p_md else 0,
                }

            return {
                "timestamp": datetime.now().isoformat(),
                "oi_data": unified_oi,
                "source": "upstox"
            }
        except Exception as e:
            logger.error(f"Upstox get_oi_data failed for {underlying}: {e}")
            return {"timestamp": time_str, "oi_data": {}}

    # --- IHistoricalDataProvider Implementation ---

    async def get_hist_candles(self, symbol: str, interval: str, count: int) -> List[List]:
        """Fetch historical candles from Upstox API and return in unified [ts, o, h, l, c, v] format."""
        if not self.access_token:
            logger.debug(f"Upstox token missing, skipping hist fetch for {symbol}")
            return []

        api = upstox_client.HistoryApi(self.api_client)
        # Upstox expects 1minute, 30minute, etc.
        upstox_interval = f"{interval}minute" if interval.isdigit() else "day"

        try:
            # Module U: Robust Instrument Key Resolution
            instrument_key = await self._resolve_instrument_key(symbol)
            if not instrument_key:
                logger.warning(f"Could not resolve Upstox key for {symbol}")
                return []

            # Try intra-day first
            try:
                res = await asyncio.to_thread(
                    api.get_intra_day_candle_data,
                    instrument_key=instrument_key,
                    interval=upstox_interval,
                    api_version="v2"
                )
                if not res.data or not getattr(res.data, 'candles', None):
                    raise ValueError("No intra-day candles")
            except Exception as e:
                logger.debug(f"Upstox intra-day fetch failed for {symbol}, trying historical: {e}")
                to_date = datetime.now().strftime('%Y-%m-%d')
                res = await asyncio.to_thread(
                    api.get_historical_candle_data,
                    instrument_key=instrument_key,
                    interval=upstox_interval,
                    to_date=to_date,
                    api_version="v2"
                )

            # Upstox returns [[ts, o, h, l, c, v, oi], ...]
            # We need to ensure ts is in seconds and only return 6 fields
            unified = []
            data = getattr(res.data, 'candles', [])
            if not data:
                return []

            for c in data[:count]:
                ts_iso = c[0]
                # Convert ISO to seconds
                # Upstox ISO format: '2026-06-12T15:29:00+05:30'
                ts_sec = int(datetime.fromisoformat(ts_iso.replace('Z', '+00:00')).timestamp())
                unified.append([ts_sec, float(c[1]), float(c[2]), float(c[3]), float(c[4]), int(c[5])])

            return unified
        except Exception as e:
            logger.error(f"Upstox historical fetch failed for {symbol}: {e}")
            return []

    # --- Helper Methods for Active Zone Logic ---

    async def _get_active_zone_mapping(self, underlying: str):
        symbol = underlying.split(':')[-1]
        if symbol not in ["NIFTY", "BANKNIFTY", "FINNIFTY"]:
            return None

        now = time.time()
        # Refresh instruments every 1 hour
        if self.instruments_df is None or (now - self.last_update_time) > 3600:
            await self._download_instruments()

        spot = self.spot_prices.get(symbol, 0)
        if spot == 0:
            # Try to fetch latest spot via API
            spot = await self._fetch_ltp(f"NSE_INDEX|{self._get_index_name(symbol)}")
            if spot:
                self.spot_prices[symbol] = spot

        if spot == 0:
            return self.symbol_mapping.get(symbol)

        # Recalculate mapping based on current spot
        return self._build_active_zone(symbol, spot)

    async def _download_instruments(self):
        logger.info("Downloading Upstox master instrument files (NSE & NFO)...")
        exchanges = ["NSE", "NFO"]
        dfs = []

        for exch in exchanges:
            url = f"https://assets.upstox.com/market-quote/instruments/exchange/{exch}.json.gz"
            try:
                logger.debug(f"Fetching {exch} master from {url}")
                response = await asyncio.to_thread(requests.get, url, timeout=20)
                if response.status_code == 200:
                    with gzip.GzipFile(fileobj=io.BytesIO(response.content)) as f:
                        df = pd.read_json(f)
                        dfs.append(df)
                    logger.debug(f"Successfully loaded {exch} master")
                else:
                    logger.warning(f"Failed to download {exch} master: HTTP {response.status_code}")
            except Exception as e:
                logger.error(f"Error downloading {exch} master: {e}")

        if dfs:
            self.instruments_df = pd.concat(dfs, ignore_index=True)
            self.last_update_time = time.time()
            logger.info(f"Upstox instrument master updated: {len(self.instruments_df)} symbols loaded")

    def _get_index_name(self, symbol: str) -> str:
        if symbol == "NIFTY": return "Nifty 50"
        if symbol == "BANKNIFTY": return "Nifty Bank"
        if symbol == "FINNIFTY": return "Nifty Fin Service"
        return symbol

    async def _resolve_instrument_key(self, symbol: str) -> Optional[str]:
        """
        Resolves a symbol (HRN, Tech Key, or TV-style option) to a valid Upstox key.
        Handles TV-style options: NIFTY260612P23300 -> NSE_FO|XXXXX
        """
        # 1. Direct standard keys
        if "NSE_INDEX|" in symbol or "NSE_FO|" in symbol:
            return symbol

        # 2. Handle Indices
        base_sym = symbol.split(':')[-1]
        if base_sym in ["NIFTY", "BANKNIFTY", "FINNIFTY"]:
            return f"NSE_INDEX|{self._get_index_name(base_sym)}"

        # 3. Handle TV-style Options (e.g. NIFTY260612P23300)
        # Pattern: <UNDERLYING><YYMMDD><C/P><STRIKE>
        opt_match = re.match(r"^(NIFTY|BANKNIFTY|FINNIFTY)(\d{6})([CP])(\d+)$", base_sym)
        if opt_match:
            underlying, expiry_str, opt_type, strike = opt_match.groups()

            # Ensure master data is loaded
            if self.instruments_df is None:
                await self._download_instruments()

            if self.instruments_df is not None:
                try:
                    # Convert TV expiry (YYMMDD) to date
                    exp_date = datetime.strptime(expiry_str, "%y%m%d").date()

                    # Map underlying to Upstox instrument name
                    upstox_name = underlying
                    if underlying == "NIFTY": upstox_name = "NIFTY 50"
                    elif underlying == "BANKNIFTY": upstox_name = "NIFTY BANK"
                    elif underlying == "FINNIFTY": upstox_name = "NIFTY FIN SERVICE"

                    # Search in instruments_df
                    # We also check trading_symbol as a fallback
                    mask = ((self.instruments_df['name'] == upstox_name) | (self.instruments_df['name'] == underlying)) & \
                           (self.instruments_df['strike_price'] == float(strike)) & \
                           (self.instruments_df['instrument_type'] == ('CE' if opt_type == 'C' else 'PE'))

                    matches = self.instruments_df[mask]
                    if not matches.empty:
                        # Find closest expiry
                        matches = matches.copy()
                        matches['exp_dt'] = pd.to_datetime(matches['expiry'], origin='unix', unit='ms').dt.date
                        best_match = matches[matches['exp_dt'] == exp_date]

                        if not best_match.empty:
                            return str(best_match.iloc[0]['instrument_key'])
                except Exception as e:
                    logger.error(f"Option resolution error: {e}")

        # 4. Fallback: try reverse mapping if already discovered
        for underlying, mapping in self.symbol_mapping.items():
             # Check all options in mapping
             for opt in mapping.get('options', []):
                 if opt['ce_trading_symbol'] == base_sym: return opt['ce']
                 if opt['pe_trading_symbol'] == base_sym: return opt['pe']

        # 5. Last resort: simple replacement
        return symbol.replace(':', '|')

    async def _fetch_ltp(self, instrument_key: str) -> float:
        if not self.access_token:
            return 0

        api = upstox_client.MarketQuoteV3Api(self.api_client)
        try:
            res = await asyncio.to_thread(api.get_ltp, instrument_key=instrument_key)
            data = res.data if isinstance(res.data, dict) else getattr(res, "data", {})
            # Normalized key in response might be different (e.g. pipe to colon)
            # Try both original and normalized keys
            val = data.get(instrument_key) or data.get(instrument_key.replace("|", ":"))
            if val:
                return float(val.last_price if hasattr(val, 'last_price') else val.get('last_price', 0))
        except Exception as e:
            logger.error(f"Error fetching LTP for {instrument_key}: {e}")
        return 0

    def _map_to_tech_key(self, upstox_key: str) -> Optional[str]:
        """Maps Upstox internal key to technical key EXCHANGE:SYMBOL."""
        # 1. Handle common indices
        if "NIFTY 50" in upstox_key.upper(): return "NSE:NIFTY"
        if "NIFTY BANK" in upstox_key.upper(): return "NSE:BANKNIFTY"
        if "NIFTY FIN" in upstox_key.upper() or "CNX FIN" in upstox_key.upper(): return "NSE:FINNIFTY"

        # 2. Handle FO / Equity if we have mapping
        # Try reverse lookup in symbol_mapping if it's an option id
        for symbol, mapping in self.symbol_mapping.items():
            if upstox_key in mapping.get('all_keys', []):
                # Search for specific trading symbol
                for opt in mapping.get('options', []):
                    if opt['ce'] == upstox_key: return f"NSE:{opt['ce_trading_symbol']}"
                    if opt['pe'] == upstox_key: return f"NSE:{opt['pe_trading_symbol']}"
                if mapping.get('future') == upstox_key: return f"NSE:{symbol}FUT"

        # 3. Fallback for Equities (e.g. NSE_EQ|RELIANCE)
        if "|" in upstox_key:
            parts = upstox_key.split('|')
            exchange = "NSE" # Default
            if "BSE" in parts[0]: exchange = "BSE"
            return f"{exchange}:{parts[-1]}"

        return upstox_key.replace('|', ':')

    def _is_valid_tick(self, instrument_key: str, price: float) -> bool:
        """Layer 1.3: Data Cleansing via Rolling Median filter."""
        if price <= 0: return False

        if not hasattr(self, '_tick_buffers'):
            self._tick_buffers = {}

        if instrument_key not in self._tick_buffers:
            self._tick_buffers[instrument_key] = []

        buffer = self._tick_buffers[instrument_key]
        if len(buffer) < 20:
            buffer.append(price)
            return True

        import numpy as np
        median = np.median(buffer)

        # Tolerance: 2% deviation for index, 5% for options
        threshold = 0.02 if "INDEX" in instrument_key.upper() else 0.05

        if abs(price - median) / median > threshold:
            logger.warning(f"Bad Tick Filtered: {instrument_key} @ {price} (Median: {median})")
            return False

        buffer.append(price)
        if len(buffer) > 20:
            buffer.pop(0)
        return True

    def _build_active_zone(self, symbol: str, spot: float):
        if self.instruments_df is None: return None

        df = self.instruments_df
        # --- 1. Current Month Future ---
        fut_df = df[(df['name'] == symbol) & (df['instrument_type'] == 'FUT')].sort_values(by='expiry')
        if fut_df.empty:
            current_fut_key = None
        else:
            current_fut_key = str(fut_df.iloc[0]['instrument_key'])

        # --- 2. Nearest Expiry Options ---
        opt_df = df[(df['name'] == symbol) & (df['instrument_type'].isin(['CE', 'PE']))].copy()
        if opt_df.empty: return None

        opt_df['expiry'] = pd.to_datetime(opt_df['expiry'], origin='unix', unit='ms')
        nearest_expiry = opt_df['expiry'].min()
        near_opt_df = opt_df[opt_df['expiry'] == nearest_expiry]

        # --- 3. Identify the 11 Strikes (ATM ± 5) ---
        unique_strikes = sorted(near_opt_df['strike_price'].unique())
        atm_strike = min(unique_strikes, key=lambda x: abs(x - spot))
        atm_index = unique_strikes.index(atm_strike)

        start_idx = max(0, atm_index - 5)
        end_idx = min(len(unique_strikes), atm_index + 6)
        selected_strikes = unique_strikes[start_idx : end_idx]

        option_keys = []
        for strike in selected_strikes:
            ce_rows = near_opt_df[(near_opt_df['strike_price'] == strike) & (near_opt_df['instrument_type'] == 'CE')]
            pe_rows = near_opt_df[(near_opt_df['strike_price'] == strike) & (near_opt_df['instrument_type'] == 'PE')]

            if ce_rows.empty or pe_rows.empty:
                continue

            option_keys.append({
                "strike": float(strike),
                "ce": str(ce_rows['instrument_key'].values[0]),
                "ce_trading_symbol" : str(ce_rows['trading_symbol'].values[0]),
                "pe": str(pe_rows['instrument_key'].values[0]),
                "pe_trading_symbol" : str(pe_rows['trading_symbol'].values[0])
            })

        mapping = {
            "future": current_fut_key,
            "expiry": nearest_expiry.strftime('%Y-%m-%d'),
            "options": option_keys,
            "all_keys": ([current_fut_key] if current_fut_key else []) +
                        [opt['ce'] for opt in option_keys] + [opt['pe'] for opt in option_keys]
        }
        self.symbol_mapping[symbol] = mapping
        return mapping
