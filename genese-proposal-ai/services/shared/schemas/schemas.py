"""Pydantic schemas for API request/response validation."""
from __future__ import annotations
from datetime import datetime
from typing import Optional, List, Any
from uuid import UUID
from pydantic import BaseModel, Field


# ── Document schemas ─────────────────────────────────────────────────────────

class DocumentUploadResponse(BaseModel):
    document_id: UUID
    filename: str
    document_type: str
    message: str = "Document ingestion queued"


class DocumentListItem(BaseModel):
    id: UUID
    filename: str
    document_type: str
    engagement_type: Optional[str]
    client_name: Optional[str]
    chunk_count: int
    ingestion_status: Optional[str]
    embedding_model: Optional[str]
    embedding_tokens: Optional[int]
    created_at: datetime

    class Config:
        from_attributes = True


class DocumentListResponse(BaseModel):
    documents: List[DocumentListItem]
    total: int


# ── Generation job schemas ────────────────────────────────────────────────────

class GenerationRequest(BaseModel):
    document_type: str = Field(..., pattern="^(proposal|sow|case_study|other)$")
    client_name: str = Field(..., min_length=1, max_length=255)
    engagement_type: str = Field(..., min_length=1, max_length=100)
    key_requirements: str = Field(..., min_length=3)
    context_notes: Optional[str] = None
    generation_constraints: Optional[str] = None
    # Optional: template_type to use (e.g. "proposal"); None means built-in default.
    # Special value: "plain_text" generates a minimal unstyled document
    # (plain headings + body text, no Genese branding, no header/footer).
    template_name: Optional[str] = None
    # Optional: override the Bedrock LLM model for this specific generation job.
    # If not provided, the worker uses BEDROCK_LLM_MODEL_ID env var / default.
    model_id: Optional[str] = None
    # Optional: custom formatting instructions for the plain_text template.
    # Only used when template_name == "plain_text".
    plain_text_instructions: Optional[str] = None


class RagContextItem(BaseModel):
    source_document: str
    excerpt: str
    similarity_score: float
    document_type: str


class TavilySource(BaseModel):
    url: str
    title: str
    excerpt: str


class GenerationJobStatus(BaseModel):
    job_id: UUID
    status: str          # queued, processing, complete, failed
    status_detail: Optional[str]
    rag_context: Optional[List[RagContextItem]]
    tavily_sources: Optional[List[TavilySource]]
    download_url: Optional[str]    # presigned S3 URL when complete
    error_message: Optional[str]
    # Model and token usage
    llm_model: Optional[str]
    input_tokens: Optional[int]
    output_tokens: Optional[int]
    created_at: datetime
    completed_at: Optional[datetime]

    class Config:
        from_attributes = True


class GenerationJobListItem(BaseModel):
    job_id: UUID
    document_type: str
    client_name: str
    engagement_type: str
    status: str
    created_at: datetime
    completed_at: Optional[datetime]

    class Config:
        from_attributes = True


# ── Search schemas ────────────────────────────────────────────────────────────

class SearchRequest(BaseModel):
    query: str = Field(..., min_length=3)
    document_type: Optional[str] = None
    engagement_type: Optional[str] = None
    top_k: int = Field(default=5, ge=1, le=20)


class SearchResult(BaseModel):
    document_id: UUID
    filename: str
    document_type: str
    client_name: Optional[str]
    excerpt: str
    similarity_score: float


class SearchResponse(BaseModel):
    query: str
    answer: str            # AI-synthesized answer
    sources: List[SearchResult]


# ── SQS message schemas ───────────────────────────────────────────────────────

class IngestionJobMessage(BaseModel):
    job_type: str = "ingestion"
    document_id: str
    s3_key: str
    document_type: str
    engagement_type: Optional[str]
    client_name: Optional[str]


class GenerationJobMessage(BaseModel):
    job_type: str = "generation"
    job_id: str
    document_type: str
    client_name: str
    engagement_type: str
    key_requirements: str
    context_notes: Optional[str]
    user_id: str
    # Optional: custom template to use during formatting.
    # Special value: "plain_text" generates a minimal unstyled document.
    template_name: Optional[str] = None
    # Optional: override the Bedrock LLM model for this job.
    # If None, the worker resolves via BEDROCK_LLM_MODEL_ID env var / default.
    model_id: Optional[str] = None
    # Optional: custom formatting instructions for the plain_text template.
    # Only used when template_name == "plain_text".
    plain_text_instructions: Optional[str] = None
