"""Jobs router — list generation job history for the current user."""
from typing import List
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from sys import path as sys_path
sys_path.insert(0, "/app")
from shared import GenerationJob, User, GenerationJobListItem
from ..core.database import get_db
from ..core.auth import get_current_user_sub

router = APIRouter()


@router.get("", response_model=List[GenerationJobListItem])
async def list_jobs(
    db: AsyncSession = Depends(get_db),
    user_sub: str = Depends(get_current_user_sub),
):
    """List all generation jobs for the current user, most recent first."""
    # Get user
    user_result = await db.execute(select(User).where(User.cognito_sub == user_sub))
    user = user_result.scalar_one_or_none()
    if not user:
        return []

    result = await db.execute(
        select(GenerationJob)
        .where(GenerationJob.user_id == user.id)
        .order_by(GenerationJob.created_at.desc())
        .limit(50)
    )
    jobs = result.scalars().all()

    return [
        GenerationJobListItem(
            job_id=j.id,
            document_type=j.document_type,
            client_name=j.client_name,
            engagement_type=j.engagement_type,
            status=j.status,
            created_at=j.created_at,
            completed_at=j.completed_at,
        )
        for j in jobs
    ]
