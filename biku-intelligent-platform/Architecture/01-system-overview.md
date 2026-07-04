# Genese Proposal AI — System Overview

> **Version**: 1.0  
> **Date**: 2026-07-03  
> **Status**: Live / Production  
> **Single source of truth for the entire system.**

---

## Table of Contents

1. [What the System Does](#1-what-the-system-does)
2. [Live Environment](#2-live-environment)
3. [High-Level Architecture](#3-high-level-architecture)
4. [Technology Stack](#4-technology-stack)
5. [AWS Infrastructure](#5-aws-infrastructure)
6. [Database Schema](#6-database-schema)
7. [API Reference](#7-api-reference)
8. [Worker Job Types](#8-worker-job-types)
9. [Key Flows](#9-key-flows)
   - 9.1 [Auth Flow](#91-auth-flow)
   - 9.2 [Document Ingestion Flow](#92-document-ingestion-flow)
   - 9.3 [Generation Pipeline Flow](#93-generation-pipeline-flow)
   - 9.4 [RAG Retrieval Flow](#94-rag-retrieval-flow)
   - 9.5 [Architecture Diagram Flow](#95-architecture-diagram-flow)
   - 9.6 [SME Review Flow](#96-sme-review-flow)
   - 9.7 [Client Portal Flow](#97-client-portal-flow)
10. [Frontend Pages](#10-frontend-pages)
11. [Design Decisions](#11-design-decisions)

---

## 1. What the System Does

Genese Proposal AI is an **internal AI-assisted document generation system** built for **Genese Solution**, a cloud consulting firm. It automates the creation of:

- **Proposals** — client-facing sales proposals
- **Statements of Work (SoW)** — scoped engagement contracts
- **Case Studies** — past-engagement success stories

### Core User Journey

```
Consultant fills form
        |
        v
System retrieves relevant context (RAG over internal docs)
        |
        v
Optional web search via Tavily for current market data
        |
        v
Claude Sonnet 4.6 drafts the document sections
        |
        v
Claude generates architecture diagram (JSON -> PNG + draw.io XML)
        |
        v
Consultant reviews, edits, and approves
        |
        v
Optional SME review (Claude as domain expert improves sections)
        |
        v
System formats and builds branded .docx output
        |
        v
Job complete — shareable client portal link available
```

The system is entirely internal; only Genese consultants log in. The generated output can be shared externally via a **public client portal link** that requires no authentication.

---

## 2. Live Environment

| Component | Value |
|-----------|-------|
| Frontend URL | https://d3gmhvny3loneb.cloudfront.net |
| API (internal ALB) | http://Genese-ApiLB-XYr1qAvXxyX7-1479126617.us-east-1.elb.amazonaws.com |
| AWS Account | 654654306837 |
| AWS Region | us-east-1 |
| CloudFront Distribution ID | E31C3VQPMUFTQZ |
| Demo login | demo@genesesolution.com / GeneseDemo2024! |

> **Note**: The ALB is internal (private). The React frontend calls it via CloudFront's `/api/*` behaviour, which strips the `/api` prefix and forwards to the ALB. Direct ALB access from the public internet is not possible.


---

## 3. High-Level Architecture

```
                        ┌─────────────────────────────────────────────────────┐
                        │                   AWS us-east-1                      │
                        │                                                       │
  Browser / Consultant  │  ┌──────────────┐    ┌──────────────────────────┐   │
  ──────────────────────┼─►│  CloudFront  │    │  S3 (Frontend)           │   │
                        │  │ E31C3VQPMUFTQZ    │  genese-proposal-ai-      │   │
                        │  │              │◄───│  frontend-654654306837    │   │
                        │  └──────┬───────┘    └──────────────────────────┘   │
                        │         │ /api/* (StripApiPrefix CF Function)        │
                        │         ▼                                             │
                        │  ┌──────────────┐                                   │
                        │  │   ALB        │  sg-08cafb5278acfbf68             │
                        │  │ (internal)   │                                   │
                        │  └──────┬───────┘                                   │
                        │         │                                             │
                        │  ┌──────▼──────────────────────────────────┐        │
                        │  │         VPC  vpc-0dd58bd2463d505d3       │        │
                        │  │         CIDR 10.0.0.0/16  (2 AZs)       │        │
                        │  │                                           │        │
                        │  │  ┌─────────────────────────────────┐    │        │
                        │  │  │  ECS Cluster: genese-proposal-ai │    │        │
                        │  │  │                                   │    │        │
                        │  │  │  ┌──────────────────────────┐   │    │        │
                        │  │  │  │  API Service             │   │    │        │
                        │  │  │  │  genese-api-service      │   │    │        │
                        │  │  │  │  TD:27  0.5vCPU / 1GB    │   │    │        │
                        │  │  │  │  sg-0574a979c34caa923    │   │    │        │
                        │  │  │  └────────────┬─────────────┘   │    │        │
                        │  │  │               │ enqueue job      │    │        │
                        │  │  │               ▼                  │    │        │
                        │  │  │  ┌──────────────────────────┐   │    │        │
                        │  │  │  │  SQS                     │   │    │        │
                        │  │  │  │  genese-generation-jobs  │   │    │        │
                        │  │  │  │  visibility: 600s        │   │    │        │
                        │  │  │  │  DLQ after 3 failures    │   │    │        │
                        │  │  │  └────────────┬─────────────┘   │    │        │
                        │  │  │               │ poll             │    │        │
                        │  │  │               ▼                  │    │        │
                        │  │  │  ┌──────────────────────────┐   │    │        │
                        │  │  │  │  Worker Service          │   │    │        │
                        │  │  │  │  genese-worker-service   │   │    │        │
                        │  │  │  │  TD:28  1vCPU / 2GB      │   │    │        │
                        │  │  │  │  sg-06903044b2e9afe46    │   │    │        │
                        │  │  │  └────────────┬─────────────┘   │    │        │
                        │  │  └───────────────┼─────────────────┘    │        │
                        │  │                  │                        │        │
                        │  │  ┌───────────────┼──────────────────┐   │        │
                        │  │  │ Data Layer    │                   │   │        │
                        │  │  │               ▼                   │   │        │
                        │  │  │  ┌────────────────────────────┐  │   │        │
                        │  │  │  │ Aurora PostgreSQL 16.4 SV2 │  │   │        │
                        │  │  │  │ + pgvector (ivfflat)       │  │   │        │
                        │  │  │  │ min 0.5 ACU / max 4 ACU    │  │   │        │
                        │  │  │  │ sg-0820d70f792deffc8       │  │   │        │
                        │  │  │  └────────────────────────────┘  │   │        │
                        │  │  │                                   │   │        │
                        │  │  │  ┌────────────────────────────┐  │   │        │
                        │  │  │  │ S3 (Docs / Artifacts)      │  │   │        │
                        │  │  │  │ genese-proposal-ai-docs-   │  │   │        │
                        │  │  │  │ 654654306837-us-east-1     │  │   │        │
                        │  │  │  └────────────────────────────┘  │   │        │
                        │  │  └───────────────────────────────────┘   │        │
                        │  └─────────────────────────────────────────-┘        │
                        │                                                       │
                        │  ┌──────────────────────────────────────────────┐   │
                        │  │ External / Managed Services                   │   │
                        │  │  Amazon Bedrock (Claude Sonnet 4.6)           │   │
                        │  │  Amazon Bedrock (Titan Text Embeddings v2)    │   │
                        │  │  Amazon Cognito  us-east-1_ThM2KRVkt          │   │
                        │  │  Tavily Web Search API (optional)             │   │
                        │  └──────────────────────────────────────────────┘   │
                        └─────────────────────────────────────────────────────┘
```

---

## 4. Technology Stack

### Backend — API Service

| Layer | Choice | Notes |
|-------|--------|-------|
| Language | Python | Async throughout |
| Web framework | FastAPI (async) | High-performance ASGI |
| ORM | SQLAlchemy (async) | Declarative models |
| DB driver | asyncpg | Async PostgreSQL driver |
| Auth integration | Amazon Cognito — AdminInitiateAuth | Server-side flow only |

### Backend — Worker Service

| Layer | Choice | Notes |
|-------|--------|-------|
| Language | Python | |
| Orchestration | LangChain | Chain construction for RAG |
| AWS SDK | boto3 | Bedrock, SQS, S3, Secrets Manager |
| LLM | Claude Sonnet 4.6 via Amazon Bedrock | Model ID: `us.anthropic.claude-sonnet-4-6` |
| Embeddings | Amazon Titan Text v2 via Bedrock | 1024 dimensions (not 1536) |
| Diagram generation | `diagrams` library + Graphviz | Renders PNG |
| draw.io export | Custom XML generator | Produces `.drawio` XML |
| PDF generation | ReportLab | |
| Web search | Tavily API | Optional; 1,000 req/month free tier |

### Frontend

| Layer | Choice |
|-------|--------|
| Framework | React + Vite |
| UI components | shadcn/ui |
| Styling | Tailwind CSS |
| Auth | Cognito JWT stored in localStorage; auto-refresh on 401 |

### Data

| Layer | Choice | Notes |
|-------|--------|-------|
| Relational DB | Aurora PostgreSQL 16.4 Serverless v2 | Scales to 0 when idle |
| Vector search | pgvector extension, ivfflat index | 1024-dim vectors |
| Object storage | Amazon S3 | Docs, diagrams, formatted output |

### Infrastructure / DevOps

| Area | Choice | Notes |
|------|--------|-------|
| IaC | AWS CDK (Python) | Same language as application |
| Container registry | Amazon ECR | Separate repos for API and Worker |
| Container runtime | Amazon ECS Fargate | Serverless containers |
| CI/CD | AWS CDK deploy + manual `ecs update-service` | See Design Decisions §11 |
| Secrets | AWS Secrets Manager | DB creds + Tavily key |
| CDN | Amazon CloudFront | Serves SPA + proxies API calls |


---

## 5. AWS Infrastructure

### Networking

| Resource | ID / Value |
|----------|-----------|
| VPC | vpc-0dd58bd2463d505d3 |
| CIDR | 10.0.0.0/16 |
| Availability Zones | us-east-1a, us-east-1b |
| Private Subnet A | subnet-0e077e24f575cd597 (us-east-1a, 10.0.2.0/24) |
| Private Subnet B | subnet-037ba0886dccac9c3 (us-east-1b, 10.0.3.0/24) |

All ECS tasks, the Aurora cluster, and the ALB run in private subnets. There are no public subnets with EC2 instances. Internet access for the worker (Tavily, Bedrock) is via a NAT Gateway.

### Security Groups

| Name | SG ID | Purpose |
|------|-------|---------|
| ALB SG | sg-08cafb5278acfbf68 | Allows inbound HTTPS from CloudFront; forwards to API SG |
| API SG | sg-0574a979c34caa923 | Allows inbound from ALB SG; allows outbound to DB SG, Worker SG, AWS services |
| Worker SG | sg-06903044b2e9afe46 | Allows outbound to DB SG, SQS, Bedrock, S3, Tavily; no inbound |
| DB SG | sg-0820d70f792deffc8 | Allows inbound on port 5432 from API SG and Worker SG only |

### ECS Cluster & Services

**Cluster**: `genese-proposal-ai`

| Service | Task Definition | vCPU | RAM | Container Image |
|---------|----------------|------|-----|----------------|
| genese-api-service | TD revision 23 | 0.5 | 1 GB | 654654306837.dkr.ecr.us-east-1.amazonaws.com/genese-proposal-ai-api |
| genese-worker-service | TD revision 27 | 1.0 | 2 GB | 654654306837.dkr.ecr.us-east-1.amazonaws.com/genese-proposal-ai-worker |

The API service is fronted by the ALB. The Worker service has no inbound network access; it only polls SQS.

### Aurora PostgreSQL

| Property | Value |
|----------|-------|
| Cluster ID | geneseproposalaistack-auroracluster23d869c0-u3dywplmcdan |
| Engine | Aurora PostgreSQL 16.4 |
| Mode | Serverless v2 |
| Min capacity | 0.5 ACU |
| Max capacity | 4 ACU |
| Extensions | pgvector |
| Index type | ivfflat |
| Credentials secret | arn:aws:secretsmanager:us-east-1:654654306837:secret:/genese/db-credentials-yADfjr |

### SQS Queue

| Property | Value |
|----------|-------|
| Queue name | genese-generation-jobs |
| Visibility timeout | 600 seconds (10 minutes) |
| Dead-letter queue | Enabled — messages moved to DLQ after 3 receive failures |

The 600-second visibility timeout covers the longest possible LLM generation job (~90s) with a large safety margin.

### S3 Buckets

| Bucket | Purpose |
|--------|---------|
| genese-proposal-ai-docs-654654306837-us-east-1 | Document uploads, generated artifacts (PNG diagrams, draw.io XML, PDFs, .docx) |
| genese-proposal-ai-frontend-654654306837-us-east-1 | React SPA static assets served via CloudFront |

### CloudFront Distribution

| Property | Value |
|----------|-------|
| Distribution ID | E31C3VQPMUFTQZ |
| Default origin | S3 frontend bucket |
| `/api/*` behavior | Forwards to ALB; CloudFront Function `StripApiPrefix` removes the `/api` prefix before forwarding |

The `StripApiPrefix` CloudFront Function rewrites the path so that a browser request to `https://d3gmhvny3loneb.cloudfront.net/api/generate` reaches the API container as `POST /generate`.

### Amazon Cognito

| Property | Value |
|----------|-------|
| User Pool ID | us-east-1_ThM2KRVkt |
| App Client ID | 19ufsosadrbr5fqlhleargbrbi |
| Auth flow | AdminInitiateAuth (server-side; requires AWS credentials) |

### AWS Secrets Manager

| Secret Path | ARN | Contents |
|-------------|-----|----------|
| /genese/db-credentials | arn:aws:secretsmanager:us-east-1:654654306837:secret:/genese/db-credentials-yADfjr | Aurora username/password |
| /genese/tavily-api-key | arn:aws:secretsmanager:us-east-1:654654306837:secret:/genese/tavily-api-key-aCxeOs | Tavily API key |

---

## 6. Database Schema

The Aurora PostgreSQL database contains five tables.

### Table: `users`

Mirrors Cognito users locally. Stores consultant profile data.

### Table: `documents`

Tracks uploaded source documents (PDFs, Word docs) used for RAG context.

| Key Column | Type | Description |
|------------|------|-------------|
| id | UUID | Primary key |
| filename | TEXT | Original file name |
| status | TEXT | processing / ready / failed |
| uploaded_by | UUID | FK → users |

### Table: `document_chunks`

Stores chunked text from documents with their vector embeddings.

| Key Column | Type | Description |
|------------|------|-------------|
| id | UUID | Primary key |
| document_id | UUID | FK → documents |
| content | TEXT | Chunk text |
| embedding | vector(1024) | Titan Text v2 embedding (1024 dims) |
| chunk_index | INT | Position within document |

The `embedding` column uses the **pgvector** extension with an **ivfflat** index for approximate nearest-neighbour search using cosine similarity.

> **Important**: The embedding dimension is **1024**, matching Amazon Titan Text Embeddings v2. It is NOT 1536 (which is the OpenAI ada-002 dimension).

### Table: `generation_jobs`

Central table — one row per generation request.

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| status | TEXT | Current pipeline state (see §8) |
| sections_content | JSONB | Generated document sections keyed by name |
| arch_json | JSONB | Claude's architecture design output |
| arch_s3_key | TEXT | S3 key for the generated PNG diagram |
| drawio_s3_key | TEXT | S3 key for the draw.io XML file |
| pdf_s3_key | TEXT | S3 key for the generated PDF |
| proposal_score | JSONB | AI-generated scoring of the proposal quality |
| outcome | TEXT | win / loss / pending — recorded by consultant |
| input_tokens | INT | Total LLM input tokens consumed |
| output_tokens | INT | Total LLM output tokens consumed |

### Table: `arch_references`

Stores architecture diagram style samples uploaded by consultants for use as diagram generation references.

---

## 7. API Reference

All endpoints except `/health` and `/portal/{job_id}` require a valid Cognito JWT in the `Authorization: Bearer <token>` header.

### Health

| Method | Path | Description |
|--------|------|-------------|
| GET | /health | Returns 200 OK; used by ALB health checks |

### Authentication

| Method | Path | Description |
|--------|------|-------------|
| POST | /auth/login | Initiates AdminInitiateAuth; returns access + refresh tokens |
| POST | /auth/signup | Creates new Cognito user |
| POST | /auth/refresh | Exchanges refresh token for new access token |
| POST | /auth/forgot-password | Triggers Cognito forgot-password flow |
| POST | /auth/confirm-forgot-password | Confirms password reset with code |

### Documents

| Method | Path | Description |
|--------|------|-------------|
| GET | /documents | List all documents for the authenticated user |
| POST | /documents/upload | Upload a document; enqueues ingestion job |
| GET | /documents/{id}/status | Poll ingestion status |
| DELETE | /documents/{id} | Delete document and its chunks |

### Generation

| Method | Path | Description |
|--------|------|-------------|
| POST | /generate | Submit generation form; enqueues generation job |
| GET | /generate/{id} | Poll job status and retrieve sections_content |
| GET | /generate/{id}/architecture | Retrieve arch PNG S3 URL and draw.io XML S3 URL |
| POST | /generate/{id}/approve | Approve the draft; triggers format job |
| POST | /generate/{id}/iterate-architecture | Request architecture diagram revision |
| POST | /generate/{id}/outcome | Record win/loss outcome |
| POST | /generate/{id}/retry | Retry a failed job |
| DELETE | /generate/{id}/cancel | Cancel a queued or in-progress job |
| POST | /generate/extract-requirements | Extract structured requirements from free-text input |

### Jobs

| Method | Path | Description |
|--------|------|-------------|
| GET | /jobs | List all generation jobs for the authenticated user |

### Search

| Method | Path | Description |
|--------|------|-------------|
| POST | /search | RAG search over document_chunks; returns top-5 chunks |

### Templates

| Method | Path | Description |
|--------|------|-------------|
| GET | /templates | List available branded templates |
| POST | /templates/upload | Upload a new .docx template |
| GET | /templates/{type}/download | Download a template by type |
| DELETE | /templates/{type} | Delete a template |

### Architecture References

| Method | Path | Description |
|--------|------|-------------|
| GET | /arch-references | List architecture diagram style references |
| POST | /arch-references | Upload a new reference image |
| DELETE | /arch-references/{id} | Delete a reference |

### Public Portal

| Method | Path | Auth Required | Description |
|--------|------|--------------|-------------|
| GET | /portal/{job_id} | No | Returns read-only view of a completed job for external client sharing |


---

## 8. Worker Job Types

The worker container polls SQS and dispatches on the `job_type` field.

| Job Type | Trigger | What It Does |
|----------|---------|-------------|
| `ingestion` | POST /documents/upload | Loads document, chunks text, generates Titan embeddings, stores in document_chunks |
| `generation` | POST /generate | Full RAG + Tavily + Claude draft + architecture diagram pipeline |
| `format` | POST /generate/{id}/approve | Takes approved sections_content → builds branded .docx, PDF → uploads to S3 |
| `arch_iterate` | POST /generate/{id}/iterate-architecture | Re-runs diagram generation with revised Claude prompt based on user feedback |

### Generation Pipeline States

The `status` column on `generation_jobs` progresses through these exact states:

```
queued
  |
  v
retrieving_context        (RAG: embed query, cosine search, fetch top-5 chunks)
  |
  v
validating_sources        (Tavily web search for supplementary data, if enabled)
  |
  v
drafting_document         (Claude Sonnet 4.6 generates all document sections)
  |
  v
generating_diagram        (Claude designs arch JSON; diagrams lib renders PNG + draw.io XML)
  |
  v
awaiting_review           (PAUSE — consultant reviews in UI)
  |
  v
[sme_reviewing]           (OPTIONAL — Claude acts as SME domain expert, critiques and improves sections)
  |
  v
formatting_output         (Worker builds .docx from approved sections + branding template)
  |
  v
complete                  (All S3 artifacts available; portal link active)
```

States in `[brackets]` are optional and only entered when the consultant enables the SME review toggle.

---

## 9. Key Flows

### 9.1 Auth Flow

```
Browser                 API (FastAPI)           Cognito
  |                          |                      |
  |-- POST /auth/login ------>|                      |
  |   {email, password}      |                      |
  |                          |-- AdminInitiateAuth ->|
  |                          |   (server-side;       |
  |                          |    uses IAM role)     |
  |                          |<-- AccessToken,  -----|
  |                          |    RefreshToken,      |
  |                          |    IdToken            |
  |<-- {accessToken,  --------|                      |
  |     refreshToken}        |                      |
  |                          |                      |
  | [tokens stored in localStorage]                 |
  |                          |                      |
  | [subsequent requests: Authorization: Bearer <accessToken>]
  |                          |                      |
  | [on 401 response]        |                      |
  |-- POST /auth/refresh ---->|                      |
  |   {refreshToken}         |-- InitiateAuth    --->|
  |                          |   (REFRESH_TOKEN)    |
  |<-- {new accessToken} -----|                      |
```

**Why AdminInitiateAuth via backend**: The `AdminInitiateAuth` flow requires AWS IAM credentials (not just a Cognito app client secret). The API container runs with an ECS task IAM role that has permission to call this Cognito API. The browser has no AWS credentials, so the auth call must be proxied through the backend.

---

### 9.2 Document Ingestion Flow

```
Browser                  API                    SQS               Worker
  |                        |                      |                   |
  |-- POST /documents/ --->|                      |                   |
  |      upload            |                      |                   |
  |   (multipart file)     |                      |                   |
  |                        |-- store file to S3 ->|                   |
  |                        |-- INSERT documents   |                   |
  |                        |   (status=processing)|                   |
  |                        |-- SendMessage ------->|                   |
  |                        |   job_type=ingestion  |                   |
  |<-- {document_id} -------|                      |                   |
  |                        |                      |-- ReceiveMessage ->|
  |                        |                      |                   |
  |                        |                      |         [PHASE 1: LOAD]
  |                        |                      |         Read file from S3
  |                        |                      |         Parse PDF/DOCX text
  |                        |                      |                   |
  |                        |                      |         [PHASE 2: CHUNK]
  |                        |                      |         Split text into
  |                        |                      |         overlapping chunks
  |                        |                      |                   |
  |                        |                      |         [PHASE 3: EMBED]
  |                        |                      |         Call Bedrock Titan
  |                        |                      |         Text v2 per chunk
  |                        |                      |         → vector(1024)
  |                        |                      |                   |
  |                        |                      |         [PHASE 4: STORE]
  |                        |                      |         INSERT document_chunks
  |                        |                      |         (content, embedding)
  |                        |                      |         UPDATE documents
  |                        |                      |         (status=ready)
  |                        |                      |-- DeleteMessage -->|
  |                        |                      |                   |
  |-- GET /documents/ ----->|                      |                   |
  |      {id}/status        |-- SELECT status ---->|                   |
  |<-- {status: "ready"} ---|                      |                   |
```

---

### 9.3 Generation Pipeline Flow

```
Browser              API               SQS            Worker           Bedrock / Tavily
  |                   |                 |                |                    |
  |-- POST /generate ->|                |                |                    |
  |   {form data}     |                |                |                    |
  |                   |-- INSERT        |                |                    |
  |                   |   generation_   |                |                    |
  |                   |   jobs          |                |                    |
  |                   |   status=queued |                |                    |
  |                   |-- SendMessage ->|                |                    |
  |                   |   job_type=     |                |                    |
  |                   |   generation    |                |                    |
  |<-- {job_id} -------|                |                |                    |
  |                   |                |- ReceiveMsg --->|                    |
  |                   |                |                 |                    |
  |                   |           [STATE: retrieving_context]                |
  |                   |                |    Embed query  |-- Titan embed ---->|
  |                   |                |                 |<-- vector(1024) ---|
  |                   |                |    pgvector     |                    |
  |                   |                |    cosine sim   |                    |
  |                   |                |    → top-5      |                    |
  |                   |                |    chunks       |                    |
  |                   |                |                 |                    |
  |                   |           [STATE: validating_sources]                |
  |                   |                |    (if Tavily   |-- Tavily search -->|
  |                   |                |     enabled)    |<-- web results ----|
  |                   |                |                 |                    |
  |                   |           [STATE: drafting_document]                 |
  |                   |                |    Build prompt |                    |
  |                   |                |    (RAG chunks  |                    |
  |                   |                |    + Tavily     |                    |
  |                   |                |    + form data) |-- Claude invoke -->|
  |                   |                |                 |<-- sections JSON --|
  |                   |                |    UPDATE       |                    |
  |                   |                |    sections_    |                    |
  |                   |                |    content JSONB|                    |
  |                   |                |                 |                    |
  |                   |           [STATE: generating_diagram]                |
  |                   |                |    Claude arch  |-- Claude invoke -->|
  |                   |                |    design       |<-- arch_json ------|
  |                   |                |    diagrams lib |                    |
  |                   |                |    + Graphviz   |                    |
  |                   |                |    → PNG        |                    |
  |                   |                |    draw.io XML  |                    |
  |                   |                |    → S3         |                    |
  |                   |                |                 |                    |
  |                   |           [STATE: awaiting_review]  ← PAUSE          |
  |                   |                                                       |
  | [Consultant reviews sections and arch diagram in UI]                     |
  |                   |                                                       |
  |-- POST /generate/ ->|               |                |                    |
  |   {id}/approve    |                |                |                    |
  |                   |-- SendMessage ->|                |                    |
  |                   |   job_type=     |                |                    |
  |                   |   format        |                |                    |
  |                   |                |- ReceiveMsg --->|                    |
  |                   |           [STATE: formatting_output]                 |
  |                   |                |    Load .docx   |                    |
  |                   |                |    template     |                    |
  |                   |                |    Inject       |                    |
  |                   |                |    sections     |                    |
  |                   |                |    Insert PNG   |                    |
  |                   |                |    → .docx      |                    |
  |                   |                |    ReportLab    |                    |
  |                   |                |    → .pdf       |                    |
  |                   |                |    → S3         |                    |
  |                   |                |                 |                    |
  |                   |           [STATE: complete]                          |
  |<-- poll complete --|                |                |                    |
```

---

### 9.4 RAG Retrieval Flow

```
Worker
  |
  |  1. Receive query text (from generation form: client name, project type, scope)
  |
  |  2. Call Amazon Bedrock — Titan Text Embeddings v2
  |       model: amazon.titan-embed-text-v2:0
  |       input: query string
  |       output: float[1024]
  |
  |  3. Execute pgvector cosine similarity search
  |       SELECT content, 1 - (embedding <=> $query_vector) AS score
  |       FROM document_chunks
  |       ORDER BY embedding <=> $query_vector
  |       LIMIT 5;
  |
  |  4. Return top-5 chunks (sorted by descending similarity score)
  |
  |  5. Concatenate chunk texts into context block
  |
  |  6. Pass context block to Claude prompt as [RETRIEVED CONTEXT] section
```

The cosine distance operator `<=>` is provided by the pgvector extension. The ivfflat index accelerates approximate nearest-neighbour lookup over large chunk tables without requiring an exact scan.

---

### 9.5 Architecture Diagram Flow

```
Worker
  |
  |  1. Build architecture design prompt
  |       - Include: client requirements, project scope, tech stack preferences
  |       - Include: arch_references (style samples uploaded by consultant)
  |       - Instruct: output structured JSON with nodes, edges, groupings
  |
  |  2. Call Claude Sonnet 4.6 → returns arch_json
  |       arch_json stored in generation_jobs.arch_json JSONB column
  |
  |  3. Parse arch_json
  |       Extract: services (nodes), connections (edges), clusters/groups
  |
  |  4. diagrams library + Graphviz
  |       Construct Diagram() object programmatically from arch_json
  |       Render to PNG file
  |       Upload PNG → S3 → store key in arch_s3_key
  |
  |  5. Custom draw.io XML generator
  |       Convert arch_json → draw.io mxGraph XML format
  |       Upload .drawio file → S3 → store key in drawio_s3_key
  |
  |  6. Transition status → awaiting_review
  |       Consultant can view PNG and download .drawio for editing
  |
  |  [If consultant requests iteration]
  |
  |  7. POST /generate/{id}/iterate-architecture
  |       Enqueues job_type=arch_iterate with revision feedback text
  |
  |  8. Worker re-runs steps 1–5 with additional prompt context:
  |       "Previous design: <arch_json>. Feedback: <user feedback>. Revise accordingly."
```

---

### 9.6 SME Review Flow

The SME review step is **optional** and toggled by the consultant before approving.

```
Consultant enables "SME Review" toggle in UI
        |
        v
POST /generate/{id}/approve  { sme_review: true }
        |
        v
Worker transitions status → sme_reviewing
        |
        v
For each section in sections_content:
  - Build SME prompt:
      "You are a senior cloud solutions expert at Genese Solution.
       Review this [section type] section and improve it for
       technical accuracy, persuasiveness, and alignment with
       AWS best practices. Here is the draft: [section text]"
  - Call Claude Sonnet 4.6
  - Replace section content with Claude's improved version
        |
        v
Update sections_content JSONB with improved sections
        |
        v
Transition status → formatting_output
        |
        v
Continue to format job (build .docx)
```

---

### 9.7 Client Portal Flow

```
Consultant (after job is complete)
        |
        v
Copies shareable link: https://d3gmhvny3loneb.cloudfront.net/portal/<job_id>
        |
        v
Sends link to client (no login required)
        |
        v
Client Browser
        |
  GET /portal/<job_id>  (via CloudFront → ALB → API)
        |
        v
API: SELECT * FROM generation_jobs WHERE id = job_id AND status = 'complete'
        |
        v
Returns read-only JSON with:
  - sections_content (proposal/SoW/case study text)
  - arch_s3_key → signed S3 URL for PNG diagram
  - proposal_score (quality scores)
  - (no auth fields, no internal metadata)
        |
        v
Frontend renders Portal page (public React route /portal/:jobId)
  - No navigation bar, no login prompt
  - Displays branded proposal content
  - Shows architecture diagram
  - Download button for .docx / PDF (signed S3 URLs)
```


---

## 10. Frontend Pages

The React SPA (served from CloudFront) has the following routes:

| Route | Page Name | Auth Required | Description |
|-------|-----------|--------------|-------------|
| `/login` | Login | No | Email/password login form; calls POST /auth/login |
| `/auth/callback` | AuthCallback | No | Handles post-auth redirect; stores tokens |
| `/generate` | Generate | Yes | Main form: client name, project type, scope, doc selection, SME toggle; submits POST /generate |
| `/history` | History | Yes | Lists all generation jobs with version grouping, tags, inline document reader, and win/loss outcome recording |
| `/documents` | Documents | Yes | Grid view of uploaded documents; upload new docs; shows ingestion status |
| `/search` | Search | Yes | RAG search interface; calls POST /search; shows top-5 matching chunks with source document attribution |
| `/arch-references` | Arch References | Yes | Upload and manage architecture diagram style samples used as references during diagram generation |
| `/portal/:jobId` | Portal | No (public) | Read-only branded view of a completed job for external client sharing |

### History Page — Feature Detail

The History page is the most feature-rich page:

- **Version grouping**: Multiple iterations of the same proposal are grouped together
- **Tags**: Consultants can tag jobs (e.g., "AWS Migration", "FinTech", "Won")
- **Inline reader**: Expand any job row to read sections_content without navigating away
- **Win/Loss recording**: Outcome selector (Win / Loss / Pending) calls POST /generate/{id}/outcome; outcome stored in generation_jobs.outcome and used for future reporting

---

## 11. Design Decisions

Every significant architectural choice is documented here with the rationale for that choice and the alternatives that were rejected.

---

### ECS Fargate — not Lambda

**Chosen**: ECS Fargate (long-running containers)  
**Rejected**: AWS Lambda functions

**Reason**: LLM generation jobs take **30–90 seconds** to complete (RAG retrieval + Tavily calls + Claude drafting + diagram rendering). AWS Lambda has a maximum execution timeout of 15 minutes, but the real constraint is the SQS consumer pattern: Lambda's SQS trigger batches messages and handles concurrency differently from a long-polling consumer loop. A Fargate container runs a tight `while True: poll → process → delete` loop, which is the natural fit for a job queue worker. Lambda would add cold-start latency, require careful concurrency tuning, and complicate the stateful progress updates written back to the database mid-job.

---

### Aurora PostgreSQL + pgvector — not Amazon OpenSearch

**Chosen**: Aurora PostgreSQL 16.4 Serverless v2 + pgvector extension  
**Rejected**: Amazon OpenSearch Service with k-NN vector search

**Reason**: Three factors drove this decision:

1. **Scale to zero**: Aurora Serverless v2 scales down to 0.5 ACU when idle. An internal tool with intermittent usage would incur unnecessary cost on a dedicated OpenSearch cluster.
2. **Single database**: All application data (users, documents, jobs) already lives in PostgreSQL. Adding OpenSearch would introduce a second data store, dual-write complexity, and additional operational burden.
3. **SQL familiarity**: The team is fluent in SQL. pgvector's `<=>` cosine distance operator integrates naturally with existing SQLAlchemy queries. There is no performance case for OpenSearch at the current document scale.

---

### AWS CDK (Python) — not Terraform

**Chosen**: AWS CDK with Python  
**Rejected**: Terraform (HCL)

**Reason**: The entire application is written in Python. Using CDK means the IaC and the application share the same language, the same dependency management (`pip`/`requirements.txt`), and the same developer tooling. CDK's high-level constructs (e.g., `aws_ecs_patterns.ApplicationLoadBalancedFargateService`) generate dozens of CloudFormation resources from a few lines of Python, reducing boilerplate significantly versus equivalent Terraform HCL.

---

### ECS Services Deployed via CLI — not CDK

**Chosen**: `aws ecs update-service` CLI commands for ECS service updates  
**Rejected**: CDK `cdk deploy` for ECS service updates

**Reason**: CloudFormation's ECS service stabilization logic waits for a service to reach a stable state before marking a stack update complete. In practice, if a new task definition has a startup issue (e.g., a missing environment variable), CloudFormation will wait for the default stabilization timeout — which can be **3 hours** — before rolling back. This makes `cdk deploy` impractical for iterative development. Deploying new container images via `aws ecs update-service --force-new-deployment` is instantaneous and gives the developer direct control; the ECS service's built-in rolling update handles the actual deployment.

---

### Cognito AdminInitiateAuth via Backend — not Browser SDK

**Chosen**: Backend proxies all Cognito auth calls using `AdminInitiateAuth`  
**Rejected**: Browser-side Cognito via Amplify JS / Hosted UI

**Reason**: The `AdminInitiateAuth` API is a server-side Cognito operation that requires **AWS IAM credentials** with the `cognito-idp:AdminInitiateAuth` permission. The browser has no AWS credentials. The API container runs with an ECS task IAM role that has this permission. This approach also keeps auth logic centralised in the backend and avoids exposing Cognito configuration details (pool ID, client ID) beyond what is strictly necessary.

---

### Amazon Titan Text Embeddings v2 — not OpenAI text-embedding-ada-002

**Chosen**: Amazon Titan Text Embeddings v2 (`amazon.titan-embed-text-v2:0`)  
**Rejected**: OpenAI `text-embedding-ada-002` (1536 dims)

**Reason**: Two factors:

1. **Data residency**: Client proposal data and internal company documents never leave AWS. Using Bedrock keeps all data within the AWS account and region.
2. **Cost**: Bedrock Titan embeddings are billed per token at AWS rates with no per-API-call overhead. There is no external API key to manage.

The Titan v2 model produces **1024-dimensional** vectors (vs. OpenAI ada-002's 1536). The pgvector `document_chunks.embedding` column is declared as `vector(1024)` to match exactly.

---

### Two Separate Containers (API + Worker) — not a Single Container

**Chosen**: Separate ECS services for the API (`genese-api-service`) and the Worker (`genese-worker-service`)  
**Rejected**: A single container handling both HTTP requests and background jobs

**Reason**: The API and Worker have fundamentally different resource profiles and scaling requirements:

| Concern | API Service | Worker Service |
|---------|------------|---------------|
| CPU / RAM | 0.5 vCPU / 1 GB | 1 vCPU / 2 GB |
| Scaling driver | HTTP request rate | SQS queue depth |
| Job duration | Milliseconds (CRUD) | 30–90 seconds (LLM) |
| Blocking risk | None | High (LLM calls are blocking) |

If the Worker ran inside the API container, a surge of long-running LLM jobs would starve FastAPI's async event loop of worker threads, causing HTTP latency spikes for all other API users. Separation ensures that LLM jobs **never block HTTP responses**.

---

*End of System Overview*
