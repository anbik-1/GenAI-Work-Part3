"""
Generation orchestrator — coordinates the full pipeline:
retrieve → validate → draft → diagram → [SME review] → await_review → format → upload

KEY DESIGN:
- Sections are drafted ONCE in run_generation_pipeline, stored in sections_content column
- run_formatting_pipeline reuses stored sections — never re-drafts
- Tavily validation runs once upfront; its purpose is to ground Claude in real AWS docs
- SME review is an optional step (controlled by sme_review_enabled flag in job message)
- Architecture iteration only re-generates the diagram, NOT the document
"""
import json
import logging
import boto3
from datetime import datetime
from sqlalchemy.orm import Session
from sqlalchemy import text as sql_text
from shared import GenerationJob, JOB_STATUS
from ..chains.retrieval_chain import retrieve_relevant_chunks, format_rag_context
from ..chains.validation_chain import validate_with_tavily, format_tavily_sources
from ..chains.generation_chain import generate_document
from ..generation.docx_builder import build_docx
from ..core.config import get_settings

logger = logging.getLogger(__name__)


def _update_job_status(db: Session, job: GenerationJob, status: str, detail: str | None = None):
    job.status = status
    job.status_detail = detail
    db.commit()


def _load_sections(db: Session, job_id: str) -> dict | None:
    """Load stored sections_content from DB (avoids re-drafting on format step)."""
    row = db.execute(
        sql_text("SELECT sections_content FROM generation_jobs WHERE id = CAST(:id AS uuid)"),
        {"id": job_id}
    ).mappings().one_or_none()
    if row and row["sections_content"]:
        return row["sections_content"]
    return None


def _save_sections(db: Session, job_id: str, sections: dict) -> None:
    """Persist sections_content to DB so format step can reuse without re-drafting."""
    try:
        db.rollback()
    except Exception:
        pass
    db.execute(
        sql_text("UPDATE generation_jobs SET sections_content = CAST(:s AS jsonb) WHERE id = CAST(:id AS uuid)"),
        {"s": json.dumps(sections), "id": job_id}
    )
    db.commit()


def run_sme_review(db: Session, job: GenerationJob, sections: dict) -> None:
    """
    SME (Subject Matter Expert) review step — interactive mode.

    Calls run_sme_review_chain() which now returns a structured REPORT
    (findings, discrepancies, proposed_improvements, score).

    Saves the report to the sme_report JSONB column and sets the job
    status to 'sme_reviewing' so the pipeline PAUSES here.

    The user must then call POST /generate/{job_id}/sme-apply (apply=True/False)
    to either apply improvements or skip, both of which enqueue a 'sme_apply'
    SQS message to continue the pipeline into formatting.
    """
    from ..chains.sme_chain import run_sme_review_chain
    _update_job_status(db, job, "sme_reviewing",
                       f"SME reviewing document for {job.engagement_type.replace('_', ' ').title()} domain...")
    try:
        report = run_sme_review_chain(
            document_type=job.document_type,
            client_name=job.client_name,
            engagement_type=job.engagement_type,
            key_requirements=job.key_requirements,
            sections=sections,
        )

        # Persist the report to sme_report JSONB column
        try:
            db.rollback()
        except Exception:
            pass
        db.execute(
            sql_text(
                "UPDATE generation_jobs SET sme_report = CAST(:r AS jsonb) WHERE id = CAST(:id AS uuid)"
            ),
            {"r": json.dumps(report), "id": str(job.id)},
        )
        db.commit()

        # Leave status as 'sme_reviewing' — the pipeline intentionally pauses here.
        # apply_sme_changes() (triggered by the /sme-apply endpoint) will continue to formatting.
        logger.info(
            f"[orchestrator] SME report saved for job {job.id} — "
            f"score={report.get('overall_score')}, "
            f"findings={len(report.get('findings', []))}"
        )

    except Exception as e:
        logger.warning(f"[orchestrator] SME review failed (non-fatal): {e} — skipping to formatting")
        # If SME review itself fails, proceed directly to formatting without improvements
        _enqueue_format(str(job.id))


