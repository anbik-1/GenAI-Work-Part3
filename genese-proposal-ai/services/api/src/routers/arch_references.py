"""
Arch References router — manage sample architecture diagrams as style references.
These are uploaded by users and used as context when generating new arch diagrams.
"""
import uuid
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
from ..core.database import get_db
from ..core.auth import get_current_user_sub
from ..core.s3 import upload_file, get_presigned_url, get_s3_client, delete_s3_object
from ..core.config import get_settings

router = APIRouter()


@router.get("")
async def list_references(
    db: AsyncSession = Depends(get_db),
    _: str = Depends(get_current_user_sub),
):
    """List all uploaded architecture reference diagrams."""
    rows = (await db.execute(
        text("SELECT id, name, description, engagement_type, s3_key, created_at FROM arch_references ORDER BY created_at DESC")
    )).mappings().all()

    result = []
    for row in rows:
        preview_url = get_presigned_url(row["s3_key"], expiry_seconds=3600) if row["s3_key"] else None
        result.append({
            "id": str(row["id"]),
            "name": row["name"],
            "description": row["description"],
            "engagement_type": row["engagement_type"],
            "preview_url": preview_url,
            "created_at": row["created_at"].isoformat() if row["created_at"] else None,
        })
    return {"references": result}


@router.post("", status_code=status.HTTP_201_CREATED)
async def upload_reference(
    file: UploadFile = File(...),
    name: str = Form(...),
    description: str = Form(default=""),
    engagement_type: str = Form(default="general"),
    db: AsyncSession = Depends(get_db),
    _: str = Depends(get_current_user_sub),
):
    """Upload a sample architecture diagram (PNG/JPG/PDF)."""
    allowed = [".png", ".jpg", ".jpeg", ".pdf"]
    ext = "." + file.filename.rsplit(".", 1)[-1].lower() if file.filename and "." in file.filename else ""
    if ext not in allowed:
        raise HTTPException(status_code=400, detail="File must be PNG, JPG, or PDF")

    content = await file.read()
    if len(content) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="File too large (max 20MB)")

    ref_id = uuid.uuid4()
    s3_key = f"arch-references/{ref_id}/{file.filename}"
    if ext == ".png":
        content_type = "image/png"
    elif ext in [".jpg", ".jpeg"]:
        content_type = "image/jpeg"
    else:
        content_type = "application/pdf"

    upload_file(content, s3_key, content_type)

    await db.execute(
        text(
            "INSERT INTO arch_references (id, name, description, engagement_type, s3_key) "
            "VALUES (CAST(:id AS uuid), :name, :desc, :eng, :key)"
        ),
        {"id": str(ref_id), "name": name, "desc": description, "eng": engagement_type, "key": s3_key},
    )
    await db.commit()

    return {"id": str(ref_id), "name": name, "s3_key": s3_key}


@router.delete("/{ref_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_reference(
    ref_id: str,
    db: AsyncSession = Depends(get_db),
    _: str = Depends(get_current_user_sub),
):
    """Delete an architecture reference."""
    row = (await db.execute(
        text("SELECT s3_key FROM arch_references WHERE id = CAST(:id AS uuid)"),
        {"id": ref_id},
    )).mappings().one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Not found")

    try:
        delete_s3_object(row["s3_key"])
    except Exception:
        pass

    await db.execute(
        text("DELETE FROM arch_references WHERE id = CAST(:id AS uuid)"),
        {"id": ref_id},
    )
    await db.commit()
