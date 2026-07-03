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
        template_name=request.template_name,
    )
    publish_job(msg.model_dump())

    return {"job_id": str(job_id), "status": JOB_STATUS["QUEUED"]}


@router.delete("/{job_id}/cancel", status_code=status.HTTP_200_OK)
async def cancel_job(
    job_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user_sub: str = Depends(get_current_user_sub),
):
    """Cancel a queued job. Cannot cancel jobs already being processed."""
    result = await db.execute(select(GenerationJob).where(GenerationJob.id == job_id))
    job = result.scalar_one_or_none()
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")

    # Can only cancel queued jobs — not ones already being processed
    if job.status not in (JOB_STATUS["QUEUED"],):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Cannot cancel job in status '{job.status}'. Only queued jobs can be cancelled."
        )

    from datetime import datetime
    job.status = JOB_STATUS["FAILED"]
    job.error_message = "Cancelled by user"
    job.completed_at = datetime.utcnow()

    return {"job_id": str(job.id), "status": "cancelled"}


@router.post("/{job_id}/retry")
async def retry_job(
    job_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user_sub: str = Depends(get_current_user_sub),
):
    """Retry a failed job with the same parameters."""
    from sqlalchemy import text as sql_text
    from datetime import datetime
    from ..core.sqs import publish_job

    row = (await db.execute(
        sql_text("""SELECT id, status, document_type, client_name, engagement_type,
                           key_requirements, context_notes, user_id
                    FROM generation_jobs WHERE id = :id"""),
        {"id": str(job_id)}
    )).mappings().one_or_none()

    if not row:
        raise HTTPException(status_code=404, detail="Job not found")

    if row["status"] not in ("failed", "complete"):
        raise HTTPException(
            status_code=409,
            detail=f"Can only retry failed or completed jobs (current: {row['status']})"
        )

    # Reset job to queued state, clear previous results
    await db.execute(
        sql_text("""UPDATE generation_jobs SET
            status = 'queued',
            status_detail = NULL,
            error_message = NULL,
            rag_context = NULL,
            tavily_sources = NULL,
            output_s3_key = NULL,
            arch_json = NULL,
            arch_s3_key = NULL,
            arch_iteration = 0,
            llm_model = NULL,
            input_tokens = 0,
            output_tokens = 0,
            completed_at = NULL
            WHERE id = CAST(:id AS uuid)"""),
        {"id": str(job_id)}
    )

    # Re-publish to SQS
    from shared import GenerationJobMessage
    msg = GenerationJobMessage(
        job_type="generation",
        job_id=str(job_id),
        document_type=row["document_type"],
        client_name=row["client_name"],
        engagement_type=row["engagement_type"],
        key_requirements=row["key_requirements"],
        context_notes=row["context_notes"],
        user_id=str(row["user_id"]) if row["user_id"] else "",
        # template_name is not persisted in the DB; user must re-select if needed
        template_name=None,
    )
    publish_job(msg.model_dump())

    return {"job_id": str(job_id), "status": "queued", "message": "Job re-queued successfully"}


@router.post("/extract-requirements")
async def extract_requirements(
    body: dict,
    _: str = Depends(get_current_user_sub),
):
    """Use Claude to extract structured requirements from pasted text."""
    import boto3, json
    from ..core.config import get_settings
    from shared import BEDROCK_LLM_MODEL_ID
    settings = get_settings()
    input_text = body.get("text", "")[:3000]
    if not input_text.strip():
        raise HTTPException(status_code=400, detail="No text provided")

    bedrock = boto3.client("bedrock-runtime", region_name=settings.aws_region)
    prompt = f"""Extract structured proposal requirements from this text. Return ONLY JSON:
{{"client_name": "company name if found or null", "key_requirements": "comprehensive requirements paragraph", "context_notes": "any technical constraints or preferences", "engagement_type": "one of: aws_migration, data_platform, managed_services, security_audit, devops_transformation, ai_ml_platform, cloud_native_development, finops_optimization, cloud_adoption, disaster_recovery, cloud_optimization, other"}}

Text to analyze:
{input_text}"""

    resp = bedrock.invoke_model(
        modelId=BEDROCK_LLM_MODEL_ID,
        body=json.dumps({
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 1024,
            "temperature": 0.1,
            "messages": [{"role": "user", "content": prompt}]
        })
    )
    raw = json.loads(resp["body"].read())["content"][0]["text"].strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        raw = raw[4:] if raw.startswith("json") else raw
    return json.loads(raw.strip())