def apply_sme_changes(db: Session, job: GenerationJob, apply: bool) -> None:
    """
    Called when the user responds to the SME review panel.

    If apply=True:  merge proposed_improvements into sections_content and save.
    If apply=False: leave sections_content unchanged (skip improvements).
    Either way, enqueue a 'format' SQS message to continue the pipeline.
    """
    from ..chains.sme_chain import apply_sme_improvements

    if apply:
        # Load current sections
        row = db.execute(
            sql_text(
                "SELECT sections_content, sme_report FROM generation_jobs WHERE id = CAST(:id AS uuid)"
            ),
            {"id": str(job.id)},
        ).mappings().one_or_none()

        if row and row["sections_content"] and row["sme_report"]:
            improved_sections = apply_sme_improvements(
                sections=row["sections_content"],
                report=row["sme_report"],
            )
            _save_sections(db, str(job.id), improved_sections)
            logger.info(f"[orchestrator] SME improvements applied for job {job.id}")
        else:
            logger.warning(
                f"[orchestrator] apply_sme_changes: missing sections or report for job {job.id} — continuing without apply"
            )

    # Enqueue the format job so the pipeline continues
    _enqueue_format(str(job.id))
    _update_job_status(db, job, "queued", "SME review complete — formatting document...")
    logger.info(f"[orchestrator] SME apply done (apply={apply}) for job {job.id} — format job enqueued")


def _enqueue_format(job_id: str) -> None:
    """Publish a 'format' SQS message to continue the pipeline after SME review."""
    settings = get_settings()
    sqs = boto3.client("sqs", region_name=settings.aws_region)
    sqs.send_message(
        QueueUrl=settings.generation_queue_url,
        MessageBody=json.dumps({"job_type": "format", "job_id": job_id, "sme_review_enabled": False}),
    )


