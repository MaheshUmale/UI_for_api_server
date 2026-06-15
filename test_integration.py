import httpx
import asyncio
import socketio
import time
import sys
import os

API_URL = "http://localhost:8000"
WS_URL = "http://localhost:8000"

async def test_health():
    async with httpx.AsyncClient() as client:
        try:
            response = await client.get(f"{API_URL}/health")
            print(f"Health check status: {response.status_code}")
            assert response.status_code == 200
            print("Health check passed")
        except Exception as e:
            print(f"Health check failed: {e}")
            return False
    return True

async def test_db_tables():
    async with httpx.AsyncClient() as client:
        try:
            response = await client.get(f"{API_URL}/api/db/tables")
            print(f"DB tables status: {response.status_code}")
            assert response.status_code == 200
            data = response.json()
            assert "tables" in data
            print(f"Tables found: {[t['name'] for t in data['tables']]}")
            print("DB tables check passed")
        except Exception as e:
            print(f"DB tables check failed: {e}")
            return False
    return True

async def test_socketio():
    sio = socketio.AsyncClient()
    received_events = []

    @sio.on('raw_tick')
    def on_raw_tick(data):
        print(f"Received raw_tick: {list(data.keys())}")
        received_events.append('raw_tick')

    @sio.on('chart_update')
    def on_chart_update(data):
        print(f"Received chart_update: {data.get('instrumentKey')}")
        received_events.append('chart_update')

    try:
        print(f"Connecting to {WS_URL}...")
        await sio.connect(WS_URL, transports=['websocket'])
        print("Connected to Socket.IO")

        await sio.emit('subscribe', {'instrumentKeys': ['NSE:NIFTY'], 'interval': '1'})
        print("Emitted subscribe for NSE:NIFTY")

        # Wait for some events
        timeout = 10
        start_time = time.time()
        while time.time() - start_time < 30:
            print(f"Received events so far: {received_events}")
            if 'raw_tick' in received_events:
                break
            await asyncio.sleep(1)

        assert 'raw_tick' in received_events
        print("Socket.IO integration test passed")
    except Exception as e:
        print(f"Socket.IO test failed: {e}")
        return False
    finally:
        await sio.disconnect()
    return True

async def main():
    print("Starting Integration Tests...")

    # Check if server is running
    h = await test_health()
    if not h:
        print("Server not responding. Please make sure it's running.")
        sys.exit(1)

    t = await test_db_tables()
    s = await test_socketio()

    if h and t and s:
        print("\nALL INTEGRATION TESTS PASSED SUCCESSFULLY!")
    else:
        print("\nSOME TESTS FAILED.")
        sys.exit(1)

if __name__ == "__main__":
    asyncio.run(main())