@router.post("/{job_id}/outcome")
async def set_job_outcome(
    job_id: uuid.UUID,
    body: dict,
    db: AsyncSession = Depends(get_db),
    _: str = Depends(get_current_user_sub),
):
    """Set win/loss/pending outcome for a completed job."""
    from sqlalchemy import text as sql_text
    outcome = body.get("outcome", "pending")
    if outcome not in ("won", "lost", "pending"):
        raise HTTPException(status_code=400, detail="outcome must be won, lost, or pending")

    row = (await db.execute(
        sql_text("SELECT id FROM generation_jobs WHERE id = :id"),
        {"id": str(job_id)}
    )).mappings().one_or_none()

    if not row:
        raise HTTPException(status_code=404, detail="Job not found")

    await db.execute(
        sql_text("UPDATE generation_jobs SET outcome = :outcome WHERE id = CAST(:id AS uuid)"),
        {"outcome": outcome, "id": str(job_id)}
    )

    return {"job_id": str(job_id), "outcome": outcome}


@router.get("/{job_id}/architecture")
async def get_architecture(
    job_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _: str = Depends(get_current_user_sub),
):
    """Get architecture diagram preview URL and JSON for a job in awaiting_review."""
    from sqlalchemy import text
    row = (await db.execute(
        text("""SELECT id, status, arch_json, arch_s3_key, arch_iteration 
                FROM generation_jobs WHERE id = :id"""),
        {"id": str(job_id)}
    )).mappings().one_or_none()

    if not row:
        raise HTTPException(status_code=404, detail="Job not found")

    preview_url = None
    if row["arch_s3_key"]:
        preview_url = get_presigned_url(row["arch_s3_key"], expiry_seconds=3600)

    return {
        "job_id": str(row["id"]),
        "status": row["status"],
        "arch_json": row["arch_json"],
        "arch_s3_key": row["arch_s3_key"],
        "arch_iteration": row["arch_iteration"] or 0,
        "preview_url": preview_url,
    }


@router.post("/{job_id}/approve")
async def approve_architecture(
    job_id: uuid.UUID,
    body: dict = None,
    db: AsyncSession = Depends(get_db),
    _: str = Depends(get_current_user_sub),
):
    """Approve the architecture — triggers final document formatting.
    Accepts optional body: { sme_review_enabled: bool }
    """
    from sqlalchemy import text as sql_text
    if body is None:
        body = {}
    sme_review_enabled = bool(body.get("sme_review_enabled", False))

    row = (await db.execute(
        sql_text("SELECT id, status FROM generation_jobs WHERE id = :id"),
        {"id": str(job_id)}
    )).mappings().one_or_none()

    if not row:
        raise HTTPException(status_code=404, detail="Job not found")

    if row["status"] != "awaiting_review":
        raise HTTPException(
            status_code=409,
            detail=f"Job is not awaiting review (current status: {row['status']})"
        )

    # Publish "format" job with sme_review_enabled flag
    from ..core.sqs import publish_job
    publish_job({"job_type": "format", "job_id": str(job_id), "sme_review_enabled": sme_review_enabled})

    await db.execute(
        sql_text("UPDATE generation_jobs SET status='queued', status_detail='Approved — formatting document...' WHERE id=:id"),
        {"id": str(job_id)}
    )

    return {"job_id": str(job_id), "status": "queued", "message": "Architecture approved. Generating final document..."}


