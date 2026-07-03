"""Jobs router — list generation job history for the current user."""
from typing import List
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, text
from sys import path as sys_path
sys_path.insert(0, "/app")
from shared import GenerationJob, User, GenerationJobListItem
from ..core.database import get_db
from ..core.auth import get_current_user_sub

router = APIRouter()


@router.get("")
async def list_jobs(
    db: AsyncSession = Depends(get_db),
    user_sub: str = Depends(get_current_user_sub),
):
    """List all generation jobs for the current user, most recent first."""
    # Resolve the user
    user_result = await db.execute(select(User).where(User.cognito_sub == user_sub))
    user = user_result.scalar_one_or_none()
    if not user:
        return []

    # Use raw SQL to include ALTER TABLE columns (outcome, proposal_score, pdf_s3_key)
    # that the ORM mapper may not yet know about.
    rows = (
        await db.execute(
            text(
                """SELECT id, document_type, client_name, engagement_type,
                          status, error_message, outcome,
                          key_requirements, context_notes,
                          created_at, completed_at
                   FROM generation_jobs
                   WHERE user_id = CAST(:user_id AS uuid)
                   ORDER BY created_at DESC
                   LIMIT 50"""
            ),
            {"user_id": str(user.id)},
        )
    ).mappings().all()

    return [
        {
            "job_id": str(r["id"]),
            "document_type": r["document_type"],
            "client_name": r["client_name"],
            "engagement_type": r["engagement_type"],
            "status": r["status"],
            "error_message": r["error_message"],
            "outcome": r["outcome"] if "outcome" in r.keys() else "pending",
            "created_at": r["created_at"].isoformat() if r["created_at"] else None,
            "completed_at": r["completed_at"].isoformat() if r["completed_at"] else None,
            "key_requirements": r["key_requirements"] or "",
            "context_notes": r["context_notes"] or "",
        }
        for r in rows
    ]
