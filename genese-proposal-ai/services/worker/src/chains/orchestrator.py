"""
Generation orchestrator — coordinates the full pipeline:
retrieve → validate → generate → format → upload
"""
import uuid
import json
import logging
import boto3
from datetime import datetime
from sqlalchemy.orm import Session
from shared import GenerationJob, JOB_STATUS
from ..chains.retrieval_chain import retrieve_relevant_chunks, format_rag_context
from ..chains.validation_chain import validate_with_tavily, format_tavily_sources
from ..chains.generation_chain import generate_document
from ..generation.docx_builder import build_docx
from ..core.config import get_settings

logger = logging.getLogger(__name__)


def _update_job_status(db: Session, job: GenerationJob, status: str, detail: str | None = None):
    """Update job status in the database."""
    job.status = status
    job.status_detail = detail
    db.commit()


def run_formatting_pipeline(db, job) -> None:
    """
    Called after user approves the architecture.
    Regenerates the full document sections and builds the final .docx with the diagram.
    """
    settings = get_settings()
    s3 = boto3.client("s3", region_name=settings.aws_region)

    try:
        # Re-run retrieval for proposal sections (quick — already indexed)
        _update_job_status(db, job, JOB_STATUS["RETRIEVING"], "Re-retrieving context for final document...")
        chunks = retrieve_relevant_chunks(
            db=db,
            query=f"{job.document_type} {job.engagement_type} {job.key_requirements}",
            engagement_type=job.engagement_type,
        )
        rag_context_str = format_rag_context(chunks)

        tavily_sources = validate_with_tavily(
            topic=f"{job.client_name} {job.engagement_type}",
            engagement_type=job.engagement_type,
        )
        tavily_context_str = format_tavily_sources(tavily_sources)

        _update_job_status(db, job, JOB_STATUS["DRAFTING"], "Drafting final document...")
        result = generate_document(
            document_type=job.document_type,
            client_name=job.client_name,
            engagement_type=job.engagement_type,
            key_requirements=job.key_requirements,
            rag_context=rag_context_str,
            tavily_sources=tavily_context_str,
            context_notes=job.context_notes,
        )
        sections_content = result["sections"]
        token_usage = result["token_usage"]
        job.llm_model = token_usage.get("model", "")
        job.input_tokens = (job.input_tokens or 0) + token_usage.get("input_tokens", 0)
        job.output_tokens = (job.output_tokens or 0) + token_usage.get("output_tokens", 0)
        job.tavily_sources = tavily_sources
        db.commit()

        # Download architecture PNG from S3 if available
        arch_png_bytes = None
        if job.arch_s3_key:
            try:
                resp = s3.get_object(Bucket=settings.documents_bucket, Key=job.arch_s3_key)
                arch_png_bytes = resp["Body"].read()
            except Exception:
                pass

        _update_job_status(db, job, JOB_STATUS["FORMATTING"], "Formatting final document...")
        docx_bytes = build_docx(
            sections_content=sections_content,
            document_type=job.document_type,
            client_name=job.client_name,
            engagement_type=job.engagement_type,
            sources=tavily_sources,
            arch_png_bytes=arch_png_bytes,
        )

        output_key = f"generated/{job.id}/{job.client_name.replace(' ', '_')}_{job.document_type}.docx"
        s3.put_object(
            Bucket=settings.documents_bucket,
            Key=output_key,
            Body=docx_bytes,
            ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        )

        # Generate PDF version (non-fatal)
        try:
            from ..generation.pdf_builder import build_pdf_from_docx
            pdf_bytes = build_pdf_from_docx(docx_bytes, job.client_name, job.document_type)
            pdf_key = f"generated/{job.id}/{job.client_name.replace(' ', '_')}_{job.document_type}.pdf"
            s3.put_object(
                Bucket=settings.documents_bucket,
                Key=pdf_key,
                Body=pdf_bytes,
                ContentType="application/pdf",
            )
            from sqlalchemy import text as sql_text
            db.execute(
                sql_text("UPDATE generation_jobs SET pdf_s3_key = :key WHERE id = CAST(:id AS uuid)"),
                {"key": pdf_key, "id": str(job.id)},
            )
            db.commit()
        except Exception as pdf_err:
            logger.warning(f"PDF generation failed (non-fatal): {pdf_err}")

        # Score the proposal (non-fatal)
        try:
            from ..chains.scoring_chain import score_proposal
            score_result = score_proposal(
                document_type=job.document_type,
                client_name=job.client_name,
                sections_content=sections_content,
            )
            from sqlalchemy import text as sql_text
            db.execute(
                sql_text(
                    "UPDATE generation_jobs SET proposal_score = CAST(:score AS jsonb) WHERE id = CAST(:id AS uuid)"
                ),
                {"score": json.dumps(score_result), "id": str(job.id)},
            )
            db.commit()
        except Exception:
            pass  # Non-fatal

        job.status = JOB_STATUS["COMPLETE"]
        job.status_detail = "Document ready for download"
        job.output_s3_key = output_key
        job.completed_at = datetime.utcnow()
        db.commit()

    except Exception as e:
        import traceback
        print(f"[orchestrator] Formatting failed: {traceback.format_exc()}")
        job.status = JOB_STATUS["FAILED"]
        job.error_message = str(e)
        job.completed_at = datetime.utcnow()
        db.commit()
        raise


