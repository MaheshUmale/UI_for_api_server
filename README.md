<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/0e17fb76-0875-4160-9a87-c9fb9c834a0b

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## Integrated Full-Stack Mode (Mock Market)

This repository is now integrated with the ProTrade API Server. You can run it in **Mock Mode** using historical data from DuckDB, bypassing the need for live broker API keys.

### 1. Backend Setup
The backend code is located in the `backend/` directory.
- **Install Dependencies**:
  ```bash
  pip install fastapi uvicorn socketio python-socketio motor pandas duckdb httpx jinja2 redis fakeredis python-dotenv pytz scipy websocket-client tradingview_scraper upstox-python-sdk
  ```
- **Configuration**: Ensure `.env` exists with `MOCK_MARKET_MODE=True` and `SERVER_PORT=8000`.

### 2. Frontend Configuration
Ensure `.env.local` contains:
```
VITE_API_URL=http://localhost:8000
VITE_WS_URL=ws://localhost:8000
```

### 3. Launching
- **Start Backend**: `export PYTHONPATH=$PYTHONPATH:. && python3 backend/api_server.py`
- **Start Frontend**: `npm run dev`

For detailed implementation details, see [INTEGRATION_SUMMARY.md](./INTEGRATION_SUMMARY.md).
