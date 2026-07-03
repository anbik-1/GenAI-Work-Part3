"""Jobs router — list generation job history, scoped by role."""
from typing import Optional
from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, text
from sys import path as sys_path
sys_path.insert(0, "/app")
from shared import GenerationJob, User
from ..core.database import get_db
from ..core.auth import get_current_user_sub

router = APIRouter()


@router.get("")
async def list_jobs(
    all: Optional[bool] = Query(default=False, description="Admin only: return all users' jobs"),
    db: AsyncSession = Depends(get_db),
    user_sub: str = Depends(get_current_user_sub),
):
    """List generation jobs.

    - Members see only their own jobs.
    - Admins see their own jobs by default; pass ?all=true to see everyone's jobs.
    """
    # Resolve the current user (id + role)
    user_row = (
        await db.execute(
            text("SELECT id, role FROM users WHERE cognito_sub = :sub"),
            {"sub": user_sub},
        )
    ).mappings().one_or_none()
    if not user_row:
        return []

    is_admin = user_row["role"] == "admin"
    show_all = is_admin and all  # ?all=true only works for admins

    if show_all:
        # Admin: all jobs across all users
        rows = (
            await db.execute(
                text(
                    """SELECT gj.id, gj.document_type, gj.client_name, gj.engagement_type,
                              gj.status, gj.error_message, gj.outcome,
                              gj.key_requirements, gj.context_notes,
                              gj.created_at, gj.completed_at,
                              u.email AS owner_email, u.name AS owner_name
                       FROM generation_jobs gj
                       LEFT JOIN users u ON u.id = gj.user_id
                       ORDER BY gj.created_at DESC
                       LIMIT 200"""
                )
            )
        ).mappings().all()
    else:
        # Member (or admin viewing their own): filter by user_id
        rows = (
            await db.execute(
                text(
                    """SELECT id, document_type, client_name, engagement_type,
                              status, error_message, outcome,
                              key_requirements, context_notes,
                              created_at, completed_at,
                              NULL AS owner_email, NULL AS owner_name
                       FROM generation_jobs
                       WHERE user_id = CAST(:user_id AS uuid)
                       ORDER BY created_at DESC
                       LIMIT 50"""
                ),
                {"user_id": str(user_row["id"])},
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
            "owner_email": r.get("owner_email"),
            "owner_name": r.get("owner_name"),
        }
        for r in rows
    ]