def run_arch_iteration(db, job, feedback: str) -> None:
    """Re-generate the architecture diagram with user feedback, return to awaiting_review."""
    settings = get_settings()
    s3 = boto3.client("s3", region_name=settings.aws_region)

    try:
        _update_job_status(db, job, JOB_STATUS["GENERATING_DIAGRAM"], "Revising architecture based on your feedback...")
        solution_summary = ""
        previous_json = json.dumps(job.arch_json) if job.arch_json else None

        from ..generation.architecture_generator import generate_architecture_diagram
        arch_json, _, png_bytes = generate_architecture_diagram(
            client_name=job.client_name,
            engagement_type=job.engagement_type,
            key_requirements=job.key_requirements,
            solution_summary=solution_summary,
            feedback=feedback,
            previous_json=previous_json,
        )

        arch_s3_key = f"architectures/{job.id}/v{(job.arch_iteration or 0) + 1}.png"
        s3.put_object(
            Bucket=settings.documents_bucket,
            Key=arch_s3_key,
            Body=png_bytes,
            ContentType="image/png",
        )

        from sqlalchemy import text as sql_text
        try:
            db.rollback()
        except Exception:
            pass
        db.execute(
            sql_text("""UPDATE generation_jobs 
                        SET arch_json = CAST(:arch_json AS jsonb),
                            arch_s3_key = :arch_s3_key,
                            arch_iteration = :arch_iteration
                        WHERE id = :job_id"""),
            {
                "arch_json": json.dumps(arch_json),
                "arch_s3_key": arch_s3_key,
                "arch_iteration": (job.arch_iteration or 0) + 1,
                "job_id": str(job.id),
            }
        )
        _update_job_status(db, job, JOB_STATUS["AWAITING_REVIEW"],
                           "Revised architecture ready — please review again")
        db.commit()
        logger.info(f"[orchestrator] Arch iteration saved: {arch_s3_key}")

    except Exception as e:
        import traceback
        print(f"[orchestrator] Arch iteration failed: {traceback.format_exc()}")
        job.status = JOB_STATUS["FAILED"]
        job.error_message = str(e)
        job.completed_at = datetime.utcnow()
        db.commit()
        raise
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
        result = generate_document(
            document_type=job.document_type,
            client_name=job.client_name,
            engagement_type=job.engagement_type,
            key_requirements=job.key_requirements,
            rag_context=rag_context_str,
            tavily_sources=tavily_context_str,
            context_notes=job.context_notes,
        )
        sections_content = result["sections"]
        token_usage = result["token_usage"]

        # Store model and token usage on job
        job.llm_model = token_usage.get("model", "")
        job.input_tokens = token_usage.get("input_tokens", 0)
        job.output_tokens = token_usage.get("output_tokens", 0)
        db.commit()

        # Step 4: Generate architecture diagram
        _update_job_status(db, job, JOB_STATUS["GENERATING_DIAGRAM"], "Designing architecture diagram...")
        solution_summary = sections_content.get("proposed_solution") or sections_content.get("solution") or ""
        if isinstance(solution_summary, str):
            solution_summary = solution_summary[:600]

        # Check if this is a re-iteration (feedback provided)
        feedback = getattr(job, '_arch_feedback', None)
        previous_json = json.dumps(job.arch_json) if job.arch_json else None

        try:
            from ..generation.architecture_generator import generate_architecture_diagram
            arch_json, _, png_bytes = generate_architecture_diagram(
                client_name=job.client_name,
                engagement_type=job.engagement_type,
                key_requirements=job.key_requirements,
                solution_summary=solution_summary,
                feedback=feedback,
                previous_json=previous_json,
            )

            # Upload PNG to S3
            arch_s3_key = f"architectures/{job.id}/v{(job.arch_iteration or 0) + 1}.png"
            s3.put_object(
                Bucket=settings.documents_bucket,
                Key=arch_s3_key,
                Body=png_bytes,
                ContentType="image/png",
            )

            # Write arch data directly via raw SQL to avoid ORM stale column cache
            from sqlalchemy import text as sql_text
            # Rollback any failed transaction before executing
            try:
                db.rollback()
            except Exception:
                pass
            db.execute(
                sql_text("""UPDATE generation_jobs 
                            SET arch_json = CAST(:arch_json AS jsonb),
                                arch_s3_key = :arch_s3_key,
                                arch_iteration = :arch_iteration
                            WHERE id = CAST(:job_id AS uuid)"""),
                {
                    "arch_json": json.dumps(arch_json),
                    "arch_s3_key": arch_s3_key,
                    "arch_iteration": (job.arch_iteration or 0) + 1,
                    "job_id": str(job.id),
                }
            )
            db.commit()
            logger.info(f"[orchestrator] Architecture diagram saved: {arch_s3_key}, PNG={len(png_bytes)} bytes")

        except Exception as arch_err:
            import traceback as _arch_tb
            logger.error(f"[orchestrator] Architecture generation FAILED: {_arch_tb.format_exc()}")
            # Don't fail the whole job — proceed to awaiting_review without diagram

        # Step 5: Pause for user review of architecture
        # Job stays in awaiting_review until user approves or requests changes
        _update_job_status(db, job, JOB_STATUS["AWAITING_REVIEW"],
                           "Architecture ready — please review and approve or request changes")
        # Store sections for use after approval
        job.rag_context = [{"source_document": c["source_document"], "excerpt": c["content"][:300], "similarity_score": c["similarity_score"], "document_type": c["document_type"]} for c in chunks]
        db.commit()

        # ── Worker STOPS here. Resumes when API calls /generate/{id}/approve ──
        return

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
