"""Search router — semantic search over the knowledge base with AI-synthesized answer."""
import json
import boto3
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
from sys import path as sys_path
sys_path.insert(0, "/app")
from shared import (
    SearchRequest, SearchResponse, SearchResult,
    BEDROCK_EMBEDDING_MODEL_ID, BEDROCK_LLM_MODEL_ID, TOP_K_RESULTS,
)
from ..core.database import get_db
from ..core.auth import get_current_user_sub
from ..core.config import get_settings

router = APIRouter()


def embed_query(query: str) -> list[float]:
    """Embed a query string using Amazon Titan Text v2."""
    settings = get_settings()
    bedrock = boto3.client("bedrock-runtime", region_name=settings.aws_region)
    response = bedrock.invoke_model(
        modelId=BEDROCK_EMBEDDING_MODEL_ID,
        body=json.dumps({"inputText": query}),
    )
    return json.loads(response["body"].read())["embedding"]


async def vector_search(
    db: AsyncSession,
    query_embedding: list[float],
    top_k: int,
    document_type: str | None = None,
    engagement_type: str | None = None,
) -> list[dict]:
    """Run pgvector similarity search with optional metadata filters."""
    # Serialize embedding as a string literal to avoid asyncpg bind variable conflict with ::vector cast
    embedding_str = "[" + ",".join(str(x) for x in query_embedding) + "]"

    filters = ""
    params: dict = {"top_k": top_k}

    if document_type:
        filters += " AND d.document_type = :doc_type"
        params["doc_type"] = document_type
    if engagement_type:
        filters += " AND d.engagement_type = :eng_type"
        params["eng_type"] = engagement_type

    # Use f-string for the embedding literal (safe — it's a float array, not user input)
    query = text(f"""
        SELECT
            dc.id,
            dc.content,
            d.id AS document_id,
            d.filename,
            d.document_type,
            d.client_name,
            1 - (dc.embedding <=> '{embedding_str}'::vector) AS similarity_score
        FROM document_chunks dc
        JOIN documents d ON dc.document_id = d.id
        WHERE dc.embedding IS NOT NULL
        {filters}
        ORDER BY dc.embedding <=> '{embedding_str}'::vector
        LIMIT :top_k
    """)
    result = await db.execute(query, params)
    return [dict(row._mapping) for row in result]


@router.post("", response_model=SearchResponse)
async def semantic_search(
    request: SearchRequest,
    db: AsyncSession = Depends(get_db),
    _: str = Depends(get_current_user_sub),
):
    """Search the knowledge base and return an AI-synthesized answer with sources."""
    # Embed the query
    query_embedding = embed_query(request.query)

    # Vector similarity search
    rows = await vector_search(
        db, query_embedding, request.top_k,
        request.document_type, request.engagement_type,
    )

    if not rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No relevant documents found in the knowledge base.",
        )

    # Build context for LLM synthesis
    context = "\n\n".join(
        f"[Source: {r['filename']}]\n{r['content']}"
        for r in rows
    )

    # Ask Claude to synthesize an answer
    settings = get_settings()
    bedrock = boto3.client("bedrock-runtime", region_name=settings.aws_region)
    prompt = (
        f"You are a helpful assistant for Genese Solution, a cloud consulting firm.\n\n"
        f"Using the following excerpts from past Genese proposals and documents, "
        f"answer this question concisely and accurately:\n\n"
        f"Question: {request.query}\n\n"
        f"Context:\n{context}\n\n"
        f"Answer:"
    )
    response = bedrock.invoke_model(
        modelId=BEDROCK_LLM_MODEL_ID,
        body=json.dumps({
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 1024,
            "messages": [{"role": "user", "content": prompt}],
        }),
    )
    answer = json.loads(response["body"].read())["content"][0]["text"]

    sources = [
        SearchResult(
            document_id=r["document_id"],
            filename=r["filename"],
            document_type=r["document_type"],
            client_name=r.get("client_name"),
            excerpt=r["content"][:300] + "..." if len(r["content"]) > 300 else r["content"],
            similarity_score=round(float(r["similarity_score"]), 4),
        )
        for r in rows
    ]

    return SearchResponse(query=request.query, answer=answer, sources=sources)
