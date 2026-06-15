# External API Documentation

Source: `backend/api_server.py`
Base URL: `http://localhost:3000`
Authentication: none configured
Live OpenAPI contract: `GET /docs` and `GET /openapi.json`

This document is intended for the Integration team. It describes the external HTTP and Socket.IO contracts exposed by `backend/api_server.py`, including purpose, signature, input, and output shape.

## Notes for Integration Team

- The server exposes both REST/HTTP APIs and Socket.IO real-time events.
- `GET /api/tv/status` is registered twice in the source file. The first registration wins, so the effective response is the legacy static TradingView status payload.
- Query parameters are URL encoded.
- JSON request bodies should use `Content-Type: application/json`.
- Output examples are representative and may include additional fields depending on provider data, database state, or analysis modules.

---

# HTTP API Reference

## Health

### `GET /health`

**Purpose:** Service liveness and API version check.

**Signature:**

```http
GET /health
```

**Input:**

None.

**Output:**

```json
{
  "status": "healthy",
  "version": "2.0-enhanced"
}
```

---

## TradingView APIs

### `GET /api/tv/status`

**Purpose:** Return TradingView status for UI compatibility.

**Signature:**

```http
GET /api/tv/status
```

**Input:**

None.

**Output:**

```json
{
  "system_health": {
    "overall_health": 95,
    "recommendations": ["All systems normal"]
  },
  "is_running": true,
  "connections": {
    "active": 3,
    "total": 3
  },
  "cache": {
    "usage_percentage": 12.5
  },
  "quality_metrics": {
    "current_metrics": {
      "completeness_rate": 0.98,
      "accuracy_rate": 0.97
    }
  },
  "performance_metrics": {
    "avg_response_time_ms": 45,
    "requests_per_second": 120,
    "error_rate": 0.001
  }
}
```

### `GET /api/tv/search`

**Purpose:** Proxy TradingView symbol search and merge locally discovered option-chain symbols.

**Signature:**

```http
GET /api/tv/search?text=NSE:NIFTY
```

**Input:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `text` | string | Yes | Search text, optionally prefixed with exchange such as `NSE:NIFTY`. |

**Output:**

```json
{
  "symbols": [
    {
      "symbol": "NIFTY",
      "description": "NIFTY",
      "exchange": "NSE",
      "type": "index"
    },
    {
      "symbol": "NIFTY24JUN22000CE",
      "description": "NIFTY24JUN22000CE Option",
      "exchange": "NSE",
      "type": "option"
    }
  ]
}
```

### `GET /api/tv/options`

**Purpose:** Return TradingView option symbols for an underlying.

**Signature:**

```http
GET /api/tv/options?underlying=NIFTY
```

**Input:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `underlying` | string | Yes | Underlying symbol, for example `NIFTY`, `BANKNIFTY`, or `FINNIFTY`. |

**Output:**

```json
{
  "symbols": [
    {
      "symbol": "NIFTY24JUN22000CE",
      "description": "NIFTY24JUN22000CE Option",
      "exchange": "NSE",
      "type": "option"
    }
  ]
}
```

### `GET /api/tv/intraday/{instrument_key}`

**Purpose:** Fetch TradingView intraday candles and calculated overlay indicators.

**Signature:**

```http
GET /api/tv/intraday/NSE:NIFTY?interval=1
```

**Input:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `instrument_key` | string | Yes | TradingView instrument key, for example `NSE:NIFTY`. |
| `interval` | string | No | TradingView interval. Defaults to `1`. |

**Output:**

```json
{
  "instrumentKey": "NSE:NIFTY",
  "hrn": "NIFTY",
  "candles": [
    [1718352000, 22600, 22650, 22580, 22640, 1000]
  ],
  "indicators": [
    {
      "id": "ema_9",
      "title": "EMA 9",
      "type": "line",
      "style": {
        "color": "#3b82f6",
        "lineWidth": 1
      },
      "data": [
        {
          "time": 1718352000,
          "value": 22625.5
        }
      ]
    },
    {
      "id": "psych_signals",
      "type": "markers",
      "title": "Psychology Signals",
      "data": [
        {
          "time": 1718352000,
          "position": "belowBar",
          "color": "#22c55e",
          "shape": "arrowUp",
          "text": "LONG"
        }
      ]
    }
  ]
}
```

