"""RAG retrieval chain — semantic similarity search over the knowledge base."""
from sqlalchemy.orm import Session
from sqlalchemy import text
from ..core.bedrock import embed_query
from shared import TOP_K_RESULTS


def retrieve_relevant_chunks(
    db: Session,
    query: str,
    top_k: int = TOP_K_RESULTS,
    document_type: str | None = None,
    engagement_type: str | None = None,
) -> list[dict]:
    """
    Embed the query and retrieve the most semantically similar document chunks
    from pgvector. Returns list of dicts with content, metadata, and similarity score.
    """
    query_embedding = embed_query(query)
    # Serialize as literal string to avoid psycopg2 bind variable conflict with ::vector cast
    embedding_str = "[" + ",".join(str(x) for x in query_embedding) + "]"

    filters = ""
    params: dict = {"top_k": top_k}

    if document_type:
        filters += " AND d.document_type = :doc_type"
        params["doc_type"] = document_type
    if engagement_type:
        filters += " AND d.engagement_type = :eng_type"
        params["eng_type"] = engagement_type

    sql = text(f"""
        SELECT
            dc.content,
            d.filename,
            d.document_type,
            d.client_name,
            d.engagement_type,
            1 - (dc.embedding <=> '{embedding_str}'::vector) AS similarity_score
        FROM document_chunks dc
        JOIN documents d ON dc.document_id = d.id
        WHERE dc.embedding IS NOT NULL
        {filters}
        ORDER BY dc.embedding <=> '{embedding_str}'::vector
        LIMIT :top_k
    """)

    result = db.execute(sql, params)
    rows = result.fetchall()

    return [
        {
            "content": row.content,
            "source_document": row.filename,
            "document_type": row.document_type,
            "client_name": row.client_name,
            "engagement_type": row.engagement_type,
            "similarity_score": round(float(row.similarity_score), 4),
        }
        for row in rows
    ]


def format_rag_context(chunks: list[dict]) -> str:
    """Format retrieved chunks into a context string for the LLM prompt."""
    if not chunks:
        return "No relevant past work found in the knowledge base."

    sections = []
    for i, chunk in enumerate(chunks, 1):
        meta = f"[Source {i}: {chunk['source_document']}"
        if chunk.get("client_name"):
            meta += f" | Client: {chunk['client_name']}"
        meta += "]"
        sections.append(f"{meta}\n{chunk['content']}")

    return "\n\n---\n\n".join(sections)
