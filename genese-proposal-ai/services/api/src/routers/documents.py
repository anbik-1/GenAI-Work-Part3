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

    # Queue ingestion job
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
    _: str = Depends(get_current_user_sub),
):
    """List all documents in the knowledge base."""
    result = await db.execute(select(Document).order_by(Document.created_at.desc()))
    documents = result.scalars().all()
    return DocumentListResponse(
        documents=[DocumentListItem.model_validate(d) for d in documents],
        total=len(documents),
    )


@router.delete("/{document_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_document(
    document_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _: str = Depends(get_current_user_sub),
):
    """Delete a document and all its chunks from the knowledge base."""
    result = await db.execute(select(Document).where(Document.id == document_id))
    document = result.scalar_one_or_none()
    if not document:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")

    # Delete from S3 and DB (cascade deletes chunks)
    delete_s3_object(document.s3_key)
    await db.execute(delete(Document).where(Document.id == document_id))
