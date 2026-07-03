# Architecture Blueprint — Genese Proposal AI

> Precise system blueprint for debugging and troubleshooting.
> Every resource named, every connection documented, every port listed.

---

## Live Environment

| Item | Value |
|---|---|
| AWS Account | 654654306837 |
| Region | us-east-1 |
| CloudFormation Stack | `GeneseProposalAIStack` (CREATE_COMPLETE) |
| Frontend URL | https://d3gmhvny3loneb.cloudfront.net |
| API URL (internal) | http://Genese-ApiLB-XYr1qAvXxyX7-1479126617.us-east-1.elb.amazonaws.com |
| CloudFront Distribution | `E31C3VQPMUFTQZ` |
| Demo Login | demo@genesesolution.com / GeneseDemo123! |

---

## System Overview

```
INTERNET
   │  HTTPS 443
   ▼
CloudFront (E31C3VQPMUFTQZ)
   │
   ├── /* ──────────────────────► S3 Frontend Bucket
   │                               (React SPA static files)
   │
   └── /api/* ──StripApiPrefix──► ALB (HTTP 80)
                  CF Function        │
                  strips /api        ▼
                                ECS API Task (port 8000)
                                (FastAPI)
                                   │
                    ┌──────────────┼──────────────┐
                    ▼              ▼              ▼
               Aurora DB       S3 Docs        SQS Queue
               (pgvector)      Bucket         (jobs)
                    │                            │
                    └────────────────────────────┘
                                                 │ poll
                                                 ▼
                                        ECS Worker Task
                                        (LangChain)
                                             │
                          ┌──────────────────┼────────────┐
                          ▼                  ▼            ▼
                    Bedrock Claude     Bedrock Titan    Tavily
                    (claude-sonnet-4-6) (embed-v2)     (web search)
                          │                  │
                          └──────────────────┘
                                   │ results
                                   ▼
                             Aurora DB + S3
                          (store job output)
```

---

## AWS Resources — Complete Inventory

### Networking

| Resource | ID / Value | Notes |
|---|---|---|
| VPC | `vpc-0dd58bd2463d505d3` | 2 AZs (us-east-1a, us-east-1b) |
| Public Subnet A | `subnet-0...` | NAT gateway lives here |
| Public Subnet B | `subnet-0...` | |
| Private Subnet A | `subnet-037ba0886dccac9c3` | ECS tasks + Aurora run here |
| Private Subnet B | `subnet-0e077e24f575cd597` | ECS tasks + Aurora run here |
| NAT Gateway | auto-created | Allows private subnet → internet (ECR pull, Bedrock calls) |
| Internet Gateway | auto-created | Public subnet internet access |

### Security Groups

| Name | ID | Inbound | Outbound |
|---|---|---|---|
| ALB SG | (from CDK) | 0.0.0.0/0 port 80 | → API SG port 8000 |
| API SG | `sg-0574a979c34caa923` | ALB SG port 8000 | 0.0.0.0/0 all |
| Worker SG | `sg-06903044b2e9afe46` | none | 0.0.0.0/0 all |
| Aurora SG | (from CDK) | API SG + Worker SG port 5432 | — |

### Load Balancer

| Resource | Value |
|---|---|
| ALB Name | `Genese-ApiLB-XYr1qAvXxyX7` |
| ALB DNS | `Genese-ApiLB-XYr1qAvXxyX7-1479126617.us-east-1.elb.amazonaws.com` |
| Listener | HTTP:80 |
| Target Group | `Genese-ApiTG-MTNJR71QSRJJ` |
| Target Group ARN | `arn:aws:elasticloadbalancing:us-east-1:654654306837:targetgroup/Genese-ApiTG-MTNJR71QSRJJ/f85b6ee52230cb06` |
| Health Check Path | `/health` |
| Health Check Interval | 30s |
| Health Check Threshold | 2 healthy / 3 unhealthy |

### S3 Buckets

