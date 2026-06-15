import redis
from fakeredis import FakeRedis
import os
import json
import logging

logger = logging.getLogger(__name__)

class RedisBus:
    """
    The Nervous System of the ProTrade Backend.
    Uses Redis Streams for event-driven data flow and Hashes for latest state.
    """
    def __init__(self, use_fake=None):
        # Default to real Redis if host is provided, else fallback to FakeRedis
        redis_host = os.getenv('REDIS_HOST')
        should_use_fake = use_fake if use_fake is not None else (not redis_host)

        if should_use_fake:
            self.client = FakeRedis(decode_responses=True)
            logger.info("Using FakeRedis for message bus")
        else:
            self.client = redis.Redis(
                host=os.getenv('REDIS_HOST', 'localhost'),
                port=int(os.getenv('REDIS_PORT', 6379)),
                decode_responses=True
            )
            logger.info(f"Connected to Redis at {os.getenv('REDIS_HOST', 'localhost')}")

    def add_to_stream(self, stream_name, data, maxlen=1000):
        """XADD: Add data to a stream."""
        return self.client.xadd(stream_name, data, maxlen=maxlen)

    def set_latest_state(self, key, data):
        """HSET: Update the Golden Record (Single Source of Truth)."""
        if isinstance(data, dict):
            # Flatten or serialize? Schema mandates JSON string for complex objects if needed,
            # but HSET can take a mapping.
            serialized = {k: (json.dumps(v) if isinstance(v, (dict, list)) else v) for k, v in data.items()}
            return self.client.hset(key, mapping=serialized)
        return False

    def get_latest_state(self, key):
        """HGETALL: Retrieve the latest state."""
        return self.client.hgetall(key)

    def read_stream(self, stream_name, last_id='0', count=10):
        """XREAD: Consume from stream."""
        return self.client.xread({stream_name: last_id}, count=count)

redis_bus = RedisBus()
