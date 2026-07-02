"""Generate router — submit generation jobs, poll status, download results."""
import uuid
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from sys import path as sys_path
sys_path.insert(0, "/app")
from shared import (
    GenerationJob, User, GenerationRequest, GenerationJobStatus,
    GenerationJobMessage, JOB_STATUS,
)
from ..core.database import get_db
from ..core.auth import get_current_user_sub
from ..core.s3 import get_presigned_url
from ..core.sqs import publish_job

router = APIRouter()


@router.post("", status_code=status.HTTP_202_ACCEPTED)
async def submit_generation_job(
    request: GenerationRequest,
    db: AsyncSession = Depends(get_db),
    user_sub: str = Depends(get_current_user_sub),
):
    """Submit a new proposal/SoW/case study generation job. Returns a job_id for polling."""
    # Get or create user
    result = await db.execute(select(User).where(User.cognito_sub == user_sub))
    user = result.scalar_one_or_none()
    if not user:
        user = User(cognito_sub=user_sub, email=user_sub)
        db.add(user)
        await db.flush()

    # Create job record
    job_id = uuid.uuid4()
    job = GenerationJob(
        id=job_id,
        user_id=user.id,
        document_type=request.document_type,
        client_name=request.client_name,
        engagement_type=request.engagement_type,
        key_requirements=request.key_requirements,
        context_notes=request.context_notes,
        status=JOB_STATUS["QUEUED"],
    )
    db.add(job)
    await db.flush()

    # Publish to SQS worker
    msg = GenerationJobMessage(
        job_id=str(job_id),
        document_type=request.document_type,
        client_name=request.client_name,
        engagement_type=request.engagement_type,
        key_requirements=request.key_requirements,
        context_notes=request.context_notes,
        user_id=str(user.id),
    )
    publish_job(msg.model_dump())

    return {"job_id": str(job_id), "status": JOB_STATUS["QUEUED"]}


@router.get("/{job_id}", response_model=GenerationJobStatus)
async def get_job_status(
    job_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user_sub: str = Depends(get_current_user_sub),
):
    """Poll generation job status. Returns download_url when complete."""
    result = await db.execute(select(GenerationJob).where(GenerationJob.id == job_id))
    job = result.scalar_one_or_none()

    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")

    # Force SQLAlchemy to reload all columns (handles ALTER TABLE-added columns)
    await db.refresh(job)

    # Build response with cost calculation
    download_url = None
    if job.status == JOB_STATUS["COMPLETE"] and job.output_s3_key:
        download_url = get_presigned_url(job.output_s3_key)

    # Claude Sonnet 4.6 pricing (us-east-1):
    # Input:  $0.003 per 1K tokens
    # Output: $0.015 per 1K tokens
    INPUT_PRICE_PER_1K  = 0.003
    OUTPUT_PRICE_PER_1K = 0.015
    input_tokens  = job.input_tokens  or 0
    output_tokens = job.output_tokens or 0
    llm_cost_usd = round(
        (input_tokens  / 1000) * INPUT_PRICE_PER_1K +
        (output_tokens / 1000) * OUTPUT_PRICE_PER_1K,
        6  # 6 decimal places so small amounts show correctly
    )

    return {
        "job_id": str(job.id),
        "status": job.status,
        "status_detail": job.status_detail,
        "rag_context": job.rag_context,
        "tavily_sources": job.tavily_sources,
        "download_url": download_url,
        "error_message": job.error_message,
        "llm_model": job.llm_model or "us.anthropic.claude-sonnet-4-6",
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "llm_cost_usd": llm_cost_usd,
        "created_at": job.created_at.isoformat() if job.created_at else None,
        "completed_at": job.completed_at.isoformat() if job.completed_at else None,
    }
