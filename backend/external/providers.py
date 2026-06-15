import asyncio
import logging
from typing import Dict, Any, List, Optional, Callable
from datetime import datetime
from backend.core.interfaces import ILiveStreamProvider, IOptionsDataProvider, IHistoricalDataProvider
from backend.external.tv_live_wss import TradingViewWSS
from backend.external.tv_options_scanner import fetch_option_chain
from backend.external.trendlyne_api import trendlyne_api
from backend.external.nse_api import fetch_nse_oi_data
from backend.external.tv_api import tv_api

logger = logging.getLogger(__name__)

class TradingViewLiveStreamProvider(ILiveStreamProvider):
    """TradingView WebSocket Implementation."""
    def __init__(self, callback: Callable = None):
        self.wss = TradingViewWSS(callback)
        self.callback = callback

    def subscribe(self, symbols: List[str], interval: str = "1"):
        self.wss.subscribe(symbols, interval)

    def unsubscribe(self, symbol: str, interval: str = "1"):
        self.wss.unsubscribe(symbol, interval)

    def set_callback(self, callback: Callable):
        self.callback = callback
        self.wss.callback = callback

    def start(self):
        self.wss.start()

    def stop(self):
        self.wss.stop()

    def is_connected(self) -> bool:
        return self.wss.ws and self.wss.ws.sock and self.wss.ws.sock.connected


class TrendlyneOptionsProvider(IOptionsDataProvider):
    """Trendlyne API Implementation for Options data."""
    def __init__(self):
        self.symbol_map = {
            "NSE:NIFTY": "NIFTY 50",
            "NSE:BANKNIFTY": "BANKNIFTY",
            "NSE:FINNIFTY": "FINNIFTY"
        }

    async def get_option_chain(self, underlying: str) -> Dict[str, Any]:
        """Fetch chain from TV Scanner as Trendlyne only provides OI snapshots."""
        raw_chain = await fetch_option_chain(underlying)
        if not raw_chain or 'symbols' not in raw_chain:
            return {"underlying": underlying, "spot_price": 0, "chain": [], "source": "trendlyne"}

        # Standardize TV chain to unified format
        standardized_chain = []
        for item in raw_chain['symbols']:
            f = item['f']
            standardized_chain.append({
                "strike": float(f[3]),
                "option_type": str(f[2]).lower(),
                "instrument_key": f[0],
                "trading_symbol": f[0],
                "expiry": str(f[6]), # TV scanner expiration
                "ltp": float(f[5] or 0),
                "volume": int(f[4] or 0)
            })

        return {
            "underlying": underlying,
            "spot_price": 0, # scanner doesn't always have current spot
            "chain": standardized_chain,
            "source": "trendlyne"
        }

    async def get_expiry_dates(self, underlying: str) -> List[str]:
        tl_symbol = self.symbol_map.get(underlying, underlying.split(':')[-1])
        stock_id = await trendlyne_api.get_stock_id(tl_symbol)
        if stock_id:
            return await trendlyne_api.get_expiry_dates(stock_id)
        return []

    async def get_oi_data(self, underlying: str, expiry: str, time_str: str) -> Dict[str, Any]:
        """Fetch OI data and map to uniform OIDataSnapshot schema."""
        tl_symbol = self.symbol_map.get(underlying, underlying.split(':')[-1])
        stock_id = await trendlyne_api.get_stock_id(tl_symbol)
        if not stock_id:
            return {"timestamp": time_str, "oi_data": {}}

        data = await trendlyne_api.get_oi_data(stock_id, expiry, time_str)
        if not data or 'body' not in data:
            return {"timestamp": time_str, "oi_data": {}}

        # Trendlyne structure: body.oiData[strike_str] = {...} or body.data.oiData
        raw_oi = data['body'].get('oiData', {})
        if not raw_oi and 'data' in data['body']:
            raw_oi = data['body']['data'].get('oiData', {})

        if not raw_oi:
            return {"timestamp": time_str, "oi_data": {}}

        unified_oi = {}

        for strike, val in raw_oi.items():
            unified_oi[str(strike)] = {
                'callOi': int(val.get('callOi', 0)),
                'callOiChange': int(val.get('callOiChange', 0)),
                'callVol': int(val.get('callVol', 0)),
                'callLtp': float(val.get('callLtp', 0)),
                'putOi': int(val.get('putOi', 0)),
                'putOiChange': int(val.get('putOiChange', 0)),
                'putVol': int(val.get('putVol', 0)),
                'putLtp': float(val.get('putLtp', 0)),
            }

        return {
            "timestamp": data.get('head', {}).get('timestamp', time_str),
            "oi_data": unified_oi
        }


