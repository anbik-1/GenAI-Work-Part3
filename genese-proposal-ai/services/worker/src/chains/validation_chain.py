"""Tavily web search chain for validating architecture recommendations."""
from tavily import TavilyClient
from ..core.redis_cache import cache_get, cache_set, make_cache_key
from ..core.config import get_tavily_api_key


def validate_with_tavily(
    topic: str,
    engagement_type: str,
    max_results: int = 3,
) -> list[dict]:
    """
    Search live AWS/Azure/GCP documentation to validate architecture claims.
    Returns a list of source dicts. Falls back to empty list on any failure.
    """
    api_key = get_tavily_api_key()
    # Skip if key is missing or still the placeholder
    if not api_key or api_key == "REPLACE_WITH_TAVILY_KEY" or len(api_key) < 10:
        return []

    query = _build_validation_query(topic, engagement_type)
    cache_key = make_cache_key(query)

    cached = cache_get(cache_key)
    if cached is not None:
        return cached

    try:
        client = TavilyClient(api_key=api_key)
        results = client.search(
            query=query,
            search_depth="basic",
            max_results=max_results,
            include_domains=[
                "docs.aws.amazon.com",
                "aws.amazon.com",
                "learn.microsoft.com",
                "cloud.google.com",
            ],
        )
        sources = [
            {
                "url": r.get("url", ""),
                "title": r.get("title", ""),
                "excerpt": r.get("content", "")[:400],
            }
            for r in results.get("results", [])
        ]
        cache_set(cache_key, sources)
        return sources
    except Exception as e:
        print(f"[validation_chain] Tavily search skipped: {type(e).__name__} — proceeding without web validation")
        return []


def _build_validation_query(topic: str, engagement_type: str) -> str:
    """Build a targeted documentation search query."""
    type_context = {
        "aws_migration": "AWS cloud migration best practices documentation",
        "data_platform": "AWS data lake analytics best practices",
        "managed_services": "AWS managed services operations",
        "security_audit": "AWS security compliance best practices",
        "devops_transformation": "AWS DevOps CI/CD pipeline best practices",
        "ai_ml_platform": "AWS SageMaker machine learning platform documentation",
    }
    context = type_context.get(engagement_type, "AWS best practices documentation")
    return f"{topic} {context}"


def format_tavily_sources(sources: list[dict]) -> str:
    """Format Tavily sources for inclusion in the LLM prompt."""
    if not sources:
        return ""
    lines = ["Validated from official documentation:"]
    for s in sources:
        lines.append(f"- {s['title']}: {s['excerpt']} (Source: {s['url']})")
    return "\n".join(lines)
