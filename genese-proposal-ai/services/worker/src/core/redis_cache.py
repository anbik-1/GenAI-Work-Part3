"""ElastiCache Redis client for caching Tavily search results."""
import json
import redis
from ..core.config import get_settings
from shared import TAVILY_CACHE_TTL


def get_redis_client() -> redis.Redis | None:
    """Return a Redis client, or None if Redis URL not configured."""
    settings = get_settings()
    if not settings.redis_url:
        return None
    try:
        client = redis.from_url(settings.redis_url, decode_responses=True)
        client.ping()
        return client
    except Exception:
        return None  # Graceful degradation — proceed without cache


def cache_get(key: str) -> dict | None:
    """Get a cached Tavily result. Returns None on cache miss or error."""
    client = get_redis_client()
    if not client:
        return None
    try:
        value = client.get(key)
        return json.loads(value) if value else None
    except Exception:
        return None


def cache_set(key: str, value: dict, ttl: int = TAVILY_CACHE_TTL) -> None:
    """Cache a Tavily result with TTL. Silent on error."""
    client = get_redis_client()
    if not client:
        return
    try:
        client.setex(key, ttl, json.dumps(value))
    except Exception:
        pass


def make_cache_key(query: str) -> str:
    """Create a deterministic cache key for a Tavily query."""
    import hashlib
    return f"tavily:{hashlib.sha256(query.encode()).hexdigest()}"