def run_formatting_pipeline(db: Session, job: GenerationJob, sme_review_enabled: bool = False) -> None:
    """
    Called AFTER user approves the architecture diagram (or after SME apply step).
    Reuses the sections_content stored during the initial draft — does NOT re-draft.

    When sme_review_enabled=True the pipeline now PAUSES at 'sme_reviewing' status:
    run_sme_review() saves the report and the job waits for the user to call
    POST /generate/{job_id}/sme-apply before formatting continues.
    """
    settings = get_settings()
    s3 = boto3.client("s3", region_name=settings.aws_region)

    try:
        # Load sections drafted in run_generation_pipeline — NO re-draft
        sections_content = _load_sections(db, str(job.id))

        if not sections_content:
            # Fallback: should not happen, but re-draft if sections were lost
            logger.warning(f"[orchestrator] sections_content missing for job {job.id}, re-drafting")
            _update_job_status(db, job, JOB_STATUS["RETRIEVING"], "Re-retrieving context...")
            chunks = retrieve_relevant_chunks(
                db=db,
                query=f"{job.document_type} {job.engagement_type} {job.key_requirements}",
                engagement_type=job.engagement_type,
            )
            rag_str = format_rag_context(chunks)
            tavily = validate_with_tavily(
                topic=f"{job.client_name} {job.engagement_type}",
                engagement_type=job.engagement_type,
            )
            _update_job_status(db, job, JOB_STATUS["DRAFTING"], "Re-drafting document...")
            result = generate_document(
                document_type=job.document_type,
                client_name=job.client_name,
                engagement_type=job.engagement_type,
                key_requirements=job.key_requirements,
                rag_context=rag_str,
                tavily_sources=format_tavily_sources(tavily),
                context_notes=job.context_notes,
            )
            sections_content = result["sections"]
            _save_sections(db, str(job.id), sections_content)
        else:
            logger.info(f"[orchestrator] Reusing stored sections for job {job.id} — no re-draft needed")

        # SME review — now interactive: generates report, saves it, and PAUSES.
        # The pipeline returns here; apply_sme_changes() (via /sme-apply endpoint)
        # will re-enqueue a 'format' job (with sme_review_enabled=False) to continue.
        if sme_review_enabled:
            run_sme_review(db, job, sections_content)
            return  # Pipeline intentionally pauses here waiting for user decision

        # Download architecture PNG
        arch_png_bytes = None
        if job.arch_s3_key:
            try:
                resp = s3.get_object(Bucket=settings.documents_bucket, Key=job.arch_s3_key)
                arch_png_bytes = resp["Body"].read()
            except Exception:
                pass

        _update_job_status(db, job, JOB_STATUS["FORMATTING"], "Formatting final .docx...")
        docx_bytes = build_docx(
            sections_content=sections_content,
            document_type=job.document_type,
            client_name=job.client_name,
            engagement_type=job.engagement_type,
            sources=job.tavily_sources or [],
            arch_png_bytes=arch_png_bytes,
            template_name=getattr(job, "template_name", None),
        )

        output_key = f"generated/{job.id}/{job.client_name.replace(' ', '_')}_{job.document_type}.docx"
        s3.put_object(
            Bucket=settings.documents_bucket,
            Key=output_key,
            Body=docx_bytes,
            ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        )

        # PDF generation (non-fatal)
        try:
            from ..generation.pdf_builder import build_pdf_from_docx
            pdf_bytes = build_pdf_from_docx(docx_bytes, job.client_name, job.document_type)
            pdf_key = f"generated/{job.id}/{job.client_name.replace(' ', '_')}_{job.document_type}.pdf"
            s3.put_object(Bucket=settings.documents_bucket, Key=pdf_key, Body=pdf_bytes, ContentType="application/pdf")
            try:
                db.rollback()
            except Exception:
                pass
            db.execute(
                sql_text("UPDATE generation_jobs SET pdf_s3_key = :k WHERE id = CAST(:id AS uuid)"),
                {"k": pdf_key, "id": str(job.id)}
            )
            db.commit()
        except Exception as pdf_err:
            logger.warning(f"[orchestrator] PDF generation failed (non-fatal): {pdf_err}")

        # Proposal scoring (non-fatal)
        try:
            from ..chains.scoring_chain import score_proposal
            score = score_proposal(job.document_type, job.client_name, sections_content)
            try:
                db.rollback()
            except Exception:
                pass
            db.execute(
                sql_text("UPDATE generation_jobs SET proposal_score = CAST(:s AS jsonb) WHERE id = CAST(:id AS uuid)"),
                {"s": json.dumps(score), "id": str(job.id)}
            )
            db.commit()
        except Exception as score_err:
            logger.warning(f"[orchestrator] Scoring failed (non-fatal): {score_err}")

        job.status = JOB_STATUS["COMPLETE"]
        job.status_detail = "Document ready for download"
        job.output_s3_key = output_key
        job.completed_at = datetime.utcnow()
        db.commit()

    except Exception as e:
        import traceback
        logger.error(f"[orchestrator] Formatting failed:\n{traceback.format_exc()}")
        job.status = JOB_STATUS["FAILED"]
        job.error_message = str(e)
        job.completed_at = datetime.utcnow()
        db.commit()
        raise


