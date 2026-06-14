import httpx
import logging
from typing import Optional, List, Dict, Any

logger = logging.getLogger(__name__)

class TrendlyneAPI:
    FALLBACK_IDS = {
        'NIFTY': 1887,
        'NIFTY 50': 1887,
        'BANKNIFTY': 1898,
        'BANK NIFTY': 1898,
        'FINNIFTY': 1900,
        'FIN NIFTY': 1900
    }

    def __init__(self):
        self.base_url = "https://smartoptions.trendlyne.com/phoenix/api"
        self.headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": "https://smartoptions.trendlyne.com/smart-options/oi-analysis/NIFTY/",
            "Origin": "https://smartoptions.trendlyne.com",
            "Sec-Fetch-Dest": "empty",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Site": "same-origin"
        }
        self.stock_id_cache = {}

    async def get_stock_id(self, symbol: str) -> Optional[int]:
        # Clean symbol for lookup
        clean_symbol = symbol.upper().replace("NSE:", "").strip()

        if clean_symbol in self.FALLBACK_IDS:
            return self.FALLBACK_IDS[clean_symbol]

        if symbol in self.stock_id_cache:
            return self.stock_id_cache[symbol]

        url = f"{self.base_url}/search-contract-stock/"
        params = {'query': symbol.lower()}

        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(url, params=params, headers=self.headers, timeout=10)
                if response.status_code == 200:
                    data = response.json()
                    logger.debug(f"Trendlyne Search Response for {symbol}: {data}")
                    if data and 'body' in data and 'data' in data['body']:
                        stock_id = None
                        for item in data['body']['data']:
                            if item.get('stock_code', '').lower() == symbol.lower():
                                stock_id = item['stock_id']
                                break

                        # Fallback to first if no exact match (optional, but user requested exact)
                        if not stock_id and len(data['body']['data']) > 0:
                             # Just in case, let's log what we found
                             logger.warning(f"No exact stock_code match for {symbol}, found codes: {[i.get('stock_code') for i in data['body']['data']]}")

                        if stock_id:
                            self.stock_id_cache[symbol] = stock_id
                            return stock_id
        except Exception as e:
            logger.error(f"Error looking up stock ID for {symbol}: {e}")
        return None

    async def _make_request(self, url: str, params: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Helper for Trendlyne API requests with WAF bypass."""
        try:
            async with httpx.AsyncClient(http2=True, follow_redirects=True) as client:
                response = await client.get(url, params=params, headers=self.headers, timeout=20)
                if response.status_code == 200:
                    data = response.json()
                    # Check if head exists and status is 0 (Success)
                    if data and data.get('head', {}).get('status') in [0, "0"]:
                        return data
                    else:
                        logger.debug(f"Trendlyne API error response: {data.get('head', {}).get('statusDescription')}")
                else:
                    logger.debug(f"Trendlyne request failed with status {response.status_code}")
        except Exception as e:
            logger.error(f"Trendlyne request exception: {e}")
        return None

    async def get_expiry_dates(self, stock_id: int) -> List[str]:
        url = f"{self.base_url}/search-contract-expiry-dates/"
        params = {'stock_pk': stock_id}

        data = await self._make_request(url, params)
        if data and 'body' in data and 'data' in data['body']:
            return data['body']['data'].get('all_exp_list', [])
        return []

    async def get_oi_data(self, stock_id: int, expiry: str, max_time: str) -> Optional[Dict[str, Any]]:
        """
        Fetch OI data snapshot.
        max_time: HH:MM
        """
        url = f"{self.base_url}/live-oi-data/"
        params = {
            'stockId': stock_id,
            'expDateList': expiry,
            'minTime': "09:15",
            'maxTime': max_time,
            'format': 'json'
        }
        return await self._make_request(url, params)

trendlyne_api = TrendlyneAPI()