| Bucket | Name | Contents |
|---|---|---|
| Documents | `genese-proposal-ai-docs-654654306837-us-east-1` | Raw uploads: `raw/{doc_id}/filename` · Architecture diagrams: `architectures/{job_id}/v{n}.png` · Generated .docx: `generated/{job_id}/filename.docx` · Templates: `templates/{type}.docx` · Migration scripts: `scripts/` |
| Frontend | `genese-proposal-ai-frontend-654654306837-us-east-1` | React SPA static files (`index.html`, JS, CSS, assets) |

### CloudFront

| Resource | Value |
|---|---|
| Distribution ID | `E31C3VQPMUFTQZ` |
| Domain | `d3gmhvny3loneb.cloudfront.net` |
| Default behavior `/*` | → S3 Frontend Bucket |
| API behavior `/api/*` | → ALB (http-only, 60s timeout) |
| CF Function | `StripApiPrefix` — strips `/api` prefix before ALB |
| Cache Policy (API) | `CachingDisabled` (ID: 4135ea2d-...) |
| Origin Request Policy (API) | `AllViewer` (ID: 216adef6-...) |

### ECR Repositories

| Repo | URI |
|---|---|
| API | `654654306837.dkr.ecr.us-east-1.amazonaws.com/genese-proposal-ai-api` |
| Worker | `654654306837.dkr.ecr.us-east-1.amazonaws.com/genese-proposal-ai-worker` |

### ECS

| Resource | Value |
|---|---|
| Cluster | `genese-proposal-ai` |
| API Service | `genese-api-service` |
| API Task Definition | `GeneseProposalAIStackApiTask0B92A25E` (current: rev 20) |
| API Container | `Api`, port 8000, 0.5 vCPU / 1GB RAM |
| Worker Service | `genese-worker-service` |
| Worker Task Definition | `GeneseProposalAIStackWorkerTask4245E981` (current: rev 25) |
| Worker Container | `Worker`, no port, 1 vCPU / 2GB RAM |
| Launch Type | FARGATE |
| Subnets | Private A + B |
| Log Driver | awslogs → CloudWatch |

### Aurora PostgreSQL

| Resource | Value |
|---|---|
| Cluster ID | `geneseproposalaistack-auroracluster23d869c0-lavzoeprhotq` |
| Engine | Aurora PostgreSQL 15.x Serverless v2 |
| Min capacity | 0.5 ACU |
| Max capacity | 4 ACU |
| Database name | `genese` |
| Port | 5432 |
| Extensions | `pgvector` (vector similarity search) |
| Credentials ARN | `arn:aws:secretsmanager:us-east-1:654654306837:secret:/genese/db-credentials-yADfjr` |

### SQS

| Resource | Value |
|---|---|
| Queue URL | `https://sqs.us-east-1.amazonaws.com/654654306837/genese-generation-jobs` |
| Visibility Timeout | 600s (10 min) |
| DLQ | `genese-generation-jobs-dlq` |
| Max Receive Count | 3 (after 3 fails → DLQ) |

### Cognito

| Resource | Value |
|---|---|
| User Pool ID | `us-east-1_ThM2KRVkt` |
| App Client ID | `19ufsosadrbr5fqlhleargbrbi` |
| Auth Flow | `ADMIN_USER_PASSWORD_AUTH` (server-side only) |
| Token Validity | Access: 1h, Refresh: 30d |

### Secrets Manager

| Secret | ARN | Value |
|---|---|---|
| DB Credentials | `arn:aws:secretsmanager:us-east-1:654654306837:secret:/genese/db-credentials-yADfjr` | `{"host":"...","port":5432,"dbname":"genese","username":"...","password":"..."}` |
| Tavily API Key | `arn:aws:secretsmanager:us-east-1:654654306837:secret:/genese/tavily-api-key-aCxeOs` | `{"api_key":"..."}` or plain string |

### IAM Roles

| Role | Purpose | Key Permissions |
|---|---|---|
| Task Role | What the container code can do | Bedrock:InvokeModel, S3:GetObject/PutObject, SQS:ReceiveMessage/DeleteMessage/SendMessage, SecretsManager:GetSecretValue |
| Execution Role | What ECS itself can do (pull image, write logs) | ECR:GetAuthorizationToken, ECR:BatchGetImage, logs:CreateLogStream, logs:PutLogEvents |

