"""Upsert document chunks and embeddings into Aurora pgvector."""
import uuid
from sqlalchemy.orm import Session
from sqlalchemy import text
from shared import DocumentChunk, Document


def upsert_chunks(
    db: Session,
    document: Document,
    chunks: list[str],
    embeddings: list[list[float]],
) -> int:
    """
    Insert document chunks with embeddings into pgvector.
    Returns the number of chunks stored.
    """
    for idx, (chunk_text, embedding) in enumerate(zip(chunks, embeddings)):
        chunk = DocumentChunk(
            id=uuid.uuid4(),
            document_id=document.id,
            chunk_index=idx,
            content=chunk_text,
            embedding=embedding,
            metadata_={
                "filename": document.filename,
                "document_type": document.document_type,
                "engagement_type": document.engagement_type,
                "client_name": document.client_name,
                "chunk_index": idx,
            },
        )
        db.add(chunk)

    # Update chunk count on the document
    document.chunk_count = len(chunks)
    db.flush()

    return len(chunks)


def delete_chunks_for_document(db: Session, document_id: uuid.UUID) -> None:
    """Remove all chunks for a document (used when re-ingesting)."""
    db.execute(
        text("DELETE FROM document_chunks WHERE document_id = :doc_id"),
        {"doc_id": str(document_id)},
    )
    db.flush()
