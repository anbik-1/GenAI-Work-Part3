"""Document embedding with token usage tracking."""
import json
import boto3
from ..core.config import get_settings
from shared import BEDROCK_EMBEDDING_MODEL_ID


def embed_texts_with_usage(texts: list[str]) -> tuple[list[list[float]], dict]:
    """
    Embed texts using Titan Text v2 directly (not via LangChain) to capture token usage.
    Returns (embeddings, usage_info).
    usage_info = {"input_tokens": N, "model": "...", "chunk_count": N}
    """
    settings = get_settings()
    bedrock = boto3.client("bedrock-runtime", region_name=settings.aws_region)

    embeddings = []
    total_input_tokens = 0

    for text in texts:
        response = bedrock.invoke_model(
            modelId=BEDROCK_EMBEDDING_MODEL_ID,
            body=json.dumps({"inputText": text}),
        )
        body = json.loads(response["body"].read())
        embeddings.append(body["embedding"])
        # Titan returns inputTextTokenCount in the response body
        total_input_tokens += body.get("inputTextTokenCount", len(text.split()))

    usage_info = {
        "input_tokens": total_input_tokens,
        "model": BEDROCK_EMBEDDING_MODEL_ID,
        "chunk_count": len(texts),
    }
    return embeddings, usage_info