### CloudWatch Log Groups

| Log Group | Service |
|---|---|
| `/genese/api` | API container logs |
| `/genese/worker` | Worker container logs |

---

## Database Schema

### Table: `users`
```
id           UUID  PK
cognito_sub  VARCHAR(255) UNIQUE  — Cognito user ID (sub claim)
email        VARCHAR(255)
name         VARCHAR(255)
created_at   TIMESTAMPTZ
```

### Table: `documents`
```
id               UUID  PK
filename         VARCHAR(500)
document_type    VARCHAR(50)   — 'proposal' | 'sow' | 'case_study'
engagement_type  VARCHAR(100)  — 'aws_migration' | 'data_platform' | etc.
client_name      VARCHAR(255)
s3_key           VARCHAR(1000) — 'raw/{id}/filename'
chunk_count      INTEGER
uploaded_by      UUID  FK → users.id
ingestion_status VARCHAR(50)   — 'pending' | 'loading' | 'chunking' | 'embedding' | 'storing' | 'indexed' | 'failed'
embedding_model  VARCHAR(255)  — 'amazon.titan-embed-text-v2:0'
embedding_tokens INTEGER       — total tokens used for embeddings
created_at       TIMESTAMPTZ
```

### Table: `document_chunks`
```
id           UUID  PK
document_id  UUID  FK → documents.id  ON DELETE CASCADE
chunk_index  INTEGER
content      TEXT              — raw chunk text (512 chars, 50 overlap)
embedding    vector(1024)      — Titan Text v2 output (1024 dims, NOT 1536)
metadata     JSONB             — {document_type, client_name, chunk_index, total_chunks}
created_at   TIMESTAMPTZ

INDEX: idx_chunks_embedding  USING ivfflat (embedding vector_cosine_ops) WITH (lists=10)
```

### Table: `generation_jobs`
```
id               UUID  PK
user_id          UUID  FK → users.id
document_type    VARCHAR(50)    — 'proposal' | 'sow' | 'case_study'
client_name      VARCHAR(255)
engagement_type  VARCHAR(100)
key_requirements TEXT
context_notes    TEXT
status           VARCHAR(50)    — see Job Status States below
status_detail    VARCHAR(255)   — human-readable progress message shown in UI
rag_context      JSONB          — top-5 retrieved chunks used as context
tavily_sources   JSONB          — web search results from Tavily
output_s3_key    VARCHAR(1000)  — 'generated/{job_id}/filename.docx'
error_message    TEXT           — set on failure
llm_model        VARCHAR(255)   — 'us.anthropic.claude-sonnet-4-6'
input_tokens     INTEGER        — Claude input tokens
output_tokens    INTEGER        — Claude output tokens
arch_json        JSONB          — architecture diagram JSON (title, layers, nodes, connections)
arch_s3_key      VARCHAR(1000)  — 'architectures/{job_id}/v{n}.png'
arch_iteration   INTEGER        — how many times the diagram was revised
created_at       TIMESTAMPTZ
completed_at     TIMESTAMPTZ
```

### Job Status States
```
queued             → job created, waiting for worker to pick up
retrieving_context → worker embedding query, searching pgvector
validating_sources → Tavily searching live AWS/cloud docs
drafting_document  → Claude generating proposal sections (JSON output)
generating_diagram → Claude designing arch JSON → diagrams lib rendering PNG
awaiting_review    → PAUSED — user must approve or revise architecture
formatting_output  → python-docx building .docx, embedding diagram PNG
complete           → .docx uploaded to S3, download URL available
failed             → error_message contains root cause
```

---

## Code Structure