---

## Options APIs

### `GET /api/options/chain/{underlying}`

**Purpose:** Return the latest option chain enriched with calculated Greeks.

**Signature:**

```http
GET /api/options/chain/NIFTY
```

**Input:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `underlying` | string | Yes | Underlying symbol, for example `NIFTY`. |

**Output:**

```json
{
  "underlying": "NIFTY",
  "chain": [
    {
      "strike": 22000,
      "expiry": "2026-06-25",
      "option_type": "call",
      "ltp": 120.5,
      "oi": 150000,
      "volume": 25000,
      "delta": 0.55,
      "gamma": 0.002,
      "theta": -8.5,
      "vega": 12.1,
      "iv": 0.18
    }
  ],
  "source": "local_chain"
}
```

### `GET /api/options/chain/{underlying}/with-greeks`

**Purpose:** Return option-chain rows with spot-derived moneyness and distance from ATM.

**Signature:**

```http
GET /api/options/chain/NIFTY/with-greeks?spot_price=22150
```

**Input:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `underlying` | string | Yes | Underlying symbol. |
| `spot_price` | number | No | Override spot price. If omitted, server discovers spot price. |

**Output:**

```json
{
  "underlying": "NIFTY",
  "spot_price": 22150,
  "chain": [
    {
      "strike": 22000,
      "expiry": "2026-06-25",
      "option_type": "call",
      "ltp": 120.5,
      "moneyness": "ITM",
      "distance_from_atm_pct": 0.68
    }
  ],
  "source": "local_chain"
}
```

### `GET /api/options/greeks/{underlying}`

**Purpose:** Calculate Black-Scholes Greeks for one option contract.

**Signature:**

```http
GET /api/options/greeks/NIFTY?strike=22000&option_type=call&expiry=2026-06-25&spot_price=22150&option_price=120.5
```

**Input:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `underlying` | string | Yes | Underlying symbol. |
| `strike` | number | Yes | Option strike price. |
| `option_type` | string | Yes | `call` or `put`. |
| `expiry` | string | No | Expiry date. ISO date or ISO datetime accepted. |
| `spot_price` | number | No | Override spot price. |
| `option_price` | number | No | Option premium used to estimate implied volatility. |

**Output:**

```json
{
  "underlying": "NIFTY",
  "spot_price": 22150,
  "strike": 22000,
  "option_type": "call",
  "expiry": "2026-06-25",
  "delta": 0.55,
  "gamma": 0.002,
  "theta": -8.5,
  "vega": 12.1,
  "iv": 0.18
}
```

### `GET /api/options/oi-buildup/{underlying}`

**Purpose:** Return OI buildup signals and strike-level OI changes.

**Signature:**

```http
GET /api/options/oi-buildup/NIFTY
```

**Input:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `underlying` | string | Yes | Underlying symbol. |

**Output:**

```json
{
  "underlying": "NIFTY",
  "signals": [
    {
      "strike": 22000,
      "option_type": "call",
      "oi_change": 12000,
      "signal": "short_buildup"
    }
  ]
}
```

### `GET /api/options/iv-analysis/{underlying}`

**Purpose:** Return implied-volatility analysis for the underlying's option chain.

**Signature:**

```http
GET /api/options/iv-analysis/NIFTY
```

**Input:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `underlying` | string | Yes | Underlying symbol. |

**Output:**

```json
{
  "underlying": "NIFTY",
  "iv_rank": 42.5,
  "iv_percentile": 55.0,
  "analysis": [
    {
      "strike": 22000,
      "option_type": "call",
      "iv": 0.18
    }
  ]
}
```

### `GET /api/options/support-resistance/{underlying}`

**Purpose:** Return OI-derived support and resistance levels.

**Signature:**

