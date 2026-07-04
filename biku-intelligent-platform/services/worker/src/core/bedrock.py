"""Amazon Bedrock client — LLM (Claude) and Embeddings (Titan Text v2)."""
import boto3
from langchain_aws import BedrockEmbeddings, ChatBedrock
from ..core.config import get_settings


def get_bedrock_client():
    settings = get_settings()
    return boto3.client("bedrock-runtime", region_name=settings.aws_region)


def get_llm(model_id: str | None = None) -> ChatBedrock:
    """Return a LangChain ChatBedrock instance.

    The model used is resolved in this priority order:
      1. ``model_id`` argument (per-request override, e.g. from job message)
      2. ``BEDROCK_LLM_MODEL_ID`` env var / ECS task definition variable
      3. Hard-coded default: ``us.anthropic.claude-sonnet-4-6``

    This allows model swaps via ECS task definition updates without code changes.
    """
    import boto3
    from botocore.config import Config
    settings = get_settings()
    effective_model_id = model_id or settings.bedrock_llm_model_id
    # Increase read timeout to 120s — large proposals can take 60-90s
    bedrock_client = boto3.client(
        "bedrock-runtime",
        region_name=settings.aws_region,
        config=Config(read_timeout=120, connect_timeout=10, retries={"max_attempts": 2})
    )
    return ChatBedrock(
        model_id=effective_model_id,
        region_name=settings.aws_region,
        client=bedrock_client,
        model_kwargs={
            "max_tokens": 4096,
            "temperature": 0.3,
        },
    )


def get_embeddings() -> BedrockEmbeddings:
    """Return a LangChain BedrockEmbeddings instance for Titan Text v2."""
    settings = get_settings()
    return BedrockEmbeddings(
        model_id=settings.bedrock_embedding_model_id,
        region_name=settings.aws_region,
    )


def embed_texts(texts: list[str]) -> list[list[float]]:
    """Embed a list of texts using Titan Text v2 directly (for bulk ingestion)."""
    embeddings_model = get_embeddings()
    return embeddings_model.embed_documents(texts)


def embed_query(query: str) -> list[float]:
    """Embed a single query string."""
    embeddings_model = get_embeddings()
    return embeddings_model.embed_query(query)