def run_arch_iteration(db: Session, job: GenerationJob, feedback: str) -> None:
    """
    Re-generate ONLY the architecture diagram with user feedback.
    Document sections are NOT re-drafted — they stay as stored.
    Returns to awaiting_review status.
    """
    settings = get_settings()
    s3 = boto3.client("s3", region_name=settings.aws_region)

    try:
        _update_job_status(db, job, JOB_STATUS["GENERATING_DIAGRAM"],
                           "Revising architecture based on your feedback...")

        previous_json = json.dumps(job.arch_json) if job.arch_json else None
        from ..generation.architecture_generator import generate_architecture_diagram
        arch_json, _, png_bytes = generate_architecture_diagram(
            client_name=job.client_name,
            engagement_type=job.engagement_type,
            key_requirements=job.key_requirements,
            solution_summary="",
            feedback=feedback,
            previous_json=previous_json,
        )

        arch_s3_key = f"architectures/{job.id}/v{(job.arch_iteration or 0) + 1}.png"
        s3.put_object(Bucket=settings.documents_bucket, Key=arch_s3_key, Body=png_bytes, ContentType="image/png")

        # Generate draw.io XML export alongside PNG
        try:
            from ..generation.drawio_builder import generate_drawio_xml
            drawio_xml = generate_drawio_xml(arch_json)
            drawio_key = f"architectures/{job.id}/v{(job.arch_iteration or 0) + 1}.drawio"
            s3.put_object(Bucket=settings.documents_bucket, Key=drawio_key,
                          Body=drawio_xml.encode("utf-8"), ContentType="application/xml")
            drawio_s3_key = drawio_key
        except Exception as dx_err:
            logger.warning(f"[orchestrator] draw.io export failed (non-fatal): {dx_err}")
            drawio_s3_key = None

        try:
            db.rollback()
        except Exception:
            pass
        db.execute(
            sql_text("""UPDATE generation_jobs
                        SET arch_json = CAST(:arch_json AS jsonb),
                            arch_s3_key = :arch_s3_key,
                            arch_iteration = :arch_iteration,
                            drawio_s3_key = :drawio_s3_key
                        WHERE id = CAST(:job_id AS uuid)"""),
            {
                "arch_json": json.dumps(arch_json),
                "arch_s3_key": arch_s3_key,
                "arch_iteration": (job.arch_iteration or 0) + 1,
                "drawio_s3_key": drawio_s3_key,
                "job_id": str(job.id),
            }
        )
        _update_job_status(db, job, JOB_STATUS["AWAITING_REVIEW"],
                           "Revised architecture ready — please review again")
        db.commit()
        logger.info(f"[orchestrator] Arch iteration saved: {arch_s3_key}")

    except Exception as e:
        import traceback
        logger.error(f"[orchestrator] Arch iteration failed:\n{traceback.format_exc()}")
        job.status = JOB_STATUS["FAILED"]
        job.error_message = str(e)
        job.completed_at = datetime.utcnow()
        db.commit()
        raise


