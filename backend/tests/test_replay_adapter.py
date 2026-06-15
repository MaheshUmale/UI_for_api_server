import unittest
import pandas as pd
from backend.aggregator.duckdb_adapter import DuckDBReplayAdapter

class TestDuckDBAdapter(unittest.TestCase):
    def setUp(self):
        self.adapter = DuckDBReplayAdapter(data_dir="backend/test_data", cache_db="data/test_cache.duckdb")

    def test_normalization(self):
        # Create a mock dataframe with one of the possible schemas
        df = pd.DataFrame({
            'ts_ms': [1718352000000],
            'open': [23500.0],
            'high': [23510.0],
            'low': [23490.0],
            'close': [23505.0],
            'volume': [1000]
        })

        normalized = self.adapter._normalize_df(df, "NSE:NIFTY")
        self.assertEqual(len(normalized), 1)
        self.assertEqual(normalized[0]['symbol'], "NSE:NIFTY")
        self.assertEqual(normalized[0]['close'], 23505.0)
        self.assertEqual(normalized[0]['type'], "SPOT")

    def test_option_normalization(self):
        df = pd.DataFrame({
            'timestamp': [1718352000000],
            'price': [250.0],
            'qty': [50]
        })
        normalized = self.adapter._normalize_df(df, "NIFTY260616C23500")
        self.assertEqual(normalized[0]['type'], "OPTION")
        self.assertEqual(normalized[0]['close'], 250.0)

if __name__ == "__main__":
    unittest.main()
