# Application Design — Components

## Component Overview

| Component | Location | Type | Purpose |
|-----------|----------|------|---------|
| API Service | services/api | FastAPI (ECS Fargate) | HTTP API — auth, jobs, search, documents |
| Worker Service | services/worker | Python worker (ECS Fargate) | RAG pipeline, LLM generation, doc output |
| Frontend | frontend/ | React SPA (S3+CloudFront) | Consultant-facing UI |
| Infrastructure | infrastructure/ | AWS CDK (Python) | All AWS resources |
| Shared Models | services/shared | Python package | Pydantic models, SQLAlchemy ORM, constants |

---

## API Service (FastAPI)

**Routers:**
- `POST /auth/token` — exchange Cognito token (validate + return user info)
- `GET /health` — health check (no auth)
- `POST /documents/upload` — upload document for ingestion
- `GET /documents` — list all documents in knowledge base
- `DELETE /documents/{document_id}` — remove document + all its chunks
- `POST /generate` — submit generation job (returns job_id)
- `GET /jobs/{job_id}` — poll job status + result
- `GET /jobs` — list all jobs for current user
- `POST /search` — semantic search over knowledge base
- `GET /download/{job_id}` — get presigned S3 URL for generated .docx

**Core modules:**
- `core/config.py` — settings via pydantic-settings (reads Secrets Manager / env)
- `core/database.py` — SQLAlchemy async engine + session factory
- `core/auth.py` — Cognito JWT validation middleware
- `core/s3.py` — S3 upload/presigned URL helpers
- `core/sqs.py` — SQS message publisher

---

## Worker Service (LangChain)

**SQS Consumer loop:**
- Polls SQS for generation jobs
- Routes to ingestion pipeline OR generation pipeline based on job_type

**Ingestion pipeline** (`ingestion/`):
- `document_loader.py` — load PDF/DOCX/TXT from S3
- `text_splitter.py` — chunk with RecursiveCharacterTextSplitter (512 tokens, 50 overlap)
- `embedder.py` — embed chunks via Bedrock Titan Text v2
- `vector_store.py` — upsert chunks + vectors to pgvector (Aurora)

**Generation pipeline** (`chains/`):
- `retrieval_chain.py` — semantic similarity search, returns top-5 chunks
- `validation_chain.py` — Tavily search for tech validation, with Redis cache
- `generation_chain.py` — LangChain chain: context → Claude Sonnet 4.6 → structured draft
- `orchestrator.py` — coordinates retrieval → validation → generation → formatting

**Document formatting** (`generation/`):
- `docx_builder.py` — fills python-docx template with generated content sections
- `section_parser.py` — parses Claude's structured JSON output into doc sections

**Core modules:**
- `core/config.py` — shared settings
- `core/database.py` — async SQLAlchemy session
- `core/bedrock.py` — Bedrock client (LLM + embeddings)
- `core/redis_cache.py` — ElastiCache Redis client for Tavily cache

---

## Frontend (React + TypeScript)

**Pages:**
- `GeneratePage` — form to create proposal/SoW/case study, live job status polling
- `SearchPage` — knowledge base Q&A with source citations
- `DocumentsPage` — upload, list, delete knowledge base documents
- `HistoryPage` — past generated documents with download links
- `LoginPage` — Cognito hosted UI redirect / token exchange

**Contexts:**
- `AuthContext` — Cognito JWT, user info, login/logout
- `JobContext` — active job tracking, polling interval

**Key components:**
- `GenerationForm` — document type, client, engagement type, requirements textarea
- `JobStatusCard` — real-time progress (queued → retrieving → drafting → formatting → ready)
- `SourcesPanel` — RAG context + Tavily sources used in generation
- `DocumentUploader` — drag-and-drop with progress bar
- `SearchResults` — semantic search results with citations

---

## Database Schema (Aurora PostgreSQL + pgvector)

```sql
-- Enable pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- Users (synced from Cognito)
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cognito_sub VARCHAR(255) UNIQUE NOT NULL,
    email VARCHAR(255) NOT NULL,
    name VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Knowledge base documents
CREATE TABLE documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    filename VARCHAR(500) NOT NULL,
    document_type VARCHAR(50) NOT NULL, -- proposal, sow, case_study, other
    engagement_type VARCHAR(100),       -- aws_migration, data_platform, etc.
    client_name VARCHAR(255),
    s3_key VARCHAR(1000) NOT NULL,
    chunk_count INTEGER DEFAULT 0,
    uploaded_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Document chunks with embeddings
CREATE TABLE document_chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    embedding vector(1536),             -- Titan Text v2 dimension
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Vector similarity index
CREATE INDEX ON document_chunks USING ivfflat (embedding vector_cosine_ops);

-- Generation jobs
CREATE TABLE generation_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id),
    document_type VARCHAR(50) NOT NULL,
    client_name VARCHAR(255) NOT NULL,
    engagement_type VARCHAR(100) NOT NULL,
    key_requirements TEXT NOT NULL,
    context_notes TEXT,
    status VARCHAR(50) DEFAULT 'queued',  -- queued, processing, complete, failed
    status_detail VARCHAR(255),
    rag_context JSONB,                    -- retrieved chunks used
    tavily_sources JSONB,                 -- web sources used
    output_s3_key VARCHAR(1000),          -- path to generated .docx
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);
```