```http
GET /api/options/support-resistance/NIFTY?top_n=3
```

**Input:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `underlying` | string | Yes | Underlying symbol. |
| `top_n` | integer | No | Number of levels to return. Defaults to `3`, range `1` to `10`. |

**Output:**

```json
{
  "underlying": "NIFTY",
  "support": [
    {
      "strike": 21800,
      "oi": 900000
    }
  ],
  "resistance": [
    {
      "strike": 22400,
      "oi": 1000000
    }
  ]
}
```

### `GET /api/options/genie-insights/{underlying}`

**Purpose:** Return consolidated Genie insights for the options dashboard.

**Signature:**

```http
GET /api/options/genie-insights/NIFTY
```

**Input:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `underlying` | string | Yes | Underlying symbol. |

**Output:**

```json
{
  "underlying": "NIFTY",
  "insights": [
    {
      "type": "trend",
      "message": "Call OI buildup observed near 22400."
    }
  ]
}
```

### `GET /api/options/high-activity/{underlying}`

**Purpose:** Return high-activity option strikes through the Greeks-enriched chain.

**Signature:**

```http
GET /api/options/high-activity/NIFTY
```

**Input:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `underlying` | string | Yes | Underlying symbol. |

**Output:**

```json
{
  "underlying": "NIFTY",
  "chain": [
    {
      "strike": 22000,
      "expiry": "2026-06-25",
      "option_type": "call",
      "volume": 25000,
      "oi": 150000
    }
  ]
}
```

### `GET /api/options/pcr-trend/{underlying}`

**Purpose:** Return current-day PCR history for trend analysis.

**Signature:**

```http
GET /api/options/pcr-trend/NIFTY
```

**Input:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `underlying` | string | Yes | Underlying symbol. |

**Output:**

```json
{
  "history": [
    {
      "timestamp": "2026-06-14T09:20:00+05:30",
      "pcr_oi": 0.92,
      "pcr_vol": 1.05,
      "pcr_oi_change": 0.03,
      "underlying_price": 22150,
      "max_pain": 22000,
      "spot_price": 22150,
      "total_oi": 2500000,
      "total_oi_change": 50000
    }
  ]
}
```

### `GET /api/options/full-history/{underlying}`

**Purpose:** Return current-day PCR and option snapshots for historical replay.

**Signature:**

```http
GET /api/options/full-history/NIFTY
```

**Input:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `underlying` | string | Yes | Underlying symbol. |

**Output:**

```json
{
  "pcr_history": [
    {
      "timestamp": "2026-06-14T09:20:00+05:30",
      "pcr_oi": 0.92
    }
  ],
  "snapshots": [
    {
      "timestamp": "2026-06-14T09:20:00+05:30",
      "strike": 22000,
      "option_type": "call",
      "oi": 150000,
      "oi_change": 12000,
      "volume": 25000,
      "ltp": 120.5,
      "iv": 0.18,
      "delta": 0.55,
      "theta": -8.5
    }
  ]
}
```

### `GET /api/options/summary`

**Purpose:** Return latest option-chain summary metrics for an underlying.

**Signature:**

```http
GET /api/options/summary?underlying=NIFTY
```

**Input:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `underlying` | string | Yes | Underlying symbol. |

**Output:**

```json
{
  "underlying": "NIFTY",
  "timestamp": "2026-06-14T15:20:00+05:30",
  "summary": {
    "total_strikes": 40,
    "total_contracts": 80,
    "total_call_oi": 1200000,
    "total_put_oi": 1100000,
    "total_call_volume": 250000,
    "total_put_volume": 230000,
    "source": "local_db"
  },
  "pcr": 0.92
}
```

### `GET /api/options/oi-analysis/{underlying}`

**Purpose:** Return latest per-strike OI distribution for an underlying.

**Signature:**

```http
GET /api/options/oi-analysis/NIFTY
```

**Input:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `underlying` | string | Yes | Underlying symbol. |

**Output:**

