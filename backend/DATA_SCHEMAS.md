# PRODESK Unified Data Schemas

To ensure consistency across multiple data sources (Upstox, NSE, Trendlyne, TradingView), all providers MUST adhere to the following internal schemas.

## 1. Option Chain Schema
Returned by `IOptionsDataProvider.get_option_chain(underlying)`.

```python
{
    "underlying": str,        # e.g., "NSE:NIFTY"
    "spot_price": float,      # Current spot price (0 if unknown)
    "source": str,            # Provider name (e.g., "upstox", "tradingview")
    "chain": [
        {
            "strike": float,
            "option_type": "call" | "put",
            "instrument_key": str,    # Provider-specific key
            "trading_symbol": str,    # Human-readable symbol
            "expiry": "YYYY-MM-DD",
            "ltp": float,             # Optional: current premium
            "oi": int,                # Optional: current OI
            "oi_change": int,         # Optional: current OI change
            "volume": int             # Optional: current Volume
        },
        ...
    ]
}
```

## 2. OI Data Snapshot Schema
Returned by `IOptionsDataProvider.get_oi_data(underlying, expiry, time_str)`.

```python
{
    "timestamp": "ISO-8601",  # Optional: snapshot time
    "oi_data": {
        "strike_price": {     # Key is string representation of strike
            "callOi": int,
            "callOiChange": int,
            "callVol": int,
            "callLtp": float,
            "putOi": int,
            "putOiChange": int,
            "putVol": int,
            "putLtp": float
        },
        ...
    }
}
```

## 3. Historical Candles Schema
Returned by `IHistoricalDataProvider.get_hist_candles(symbol, interval, count)`.

A list of lists, where each sub-list represents one candle:
`[timestamp_seconds, open, high, low, close, volume]`

Example:
`[[1780550400, 22100.5, 22120.0, 22090.0, 22115.0, 50000], ...]`

## 4. Live Tick Schema
Normalized by `ILiveStreamProvider` callback.

```python
{
    "type": "live_feed",
    "feeds": {
        "instrument_key": {
            "last_price": float,
            "tv_volume": float, # Cumulative daily volume
            "ltq": int,         # Last traded quantity (diff)
            "oi": int,
            "coi": int,         # Change in OI
            "ts_ms": int,       # Millisecond timestamp
            "source": str
        }
    }
}
```
