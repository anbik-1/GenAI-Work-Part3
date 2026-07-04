"""Templates router — upload and manage branded .docx proposal templates."""
import uuid
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, status
from sqlalchemy.ext.asyncio import AsyncSession
from ..core.database import get_db
from ..core.auth import get_current_user_sub
from ..core.s3 import upload_file, get_presigned_url, delete_s3_object, get_s3_client
from ..core.config import get_settings

router = APIRouter()

# Template types
TEMPLATE_TYPES = ["proposal", "sow", "case_study"]

# S3 key format: templates/{type}/template.docx
def template_s3_key(doc_type: str) -> str:
    return f"templates/{doc_type}/template.docx"


@router.post("/upload", status_code=status.HTTP_200_OK)
async def upload_template(
    file: UploadFile = File(...),
    template_type: str = Form(...),
    _: str = Depends(get_current_user_sub),
):
    """Upload a branded .docx template for proposals, SoWs or case studies."""
    if template_type not in TEMPLATE_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"template_type must be one of: {TEMPLATE_TYPES}",
        )

    if not file.filename.endswith(".docx"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Template must be a .docx file",
        )

    content = await file.read()
    if len(content) > 20 * 1024 * 1024:  # 20MB max
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="Template file too large (max 20MB)",
        )

    s3_key = template_s3_key(template_type)
    upload_file(
        content, s3_key,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    )

    return {
        "message": f"Template uploaded successfully for {template_type}",
        "template_type": template_type,
        "s3_key": s3_key,
    }


@router.get("")
async def list_templates(_: str = Depends(get_current_user_sub)):
    """List all uploaded templates and their status."""
    settings = get_settings()
    s3 = get_s3_client()
    templates = []

    for doc_type in TEMPLATE_TYPES:
        key = template_s3_key(doc_type)
        try:
            response = s3.head_object(Bucket=settings.documents_bucket, Key=key)
            size_kb = round(response["ContentLength"] / 1024, 1)
            last_modified = response["LastModified"].isoformat()
            templates.append({
                "template_type": doc_type,
                "exists": True,
                "size_kb": size_kb,
                "last_modified": last_modified,
                "s3_key": key,
            })
        except Exception:
            templates.append({
                "template_type": doc_type,
                "exists": False,
                "size_kb": None,
                "last_modified": None,
                "s3_key": key,
            })

    return {"templates": templates}


@router.get("/{template_type}/download")
async def download_template(
    template_type: str,
    _: str = Depends(get_current_user_sub),
):
    """Get a presigned download URL for a template."""
    if template_type not in TEMPLATE_TYPES:
        raise HTTPException(status_code=400, detail="Invalid template type")

    key = template_s3_key(template_type)
    settings = get_settings()
    s3 = get_s3_client()

    try:
        s3.head_object(Bucket=settings.documents_bucket, Key=key)
    except Exception:
        raise HTTPException(status_code=404, detail=f"No template found for {template_type}")

    url = get_presigned_url(key, expiry_seconds=3600)
    return {"download_url": url, "template_type": template_type}


@router.delete("/{template_type}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_template(
    template_type: str,
    _: str = Depends(get_current_user_sub),
):
    """Delete a template."""
    if template_type not in TEMPLATE_TYPES:
        raise HTTPException(status_code=400, detail="Invalid template type")
    delete_s3_object(template_s3_key(template_type))