```
genese-proposal-ai/
├── deploy.sh                          ← one-script deployment
├── infrastructure/
│   ├── app.py                         ← CDK app entry point
│   └── stacks/
│       └── genese_stack.py            ← full CDK stack definition
│
├── services/
│   ├── api/
│   │   ├── Dockerfile                 ← FROM python:3.12-slim, uvicorn
│   │   └── src/
│   │       ├── main.py                ← FastAPI app, CORS, router registration
│   │       ├── core/
│   │       │   ├── config.py          ← reads env vars (DB_SECRET_ARN, etc.)
│   │       │   ├── database.py        ← SQLAlchemy async engine + session
│   │       │   └── s3.py              ← boto3 S3 client helper
│   │       └── routers/
│   │           ├── auth.py            ← POST /auth/login → Cognito AdminInitiateAuth
│   │           ├── documents.py       ← GET/POST /documents — upload, list, status
│   │           ├── generate.py        ← POST /generate — create job, poll status, arch review
│   │           ├── jobs.py            ← GET /jobs — history list
│   │           ├── search.py          ← POST /search — RAG semantic search
│   │           └── templates.py       ← GET/POST/DELETE /templates — .docx templates
│   │
│   ├── worker/
│   │   ├── Dockerfile                 ← FROM python:3.12-slim + graphviz apt package
│   │   └── src/
│   │       ├── main.py                ← SQS consumer loop, dispatches job types
│   │       ├── core/
│   │       │   ├── config.py          ← reads env vars
│   │       │   ├── database.py        ← same async SQLAlchemy setup
│   │       │   └── bedrock.py         ← boto3 Bedrock client, 300s read timeout
│   │       ├── chains/
│   │       │   └── orchestrator.py    ← main pipeline: RAG→Tavily→Claude→Diagram→Pause→Docx
│   │       └── generation/
│   │           ├── generation_chain.py    ← Claude Sonnet 4.6 call, returns tokens
│   │           ├── architecture_generator.py ← Claude designs arch JSON → diagrams renders PNG
│   │           ├── docx_builder.py        ← python-docx, embeds arch PNG, fills template
│   │           ├── ingestion.py           ← text extraction, chunking, embedding, pgvector insert
│   │           └── rag_retriever.py       ← pgvector cosine similarity search
│   │
│   └── shared/
│       ├── constants.py               ← MODEL_ID, EMBEDDING_DIM=1024, JOB_STATUS values
│       ├── models/
│       │   └── orm.py                 ← SQLAlchemy ORM models (User, Document, Chunk, Job)
│       └── schemas/
│           └── schemas.py             ← Pydantic request/response schemas
│
├── frontend/
│   ├── package.json                   ← React, shadcn/ui, Tailwind, Vite
│   ├── vite.config.ts
│   └── src/
│       ├── App.tsx                    ← routes: /, /generate, /history, /documents, /search, /templates
│       ├── contexts/
│       │   └── AuthContext.tsx        ← JWT storage, login/logout, token refresh
│       ├── components/
│       │   └── layout/
│       │       └── navbar.tsx         ← top navigation
│       └── pages/
│           ├── LoginPage.tsx
│           ├── GeneratePage.tsx       ← form + progress polling + arch review panel
│           ├── HistoryPage.tsx        ← job list + arch review for awaiting_review jobs
│           ├── DocumentsPage.tsx      ← upload + 4-phase indexing progress
│           ├── SearchPage.tsx         ← semantic search UI
│           └── TemplatesPage.tsx      ← upload/manage .docx templates
│
└── scripts/
    └── seed_documents/                ← 10 synthetic .txt files for seeding
```

---

## Key Technical Decisions (Quick Reference)

| Decision | Choice | Why |
|---|---|---|
| LLM | Claude Sonnet 4.6 via Bedrock | Data stays in AWS, strong structured JSON output |
| Model ID | `us.anthropic.claude-sonnet-4-6` | Cross-region inference profile — must use this exact ID |
| Embeddings | Titan Text v2 via Bedrock | AWS-native, cheapest, data stays in AWS |
| Embedding dims | 1024 | Titan v2 actual output — NOT 1536 (common mistake) |
| Vector DB | Aurora + pgvector | Single DB for all data, scales to 0 ACU, no extra service |
| Compute | ECS Fargate | LLM jobs take 30-90s — Lambda 15min limit and cold start not suitable |
| Queue | SQS | Decouples API (sync) from Worker (async), auto-retry |
| Auth | Cognito via backend proxy | AdminInitiateAuth requires server-side AWS creds |
| IaC | CDK for infra, CLI for ECS services | CFN ECS stabilization timeout causes 3-hour rollbacks |
| Arch diagram | `diagrams` Python lib + Graphviz | Renders real AWS-icon PNGs from JSON spec |
| pgvector query | f-string embedding, not bind param | asyncpg conflicts with `:param::vector` syntax |

