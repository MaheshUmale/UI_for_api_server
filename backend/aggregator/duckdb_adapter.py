import duckdb
import logging
import os
import json
import pandas as pd
from datetime import datetime, timedelta
from typing import List, Dict, Any, Optional

logger = logging.getLogger(__name__)

class DuckDBReplayAdapter:
    """
    Adapter for managing historical DuckDB files and fallback data normalization.
    """
    def __init__(self, data_dir: str = "backend/test_data", cache_db: str = "data/historical_cache.duckdb"):
        self.data_dir = data_dir
        self.cache_db_path = cache_db
        os.makedirs(os.path.dirname(self.cache_db_path), exist_ok=True)
        self._init_cache()

    def _init_cache(self):
        """Initialize local cache for fallback historical data."""
        self.cache_conn = duckdb.connect(self.cache_db_path)
        self.cache_conn.execute("""
            CREATE TABLE IF NOT EXISTS historical_ohlcv (
                timestamp BIGINT,
                symbol VARCHAR,
                type VARCHAR,
                open DOUBLE,
                high DOUBLE,
                low DOUBLE,
                close DOUBLE,
                volume DOUBLE,
                oi BIGINT,
                source VARCHAR,
                PRIMARY KEY (timestamp, symbol)
            )
        """)

    def inspect_schema(self, db_path: str) -> Optional[str]:
        """Inspect schema and return the appropriate table name for OHLCV data."""
        try:
            conn = duckdb.connect(db_path, read_only=True)
            tables = [t[0] for t in conn.execute("SHOW TABLES").fetchall()]

            # Priority table names
            for target in ['ohlcv', 'ticks', 'prices', 'historical_data', 'data']:
                if target in tables:
                    # Verify required columns exist
                    cols = [c[0].lower() for c in conn.execute(f"DESCRIBE {target}").fetchall()]
                    if any(c in cols for c in ['timestamp', 'ts_ms', 'time']):
                        conn.close()
                        return target
            conn.close()
            return None
        except Exception as e:
            logger.error(f"Error inspecting schema for {db_path}: {e}")
            return None

    def query_historical(self, symbol: str, start_ts: int, end_ts: int, date_str: str) -> List[Dict[str, Any]]:
        """Query data for a specific symbol and time range from DuckDB or Cache."""
        results = []

        # 1. Try local date-specific DuckDB
        db_file = os.path.join(self.data_dir, f"{date_str.replace('-', '')}.duckdb")
        if os.path.exists(db_file) and os.path.getsize(db_file) > 1000:
            table = self.inspect_schema(db_file)
            if table:
                try:
                    conn = duckdb.connect(db_file, read_only=True)
                    # Dynamically find the timestamp column for the WHERE clause
                    cols = [c[0].lower() for c in conn.execute(f"DESCRIBE {table}").fetchall()]
                    ts_col = 'ts_ms' if 'ts_ms' in cols else ('timestamp' if 'timestamp' in cols else ('time' if 'time' in cols else None))

                    if ts_col:
                        df = conn.execute(f"SELECT * FROM {table} WHERE {ts_col} >= ? AND {ts_col} <= ?", (start_ts, end_ts)).fetch_df()
                        conn.close()
                        results.extend(self._normalize_df(df, symbol))
                    else:
                        conn.close()
                except Exception as e:
                    logger.warning(f"Failed to query {db_file}: {e}")

        # 2. Try Local Cache
        if not results:
            df = self.cache_conn.execute("""
                SELECT * FROM historical_ohlcv
                WHERE symbol = ? AND timestamp >= ? AND timestamp <= ?
                ORDER BY timestamp ASC
            """, (symbol, start_ts, end_ts)).fetch_df()
            if not df.empty:
                results.extend(df.to_dict('records'))

        return results

    def _normalize_df(self, df: pd.DataFrame, symbol: str) -> List[Dict[str, Any]]:
        """Normalize various DuckDB schemas into a standard format."""
        if df.empty: return []

        # Standardize column names to lowercase
        df.columns = [c.lower() for c in df.columns]

        norm = pd.DataFrame()

        def get_col(candidates):
            for c in candidates:
                if c in df.columns: return df[c]
            return None

        ts = get_col(['ts_ms', 'timestamp', 'time'])
        if ts is not None: norm['timestamp'] = ts

        norm['symbol'] = symbol
        # More robust option detection
        is_option = any(x in symbol.upper() for x in ['CE', 'PE', 'CALL', 'PUT']) or \
                    (len(symbol) > 10 and any(c.isdigit() for c in symbol) and any(x in symbol.upper() for x in ['C', 'P']))
        norm['type'] = 'OPTION' if is_option else 'SPOT'

        col = get_col(['open', 'price', 'o'])
        norm['open'] = col if col is not None else 0

        col = get_col(['high', 'price', 'h'])
        norm['high'] = col if col is not None else 0

        col = get_col(['low', 'price', 'l'])
        norm['low'] = col if col is not None else 0

        col = get_col(['close', 'price', 'c'])
        norm['close'] = col if col is not None else 0

        col = get_col(['volume', 'qty', 'v'])
        norm['volume'] = col if col is not None else 0

        col = get_col(['oi', 'open_interest'])
        norm['oi'] = col if col is not None else 0
        norm['source'] = 'DUCKDB'

        return norm.to_dict('records')

    def cache_historical_data(self, data: List[Dict[str, Any]]):
        """Save fallback API data into local DuckDB cache."""
        if not data: return
        df = pd.DataFrame(data)
        try:
            self.cache_conn.execute("INSERT OR IGNORE INTO historical_ohlcv SELECT * FROM df")
            logger.info(f"Cached {len(data)} rows of historical data")
        except Exception as e:
            logger.error(f"Error caching data: {e}")

duckdb_replay_adapter = DuckDBReplayAdapter()