```json
{
  "timestamp": "2026-06-14T15:20:00+05:30",
  "data": [
    {
      "strike": 22000,
      "call_oi": 150000,
      "put_oi": 180000,
      "call_oi_change": 12000,
      "put_oi_change": -8000,
      "call_volume": 25000,
      "put_volume": 21000,
      "source": "local_db"
    }
  ]
}
```

### `POST /api/options/backfill`

**Purpose:** Start a background task to backfill today's options data.

**Signature:**

```http
POST /api/options/backfill
```

**Input:**

No body required.

**Output:**

```json
{
  "status": "success",
  "message": "Backfill task started"
}
```

---

## Strategy APIs

### `POST /api/strategy/build`

**Purpose:** Build and analyze a custom strategy from request-supplied legs.

**Signature:**

```http
POST /api/strategy/build
```

**Input:**

```json
{
  "name": "Custom Strategy",
  "strategy_type": "CUSTOM",
  "underlying": "NIFTY",
  "spot_price": 22150,
  "legs": [
    {
      "option_type": "call",
      "strike": 22000,
      "action": "buy",
      "quantity": 1,
      "premium": 120.5,
      "expiry": "2026-06-25"
    }
  ]
}
```

**Output:**

```json
{
  "status": "success",
  "strategy_id": "Custom Strategy",
  "analysis": {
    "max_profit": 0,
    "max_loss": 0,
    "breakeven": [22120.5]
  }
}
```

### `POST /api/strategy/bull-call-spread`

**Purpose:** Create and analyze a bull call spread.

**Signature:**

```http
POST /api/strategy/bull-call-spread
```

**Input:**

```json
{
  "underlying": "NIFTY",
  "spot_price": 22150,
  "lower_strike": 22000,
  "higher_strike": 22400,
  "lower_premium": 120.5,
  "higher_premium": 40.0,
  "expiry": "2026-06-25",
  "quantity": 1
}
```

**Output:**

```json
{
  "status": "success",
  "strategy_id": "Bull Call Spread",
  "analysis": {
    "max_profit": 0,
    "max_loss": 0,
    "breakeven": [22080.5]
  }
}
```

### `POST /api/strategy/iron-condor`

**Purpose:** Create and analyze an iron condor.

**Signature:**

```http
POST /api/strategy/iron-condor
```

**Input:**

```json
{
  "underlying": "NIFTY",
  "spot_price": 22150,
  "put_sell_strike": 21800,
  "put_buy_strike": 21600,
  "call_sell_strike": 22400,
  "call_buy_strike": 22600,
  "premiums": {
    "put_sell": 60,
    "put_buy": 20,
    "call_sell": 55,
    "call_buy": 18
  },
  "expiry": "2026-06-25",
  "quantity": 1
}
```

**Output:**

```json
{
  "status": "success",
  "strategy_id": "Iron Condor",
  "analysis": {
    "max_profit": 0,
    "max_loss": 0,
    "breakeven": [21805, 22395]
  }
}
```

### `POST /api/strategy/long-straddle`

**Purpose:** Create and analyze a long straddle.

**Signature:**

```http
POST /api/strategy/long-straddle
```

**Input:**

```json
{
  "underlying": "NIFTY",
  "spot_price": 22150,
  "strike": 22000,
  "call_premium": 120.5,
  "put_premium": 105.0,
  "expiry": "2026-06-25",
  "quantity": 1
}
```

**Output:**

```json
{
  "status": "success",
  "strategy_id": "Long Straddle",
  "analysis": {
    "max_profit": 0,
    "max_loss": 0,
    "breakeven": [21774.5, 22225.5]
  }
}
```

### `GET /api/strategy/{strategy_id}/analysis`

**Purpose:** Retrieve stored analysis for a previously built strategy.

**Signature:**

```http
GET /api/strategy/Bull%20Call%20Spread/analysis
```

**Input:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `strategy_id` | string | Yes | Strategy identifier or name. |

**Output:**

```json
{
  "max_profit": 0,
  "max_loss": 0,
  "breakeven": [22080.5]
}
```