class NSEOptionsProvider(IOptionsDataProvider):
    """NSE India Direct Implementation for Options data."""
    async def get_option_chain(self, underlying: str) -> Dict[str, Any]:
        symbol = underlying.split(':')[-1]
        if symbol == "CNXFINANCE": symbol = "FINNIFTY"
        data = await asyncio.to_thread(fetch_nse_oi_data, symbol)

        if not data or 'records' not in data:
            return {"underlying": underlying, "spot_price": 0, "chain": [], "source": "nse"}

        standardized_chain = []
        spot_price = data.get('records', {}).get('underlyingValue', 0)

        for item in data.get('records', {}).get('data', []):
            for opt_type in ['CE', 'PE']:
                opt = item.get(opt_type)
                if opt:
                    standardized_chain.append({
                        "strike": float(opt['strikePrice']),
                        "option_type": opt_type.lower() == 'ce' and 'call' or 'put',
                        "instrument_key": opt['identifier'],
                        "trading_symbol": f"{symbol}{opt['expiryDate']}{opt['strikePrice']}{opt_type}",
                        "expiry": datetime.strptime(opt['expiryDate'], "%d-%b-%Y").strftime("%Y-%m-%d"),
                        "ltp": float(opt['lastPrice'] or 0),
                        "oi": int(opt['openInterest'] or 0),
                        "oi_change": int(opt['changeinOpenInterest'] or 0),
                        "volume": int(opt['totalTradedVolume'] or 0)
                    })

        return {
            "underlying": underlying,
            "spot_price": float(spot_price),
            "chain": standardized_chain,
            "source": "nse"
        }

    async def get_expiry_dates(self, underlying: str) -> List[str]:
        data = await asyncio.to_thread(fetch_nse_oi_data, underlying.split(':')[-1])
        if data and 'records' in data:
            raw_dates = data['records'].get('expiryDates', [])
            standard_dates = []
            for d in raw_dates:
                try:
                    dt = datetime.strptime(d, "%d-%b-%Y")
                    standard_dates.append(dt.strftime("%Y-%m-%d"))
                except:
                    standard_dates.append(d)
            return standard_dates
        return []

    async def get_oi_data(self, underlying: str, expiry: str, time_str: str) -> Dict[str, Any]:
        """NSE snapshot logic mapping to OIDataSnapshot schema."""
        symbol = underlying.split(':')[-1]
        data = await asyncio.to_thread(fetch_nse_oi_data, symbol)
        if not data: return {"timestamp": time_str, "oi_data": {}}

        oi_data = {}
        for item in data.get('filtered', {}).get('data', []):
            raw_exp = item.get('expiryDate')
            try:
                std_exp = datetime.strptime(raw_exp, "%d-%b-%Y").strftime("%Y-%m-%d")
            except:
                std_exp = raw_exp

            if std_exp == expiry:
                strike = str(item['strikePrice'])
                oi_data[strike] = {
                    'callOi': int(item.get('CE', {}).get('openInterest', 0)),
                    'callOiChange': int(item.get('CE', {}).get('changeinOpenInterest', 0)),
                    'callVol': int(item.get('CE', {}).get('totalTradedVolume', 0)),
                    'callLtp': float(item.get('CE', {}).get('lastPrice', 0)),
                    'putOi': int(item.get('PE', {}).get('openInterest', 0)),
                    'putOiChange': int(item.get('PE', {}).get('changeinOpenInterest', 0)),
                    'putVol': int(item.get('PE', {}).get('totalTradedVolume', 0)),
                    'putLtp': float(item.get('PE', {}).get('lastPrice', 0)),
                }
        return {
            "timestamp": time_str, # NSE direct doesn't provide historical snapshots easily
            "oi_data": oi_data
        }


class TradingViewHistoricalProvider(IHistoricalDataProvider):
    """TradingView Historical Data Implementation."""
    async def get_hist_candles(self, symbol: str, interval: str, count: int) -> List[List]:
        # Returns [ts, o, h, l, c, v] directly
        return await asyncio.to_thread(tv_api.get_hist_candles, symbol, interval, count)
