"""
Generation orchestrator — coordinates the full pipeline:
retrieve → validate → generate → format → upload
"""
import uuid
import boto3
from datetime import datetime
from sqlalchemy.orm import Session
from shared import GenerationJob, JOB_STATUS
from ..chains.retrieval_chain import retrieve_relevant_chunks, format_rag_context
from ..chains.validation_chain import validate_with_tavily, format_tavily_sources
from ..chains.generation_chain import generate_document
from ..generation.docx_builder import build_docx
from ..core.config import get_settings


def _update_job_status(db: Session, job: GenerationJob, status: str, detail: str | None = None):
    """Update job status in the database."""
    job.status = status
    job.status_detail = detail
    db.commit()


def run_generation_pipeline(
    db: Session,
    job: GenerationJob,
) -> None:
    """
    Full proposal generation pipeline. Updates job status at each step.
    On completion, uploads .docx to S3 and marks job complete.
    On failure, records the error and marks job failed.
    """
    settings = get_settings()
    s3 = boto3.client("s3", region_name=settings.aws_region)

    try:
        # Step 1: Retrieve relevant past work
        _update_job_status(db, job, JOB_STATUS["RETRIEVING"], "Searching knowledge base...")
        chunks = retrieve_relevant_chunks(
            db=db,
            query=f"{job.document_type} {job.engagement_type} {job.key_requirements}",
            engagement_type=job.engagement_type,
        )
        rag_context_str = format_rag_context(chunks)

        # Store RAG context on job for UI transparency
        job.rag_context = [
            {
                "source_document": c["source_document"],
                "excerpt": c["content"][:300],
                "similarity_score": c["similarity_score"],
                "document_type": c["document_type"],
            }
            for c in chunks
        ]
        db.commit()

        # Step 2: Validate with Tavily
        _update_job_status(db, job, JOB_STATUS["VALIDATING"], "Validating against official documentation...")
        tavily_sources = validate_with_tavily(
            topic=f"{job.client_name} {job.engagement_type}",
            engagement_type=job.engagement_type,
        )
        tavily_context_str = format_tavily_sources(tavily_sources)

        job.tavily_sources = tavily_sources
        db.commit()

        # Step 3: Generate document content with Claude
        _update_job_status(db, job, JOB_STATUS["DRAFTING"], "Drafting document with AI...")
        sections_content = generate_document(
            document_type=job.document_type,
            client_name=job.client_name,
            engagement_type=job.engagement_type,
            key_requirements=job.key_requirements,
            rag_context=rag_context_str,
            tavily_sources=tavily_context_str,
            context_notes=job.context_notes,
        )

        # Step 4: Format into branded .docx
        _update_job_status(db, job, JOB_STATUS["FORMATTING"], "Formatting branded document...")
        docx_bytes = build_docx(
            sections_content=sections_content,
            document_type=job.document_type,
            client_name=job.client_name,
            engagement_type=job.engagement_type,
            sources=tavily_sources,
        )

        # Step 5: Upload to S3
        output_key = f"generated/{job.id}/{job.client_name.replace(' ', '_')}_{job.document_type}.docx"
        s3.put_object(
            Bucket=settings.documents_bucket,
            Key=output_key,
            Body=docx_bytes,
            ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        )

        # Mark complete
        job.status = JOB_STATUS["COMPLETE"]
        job.status_detail = "Document ready for download"
        job.output_s3_key = output_key
        job.completed_at = datetime.utcnow()
        db.commit()

    except Exception as e:
        import traceback
        full_error = traceback.format_exc()
        print(f"[orchestrator] FULL ERROR:\n{full_error}")
        job.status = JOB_STATUS["FAILED"]
        job.error_message = str(e)
        job.completed_at = datetime.utcnow()
        db.commit()
        raise