### `GET /api/strategy/recommendations`

**Purpose:** Return strategy recommendations based on market view and IV rank.

**Signature:**

```http
GET /api/strategy/recommendations?market_view=bullish&iv_rank=35
```

**Input:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `market_view` | string | Yes | One of `bullish`, `bearish`, `neutral`, or `volatile`. |
| `iv_rank` | number | Yes | IV rank from `0` to `100`. |

**Output:**

```json
{
  "recommendations": [
    {
      "strategy": "Bull Call Spread",
      "reason": "Bullish view with moderate IV."
    }
  ]
}
```

---

## Alert APIs

### `POST /api/alerts/create`

**Purpose:** Create a new alert from request-supplied conditions and notification channels.

**Signature:**

```http
POST /api/alerts/create
```

**Input:**

```json
{
  "name": "NIFTY PCR Alert",
  "alert_type": "PCR",
  "underlying": "NIFTY",
  "condition": "pcr_oi < 0.8",
  "message_template": "PCR dropped below 0.8",
  "cooldown_minutes": 15,
  "notification_channels": ["websocket"]
}
```

**Output:**

```json
{
  "status": "success",
  "alert": {
    "id": "alert-id",
    "name": "NIFTY PCR Alert",
    "status": "active"
  }
}
```

### `GET /api/alerts`

**Purpose:** List alerts with optional underlying and status filters.

**Signature:**

```http
GET /api/alerts?underlying=NIFTY&status=active
```

**Input:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `underlying` | string | No | Filter alerts by underlying. |
| `status` | string | No | Filter alerts by status. |

**Output:**

```json
{
  "alerts": [
    {
      "id": "alert-id",
      "name": "NIFTY PCR Alert",
      "underlying": "NIFTY",
      "status": "active"
    }
  ]
}
```

### `DELETE /api/alerts/{alert_id}`

**Purpose:** Delete an alert by identifier.

**Signature:**

```http
DELETE /api/alerts/alert-id
```

**Input:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `alert_id` | string | Yes | Alert identifier. |

**Output:**

```json
{
  "status": "success",
  "message": "Alert deleted"
}
```

### `POST /api/alerts/{alert_id}/pause`

**Purpose:** Pause an alert by identifier.

**Signature:**

```http
POST /api/alerts/alert-id/pause
```

**Input:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `alert_id` | string | Yes | Alert identifier. |

**Output:**

```json
{
  "status": "success",
  "message": "Alert paused"
}
```

### `POST /api/alerts/{alert_id}/resume`

**Purpose:** Resume a paused alert by identifier.

**Signature:**

```http
POST /api/alerts/alert-id/resume
```

**Input:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `alert_id` | string | Yes | Alert identifier. |

**Output:**

```json
{
  "status": "success",
  "message": "Alert resumed"
}
```

---

## Scalper APIs

### `POST /api/scalper/start`

**Purpose:** Start the NSE Confluence Scalper for the requested underlying.

**Signature:**

```http
POST /api/scalper/start?underlying=NSE:NIFTY
```

**Input:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `underlying` | string | No | Underlying instrument key. Defaults to `NSE:NIFTY`. |

**Output:**

```json
{
  "status": "success",
  "message": "Scalper started for NSE:NIFTY"
}
```

### `POST /api/scalper/stop`

**Purpose:** Stop the active NSE Confluence Scalper.

**Signature:**

```http
POST /api/scalper/stop
```

**Input:**

None.

**Output:**

```json
{
  "status": "success",
  "message": "Scalper stopped"
}
```

### `GET /api/scalper/status`

**Purpose:** Return current scalper running state, underlying, active trades, and spot price.

**Signature:**

```http
GET /api/scalper/status
```

**Input:**

None.

**Output:**

```json
{
  "is_running": true,
  "underlying": "NSE:NIFTY",
  "active_trades": [],
  "current_spot": 22150
}
```

---

## Dashboard Routes

These routes render HTML pages for the terminal UI.

### `GET /`

**Purpose:** Render the main terminal dashboard.