---

## API Endpoints — Complete List

```
Auth
  POST /auth/login          body: {email, password} → {idToken, accessToken, refreshToken}

Documents
  GET  /documents           → list all documents with status + token info
  POST /documents/upload    multipart: file, document_type, engagement_type, client_name
  GET  /documents/{id}/status → {ingestion_status, phase, chunk_count, tokens}

Generation
  POST /generate            body: {document_type, client_name, engagement_type, key_requirements, context_notes}
                            → {job_id}
  GET  /generate/{id}       → full job status: status, status_detail, output_url, tokens, error
  GET  /generate/{id}/architecture → {arch_json, arch_s3_key, arch_iteration, presigned_url}
  POST /generate/{id}/approve     → approves arch diagram, triggers formatting
  POST /generate/{id}/iterate     body: {feedback} → redesigns diagram, stays awaiting_review
  POST /generate/{id}/retry       → resets failed/stuck job and re-queues

Jobs
  GET  /jobs                → list all jobs: id, type, client, status, error, created_at

Search
  POST /search              body: {query} → {answer, sources: [{content, similarity, metadata}]}

Templates
  GET  /templates           → list uploaded templates per type
  POST /templates/upload    multipart: file, template_type
  GET  /templates/{type}/download → presigned S3 URL
  DELETE /templates/{type}  → removes template

Health
  GET  /health              → {"status":"healthy","service":"genese-proposal-ai-api"}
```

---

## Worker Job Types (SQS Message `job_type` field)

| job_type | Handler function | What it does |
|---|---|---|
| `ingestion` | `process_ingestion_job` | Extract text → chunk → embed → store in pgvector |
| `generation` | `process_generation_job` | Full pipeline: RAG→Tavily→Claude→Diagram→pause |
| `format` | `process_format_job` | Resume after arch approval → build .docx → upload |
| `arch_iterate` | `process_arch_iterate_job` | Redesign arch diagram with user feedback |

---

## Generation Pipeline — Step by Step

```
SQS message arrives (job_type=generation)
         │
         ▼
1. RETRIEVING_CONTEXT (20%)
   - Embed query text via Titan Text v2 → 1024-dim vector
   - pgvector: SELECT chunks ORDER BY embedding <=> query_vec LIMIT 5
   - Returns top-5 most similar chunks from all indexed documents

2. VALIDATING_SOURCES (35%)
   - Tavily search: "{client_type} {engagement_type} AWS architecture best practices"
   - Results cached 24h (preserve free-tier 1000 req/month)
   - Gracefully skipped if key is placeholder

3. DRAFTING_DOCUMENT (55%)
   - Claude Sonnet 4.6 prompt:
     System: "You are a Genese Solution proposal writer..."
     Context: top-5 chunks + Tavily sources
     Request: "Return JSON with keys: executive_summary, problem_statement,
               proposed_solution, technical_architecture, implementation_plan,
               team_and_qualifications, investment_summary, next_steps"
   - Capture input_tokens + output_tokens for cost display

4. GENERATING_DIAGRAM (70%)
   - Claude designs architecture as JSON:
     {title, layers: [{name, services: [{name, icon_class}]}], connections: [{from, to}]}
   - diagrams library renders PNG with real AWS service icons
   - PNG uploaded to S3: architectures/{job_id}/v1.png
   - arch_json + arch_s3_key stored in DB

5. AWAITING_REVIEW (80%) ← PIPELINE PAUSED HERE
   - Job status = awaiting_review
   - User sees diagram in UI (presigned S3 URL)
   - Option A: Approve → SQS message job_type=format
   - Option B: Revise → SQS message job_type=arch_iterate + feedback

6. FORMATTING_OUTPUT (92%)  [triggered by format job]
   - Download arch PNG from S3
   - Open .docx template (or build default)
   - Clear body, keep styles/header/footer
   - Fill each section with Claude's content
   - Embed arch PNG in Architecture section
   - Upload .docx to S3: generated/{job_id}/filename.docx
   - Generate 24h presigned download URL

7. COMPLETE (100%)
   - status = complete
   - output_s3_key set
   - completed_at set
```

