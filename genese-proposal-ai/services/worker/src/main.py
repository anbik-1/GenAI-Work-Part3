"""
Genese Proposal AI — Worker Service entry point.
SQS consumer loop that processes ingestion and generation jobs.
"""
import json
import time
import uuid
import boto3
import logging
from sqlalchemy import select
from .core.config import get_settings
from .core.database import get_db
from shared import (
    GenerationJob, Document, JOB_STATUS,
    IngestionJobMessage, GenerationJobMessage,
)
from .ingestion.document_loader import load_document_from_s3
from .ingestion.text_splitter import split_text
from .core.bedrock import embed_texts
from .ingestion.embedder import embed_texts_with_usage
from .ingestion.vector_store import upsert_chunks
from .chains.orchestrator import run_generation_pipeline

logging.basicConfig(
    level=logging.INFO,
    format='{"time": "%(asctime)s", "level": "%(levelname)s", "msg": "%(message)s"}',
)
logger = logging.getLogger(__name__)


def process_ingestion_job(db, message: dict) -> None:
    """Download document from S3, chunk it, embed it, and store in pgvector."""
    import time
    msg = IngestionJobMessage(**message)
    logger.info(f"Processing ingestion job: document_id={msg.document_id}")

    doc = db.execute(
        select(Document).where(Document.id == uuid.UUID(msg.document_id))
    ).scalar_one_or_none()

    if not doc:
        logger.error(f"Document {msg.document_id} not found in DB")
        return

    doc.ingestion_status = "processing"
    db.commit()

    try:
        t0 = time.time()

        # Phase 1: Load document from S3
        doc.ingestion_status = "loading"
        db.commit()
        text = load_document_from_s3(msg.s3_key)
        t_load = round(time.time() - t0, 2)
        logger.info(f"[{msg.document_id}] Loaded in {t_load}s")

        # Phase 2: Chunk the text
        doc.ingestion_status = "chunking"
        db.commit()
        t1 = time.time()
        chunks = split_text(text)
        t_chunk = round(time.time() - t1, 2)
        logger.info(f"[{msg.document_id}] Chunked into {len(chunks)} chunks in {t_chunk}s")

        if not chunks:
            logger.warning(f"No chunks extracted from {msg.s3_key}")
            doc.ingestion_status = "failed"
            db.commit()
            return

        # Phase 3: Embed chunks with Titan Text v2
        doc.ingestion_status = "embedding"
        db.commit()
        t2 = time.time()
        embeddings, usage_info = embed_texts_with_usage(chunks)
        t_embed = round(time.time() - t2, 2)
        logger.info(f"[{msg.document_id}] Embedded {len(chunks)} chunks "
                    f"({usage_info.get('input_tokens', 0)} tokens) in {t_embed}s")

        # Phase 4: Store in pgvector
        doc.ingestion_status = "storing"
        db.commit()
        t3 = time.time()
        count = upsert_chunks(db, doc, chunks, embeddings)
        t_store = round(time.time() - t3, 2)
        t_total = round(time.time() - t0, 2)

        # Store final metadata
        doc.embedding_model = usage_info.get("model", "amazon.titan-embed-text-v2:0")
        doc.embedding_tokens = usage_info.get("input_tokens", 0)
        doc.ingestion_status = "complete"
        db.commit()

        logger.info(
            f"[{msg.document_id}] DONE — {count} chunks | "
            f"load={t_load}s chunk={t_chunk}s embed={t_embed}s store={t_store}s total={t_total}s | "
            f"tokens={usage_info.get('input_tokens', 0)} model={usage_info.get('model', '')}"
        )
    except Exception as e:
        import traceback
        logger.error(f"Ingestion failed for {msg.document_id}: {traceback.format_exc()}")
        doc.ingestion_status = "failed"
        db.commit()


def process_generation_job(db, message: dict) -> None:
    """Run the full RAG → validate → generate → format pipeline for a job."""
    msg = GenerationJobMessage(**message)
    logger.info(f"Processing generation job: job_id={msg.job_id}")

    # Retry up to 5 times with backoff — Aurora may not have replicated the write yet
    job = None
    for attempt in range(5):
        try:
            result = db.execute(
                select(GenerationJob).where(
                    GenerationJob.id == uuid.UUID(msg.job_id)
                )
            )
            job = result.scalar_one_or_none()
        except Exception as e:
            logger.warning(f"DB query failed on attempt {attempt+1}: {e}")
        if job:
            break
        logger.info(f"Job {msg.job_id} not found yet, retrying in {2**attempt}s (attempt {attempt+1}/5)")
        time.sleep(2 ** attempt)

    if not job:
        logger.error(f"Generation job {msg.job_id} not found in DB after retries")
        return

    run_generation_pipeline(db=db, job=job)
    logger.info(f"Generation job {msg.job_id} complete — status: {job.status}")


def main():
    """Main SQS consumer loop — runs indefinitely, polling for messages."""
    settings = get_settings()
    sqs = boto3.client("sqs", region_name=settings.aws_region)
    logger.info("Worker started — polling SQS for jobs")

    while True:
        try:
            response = sqs.receive_message(
                QueueUrl=settings.generation_queue_url,
                MaxNumberOfMessages=settings.sqs_max_messages,
                WaitTimeSeconds=settings.sqs_wait_time_seconds,  # long polling
                AttributeNames=["All"],
            )

            messages = response.get("Messages", [])
            if not messages:
                continue  # Long poll — wait cycle, not busy wait

            for sqs_msg in messages:
                receipt_handle = sqs_msg["ReceiptHandle"]
                try:
                    body = json.loads(sqs_msg["Body"])
                    job_type = body.get("job_type", "generation")

                    # Use a fresh DB session per message
                    for db in get_db():
                        if job_type == "ingestion":
                            process_ingestion_job(db, body)
                        else:
                            process_generation_job(db, body)

                    # Delete message on success
                    sqs.delete_message(
                        QueueUrl=settings.generation_queue_url,
                        ReceiptHandle=receipt_handle,
                    )

                except Exception as e:
                    import traceback as _tb
                    logger.error(f"Failed to process message: {e}\nFULL TRACEBACK:\n{_tb.format_exc()}")

        except Exception as e:
            logger.error(f"SQS polling error: {e}")
            time.sleep(5)  # Brief pause before retrying


if __name__ == "__main__":
    main()