@router.post("/{job_id}/iterate-architecture")
async def iterate_architecture(
    job_id: uuid.UUID,
    body: dict,
    db: AsyncSession = Depends(get_db),
    _: str = Depends(get_current_user_sub),
):
    """Request architecture changes with feedback."""
    feedback = body.get("feedback", "")
    if not feedback.strip():
        raise HTTPException(status_code=400, detail="Feedback is required")

    from sqlalchemy import text as sql_text
    row = (await db.execute(
        sql_text("SELECT id, status FROM generation_jobs WHERE id = :id"),
        {"id": str(job_id)}
    )).mappings().one_or_none()

    if not row:
        raise HTTPException(status_code=404, detail="Job not found")

    if row["status"] != "awaiting_review":
        raise HTTPException(status_code=409, detail="Job is not awaiting review")

    # Send iteration job to SQS
    from ..core.sqs import publish_job
    publish_job({"job_type": "arch_iterate", "job_id": str(job_id), "feedback": feedback})

    await db.execute(
        sql_text("UPDATE generation_jobs SET status='generating_diagram', status_detail='Revising architecture...' WHERE id=:id"),
        {"id": str(job_id)}
    )

    return {"job_id": str(job_id), "status": "generating_diagram", "message": "Revising architecture based on your feedback..."}


@router.get("/{job_id}")
async def get_job_status(
    job_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user_sub: str = Depends(get_current_user_sub),
):
    """Poll generation job status. Returns download_url when complete."""
    from sqlalchemy import text

    # Use raw SQL to avoid async ORM stale column metadata issues with ALTER TABLE columns
    row = (await db.execute(
        text("""SELECT id, status, status_detail, rag_context, tavily_sources,
                       output_s3_key, pdf_s3_key, error_message, llm_model,
                       input_tokens, output_tokens, created_at, completed_at,
                       proposal_score, outcome, sections_content, drawio_s3_key
                FROM generation_jobs WHERE id = :job_id"""),
        {"job_id": str(job_id)}
    )).mappings().one_or_none()

    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")

    # Build download URLs if complete
    download_url = None
    pdf_download_url = None
    if row["status"] == JOB_STATUS["COMPLETE"]:
        if row["output_s3_key"]:
            download_url = get_presigned_url(row["output_s3_key"])
        if row["pdf_s3_key"]:
            pdf_download_url = get_presigned_url(row["pdf_s3_key"])

    # Cost calculation
    INPUT_PRICE_PER_1K  = 0.003
    OUTPUT_PRICE_PER_1K = 0.015
    input_tokens  = row["input_tokens"]  or 0
    output_tokens = row["output_tokens"] or 0
    llm_cost_usd = round(
        (input_tokens  / 1000) * INPUT_PRICE_PER_1K +
        (output_tokens / 1000) * OUTPUT_PRICE_PER_1K,
        6
    )

    return {
        "job_id": str(row["id"]),
        "status": row["status"],
        "status_detail": row["status_detail"],
        "rag_context": row["rag_context"],
        "tavily_sources": row["tavily_sources"],
        "download_url": download_url,
        "pdf_download_url": pdf_download_url,
        "error_message": row["error_message"],
        "llm_model": row["llm_model"] or "us.anthropic.claude-sonnet-4-6",
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "llm_cost_usd": llm_cost_usd,
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
        "completed_at": row["completed_at"].isoformat() if row["completed_at"] else None,
        "proposal_score": row["proposal_score"] if "proposal_score" in row.keys() else None,
        "outcome": row["outcome"] if "outcome" in row.keys() else None,
        "sections_content": row["sections_content"] if "sections_content" in row.keys() else None,
        "drawio_download_url": get_presigned_url(row["drawio_s3_key"], expiry_seconds=3600) if row.get("drawio_s3_key") else None,
    }