def run_generation_pipeline(db: Session, job: GenerationJob, sme_review_enabled: bool = False, model_id: str | None = None) -> None:
    """
    Full proposal generation pipeline. Steps:
    1. RETRIEVING  — semantic search of knowledge base (past proposals)
    2. VALIDATING  — Tavily web search for live AWS/cloud docs (grounds Claude in facts)
    3. DRAFTING    — Claude generates all proposal sections as JSON, stored in DB
    4. DIAGRAMMING — Claude designs AWS architecture → diagrams renders PNG
    5. [SME]       — Optional: domain expert review using web search (if enabled)
    6. AWAIT_REVIEW— PAUSES: user reviews and approves architecture
       → On approval: run_formatting_pipeline() builds .docx using stored sections

    Args:
        model_id: Optional Bedrock model ID override for this job. If None, the
                  worker resolves via ``BEDROCK_LLM_MODEL_ID`` env var or default.
    """
    settings = get_settings()
    s3 = boto3.client("s3", region_name=settings.aws_region)

    try:
        # ── Step 1: RAG retrieval ───────────────────────────────────────────
        # Why: grounds Claude in Genese's actual past work, not generic content
        _update_job_status(db, job, JOB_STATUS["RETRIEVING"],
                           "Searching knowledge base for relevant past proposals...")
        chunks = retrieve_relevant_chunks(
            db=db,
            query=f"{job.document_type} {job.engagement_type} {job.key_requirements}",
            engagement_type=job.engagement_type,
        )
        rag_context_str = format_rag_context(chunks)
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

        # ── Step 2: Tavily validation ───────────────────────────────────────
        # Why: fetches live AWS/Azure/GCP documentation so Claude references
        # real service names, current pricing tiers, and accurate capabilities.
        # Without this, Claude may cite deprecated services or wrong pricing.
        _update_job_status(db, job, JOB_STATUS["VALIDATING"],
                           "Fetching latest AWS documentation to ground recommendations...")
        tavily_sources = validate_with_tavily(
            topic=f"{job.client_name} {job.engagement_type}",
            engagement_type=job.engagement_type,
        )
        tavily_context_str = format_tavily_sources(tavily_sources)
        job.tavily_sources = tavily_sources
        db.commit()

        # ── Step 3: Draft document ──────────────────────────────────────────
        # Claude generates all sections as structured JSON.
        # Sections are stored so the format step can reuse them — no re-draft.
        _update_job_status(db, job, JOB_STATUS["DRAFTING"],
                           "Claude is drafting your document...")

        # Include generation constraints if set (from the form's steering field)
        full_context = job.context_notes or ""
        if hasattr(job, 'generation_constraints') and job.generation_constraints:
            full_context = f"{full_context}\n\nCONSTRAINTS:\n{job.generation_constraints}".strip()

        result = generate_document(
            document_type=job.document_type,
            client_name=job.client_name,
            engagement_type=job.engagement_type,
            key_requirements=job.key_requirements,
            rag_context=rag_context_str,
            tavily_sources=tavily_context_str,
            context_notes=full_context or None,
            model_id=model_id,
        )
        sections_content = result["sections"]
        token_usage = result["token_usage"]
        job.llm_model = token_usage.get("model", "")
        job.input_tokens = token_usage.get("input_tokens", 0)
        job.output_tokens = token_usage.get("output_tokens", 0)
        db.commit()

        # Persist sections — format step will read these, NOT re-draft
        _save_sections(db, str(job.id), sections_content)

        # ── Step 4: Generate architecture diagram ───────────────────────────
        _update_job_status(db, job, JOB_STATUS["GENERATING_DIAGRAM"],
                           "Designing AWS architecture diagram...")
        solution_summary = sections_content.get("proposed_solution") or sections_content.get("solution") or ""
        if isinstance(solution_summary, str):
            solution_summary = solution_summary[:600]

        try:
            from ..generation.architecture_generator import generate_architecture_diagram
            arch_json, _, png_bytes = generate_architecture_diagram(
                client_name=job.client_name,
                engagement_type=job.engagement_type,
                key_requirements=job.key_requirements,
                solution_summary=solution_summary,
            )

            arch_s3_key = f"architectures/{job.id}/v1.png"
            s3.put_object(Bucket=settings.documents_bucket, Key=arch_s3_key,
                          Body=png_bytes, ContentType="image/png")

            # Generate draw.io XML export
            drawio_s3_key = None
            try:
                from ..generation.drawio_builder import generate_drawio_xml
                drawio_xml = generate_drawio_xml(arch_json)
                drawio_key = f"architectures/{job.id}/v1.drawio"
                s3.put_object(Bucket=settings.documents_bucket, Key=drawio_key,
                              Body=drawio_xml.encode("utf-8"), ContentType="application/xml")
                drawio_s3_key = drawio_key
            except Exception as dx_err:
                logger.warning(f"[orchestrator] draw.io export failed (non-fatal): {dx_err}")

            try:
                db.rollback()
            except Exception:
                pass
            db.execute(
                sql_text("""UPDATE generation_jobs
                            SET arch_json = CAST(:arch_json AS jsonb),
                                arch_s3_key = :arch_s3_key,
                                arch_iteration = 1,
                                drawio_s3_key = :drawio_s3_key
                            WHERE id = CAST(:job_id AS uuid)"""),
                {
                    "arch_json": json.dumps(arch_json),
                    "arch_s3_key": arch_s3_key,
                    "drawio_s3_key": drawio_s3_key,
                    "job_id": str(job.id),
                }
            )
            db.commit()
            logger.info(f"[orchestrator] Architecture saved: {arch_s3_key}")

        except Exception as arch_err:
            logger.error(f"[orchestrator] Architecture generation failed: {arch_err}")
            # Non-fatal — continue to awaiting_review without diagram

        # ── Step 5 (optional): SME review — NOW INTERACTIVE ────────────────
        # run_sme_review() saves the report and sets status to 'sme_reviewing'.
        # The pipeline pauses here; user responds via /sme-apply endpoint.
        # apply_sme_changes() re-enqueues a 'format' message to continue.
        if sme_review_enabled:
            run_sme_review(db, job, sections_content)
            return  # Pipeline pauses — waiting for user's SME decision

        # ── Step 6: Pause — wait for user to approve architecture ───────────
        # run_formatting_pipeline() is called when user clicks Approve
        _update_job_status(db, job, JOB_STATUS["AWAITING_REVIEW"],
                           "Architecture ready — please review and approve or request changes")
        return

    except Exception as e:
        import traceback
        logger.error(f"[orchestrator] Generation pipeline failed:\n{traceback.format_exc()}")
        job.status = JOB_STATUS["FAILED"]
        job.error_message = str(e)
        job.completed_at = datetime.utcnow()
        db.commit()
        raise
