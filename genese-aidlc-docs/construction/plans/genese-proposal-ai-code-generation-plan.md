# Genese Proposal AI — Code Generation Plan

## Unit Context
- **Unit**: genese-proposal-ai (single unit — full system)
- **Code Location**: `/home/ec2-user/environment/genese-proposal-ai`
- **Language**: Python 3.12 (backend + worker + infra) + TypeScript (frontend)
- **Architecture**: ECS Fargate (API + Worker) + Aurora pgvector + Bedrock + SQS

## Target Structure
```
genese-proposal-ai/
├── services/
│   ├── shared/              ← Pydantic models, SQLAlchemy ORM, constants
│   ├── api/                 ← FastAPI application
│   └── worker/              ← LangChain RAG + generation worker
├── frontend/                ← React SPA
├── infrastructure/          ← AWS CDK (Python)
├── scripts/                 ← seed_data.py + synthetic documents
├── templates/               ← genese branded .docx template
└── README.md
```

---

## Code Generation Steps

### Step 1: Project Structure + Shared Package
- [ ] Create root directory structure
- [ ] Create `services/shared/` package (Pydantic models, SQLAlchemy ORM, DB schema, constants)
- [ ] Create `services/shared/models/` — User, Document, DocumentChunk, GenerationJob
- [ ] Create `services/shared/schemas/` — Pydantic request/response schemas
- [ ] Create `services/shared/constants.py` — doc types, engagement types, status values

### Step 2: API Service — Core
- [ ] Create `services/api/requirements.txt`
- [ ] Create `services/api/Dockerfile`
- [ ] Create `services/api/src/core/config.py` — pydantic-settings from Secrets Manager/env
- [ ] Create `services/api/src/core/database.py` — async SQLAlchemy engine + session
- [ ] Create `services/api/src/core/auth.py` — Cognito JWT middleware
- [ ] Create `services/api/src/core/s3.py` — S3 helpers (upload, presigned URLs)
- [ ] Create `services/api/src/core/sqs.py` — SQS job publisher
- [ ] Create `services/api/src/main.py` — FastAPI app, CORS, router registration

### Step 3: API Service — Routers
- [ ] Create `services/api/src/routers/health.py` — GET /health
- [ ] Create `services/api/src/routers/documents.py` — upload, list, delete
- [ ] Create `services/api/src/routers/generate.py` — submit job, poll status, download
- [ ] Create `services/api/src/routers/search.py` — semantic search endpoint
- [ ] Create `services/api/src/routers/jobs.py` — list jobs for user

### Step 4: Worker Service — Core + Ingestion
- [ ] Create `services/worker/requirements.txt`
- [ ] Create `services/worker/Dockerfile`
- [ ] Create `services/worker/src/core/config.py`
- [ ] Create `services/worker/src/core/database.py`
- [ ] Create `services/worker/src/core/bedrock.py` — Bedrock client (LLM + embeddings)
- [ ] Create `services/worker/src/core/redis_cache.py` — ElastiCache Redis client
- [ ] Create `services/worker/src/ingestion/document_loader.py` — load PDF/DOCX/TXT from S3
- [ ] Create `services/worker/src/ingestion/text_splitter.py` — LangChain chunking
- [ ] Create `services/worker/src/ingestion/embedder.py` — Titan Text v2 embeddings
- [ ] Create `services/worker/src/ingestion/vector_store.py` — pgvector upsert

### Step 5: Worker Service — RAG + Generation Chains
- [ ] Create `services/worker/src/chains/retrieval_chain.py` — similarity search, top-5 chunks
- [ ] Create `services/worker/src/chains/validation_chain.py` — Tavily search + Redis cache
- [ ] Create `services/worker/src/chains/generation_chain.py` — Claude Sonnet 4.6 LangChain chain
- [ ] Create `services/worker/src/chains/orchestrator.py` — retrieve → validate → generate → format
- [ ] Create `services/worker/src/generation/section_parser.py` — parse Claude JSON output
- [ ] Create `services/worker/src/generation/docx_builder.py` — python-docx template filler
- [ ] Create `services/worker/src/main.py` — SQS consumer loop

### Step 6: Frontend — Setup + Config
- [ ] Create `frontend/package.json` (React, Vite, Tailwind, shadcn/ui)
- [ ] Create `frontend/vite.config.ts`
- [ ] Create `frontend/tailwind.config.ts`
- [ ] Create `frontend/src/styles/globals.css`
- [ ] Create `frontend/src/lib/utils.ts` — cn() utility
- [ ] Create `frontend/src/lib/api.ts` — HTTP client with JWT auth
- [ ] Create `frontend/src/vite-env.d.ts`

### Step 7: Frontend — shadcn/ui Components
- [ ] Create base UI components: button, card, input, label, textarea, select, badge, progress, alert, skeleton, toast/toaster, separator, dialog, table

### Step 8: Frontend — Layout + Auth Context
- [ ] Create `frontend/src/components/layout/` — Navbar, Layout, ThemeProvider
- [ ] Create `frontend/src/contexts/AuthContext.tsx`
- [ ] Create `frontend/src/contexts/JobContext.tsx`

### Step 9: Frontend — Pages
- [ ] Create `frontend/src/pages/LoginPage.tsx`
- [ ] Create `frontend/src/pages/GeneratePage.tsx` — form + live job status polling
- [ ] Create `frontend/src/pages/SearchPage.tsx` — knowledge base Q&A
- [ ] Create `frontend/src/pages/DocumentsPage.tsx` — upload + manage knowledge base
- [ ] Create `frontend/src/pages/HistoryPage.tsx` — past generated documents

### Step 10: Frontend — App Shell
- [ ] Create `frontend/src/App.tsx` — routes + providers
- [ ] Create `frontend/src/main.tsx`
- [ ] Create `frontend/index.html`

### Step 11: Infrastructure (CDK)
- [ ] Create `infrastructure/requirements.txt`
- [ ] Create `infrastructure/app.py` — CDK entry point
- [ ] Create `infrastructure/stacks/genese_stack.py` — full AWS stack:
  VPC, S3, Cognito, Aurora, Redis, SQS, ECR, ECS (API+Worker), ALB, CloudFront, IAM, CloudWatch

### Step 12: Synthetic Seed Data + Templates
- [ ] Create `scripts/seed_documents/` — 10 synthetic Genese-style .txt documents
  (4 proposals, 3 SoWs, 3 case studies)
- [ ] Create `scripts/seed_data.py` — ingestion script
- [ ] Create `templates/genese_proposal_template.docx` — programmatically generated base template

### Step 13: README + DB Migration Script
- [ ] Create `scripts/db_migrate.py` — run pgvector extension + create tables
- [ ] Create `README.md` — setup, architecture, deployment, testing

### Step 14: Code Summary Documentation
- [ ] Create `genese-aidlc-docs/construction/genese-proposal-ai/code/code-generation-summary.md`

---

## Estimated Scope
- **Total Steps**: 14
- **Total Files**: ~90–100
- **Languages**: Python (60%), TypeScript (35%), Other config (5%)
- **Services**: 2 Docker containers + 1 React SPA + 1 CDK stack