**Signature:**

```http
GET /
```

**Input:**

None.

**Output:**

HTML page: `index.html`.

### `GET /options`

**Purpose:** Render the options analysis dashboard.

**Signature:**

```http
GET /options
```

**Input:**

None.

**Output:**

HTML page: `options_dashboard.html`.

### `GET /db-viewer`

**Purpose:** Render the local DuckDB inspection dashboard.

**Signature:**

```http
GET /db-viewer
```

**Input:**

None.

**Output:**

HTML page: `db_viewer.html`.

---

## Database APIs

### `GET /api/db/tables`

**Purpose:** List local DuckDB tables, schemas, and row counts.

**Signature:**

```http
GET /api/db/tables
```

**Input:**

None.

**Output:**

```json
{
  "tables": [
    {
      "name": "ticks",
      "schema": [
        {
          "name": "ts_ms",
          "type": "BIGINT"
        }
      ],
      "row_count": 100000
    }
  ]
}
```

### `POST /api/db/query`

**Purpose:** Run a SQL query against the local DuckDB database.

**Signature:**

```http
POST /api/db/query
```

**Input:**

```json
{
  "sql": "SELECT * FROM ticks LIMIT 10"
}
```

**Output:**

```json
{
  "results": [
    {
      "ts_ms": 1718352000000,
      "instrumentKey": "NSE:NIFTY",
      "price": 22150
    }
  ]
}
```

### `POST /api/db/export`

**Purpose:** Export DuckDB query results as a CSV attachment.

**Signature:**

```http
POST /api/db/export
```

**Input:**

```json
{
  "sql": "SELECT * FROM ticks LIMIT 10"
}
```

**Output:**

CSV attachment:

```csv
ts_ms,instrumentKey,price
1718352000000,NSE:NIFTY,22150
```

---

# Socket.IO Event Reference

Base Socket.IO transport is mounted on the same ASGI app as the HTTP API.

## `connect`

**Purpose:** Log a new Socket.IO client session.

**Input:**

None.

**Output/Effect:**

Server logs client connection.

## `disconnect`

**Purpose:** Log client disconnection and clean up data subscriptions.

**Input:**

None.

**Output/Effect:**

Server calls `data_engine.handle_disconnect(sid)`.

## `subscribe`

**Purpose:** Subscribe a client to one or more instrument rooms and start throttled data emissions.

**Input:**

```json
{
  "instrumentKeys": ["NSE:NIFTY"],
  "interval": "1"
}
```

**Output/Effect:**

Client joins room `NSE:NIFTY` and receives market data broadcasts for the requested interval.

## `unsubscribe`

**Purpose:** Unsubscribe a client from instrument rooms when no active session remains.

**Input:**

```json
{
  "instrumentKeys": ["NSE:NIFTY"],
  "interval": "1"
}
```

**Output/Effect:**

Server removes data subscriptions and leaves the room if no other session uses it.

## `subscribe_options`

**Purpose:** Add a client to an underlying's options broadcast room.

**Input:**

```json
{
  "underlying": "NIFTY"
}
```

**Output/Effect:**

Client joins room `options_NIFTY`.

## `unsubscribe_options`

**Purpose:** Remove a client from an underlying's options broadcast room.

**Input:**

```json
{
  "underlying": "NIFTY"
}
```

**Output/Effect:**

Client leaves room `options_NIFTY`.

## `start_replay`

**Purpose:** Start historical replay for one or more synchronized TradingView symbols.

**Input:**

```json
{
  "symbol": "NSE:NIFTY",
  "symbols": ["NSE:NIFTY", "NIFTY24JUN22000CE"],
  "start_time": "2026-06-14T09:15:00+05:30",
  "end_time": "2026-06-14T15:30:00+05:30",
  "speed": 1.0
}
```

**Output/Effect:**

Server starts replay aggregation and broadcasts replay data.

## `stop_replay`

**Purpose:** Stop the active replay session.

**Input:**

None.

**Output/Effect:**

Server stops replay aggregation and halts replay broadcasts.
