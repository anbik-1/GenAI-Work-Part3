# Genese Proposal AI — Architecture Blueprint
**Version**: 1.0 | **Date**: 2026-07-03 | **Status**: Definitive Technical Reference

> This document is the single source of truth for system architecture, infrastructure, data models, code structure, and operational runbooks. It is complete enough to debug any issue, extend any feature, or understand any component without reading source code.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [AWS Infrastructure](#2-aws-infrastructure)
3. [Network & Security Groups](#3-network--security-groups)
4. [Container Services (ECS)](#4-container-services-ecs)
5. [Data Layer](#5-data-layer)
6. [Messaging & Async Processing](#6-messaging--async-processing)
7. [Storage (S3)](#7-storage-s3)
8. [Authentication & Authorization](#8-authentication--authorization)
9. [Frontend & CDN](#9-frontend--cdn)
10. [Code Structure — API Service](#10-code-structure--api-service)
11. [Code Structure — Worker Service](#11-code-structure--worker-service)
12. [Code Structure — Shared & Frontend](#12-code-structure--shared--frontend)
13. [Database Schema](#13-database-schema)
14. [Job Status State Machine](#14-job-status-state-machine)
15. [Request Flow Walkthroughs](#15-request-flow-walkthroughs)
16. [AI/ML Pipeline](#16-aiml-pipeline)
17. [Debug Runbook](#17-debug-runbook)
18. [Symptom → Cause → Fix Reference](#18-symptom--cause--fix-reference)
19. [Extension Guide](#19-extension-guide)

---

## 1. System Overview

Genese Proposal AI is a cloud-native SaaS application that generates professional consulting proposals using Retrieval-Augmented Generation (RAG). Users upload reference documents, which are chunked, embedded, and stored in a vector database. When a proposal is requested, a worker process retrieves semantically similar context, validates it with live web search, generates a structured document via Claude, produces an architecture diagram, formats output as DOCX/PDF, and delivers results through a React frontend.

### Component Topology

```
Browser
  └─► CloudFront (E31C3VQPMUFTQZ)
        ├─► S3 Frontend Bucket (static assets)
        └─► ALB /api/* → StripApiPrefix CF Function → ALB
              └─► ECS API Service (FastAPI, port 8000)
                    ├─► Aurora PostgreSQL (pgvector)
                    ├─► S3 Docs Bucket
                    └─► SQS genese-generation-jobs
                              └─► ECS Worker Service
                                    ├─► Aurora PostgreSQL
                                    ├─► S3 Docs Bucket
                                    ├─► AWS Bedrock (Claude + Titan)
                                    └─► Tavily Web Search API
```

### Technology Stack

| Layer | Technology | Version/Detail |
|---|---|---|
| Frontend | React + TypeScript | Vite build, hosted on S3+CloudFront |
| API | FastAPI (Python) | Async, 9 routers, port 8000 |
| Worker | Python | Sync SQLAlchemy, SQS consumer loop |
| Database | Aurora PostgreSQL Serverless v2 | PostgreSQL 16.4, pgvector extension |
| Vector Search | pgvector | ivfflat index, cosine similarity, dim=1024 |
| LLM | Claude Sonnet 4.6 | Via AWS Bedrock |
| Embeddings | Amazon Titan Text v2 | 1024-dimension vectors |
| Web Search | Tavily API | Proposal fact validation |
| Container Registry | Amazon ECR | Two repos: api, worker |
| Container Orchestration | Amazon ECS Fargate | Two services in private subnets |
| Message Queue | Amazon SQS | FIFO with DLQ |
| CDN | Amazon CloudFront | With custom CF Function |
| Auth | Amazon Cognito | User Pool + JWT validation |
| Secrets | AWS Secrets Manager | DB credentials + Tavily key |

---

## 2. AWS Infrastructure

### Account & Region

| Parameter | Value |
|---|---|
| AWS Account ID | 654654306837 |
| Primary Region | us-east-1 |

### VPC & Subnets

| Resource | ID | CIDR | AZ |
|---|---|---|---|
| VPC | vpc-0dd58bd2463d505d3 | 10.0.0.0/16 | — |
| Private Subnet A | subnet-0e077e24f575cd597 | 10.0.2.0/24 | us-east-1a |
| Private Subnet B | subnet-037ba0886dccac9c3 | 10.0.3.0/24 | us-east-1b |

> All ECS tasks and the Aurora cluster run in private subnets. There are no public subnets for compute. Internet access from private subnets is assumed to be via NAT Gateway (required for Bedrock, Tavily, ECR, S3, SQS, Secrets Manager API calls).

### Load Balancer

| Parameter | Value |
|---|---|
| ALB DNS | Genese-ApiLB-XYr1qAvXxyX7-1479126617.us-east-1.elb.amazonaws.com |
| Target Group Name | Genese-ApiTG-MTNJR71QSRJJ |
| Target Group ARN suffix | f85b6ee52230cb06 |
| Listener | HTTP:80 → forward to target group |
| Health Check | GET /health (routers/health.py) |
| Target Port | 8000 |

### ECR Repositories

| Service | Repository URI |
|---|---|
| API | 654654306837.dkr.ecr.us-east-1.amazonaws.com/genese-proposal-ai-api |
| Worker | 654654306837.dkr.ecr.us-east-1.amazonaws.com/genese-proposal-ai-worker |

### ECS Cluster & Services

| Parameter | Value |
|---|---|
| Cluster Name | genese-proposal-ai |
| Launch Type | Fargate |

| Service | Name | Task Definition | CPU | Memory |
|---|---|---|---|---|
| API | genese-api-service | TD revision 23 | 0.5 vCPU | 1 GB |
| Worker | genese-worker-service | TD revision 27 | 1 vCPU | 2 GB |

Both services run in Private Subnet A and Private Subnet B with their respective security groups. The worker service does not register with any load balancer — it pulls work from SQS.

### CloudWatch Log Groups

| Service | Log Group |
|---|---|
| API | /ecs/genese-api |
| Worker | /ecs/genese-worker |

---

## 3. Network & Security Groups

### Security Group Rules

| SG Name | SG ID | Inbound Rules | Outbound |
|---|---|---|---|
| ALB SG | sg-08cafb5278acfbf68 | 0.0.0.0/0 port 80 (HTTP from internet) | All |
| API SG | sg-0574a979c34caa923 | sg-08cafb5278acfbf68 port 8000 (ALB only) | All |
| Worker SG | sg-06903044b2e9afe46 | None (no inbound) | All |
| DB SG | sg-0820d70f792deffc8 | sg-0574a979c34caa923 port 5432, sg-06903044b2e9afe46 port 5432 | All |

### Traffic Flow Diagram

```
Internet
  │  :80
  ▼
ALB SG (sg-08cafb5278acfbf68)
  │  :8000
  ▼
API SG (sg-0574a979c34caa923)   Worker SG (sg-06903044b2e9afe46)
  │  :5432                              │  :5432
  └──────────────────────────┬──────────┘
                             ▼
                    DB SG (sg-0820d70f792deffc8)
                    Aurora PostgreSQL :5432
```

### Key Security Notes

- The API container is only reachable from the ALB — no direct public access.
- The Worker has zero inbound rules. It initiates all connections outbound (SQS poll, DB write, Bedrock, Tavily).
- The DB is isolated: only API and Worker SGs can reach port 5432.
- All secrets (DB password, Tavily key) are retrieved at runtime from AWS Secrets Manager — never in environment variables or images.

---

## 4. Container Services (ECS)

### API Service — genese-api-service

**Task Definition**: TD:23  
**Image**: `654654306837.dkr.ecr.us-east-1.amazonaws.com/genese-proposal-ai-api`  
**Entrypoint**: `uvicorn main:app --host 0.0.0.0 --port 8000`  
**Network Mode**: awsvpc  
**Subnets**: subnet-0e077e24f575cd597, subnet-037ba0886dccac9c3  
**Security Group**: sg-0574a979c34caa923  

Required environment variables (resolved at container start):

| Variable | Source | Purpose |
|---|---|---|
| DATABASE_URL | Secrets Manager /genese/db-credentials | PostgreSQL async connection string |
| COGNITO_USER_POOL_ID | ECS env | JWT validation (must match Cognito pool) |
| COGNITO_CLIENT_ID | ECS env | Auth flow |
| AWS_DEFAULT_REGION | ECS env | SDK region |
| S3_DOCS_BUCKET | ECS env | genese-proposal-ai-docs-654654306837-us-east-1 |
| SQS_QUEUE_URL | ECS env | https://sqs.us-east-1.amazonaws.com/654654306837/genese-generation-jobs |

### Worker Service — genese-worker-service

**Task Definition**: TD:27  
**Image**: `654654306837.dkr.ecr.us-east-1.amazonaws.com/genese-proposal-ai-worker`  
**Entrypoint**: `python main.py` (blocking SQS poll loop)  
**Network Mode**: awsvpc  
**Subnets**: subnet-0e077e24f575cd597, subnet-037ba0886dccac9c3  
**Security Group**: sg-06903044b2e9afe46  

Required environment variables:

| Variable | Source | Purpose |
|---|---|---|
| DATABASE_URL | Secrets Manager /genese/db-credentials | PostgreSQL sync connection string |
| TAVILY_SECRET_ARN | ECS env | arn:aws:secretsmanager:us-east-1:654654306837:secret:/genese/tavily-api-key-aCxeOs |
| AWS_DEFAULT_REGION | ECS env | Bedrock + S3 region |
| S3_DOCS_BUCKET | ECS env | genese-proposal-ai-docs-654654306837-us-east-1 |
| SQS_QUEUE_URL | ECS env | https://sqs.us-east-1.amazonaws.com/654654306837/genese-generation-jobs |
| BEDROCK_REGION | ECS env | us-east-1 (Bedrock endpoint) |

### IAM Task Role Permissions (required)

Both services need an ECS Task Role with at minimum:

- `secretsmanager:GetSecretValue` on the two secret ARNs
- `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` on both S3 buckets
- `sqs:SendMessage`, `sqs:ReceiveMessage`, `sqs:DeleteMessage` on the SQS queue
- `bedrock:InvokeModel` on Titan and Claude model ARNs (worker only)
- `ecr:GetAuthorizationToken`, `ecr:BatchGetImage` (execution role, for image pull)
- `logs:CreateLogStream`, `logs:PutLogEvents` on the respective log groups

---

## 5. Data Layer

### Aurora PostgreSQL

| Parameter | Value |
|---|---|
| Cluster Identifier | geneseproposalaistack-auroracluster23d869c0-u3dywplmcdan |
| Engine | Aurora PostgreSQL 16.4 |
| Mode | Serverless v2 |
| ACU Range | 0.5 minimum → 4 maximum |
| DB Secret ARN | arn:aws:secretsmanager:us-east-1:654654306837:secret:/genese/db-credentials-yADfjr |
| Extension | pgvector (vector similarity search) |
| Subnets | Private Subnet A + B |
| Security Group | sg-0820d70f792deffc8 |

The DB secret at `/genese/db-credentials-yADfjr` contains a JSON object with keys `username`, `password`, `host`, `port`, `dbname`. The API (`core/config.py`) and Worker (`core/config.py`) both read this secret at startup and construct a SQLAlchemy connection URL.

- **API** uses `asyncpg` driver → async SQLAlchemy engine (non-blocking I/O)
- **Worker** uses `psycopg2` driver → sync SQLAlchemy engine (simpler for long-running pipeline tasks)

### Connection String Format

```
# API (async)
postgresql+asyncpg://username:password@host:5432/dbname

# Worker (sync)
postgresql+psycopg2://username:password@host:5432/dbname
```

### pgvector Index

The `document_chunks` table has a single vector index critical to search performance:

```sql
CREATE INDEX idx_chunks_embedding
ON document_chunks
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 10);
```

- **lists=10**: Appropriate for small-to-medium datasets. Increase to `sqrt(row_count)` as data grows.
- **vector_cosine_ops**: Cosine similarity — matches how Titan embeddings are compared.
- **dimension**: 1024 — must match `EMBEDDING_DIMENSION` in `services/shared/constants.py`.

> **Critical**: If you change embedding models, the dimension must match. A mismatch causes a pgvector error on insert. Current model: Amazon Titan Text v2 → 1024 dims.

---

## 6. Messaging & Async Processing

### SQS Queue

| Parameter | Value |
|---|---|
| Queue Name | genese-generation-jobs |
| Queue URL | https://sqs.us-east-1.amazonaws.com/654654306837/genese-generation-jobs |
| Visibility Timeout | 600 seconds (10 minutes) |
| DLQ Name | genese-generation-jobs-dlq |
| DLQ Max Receive Count | 3 (after 3 failures, message moves to DLQ) |

### Message Schema

A job message published by the API (`core/sqs.py → publish_job`) contains:

```json
{
  "job_id": "<UUID>",
  "job_type": "generation | ingestion | format | arch_iterate",
  "user_id": "<UUID>"
}
```

The worker (`main.py`) reads `job_type` and dispatches to the appropriate pipeline in `chains/orchestrator.py`.

### Worker Consumer Loop

`services/worker/src/main.py` runs an infinite loop:

1. `sqs.receive_message(MaxNumberOfMessages=1, WaitTimeSeconds=20)` — long polling
2. If message received: parse body, dispatch to orchestrator
3. On success: `sqs.delete_message(ReceiptHandle=...)`
4. On exception: do NOT delete → message becomes visible again after visibility timeout
5. After 3 failed deliveries: SQS moves message to DLQ automatically

### Why Visibility Timeout is 600s

Generation jobs (LLM inference + diagram rendering + DOCX formatting) can take 2-8 minutes. The 600s visibility timeout ensures that if the worker crashes mid-job, the message re-appears after 10 minutes for retry — not within seconds, which would cause duplicate processing.

### Job Type → Pipeline Mapping

| job_type | Orchestrator Function | Purpose |
|---|---|---|
| ingestion | (direct in worker) | Chunk + embed document |
| generation | run_generation_pipeline | Full proposal generation |
| format | run_formatting_pipeline | Re-format existing content |
| arch_iterate | run_arch_iteration | Regenerate architecture diagram |

---

## 7. Storage (S3)

### Buckets

| Bucket | Name | Purpose |
|---|---|---|
| Documents | genese-proposal-ai-docs-654654306837-us-east-1 | All user documents, proposals, diagrams, templates |
| Frontend | genese-proposal-ai-frontend-654654306837-us-east-1 | Static React build artifacts |

### S3 Key Patterns — Documents Bucket

| Pattern | Example | Purpose |
|---|---|---|
| `raw/{doc_id}/{filename}` | `raw/abc-123/rfp-acme.pdf` | Original uploaded documents |
| `architectures/{job_id}/v{n}.png` | `architectures/def-456/v1.png` | Architecture diagram PNG (per iteration) |
| `architectures/{job_id}/v{n}.drawio` | `architectures/def-456/v1.drawio` | draw.io XML export (per iteration) |
| `generated/{job_id}/{client}_{type}.docx` | `generated/def-456/Acme_proposal.docx` | Final proposal DOCX |
| `generated/{job_id}/{client}_{type}.pdf` | `generated/def-456/Acme_proposal.pdf` | PDF version |
| `templates/{type}/template.docx` | `templates/proposal/template.docx` | Branded DOCX templates |
| `arch-references/{ref_id}/{filename}` | `arch-references/ghi-789/aws-style.png` | Architecture style reference images |
| `scripts/` | `scripts/migration_v2.sql` | DB migration scripts |

### Access Pattern

- **API** uses `core/s3.py` functions: `upload_file()`, `get_presigned_url()`, `delete_s3_object()`
- **Worker** uses boto3 directly for large binary uploads (PNG, DOCX, PDF)
- **Frontend** receives presigned URLs from the API for direct download — never proxies file content through the API
- **Frontend bucket** is served exclusively via CloudFront — direct S3 access is blocked

---

## 8. Authentication & Authorization

### Cognito User Pool

| Parameter | Value |
|---|---|
| User Pool ID | us-east-1_ThM2KRVkt |
| App Client ID | 19ufsosadrbr5fqlhleargbrbi |
| Region | us-east-1 |
| Auth Flow | AdminInitiateAuth (server-side) + OAuth (Google, if configured) |

### JWT Validation Flow

Every protected API endpoint passes through `core/auth.py`:

1. Extract `Authorization: Bearer <token>` header
2. Decode JWT header to get `kid` (key ID)
3. Fetch JWKS from: `https://cognito-idp.us-east-1.amazonaws.com/us-east-1_ThM2KRVkt/.well-known/jwks.json`
4. Find matching public key by `kid`
5. Verify signature, expiry, audience (`aud` = client ID), issuer (`iss` = pool URL)
6. Extract `sub` claim → look up user in `users` table by `cognito_sub`
7. Return user object to route handler

> **Debug tip**: If all API calls return 401, the `COGNITO_USER_POOL_ID` env var in the API task definition is wrong. The JWKS URL is constructed from this value.

### Auth Endpoints (routers/auth.py)

| Method | Path | Purpose |
|---|---|---|
| POST | /auth/login | Email/password → Cognito AdminInitiateAuth → returns id_token, access_token, refresh_token |
| POST | /auth/signup | Register new user → Cognito + insert users row |
| POST | /auth/refresh | refresh_token → new id_token |
| POST | /auth/forgot-password | Trigger Cognito forgot password flow |

### Token Storage (Frontend)

- Tokens stored in `AuthContext.tsx` (in-memory + localStorage)
- `lib/api.ts` intercepts 401 responses: auto-calls refresh endpoint, retries original request once
- If refresh fails: calls `setLogoutCallback` → redirects to /login

### Public Routes

`routers/portal.py` — GET `/portal/{job_id}` — returns proposal data with no auth required. Used for client-facing shareable links.

---

## 9. Frontend & CDN

### CloudFront Distribution

| Parameter | Value |
|---|---|
| Distribution ID | E31C3VQPMUFTQZ |
| Domain | d3gmhvny3loneb.cloudfront.net |
| Origin 1 | S3 Frontend Bucket (static assets) |
| Origin 2 | ALB DNS (API calls) |

### CloudFront Behaviors

| Path Pattern | Origin | CF Function | Purpose |
|---|---|---|---|
| `/api/*` | ALB | StripApiPrefix | API proxy — strips `/api` before forwarding to ALB |
| `/*` (default) | S3 Frontend | None | Serve React SPA |

### StripApiPrefix CF Function

This CloudFront Function runs on viewer request for `/api/*` paths:

```javascript
// Conceptual behavior:
// Input:  /api/generate/submit
// Output: /generate/submit  (forwarded to ALB)
```

> **Debug tip**: If the browser shows `NetworkError` on API calls, this behavior is misconfigured or missing. Check CloudFront behaviors in the AWS console.

### Frontend Routes (App.tsx)

| Path | Component | Auth Required | Purpose |
|---|---|---|---|
| /login | LoginPage | No | Email/password + Google OAuth |
| /auth/callback | AuthCallbackPage | No | OAuth authorization code exchange |
| /portal/:jobId | PortalPage | No | Public shareable proposal view |
| /generate | GeneratePage | Yes | Submit new proposal job |
| /history | HistoryPage | Yes | View past proposals |
| /documents | DocumentsPage | Yes | Upload/manage reference documents |
| /search | SearchPage | Yes | Semantic RAG search |
| /arch-references | ArchReferencesPage | Yes | Manage architecture style references |

### Frontend Build & Deploy

```bash
# Build
cd frontend
npm run build   # outputs to dist/

# Deploy to S3
aws s3 sync dist/ s3://genese-proposal-ai-frontend-654654306837-us-east-1 --delete

# Invalidate CloudFront cache
aws cloudfront create-invalidation \
  --distribution-id E31C3VQPMUFTQZ \
  --paths "/*" \
  --region us-east-1
```

---

## 10. Code Structure — API Service

All files live under `services/api/src/`.

### Entry Point

**`main.py`** — FastAPI application factory.
- Creates `FastAPI()` app instance
- Configures CORS (allow origins from env, or `*` in dev)
- Registers all 9 routers with their prefixes
- Runs with `uvicorn` on `0.0.0.0:8000`

Router registration order and prefixes:

| Router Module | Prefix | Purpose |
|---|---|---|
| routers/health.py | /health | ALB health check — always returns 200 |
| routers/auth.py | /auth | Cognito auth operations |
| routers/generate.py | /generate | Job submission and lifecycle |
| routers/documents.py | /documents | Document upload and management |
| routers/jobs.py | /jobs | Job history listing |
| routers/search.py | /search | RAG semantic search |
| routers/templates.py | /templates | DOCX template management |
| routers/arch_references.py | /arch-references | Architecture reference images |
| routers/portal.py | /portal | Public job view (no auth) |

### Core Modules

**`core/config.py`** — Pydantic `Settings` class. Reads environment variables at startup. Calls `boto3` Secrets Manager to fetch the DB URL from secret ARN. All other modules import `settings` from here.

**`core/database.py`** — Creates async SQLAlchemy engine using `asyncpg`. Provides `AsyncSession` dependency injected into route handlers via FastAPI `Depends()`.

**`core/auth.py`** — `get_current_user()` dependency. Validates JWT against Cognito JWKS. Returns ORM `User` object. Raises `HTTP 401` on any validation failure.

**`core/s3.py`** — Three functions:
- `upload_file(bucket, key, data)` — uploads bytes to S3
- `get_presigned_url(bucket, key, expiry=3600)` — generates time-limited download URL
- `delete_s3_object(bucket, key)` — deletes object

**`core/sqs.py`** — `publish_job(job_id, job_type, user_id)` — serializes message to JSON, calls `sqs.send_message()` with the queue URL from settings.

### Router Details

**`routers/generate.py`** — Most complex router. Endpoints:

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | /generate/submit | Yes | Create generation_jobs row (status=queued), publish SQS message |
| GET | /generate/status/{job_id} | Yes | Poll job status + status_detail |
| POST | /generate/arch-review/{job_id} | Yes | Submit arch review feedback (triggers arch_iterate job) |
| POST | /generate/approve/{job_id} | Yes | Move job to formatting_output, publish format job to SQS |
| POST | /generate/iterate/{job_id} | Yes | Request new arch iteration |
| POST | /generate/outcome/{job_id} | Yes | Record win/loss outcome |
| POST | /generate/retry/{job_id} | Yes | Re-queue a failed job |
| POST | /generate/cancel/{job_id} | Yes | Mark job cancelled |
| POST | /generate/extract-requirements | Yes | Use Claude to extract requirements from pasted text |

**`routers/documents.py`** — Endpoints:

| Method | Path | Purpose |
|---|---|---|
| POST | /documents/upload | Upload file to S3 raw/, create documents row, publish ingestion job to SQS |
| GET | /documents/ | List all documents for user |
| GET | /documents/{doc_id}/status | Poll ingestion_status |
| DELETE | /documents/{doc_id} | Delete from DB + S3 |

**`routers/search.py`** — `GET /search?query=...&limit=10` — embeds query via Bedrock Titan, runs pgvector cosine similarity against `document_chunks`, returns top-k results with source metadata.

**`routers/portal.py`** — `GET /portal/{job_id}` — no auth dependency. Returns job data + presigned download URLs for DOCX/PDF. Used for client-facing links.

---

## 11. Code Structure — Worker Service

All files live under `services/worker/src/`.

### Entry Point

**`main.py`** — Blocking SQS consumer loop:

```python
while True:
    messages = sqs.receive_message(MaxNumberOfMessages=1, WaitTimeSeconds=20)
    if messages:
        process(message)   # dispatches by job_type
        sqs.delete_message(ReceiptHandle)
    # loop continues — no sleep needed (long polling blocks 20s)
```

Dispatches by `job_type`:
- `ingestion` → document ingestion pipeline
- `generation` → `orchestrator.run_generation_pipeline()`
- `format` → `orchestrator.run_formatting_pipeline()`
- `arch_iterate` → `orchestrator.run_arch_iteration()`

### Core Modules

**`core/bedrock.py`** — boto3 Bedrock runtime client wrapper:
- `get_llm()` — returns configured Bedrock LLM client for Claude Sonnet 4.6
- `embed_texts(texts: list[str]) → list[list[float]]` — calls Titan Text v2, returns 1024-dim embeddings

**`core/config.py`** — Sync settings. Includes `get_tavily_api_key()` which calls Secrets Manager at runtime (not cached globally — called per-job to handle rotation).

**`core/database.py`** — Sync SQLAlchemy engine + `SessionLocal`. Worker uses sync because pipeline steps are sequential and sync is simpler for long-running processes.

### Orchestrator & Chains

**`chains/orchestrator.py`** — Top-level pipeline coordinator. Four public functions:

`run_generation_pipeline(job_id)`:
1. Update status → `retrieving_context`
2. Call `retrieval_chain.retrieve_relevant_chunks()`
3. Update status → `validating_sources`
4. Call `validation_chain.validate_with_tavily()`
5. Update status → `drafting_document`
6. Call `generation_chain.generate_document()`
7. Update status → `generating_diagram`
8. Call `architecture_generator.design_architecture()` + `render_architecture_png()`
9. Call `drawio_builder.generate_drawio_xml()`
10. If SME review requested: update status → `sme_reviewing`, call `sme_chain.run_sme_review_chain()`
11. Update status → `awaiting_review`
12. Call `scoring_chain.score_proposal()`
13. Save all outputs to DB (rag_context, tavily_sources, sections_content, arch_json, arch_s3_key, drawio_s3_key, proposal_score)

`run_formatting_pipeline(job_id)`:
1. Update status → `formatting_output`
2. Call `docx_builder.build_docx()`
3. Call `pdf_builder.build_pdf_from_docx()`
4. Upload DOCX + PDF to S3
5. Update status → `complete`, set output_s3_key, pdf_s3_key, completed_at

`run_arch_iteration(job_id)`:
1. Increment `arch_iteration` counter
2. Re-run `design_architecture()` with review feedback
3. Re-render PNG + drawio XML
4. Upload new versions as `v{n}.png`, `v{n}.drawio`
5. Update status → `awaiting_review`

`run_sme_review(job_id)`:
1. Pass sections_content to `sme_chain.run_sme_review_chain()`
2. Apply SME suggestions to sections_content
3. Continue to `awaiting_review`

**`chains/generation_chain.py`** — `generate_document(job_id, rag_context, tavily_sources, job_params)`:
- Constructs a structured prompt with retrieved context and validated web sources
- Calls Claude Sonnet 4.6 via Bedrock
- Returns structured `sections_content` dict (section name → generated text)
- Records `llm_model`, `input_tokens`, `output_tokens` in DB

**`chains/retrieval_chain.py`** — `retrieve_relevant_chunks(query_text, engagement_type, limit=20)`:
- Embeds query with Titan Text v2
- Runs SQL: `ORDER BY embedding <=> query_embedding LIMIT {limit}`
- Optionally filters by `engagement_type` on the parent `documents` row
- Returns list of chunk dicts with content + metadata

**`chains/validation_chain.py`** — `validate_with_tavily(claims: list[str])`:
- Calls Tavily Search API for each claim
- Maintains in-memory cache (dict keyed by claim text) to avoid duplicate API calls within same job
- Returns `tavily_sources` list with URLs and relevance scores

**`chains/scoring_chain.py`** — `score_proposal(sections_content, job_params)`:
- Calls Claude with the full proposal text
- Claude returns JSON scores on 5 dimensions (stored in `proposal_score` JSONB column)
- Dimensions: relevance, completeness, technical_accuracy, commercial_clarity, presentation

**`chains/sme_chain.py`** — `run_sme_review_chain(sections_content, engagement_type)`:
- Calls Claude prompted as a domain expert SME
- Returns suggested edits and additions per section
- Worker applies suggestions before setting status to `awaiting_review`

### Generation Modules

**`generation/architecture_generator.py`**:
- `design_architecture(job_params, sections_content)` — prompts Claude to return a JSON architecture spec (nodes, edges, layers, labels)
- `render_architecture_png(arch_json)` — uses the `diagrams` Python library (Graphviz backend) to render the JSON spec as a PNG
- Stores `arch_json` in DB column, uploads PNG to `architectures/{job_id}/v{n}.png`

> **Debug tip**: If jobs get stuck at `generating_diagram`, check worker logs for Graphviz errors. The `diagrams` library requires the `graphviz` system package to be installed in the container.

**`generation/drawio_builder.py`**:
- `generate_drawio_xml(arch_json)` — converts arch JSON to mxGraph XML format
- `generate_mermaid(arch_json)` — alternative: generates Mermaid diagram source (for display)
- Uploads XML to `architectures/{job_id}/v{n}.drawio`

**`generation/docx_builder.py`** — `build_docx(job_id, sections_content, template_type)`:
- Checks S3 for `templates/{template_type}/template.docx`
- If found: fills template placeholders with section content using python-docx
- If not found: creates default-styled document
- Returns bytes of finished DOCX

**`generation/pdf_builder.py`** — `build_pdf_from_docx(docx_bytes)`:
- Converts DOCX to PDF using ReportLab
- Returns PDF bytes for upload to S3

### Ingestion Pipeline

**`ingestion/document_loader.py`** — `load_document(doc_id, s3_key)`:
- Downloads file from S3 `raw/{doc_id}/...`
- Extracts text based on file type:
  - `.pdf` → pypdf
  - `.docx` → python-docx
- Returns plain text string

**`ingestion/text_splitter.py`** — Wraps LangChain `RecursiveCharacterTextSplitter`:
- `chunk_size=512` characters
- `chunk_overlap=50` characters
- Returns list of text chunks

**`ingestion/embedder.py`** — `embed_texts_with_usage(texts: list[str])`:
- Batches texts, calls Titan Text v2 via Bedrock
- Returns `(embeddings, token_count)` — token count stored in `documents.embedding_tokens`

**`ingestion/vector_store.py`** — `upsert_chunks(document_id, chunks, embeddings)`:
- Deletes existing chunks for document (handles re-ingestion)
- Bulk inserts `document_chunks` rows
- Updates `documents.chunk_count` and `ingestion_status = 'complete'`

### Document Ingestion Status Progression

```
pending → loading → chunking → embedding → storing → complete
                                                    ↘ failed (any step)
```

Each step updates `documents.ingestion_status` in DB so the frontend can show a 4-phase progress indicator.

**`db_migration_v2.py`** — Standalone migration script. Run once manually (or via ECS task) to apply schema changes: `ALTER TABLE generation_jobs ADD COLUMN ...` and `CREATE TABLE arch_references`. See `scripts/` in S3 for SQL files.

---

## 12. Code Structure — Shared & Frontend

### Shared Library (`services/shared/`)

**`constants.py`**:

```python
JOB_STATUS = {
    "QUEUED": "queued",
    "RETRIEVING_CONTEXT": "retrieving_context",
    "VALIDATING_SOURCES": "validating_sources",
    "DRAFTING_DOCUMENT": "drafting_document",
    "GENERATING_DIAGRAM": "generating_diagram",
    "AWAITING_REVIEW": "awaiting_review",
    "SME_REVIEWING": "sme_reviewing",
    "FORMATTING_OUTPUT": "formatting_output",
    "COMPLETE": "complete",
    "FAILED": "failed",
}

BEDROCK_LLM_MODEL_ID = "anthropic.claude-sonnet-4-6"   # Claude Sonnet 4.6
EMBEDDING_MODEL_ID = "amazon.titan-embed-text-v2:0"    # Titan Text v2
EMBEDDING_DIMENSION = 1024                              # MUST match pgvector column
```

> **Critical**: `EMBEDDING_DIMENSION = 1024` must match the `vector(1024)` type on `document_chunks.embedding`. Changing the embedding model without migrating all existing embeddings will cause errors.

**`schemas/schemas.py`** — Pydantic v2 models shared between API and potentially frontend type generation:

| Model | Purpose |
|---|---|
| GenerationRequest | POST /generate/submit request body |
| GenerationJobStatus | GET /generate/status/{id} response |
| DocumentUploadResponse | POST /documents/upload response |
| SearchRequest / SearchResult | RAG search request/response |
| ArchReferenceUpload | POST /arch-references request |

**`models/orm.py`** — SQLAlchemy ORM models: `User`, `Document`, `DocumentChunk`, `GenerationJob`, `ArchReference`. Both API and Worker import from this module — the single source of truth for the data model.

### Frontend (`frontend/src/`)

**`lib/api.ts`** — Central fetch wrapper:
- Prepends `/api` to all paths (CloudFront routes `/api/*` to ALB)
- Attaches `Authorization: Bearer {id_token}` header
- On 401: calls `AuthContext.refresh()` → retries request once
- On second 401: calls `setLogoutCallback()` → user redirected to /login
- Exports typed functions for every API endpoint

**`contexts/AuthContext.tsx`** — React context providing:
- `user` object (decoded JWT claims)
- `login(email, password)` — calls POST /auth/login, stores tokens
- `logout()` — clears tokens, redirects to /login
- `refreshTokens()` — calls POST /auth/refresh
- Token persistence: localStorage for refresh_token, memory for id/access tokens

**`contexts/JobContext.tsx`** — Manages active job polling:
- When a job is submitted, stores `activeJobId`
- Polls `GET /generate/status/{job_id}` every 3 seconds
- Stops polling when status is `complete`, `failed`, or `awaiting_review`
- Exposes `currentJob` state to GeneratePage

### Key Page Behaviors

**`GeneratePage.tsx`**:
- Form fields: client_name, document_type, engagement_type, key_requirements, context_notes
- Smart Import: paste any text → calls `/generate/extract-requirements` → auto-fills form
- Template Selector: calls GET /templates, allows inline upload
- After submit: shows real-time progress bar mapped to job status stages
- At `awaiting_review`: shows architecture diagram (presigned PNG URL), approve/request changes buttons
- SME Review toggle: if enabled, job passes through `sme_reviewing` state before `awaiting_review`
- draw.io download button: fetches presigned URL for `.drawio` file

**`HistoryPage.tsx`**:
- Groups jobs by client + version (arch_iteration counter)
- Cards show: status, score badges, engagement type, created_at
- Arch lightbox: click to view architecture diagram full screen
- Iterate modal: submit arch review feedback
- Overview modal: inline document reader for generated proposal
- Win/Loss toggle: calls POST /generate/outcome

**`DocumentsPage.tsx`**:
- Grid layout of uploaded documents
- Shows 4-phase ingestion progress (loading/chunking/embedding/storing) with polling
- Delete button: calls DELETE /documents/{id}

**`PortalPage.tsx`** (`/portal/:jobId` — no auth):
- Public view of a completed proposal
- Shows proposal sections, architecture diagram
- Download DOCX/PDF via presigned URLs
- No auth required — suitable for client sharing

**`LoginPage.tsx`**:
- Email + password form → POST /auth/login
- Google OAuth button — requires Cognito Google identity provider to be configured
- On success: stores tokens, redirects to /generate

**`AuthCallbackPage.tsx`** (`/auth/callback`):
- Handles OAuth authorization code returned by Cognito hosted UI
- Exchanges code for tokens via Cognito token endpoint
- Stores tokens, redirects to /generate

---

## 13. Database Schema

### Table: users

| Column | Type | Constraints | Notes |
|---|---|---|---|
| id | UUID | PK, default gen_random_uuid() | Internal user ID |
| cognito_sub | VARCHAR(255) | UNIQUE, NOT NULL | Cognito subject claim from JWT |
| email | VARCHAR(255) | NOT NULL | User email |
| name | VARCHAR(255) | | Display name |
| created_at | TIMESTAMP | default now() | Registration time |

### Table: documents

| Column | Type | Constraints | Notes |
|---|---|---|---|
| id | UUID | PK | Document ID |
| filename | VARCHAR(255) | NOT NULL | Original filename |
| document_type | VARCHAR(100) | | e.g. "rfp", "case_study" |
| engagement_type | VARCHAR(100) | | e.g. "migration", "modernization" |
| client_name | VARCHAR(255) | | Client this doc belongs to |
| s3_key | TEXT | NOT NULL | raw/{id}/{filename} |
| chunk_count | INTEGER | | Set after ingestion completes |
| uploaded_by | UUID | FK users(id) | Owner |
| ingestion_status | VARCHAR(50) | | pending/loading/chunking/embedding/storing/complete/failed |
| embedding_model | VARCHAR(255) | | Titan model ID used |
| embedding_tokens | INTEGER | | Total tokens consumed |
| created_at | TIMESTAMP | default now() | Upload time |

### Table: document_chunks

| Column | Type | Constraints | Notes |
|---|---|---|---|
| id | UUID | PK | Chunk ID |
| document_id | UUID | FK documents(id) ON DELETE CASCADE | Parent document |
| chunk_index | INTEGER | NOT NULL | Order within document |
| content | TEXT | NOT NULL | Raw chunk text |
| embedding | vector(1024) | | 1024-dim Titan embedding |
| metadata | JSONB | | Source page, position, etc. |
| created_at | TIMESTAMP | default now() | Ingestion time |

**Index**: `idx_chunks_embedding USING ivfflat (embedding vector_cosine_ops) WITH (lists=10)`

### Table: generation_jobs

| Column | Type | Constraints | Notes |
|---|---|---|---|
| id | UUID | PK | Job ID |
| user_id | UUID | FK users(id) | Owner |
| document_type | VARCHAR(100) | | Proposal type |
| client_name | VARCHAR(255) | | Target client |
| engagement_type | VARCHAR(100) | | Engagement category |
| key_requirements | TEXT | | User-provided requirements |
| context_notes | TEXT | | Additional context |
| status | VARCHAR(50) | | Current state machine value |
| status_detail | VARCHAR(255) | | Human-readable progress message |
| rag_context | JSONB | | Retrieved chunks used for generation |
| tavily_sources | JSONB | | Web validation sources |
| output_s3_key | TEXT | | generated/{job_id}/{client}_{type}.docx |
| error_message | TEXT | | Set on failure |
| llm_model | VARCHAR(255) | | Claude model ID used |
| input_tokens | INTEGER | | LLM input token count |
| output_tokens | INTEGER | | LLM output token count |
| arch_json | JSONB | | Architecture spec from Claude |
| arch_s3_key | TEXT | | architectures/{job_id}/v{n}.png |
| arch_iteration | INTEGER | default 0 | Iteration counter |
| sections_content | JSONB | | Generated section text by section name |
| drawio_s3_key | TEXT | | architectures/{job_id}/v{n}.drawio |
| pdf_s3_key | TEXT | | generated/{job_id}/{client}_{type}.pdf |
| proposal_score | JSONB | | 5-dimension score object |
| outcome | VARCHAR(20) | | "win", "loss", or null |
| created_at | TIMESTAMP | default now() | Submission time |
| completed_at | TIMESTAMP | | Set when status = complete |

### Table: arch_references

| Column | Type | Constraints | Notes |
|---|---|---|---|
| id | UUID | PK | Reference ID |
| name | VARCHAR(255) | NOT NULL | Display name |
| description | TEXT | | Usage guidance |
| engagement_type | VARCHAR(100) | | Engagement filter tag |
| s3_key | TEXT | NOT NULL | arch-references/{id}/{filename} |
| created_at | TIMESTAMP | default now() | Upload time |

---

## 14. Job Status State Machine

### State Transitions

```
                    ┌─────────────┐
    POST /submit ──►│   queued    │
                    └──────┬──────┘
                           │ worker picks up SQS message
                    ┌──────▼──────────────┐
                    │  retrieving_context │
                    └──────┬──────────────┘
                           │ RAG chunks retrieved
                    ┌──────▼──────────────┐
                    │  validating_sources │
                    └──────┬──────────────┘
                           │ Tavily validation complete
                    ┌──────▼──────────────┐
                    │  drafting_document  │
                    └──────┬──────────────┘
                           │ Claude generation complete
                    ┌──────▼──────────────┐
                    │ generating_diagram  │
                    └──────┬──────────────┘
                           │ PNG + drawio generated
                    ┌──────▼──────────────┐     ┌───────────────┐
                    │   awaiting_review   │◄────│  sme_reviewing │
                    └──────┬──────────────┘     └───────────────┘
                           │                          ▲
                           │ (if SME toggle on) ──────┘
                           │
                    ┌──────▼──────────────┐
         approve ──►│  formatting_output  │
                    └──────┬──────────────┘
                           │ DOCX + PDF generated
                    ┌──────▼──────────────┐
                    │     complete        │
                    └─────────────────────┘

Any state ──► failed  (error_message set)
```

### Status Values Reference

| Status | Set By | Meaning |
|---|---|---|
| queued | API (POST /submit) | Job created, SQS message published |
| retrieving_context | Worker orchestrator | RAG retrieval in progress |
| validating_sources | Worker orchestrator | Tavily web search in progress |
| drafting_document | Worker orchestrator | Claude LLM generation in progress |
| generating_diagram | Worker orchestrator | Architecture PNG + drawio rendering |
| awaiting_review | Worker orchestrator | Ready for user to review arch diagram |
| sme_reviewing | Worker orchestrator | Optional: Claude SME review in progress |
| formatting_output | Worker (after approve) | DOCX + PDF build in progress |
| complete | Worker orchestrator | All outputs ready, S3 keys set |
| failed | Worker (any exception) | error_message column contains detail |

### Terminal States

`complete` and `failed` are terminal. To restart a failed job: `POST /generate/retry/{job_id}` — resets status to `queued` and re-publishes SQS message.

---

## 15. Request Flow Walkthroughs

### Flow 1: User Submits a Proposal Generation Job

```
1. Browser                POST /api/generate/submit
   ├── Headers: Authorization: Bearer {id_token}
   └── Body: { client_name, document_type, engagement_type, key_requirements, context_notes }

2. CloudFront             Routes /api/* → StripApiPrefix CF Function → ALB

3. ALB                    Health-checks API task, forwards to port 8000

4. API (routers/generate.py)
   ├── core/auth.py:      Validate JWT, load User from DB
   ├── DB:                INSERT generation_jobs (status='queued')
   ├── core/sqs.py:       send_message({ job_id, job_type='generation', user_id })
   └── Response:          { job_id, status: 'queued' }

5. Frontend               Starts polling GET /api/generate/status/{job_id} every 3s

6. Worker (main.py)       SQS long-poll receives message
   └── orchestrator.py:  run_generation_pipeline(job_id)
         ├── DB UPDATE status='retrieving_context'
         ├── retrieval_chain: embed query → pgvector search → top-20 chunks
         ├── DB UPDATE status='validating_sources'
         ├── validation_chain: Tavily search on key claims
         ├── DB UPDATE status='drafting_document'
         ├── generation_chain: Claude Sonnet 4.6 → sections_content JSON
         ├── DB UPDATE status='generating_diagram'
         ├── architecture_generator: Claude → arch_json → render PNG
         ├── drawio_builder: arch_json → .drawio XML
         ├── S3 upload: architectures/{job_id}/v1.png, v1.drawio
         ├── (optional) sme_chain: Claude SME review → update sections_content
         ├── scoring_chain: Claude → proposal_score JSON
         └── DB UPDATE status='awaiting_review', arch_s3_key, drawio_s3_key, proposal_score

7. Frontend               Polling sees 'awaiting_review'
   └── GeneratePage:      Show arch diagram (presigned URL), approve/iterate buttons
```

### Flow 2: User Approves and Downloads Proposal

```
1. Browser                POST /api/generate/approve/{job_id}

2. API (routers/generate.py)
   ├── DB UPDATE status='formatting_output'
   └── SQS: publish { job_id, job_type='format' }

3. Worker (main.py)       Receives format message
   └── orchestrator.py:  run_formatting_pipeline(job_id)
         ├── docx_builder: load template from S3, fill sections → DOCX bytes
         ├── pdf_builder: convert DOCX → PDF bytes
         ├── S3 upload: generated/{job_id}/{client}_{type}.docx
         ├── S3 upload: generated/{job_id}/{client}_{type}.pdf
         └── DB UPDATE status='complete', output_s3_key, pdf_s3_key, completed_at

4. Frontend               Polling sees 'complete'
   └── Shows download buttons → GET presigned URLs → direct S3 download
```

### Flow 3: Document Ingestion

```
1. Browser                POST /api/documents/upload (multipart form)

2. API (routers/documents.py)
   ├── core/auth.py:      Validate JWT
   ├── core/s3.py:        Upload to raw/{doc_id}/{filename}
   ├── DB:                INSERT documents (status='pending')
   └── core/sqs.py:       publish { job_id=doc_id, job_type='ingestion' }

3. Worker (main.py)       Receives ingestion message
   ├── DB UPDATE ingestion_status='loading'
   ├── document_loader:   Download from S3, extract text
   ├── DB UPDATE ingestion_status='chunking'
   ├── text_splitter:     512-char chunks, 50-char overlap
   ├── DB UPDATE ingestion_status='embedding'
   ├── embedder:          Batch → Titan Text v2 → 1024-dim vectors
   ├── DB UPDATE ingestion_status='storing'
   ├── vector_store:      Upsert document_chunks rows
   └── DB UPDATE ingestion_status='complete', chunk_count=N, embedding_tokens=T

4. Frontend (DocumentsPage)
   └── Polls GET /documents/{doc_id}/status → shows 4-phase progress bar
```

### Flow 4: Semantic Search

```
1. Browser                GET /api/search?query=cloud+migration+assessment&limit=10

2. API (routers/search.py)
   ├── core/auth.py:      Validate JWT
   ├── core/bedrock.py:   embed_texts([query]) → 1024-dim vector
   └── DB query:
         SELECT dc.content, dc.metadata, d.filename, d.client_name
         FROM document_chunks dc JOIN documents d ON dc.document_id = d.id
         ORDER BY dc.embedding <=> $1
         LIMIT 10
         Response: [ { content, score, source_document, metadata } ]
```

---

## 16. AI/ML Pipeline

### Models Used

| Model | Provider | ID | Use |
|---|---|---|---|
| Claude Sonnet 4.6 | AWS Bedrock | anthropic.claude-sonnet-4-6 | Generation, scoring, SME review, arch design, requirement extraction |
| Amazon Titan Text v2 | AWS Bedrock | amazon.titan-embed-text-v2:0 | Text embeddings (1024 dims) |

### Bedrock Integration

All Bedrock calls go through `services/worker/src/core/bedrock.py` using boto3:

```python
client = boto3.client('bedrock-runtime', region_name='us-east-1')

# LLM invocation
response = client.invoke_model(
    modelId='anthropic.claude-sonnet-4-6',
    body=json.dumps({
        "anthropic_version": "bedrock-2023-05-31",
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 4096
    })
)

# Embedding
response = client.invoke_model(
    modelId='amazon.titan-embed-text-v2:0',
    body=json.dumps({"inputText": text})
)
# Returns: {"embedding": [float x 1024], "inputTextTokenCount": N}
```

### RAG Retrieval Strategy

1. Query text is embedded with Titan Text v2 (same model as ingestion — critical for vector space alignment)
2. pgvector `<=>` operator computes cosine distance against all `document_chunks.embedding` vectors
3. `ORDER BY embedding <=> $query_vector LIMIT 20` returns top-20 semantically similar chunks
4. Optional filter: `JOIN documents ON document_id = id WHERE engagement_type = $type`
5. Retrieved chunks are concatenated as context in the Claude generation prompt

### Architecture Generation Pipeline

1. `design_architecture()` — prompts Claude with job context + proposal sections. Claude returns structured JSON:
   ```json
   {
     "nodes": [{"id": "vpc", "label": "VPC", "type": "network", "layer": "infrastructure"}],
     "edges": [{"from": "alb", "to": "api", "label": "HTTPS"}],
     "layers": ["internet", "edge", "application", "data"]
   }
   ```
2. `render_architecture_png()` — Python `diagrams` library reads the JSON, maps node types to AWS icons, renders via Graphviz to PNG
3. `generate_drawio_xml()` — same JSON mapped to mxGraph XML format for draw.io compatibility

### Proposal Scoring

Claude evaluates the generated proposal on 5 dimensions, returning:
```json
{
  "relevance": 8,
  "completeness": 7,
  "technical_accuracy": 9,
  "commercial_clarity": 7,
  "presentation": 8,
  "overall": 7.8,
  "commentary": "Strong technical depth, could improve executive summary..."
}
```
Stored in `generation_jobs.proposal_score` JSONB. Displayed as badges in HistoryPage.

### SME Review Chain

When the user enables SME review on the GeneratePage:
1. Worker passes `sections_content` to `sme_chain.run_sme_review_chain()`
2. Claude is prompted as a senior consultant in the `engagement_type` domain
3. Claude returns suggestions and amended text per section
4. Orchestrator merges suggestions into `sections_content`
5. Job proceeds to `awaiting_review` with enhanced content

### Tavily Validation

For each key claim extracted from the generation context:
1. Tavily API called with claim as query
2. Returns top web sources with relevance scores
3. Results stored in `generation_jobs.tavily_sources` JSONB
4. Displayed in the portal view as source citations
5. In-memory cache prevents duplicate Tavily calls for the same claim within one job run

---

## 17. Debug Runbook

### Step 1 — Check ECS Service Health

```bash
aws ecs describe-services \
  --cluster genese-proposal-ai \
  --services genese-api-service genese-worker-service \
  --region us-east-1 \
  --query 'services[*].{name:serviceName,running:runningCount,desired:desiredCount}'
```

Expected output: both services show `running == desired` (typically 1/1).

If `running=0`: a task failed to start. Check logs immediately.

### Step 2 — Read Live Logs

```bash
# API logs (streaming)
aws logs tail /ecs/genese-api --follow --region us-east-1

# Worker logs (streaming)
aws logs tail /ecs/genese-worker --follow --region us-east-1

# Last 100 lines, no follow
aws logs tail /ecs/genese-api --region us-east-1
aws logs tail /ecs/genese-worker --region us-east-1
```

Worker crashes on startup always show in the first 10 log lines. Look for: `ImportError`, `ModuleNotFoundError`, `botocore.exceptions`, or missing environment variable errors.

### Step 3 — Check SQS Queue Depth

```bash
# Main queue
aws sqs get-queue-attributes \
  --queue-url https://sqs.us-east-1.amazonaws.com/654654306837/genese-generation-jobs \
  --attribute-names ApproximateNumberOfMessages \
  --region us-east-1

# Dead letter queue
aws sqs get-queue-attributes \
  --queue-url https://sqs.us-east-1.amazonaws.com/654654306837/genese-generation-jobs-dlq \
  --attribute-names ApproximateNumberOfMessages \
  --region us-east-1
```

- If main queue depth > 0 and has been for minutes → worker is not processing (check worker running count)
- If DLQ depth > 0 → messages failed 3 times, inspect worker logs for the error

### Step 4 — Verify ALB / API Reachability

```bash
# Direct ALB health check (bypasses CloudFront)
curl http://Genese-ApiLB-XYr1qAvXxyX7-1479126617.us-east-1.elb.amazonaws.com/health
# Expected: {"status": "ok"}
```

If this returns 503: the API ECS task is not running or failed health check.  
If this returns 502: uvicorn is not listening on port 8000 — check container logs.

### Step 5 — Force Restart Services

```bash
# Restart API (pulls latest task definition, same TD revision)
aws ecs update-service \
  --cluster genese-proposal-ai \
  --service genese-api-service \
  --force-new-deployment \
  --region us-east-1

# Restart Worker
aws ecs update-service \
  --cluster genese-proposal-ai \
  --service genese-worker-service \
  --force-new-deployment \
  --region us-east-1
```

### Step 6 — Invalidate CloudFront Cache

```bash
aws cloudfront create-invalidation \
  --distribution-id E31C3VQPMUFTQZ \
  --paths "/*" \
  --region us-east-1
```

Required after every frontend deployment to S3.

### Step 7 — Deploy New Container Image

```bash
# Authenticate to ECR
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin \
  654654306837.dkr.ecr.us-east-1.amazonaws.com

# Build and push API
docker build -t genese-proposal-ai-api ./services/api
docker tag genese-proposal-ai-api:latest \
  654654306837.dkr.ecr.us-east-1.amazonaws.com/genese-proposal-ai-api:latest
docker push 654654306837.dkr.ecr.us-east-1.amazonaws.com/genese-proposal-ai-api:latest

# Build and push Worker
docker build -t genese-proposal-ai-worker ./services/worker
docker tag genese-proposal-ai-worker:latest \
  654654306837.dkr.ecr.us-east-1.amazonaws.com/genese-proposal-ai-worker:latest
docker push 654654306837.dkr.ecr.us-east-1.amazonaws.com/genese-proposal-ai-worker:latest

# Force new deployment to pick up new image
aws ecs update-service --cluster genese-proposal-ai \
  --service genese-api-service --force-new-deployment --region us-east-1
aws ecs update-service --cluster genese-proposal-ai \
  --service genese-worker-service --force-new-deployment --region us-east-1
```

### Step 8 — Check Secrets Manager

```bash
# Verify DB secret is accessible (returns JSON, don't log in production)
aws secretsmanager get-secret-value \
  --secret-id arn:aws:secretsmanager:us-east-1:654654306837:secret:/genese/db-credentials-yADfjr \
  --region us-east-1 \
  --query SecretString

# Verify Tavily secret
aws secretsmanager get-secret-value \
  --secret-id arn:aws:secretsmanager:us-east-1:654654306837:secret:/genese/tavily-api-key-aCxeOs \
  --region us-east-1 \
  --query SecretString
```

### Step 9 — Inspect a Specific Job in DB

Connect to Aurora via a bastion or AWS Query Editor, then:

```sql
-- Check job status and error
SELECT id, status, status_detail, error_message, created_at, completed_at
FROM generation_jobs
WHERE id = '<job_uuid>';

-- Check document ingestion
SELECT id, filename, ingestion_status, chunk_count, embedding_tokens
FROM documents
WHERE id = '<doc_uuid>';

-- Check vector count for a document
SELECT COUNT(*) FROM document_chunks WHERE document_id = '<doc_uuid>';
```

### Step 10 — Purge DLQ for Reprocessing

```bash
# Move DLQ messages back to main queue (requires SQS DLQ redrive policy)
# Or delete all DLQ messages if they're irrecoverable
aws sqs purge-queue \
  --queue-url https://sqs.us-east-1.amazonaws.com/654654306837/genese-generation-jobs-dlq \
  --region us-east-1
```

---

## 18. Symptom → Cause → Fix Reference

| Symptom | Most Likely Cause | Diagnostic Step | Fix |
|---|---|---|---|
| Job stuck in `queued` | Worker not running or SQS not delivering | Check worker `runningCount`; check SQS `ApproximateNumberOfMessages` | Restart worker service; verify SQS queue URL in task env var |
| Job stuck in `generating_diagram` | Bedrock timeout or diagrams/graphviz error | `aws logs tail /ecs/genese-worker` — look for Graphviz or Bedrock error | If Graphviz: ensure `graphviz` system pkg in Dockerfile. If Bedrock: check Bedrock service limits and IAM permissions |
| Job stuck in `retrieving_context` | pgvector query hanging or DB connection exhausted | Check worker logs for DB timeout; check Aurora ACU usage | Scale Aurora max ACU; check connection pool settings |
| Job status never updates (stays queued forever) | SQS message published before DB transaction committed (race condition) | Check API code in `routers/documents.py` — verify `await session.commit()` before `publish_job()` | Add explicit commit before SQS publish in API |
| ALB returns 503 | API ECS task not running | `aws ecs describe-services ... --query runningCount` | Force new deployment or check task definition for startup errors |
| ALB returns 502 | uvicorn crashed inside container | `aws logs tail /ecs/genese-api` | Fix startup error (missing import, bad env var), redeploy |
| Browser shows `NetworkError` on API calls | CloudFront `/api/*` behavior missing or misconfigured | Check CloudFront distribution behaviors in AWS console | Add behavior: path=/api/*, origin=ALB, CF Function=StripApiPrefix |
| All API calls return 401 | JWT validation failing — wrong User Pool ID | Check `COGNITO_USER_POOL_ID` env var in API task definition | Set correct value: `us-east-1_ThM2KRVkt` |
| Login returns 400 | Wrong Cognito Client ID or AdminInitiateAuth not enabled | Check `COGNITO_CLIENT_ID` env var; check Cognito app client settings | Set correct value: `19ufsosadrbr5fqlhleargbrbi`; enable AdminInitiateAuth in Cognito |
| Document stuck at `pending` | API published SQS message before DB commit | See race condition fix above | Ensure DB commit before SQS publish |
| Dimension mismatch error in pgvector | Wrong embedding model producing different vector size | Check `EMBEDDING_DIMENSION` in `constants.py` | Must be 1024 for Titan Text v2; if model changed, re-embed all documents |
| Worker crashes on startup | Broken import or missing environment variable | `aws logs tail /ecs/genese-worker` — first 10 lines show traceback | Fix import error in code or add missing env var to task definition |
| CloudFront serves stale frontend | Cache not invalidated after deploy | Check if invalidation was run after S3 sync | `aws cloudfront create-invalidation --distribution-id E31C3VQPMUFTQZ --paths /*` |
| DLQ depth growing | Repeated worker failures for same message | Check DLQ, find message body, find job_id, check worker logs | Fix underlying error; retry job via API or redrive from DLQ |
| DOCX download is empty/corrupted | docx_builder error or S3 upload failure | Check worker logs during `formatting_output` phase; check S3 key exists | Check python-docx template compatibility; verify template exists at `templates/{type}/template.docx` |
| Arch diagram not displaying | Presigned URL expired or arch_s3_key null | Check `arch_s3_key` in DB; check S3 key exists; presigned URLs expire in 1 hour | Re-generate presigned URL; verify architecture generator completed successfully |
| Search returns no results | No documents ingested or index not built | Check `document_chunks` count; check ivfflat index exists | Ingest documents; re-run `CREATE INDEX` if missing |
| Tavily validation step hangs | Tavily API key invalid or rate limited | Check worker logs; verify `/genese/tavily-api-key-aCxeOs` secret value | Update Tavily API key in Secrets Manager |

---

## 19. Extension Guide

### Adding a New API Endpoint

1. Create or modify a file in `services/api/src/routers/`
2. Define FastAPI route with `Depends(get_current_user)` for auth
3. If the endpoint creates async work, publish to SQS with a new `job_type`
4. Register the router in `main.py` if it's a new file
5. Add corresponding Pydantic schema to `services/shared/schemas/schemas.py`
6. Update `frontend/src/lib/api.ts` with the new typed function
7. Build and push new API image; force new deployment

### Adding a New Worker Pipeline Step

1. Create a new chain file in `services/worker/src/chains/` or `generation/`
2. Import and call from `chains/orchestrator.py` at the correct pipeline position
3. Add the new status value to `JOB_STATUS` dict in `services/shared/constants.py`
4. Add `status_detail` message for the new state
5. The frontend `GeneratePage.tsx` progress bar reads status values — update the mapping there
6. Build and push new Worker image; force new deployment

### Adding a New Job Type

1. Add `job_type` string constant to shared constants
2. In `services/worker/src/main.py`: add dispatch case for the new type
3. Implement the pipeline function in `orchestrator.py`
4. Add API endpoint to publish the new job type via SQS
5. No SQS infrastructure changes needed — same queue handles all job types

### Adding a New Document Field

1. Add column to `generation_jobs` in `services/shared/models/orm.py`
2. Write migration SQL: `ALTER TABLE generation_jobs ADD COLUMN ...`
3. Run migration via `db_migration_v2.py` pattern (ECS one-off task) or via Aurora Query Editor
4. Update Pydantic schema in `services/shared/schemas/schemas.py`
5. Update API router responses and worker DB writes

### Scaling Considerations

| Concern | Current State | How to Scale |
|---|---|---|
| API throughput | Single Fargate task (0.5 vCPU) | Increase desired count; add ALB target group auto-scaling |
| Worker throughput | Single Fargate task (1 vCPU) | Multiple workers safe — SQS visibility timeout prevents duplicate processing |
| Vector search latency | ivfflat lists=10 (small dataset) | Increase `lists` as chunk count grows; consider HNSW index for large datasets |
| Aurora capacity | 0.5–4 ACU serverless | Increase max ACU; consider provisioned cluster for predictable high load |
| LLM latency | Claude Sonnet 4.6 synchronous | Consider Bedrock async inference API for batch; add Bedrock provisioned throughput |
| SQS message retention | Default 4 days | Increase if job queue may be unprocessed for longer periods |

### Environment Promotion (Dev → Prod)

All infrastructure IDs in this document are for the production environment. For a new environment:

1. Deploy new CDK/CloudFormation stack with distinct resource names
2. Update all `*-654654306837-us-east-1` bucket names
3. Create new Cognito User Pool, update pool ID and client ID in task definitions
4. Create new Secrets Manager secrets with environment-specific values
5. Update CloudFront behaviors and CF Function for the new ALB
6. Update frontend `VITE_API_URL` / CloudFront domain

### Running Database Migrations

```bash
# Option 1: ECS one-off task (preferred for production)
aws ecs run-task \
  --cluster genese-proposal-ai \
  --task-definition genese-worker-service \
  --overrides '{"containerOverrides":[{"name":"worker","command":["python","db_migration_v2.py"]}]}' \
  --network-configuration 'awsvpcConfiguration={subnets=[subnet-0e077e24f575cd597],securityGroups=[sg-06903044b2e9afe46]}' \
  --launch-type FARGATE \
  --region us-east-1

# Option 2: Aurora Query Editor in AWS Console
# Navigate to RDS → Query Editor → select cluster → run SQL
```

---

*End of Architecture Blueprint — Genese Proposal AI*  
*Last updated: 2026-07-03*
