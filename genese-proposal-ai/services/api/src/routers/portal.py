"""Portal router — public (no-auth) access to completed proposals for client sharing."""
import uuid
from fastapi import APIRouter, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
from fastapi import Depends
from ..core.database import get_db
from ..core.s3 import get_presigned_url

router = APIRouter()


@router.get("/{job_id}")
async def get_portal_job(
    job_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
):
    """Public endpoint — returns proposal details for the client portal. No auth required."""
    row = (await db.execute(
        text("""SELECT id, status, document_type, client_name, engagement_type,
                       output_s3_key, pdf_s3_key, created_at, completed_at,
                       proposal_score, outcome
                FROM generation_jobs WHERE id = :job_id"""),
        {"job_id": str(job_id)}
    )).mappings().one_or_none()

    if not row or row["status"] != "complete":
        raise HTTPException(status_code=404, detail="Proposal not found or not yet complete")

    download_url = None
    if row["output_s3_key"]:
        download_url = get_presigned_url(row["output_s3_key"], expiry_seconds=3600)

    pdf_url = None
    try:
        if row["pdf_s3_key"]:
            pdf_url = get_presigned_url(row["pdf_s3_key"], expiry_seconds=3600)
    except Exception:
        pass

    return {
        "job_id": str(row["id"]),
        "status": row["status"],
        "document_type": row["document_type"],
        "client_name": row["client_name"],
        "engagement_type": row["engagement_type"],
        "download_url": download_url,
        "pdf_url": pdf_url,
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
        "completed_at": row["completed_at"].isoformat() if row["completed_at"] else None,
        "proposal_score": row["proposal_score"] if "proposal_score" in row.keys() else None,
    }