---

## Environment Variables (set in ECS Task Definition)

```
DB_SECRET_ARN       ARN of Secrets Manager secret for Aurora credentials
TAVILY_SECRET_ARN   ARN of Secrets Manager secret for Tavily key
DOCS_BUCKET         Name of documents S3 bucket
SQS_QUEUE_URL       URL of SQS generation jobs queue
AWS_REGION          us-east-1
COGNITO_USER_POOL_ID    us-east-1_ThM2KRVkt
COGNITO_CLIENT_ID       19ufsosadrbr5fqlhleargbrbi
PYTHONPATH          /app   (set in Dockerfiles)
```

---

## Common Debug Commands

```bash
# Check ECS service health
aws ecs describe-services --cluster genese-proposal-ai \
  --services genese-api-service genese-worker-service \
  --region us-east-1 \
  --query 'services[*].{name:serviceName,running:runningCount,desired:desiredCount}'

# Live API logs
aws logs tail /genese/api --follow --region us-east-1

# Live Worker logs
aws logs tail /genese/worker --follow --region us-east-1

# Check SQS queue depth
aws sqs get-queue-attributes \
  --queue-url https://sqs.us-east-1.amazonaws.com/654654306837/genese-generation-jobs \
  --attribute-names ApproximateNumberOfMessages \
  --region us-east-1

# Check DLQ (failed jobs after 3 attempts)
aws sqs get-queue-attributes \
  --queue-url https://sqs.us-east-1.amazonaws.com/654654306837/genese-generation-jobs-dlq \
  --attribute-names ApproximateNumberOfMessages \
  --region us-east-1

# Force restart API service (re-pull image)
aws ecs update-service --cluster genese-proposal-ai \
  --service genese-api-service --force-new-deployment --region us-east-1

# Force restart Worker service
aws ecs update-service --cluster genese-proposal-ai \
  --service genese-worker-service --force-new-deployment --region us-east-1

# Check Aurora cluster status
aws rds describe-db-clusters \
  --db-cluster-identifier geneseproposalaistack-auroracluster23d869c0-lavzoeprhotq \
  --region us-east-1 \
  --query 'DBClusters[0].{Status:Status,Capacity:ServerlessV2ScalingConfiguration}'

# Test API health directly
curl http://Genese-ApiLB-XYr1qAvXxyX7-1479126617.us-east-1.elb.amazonaws.com/health

# Test API via CloudFront HTTPS
curl https://d3gmhvny3loneb.cloudfront.net/api/health
```

---

## Symptom → Cause → Fix (Quick Lookup)

| Symptom | Where to look | Likely cause |
|---|---|---|
| Job stuck in `queued` | Worker logs `/genese/worker` | Worker task not running, or SQS not delivering |
| Job stuck in `generating_diagram` | Worker logs | Bedrock timeout, or diagrams/graphviz error |
| ALB returns 503 | ECS console — runningCount=0? | API task crashed or failed health check |
| Browser `NetworkError` on API call | CloudFront behaviors | `/api/*` behavior missing or StripApiPrefix not published |
| Document stuck `pending` | Worker logs | SQS race condition (API not committing before publish) |
| 401 on all API calls | API logs | JWT validation failing — check Cognito User Pool ID env var |
| Login returns 400 | API logs | Cognito `AdminInitiateAuth` error — check Client ID |
| `dimension mismatch` in pgvector | Worker logs | Embedding model changed, schema not updated |
| Worker crashes on start | Worker logs | Missing env var, bad secret ARN, import error |
| CloudFront shows old frontend | Browser | Invalidation not run — `aws cloudfront create-invalidation --paths "/*"` |
| Architecture PNG not loading | Browser network tab | S3 presigned URL expired (24h) or wrong bucket permissions |
