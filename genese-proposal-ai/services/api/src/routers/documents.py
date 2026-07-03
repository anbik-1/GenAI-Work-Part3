"""Documents router — upload, list, delete knowledge base documents."""
import uuid
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete
from sys import path as sys_path
sys_path.insert(0, "/app")
from shared import (
    Document, DocumentListResponse, DocumentListItem,
    DocumentUploadResponse, IngestionJobMessage,
)
from ..core.database import get_db
from ..core.auth import get_current_user_sub
from ..core.s3 import upload_file, delete_s3_object
from ..core.sqs import publish_job

router = APIRouter()

ALLOWED_EXTENSIONS = {".pdf", ".docx", ".txt"}
MAX_FILE_SIZE = 50 * 1024 * 1024  # 50 MB


@router.post("/upload", response_model=DocumentUploadResponse, status_code=status.HTTP_202_ACCEPTED)
async def upload_document(
    file: UploadFile = File(...),
    document_type: str = Form(...),
    engagement_type: Optional[str] = Form(default=None),
    client_name: Optional[str] = Form(default=None),
    db: AsyncSession = Depends(get_db),
    user_sub: str = Depends(get_current_user_sub),
):
    """Upload a document to S3 and queue it for ingestion into the knowledge base."""
    # Validate file extension
    import os
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"File type {ext} not supported. Allowed: {ALLOWED_EXTENSIONS}",
        )

    # Read and validate size
    content = await file.read()
    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="File size exceeds 50MB limit",
        )

    # Get or create user
    from shared import User
    result = await db.execute(select(User).where(User.cognito_sub == user_sub))
    user = result.scalar_one_or_none()
    if not user:
        user = User(cognito_sub=user_sub, email=user_sub)
        db.add(user)
        await db.flush()

    # Create document record
    doc_id = uuid.uuid4()
    s3_key = f"raw/{doc_id}/{file.filename}"
    upload_file(content, s3_key, file.content_type or "application/octet-stream")

    document = Document(
        id=doc_id,
        filename=file.filename,
        document_type=document_type,
        engagement_type=engagement_type,
        client_name=client_name,
        s3_key=s3_key,
        uploaded_by=user.id,
    )
    db.add(document)
    await db.flush()
    await db.commit()  # Commit BEFORE publishing to SQS so worker can find the document

    # Queue ingestion job (after commit so the worker sees the document in DB)
    msg = IngestionJobMessage(
        document_id=str(doc_id),
        s3_key=s3_key,
        document_type=document_type,
        engagement_type=engagement_type,
        client_name=client_name,
    )
    publish_job(msg.model_dump())

    return DocumentUploadResponse(
        document_id=doc_id,
        filename=file.filename,
        document_type=document_type,
    )


@router.get("", response_model=DocumentListResponse)
async def list_documents(
    db: AsyncSession = Depends(get_db),
    user_sub: str = Depends(get_current_user_sub),
):
    """List documents in the knowledge base.

    Admins see all documents; members see only documents they uploaded.
    """
    from sqlalchemy import text as sa_text

    # Look up current user's id and role
    user_row = (
        await db.execute(
            sa_text("SELECT id, role FROM users WHERE cognito_sub = :sub"),
            {"sub": user_sub},
        )
    ).mappings().one_or_none()

    if user_row and user_row["role"] == "admin":
        # Admin sees everything
        result = await db.execute(select(Document).order_by(Document.created_at.desc()))
    elif user_row:
        # Member sees only their own uploads
        result = await db.execute(
            select(Document)
            .where(Document.uploaded_by == user_row["id"])
            .order_by(Document.created_at.desc())
        )
    else:
        # Unknown user — return empty
        return DocumentListResponse(documents=[], total=0)

    documents = result.scalars().all()
    return DocumentListResponse(
        documents=[DocumentListItem.model_validate(d) for d in documents],
        total=len(documents),
    )


@router.delete("/{document_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_document(
    document_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user_sub: str = Depends(get_current_user_sub),
):
    """Delete a document and all its chunks from the knowledge base.

    Admins can delete any document; members can only delete their own.
    """
    from sqlalchemy import text as sa_text

    result = await db.execute(select(Document).where(Document.id == document_id))
    document = result.scalar_one_or_none()
    if not document:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")

    # Enforce ownership for non-admins
    user_row = (
        await db.execute(
            sa_text("SELECT id, role FROM users WHERE cognito_sub = :sub"),
            {"sub": user_sub},
        )
    ).mappings().one_or_none()

    if not user_row or (user_row["role"] != "admin" and document.uploaded_by != user_row["id"]):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You don't have permission to delete this document")

    # Delete from S3 and DB (cascade deletes chunks)
    delete_s3_object(document.s3_key)
    await db.execute(delete(Document).where(Document.id == document_id))


@router.get("/{document_id}/status")
async def get_document_status(
    document_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _: str = Depends(get_current_user_sub),
):
    """Get real-time ingestion status, phase, model info and token usage for a document."""
    result = await db.execute(select(Document).where(Document.id == document_id))
    document = result.scalar_one_or_none()
    if not document:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")

    # Phase display labels and descriptions
    PHASE_LABELS = {
        "pending":    {"label": "Pending",        "description": "Waiting to be processed"},
        "loading":    {"label": "Loading",         "description": "Downloading from S3..."},
        "chunking":   {"label": "Chunking",        "description": "Splitting into chunks (512 tokens, 50 overlap)..."},
        "embedding":  {"label": "Embedding",       "description": f"Generating vectors with Titan Text v2..."},
        "storing":    {"label": "Storing",         "description": "Writing chunks to pgvector (Aurora PostgreSQL)..."},
        "complete":   {"label": "Complete",        "description": "Indexed and ready for RAG search"},
        "failed":     {"label": "Failed",          "description": "Ingestion failed — check logs"},
    }

    current_status = document.ingestion_status or "pending"
    phase_info = PHASE_LABELS.get(current_status, {"label": current_status, "description": ""})

    # Determine completed phases for progress display
    PHASE_ORDER = ["loading", "chunking", "embedding", "storing", "complete"]
    current_idx = PHASE_ORDER.index(current_status) if current_status in PHASE_ORDER else -1

    phases = []
    for i, phase in enumerate(["loading", "chunking", "embedding", "storing"]):
        if current_status == "complete":
            state = "done"
        elif current_status == phase:
            state = "active"
        elif current_idx > i:
            state = "done"
        else:
            state = "pending"
        phases.append({
            "key": phase,
            "label": PHASE_LABELS[phase]["label"],
            "description": PHASE_LABELS[phase]["description"],
            "state": state,
        })

    # Pricing: Titan Text v2 = $0.00002 per 1K tokens (input)
    TITAN_PRICE_PER_1K = 0.00002
    embedding_tokens = document.embedding_tokens or 0
    embedding_cost = round((embedding_tokens / 1000) * TITAN_PRICE_PER_1K, 6)

    return {
        "document_id": str(document.id),
        "filename": document.filename,
        "ingestion_status": current_status,
        "phase_label": phase_info["label"],
        "phase_description": phase_info["description"],
        "phases": phases,
        "chunk_count": document.chunk_count or 0,
        "embedding_model": document.embedding_model or "amazon.titan-embed-text-v2:0",
        "embedding_tokens": embedding_tokens,
        "embedding_cost_usd": embedding_cost,
    }
