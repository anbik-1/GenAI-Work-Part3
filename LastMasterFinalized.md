# LastMasterFinalized.md
## Genese Proposal AI — Complete Decision Record

> Every decision, every service choice, every workflow, every tradeoff.
> Written so you can explain any part of this system to anyone.

---

## 1. What We Set Out to Build

**The Problem:** Genese Solution consultants spend hours writing proposals that are 80% identical to the last one. They manually re-read past work, rewrite nearly identical sections, and check AWS documentation by hand.

**The Goal:** An internal AI system where the consultant describes a client's needs → gets a first-draft branded proposal in 60 seconds. The consultant edits, not writes.

**Three core features:**
1. **RAG-powered generation** — Claude reads your past proposals and uses them as context when writing
2. **Live architecture diagram** — automatically designs an AWS architecture for the engagement, which you review and approve before the final document
3. **Knowledge base search** — ask "what did we do for fintech clients?" and get an AI answer with citations

---

## 2. Every Service Decision — Why We Chose It

### LLM: Claude Sonnet 4.6 via Amazon Bedrock

**Why:** Active in this AWS account. Data stays inside AWS — never leaves your network boundary. Strong at structured JSON output (critical for parsing proposal sections).

**Model ID used:** `us.anthropic.claude-sonnet-4-6` (cross-region inference profile)

**Cost:** ~$0.003/1K input tokens + $0.015/1K output tokens. A typical proposal costs $0.03–$0.10.

**What we rejected:**
- OpenAI GPT-4: better creative writing, but proposal text leaves AWS
- Amazon Nova Pro: cheaper but weaker on nuanced consulting text
- Open-source LLM on GPU: zero per-token cost but GPU EC2 ops burden

**Key lesson learned:** Claude rejects `temperature` + `top_p` together — use only one.

---

### Embeddings: Amazon Titan Text Embeddings v2 via Bedrock

**Why:** AWS-native (zero external API calls), cheapest embedding in the account, data stays in AWS.

**Dimension:** 1024 (not 1536 — this cost us debugging time, documented below)

**Cost:** $0.00002 per 1K tokens — essentially free for our volume

**What we rejected:**
- Cohere Embed v3 via Bedrock: slightly better quality, more expensive
- Cohere direct API / OpenAI embeddings: data leaves AWS

---

### Vector Database: Aurora PostgreSQL Serverless v2 + pgvector

**Why:** Scales to 0 ACU when idle (near-zero cost when not in use). Stores all app data in one place — jobs, users, documents, embeddings. SQL familiarity for the team.

**Key config:** `serverless_v2_min_capacity=0.5`, `max=4`. pgvector `ivfflat` index with `lists=10`.

**What we rejected:**
- OpenSearch Serverless: managed vector search, but $300–700/month minimum floor cost always running
- Pinecone/Weaviate: external SaaS, data leaves AWS
- Bedrock Knowledge Bases: fully managed RAG, but less control over chunking and retrieval

**Key lesson learned:** Titan Text v2 returns 1024-dim vectors, not 1536. Always verify actual model output dimensions before creating schema.

---

### Compute: ECS Fargate (2 services)

**Why ECS and not Lambda:** LLM generation takes 30–90 seconds. Lambda cold starts add 3–5s and the 15-minute limit is fine technically, but the SQS consumer pattern (a loop that runs forever polling for messages) doesn't fit Lambda. Fargate is the right model for "long-running async worker."

**Two services:**
- **API service** (FastAPI): 0.5 vCPU / 1GB RAM — handles HTTP requests, auth, DB reads/writes, SQS publish
- **Worker service** (LangChain): 1 vCPU / 2GB RAM — does all the heavy work (RAG, Bedrock calls, diagram generation, .docx building)

**Why separated:** They have different scaling needs. If generation is slow, add more workers. If the API is under load, add more API tasks. They don't share a process and can't block each other.

**Key lesson learned:** Never let CloudFormation manage ECS services — CFN waits up to 3 hours for ECS service stabilization. We create ECS services via CLI after CDK deploys infrastructure.

---

### Job Queue: Amazon SQS

**Why:** Decouples the API (sync HTTP) from the Worker (async LLM work). API returns `job_id` in milliseconds. Worker processes at its own pace. If worker crashes, SQS redelivers the message automatically.

**Key config:** Visibility timeout = 600 seconds (10 min), DLQ after 3 failures.

**Critical lesson learned:** Always commit the DB record BEFORE publishing to SQS. If SQS message arrives before DB commit is visible, the worker finds nothing and silently drops the job. This caused "permanent pending" bugs that took hours to debug.

---

### Web Search: Tavily

**Why:** Purpose-built for LLM agents. Free tier (1,000/month) with no credit card. Used to validate architecture recommendations against live AWS/Azure/GCP documentation.

**Sign up:** app.tavily.com — email only, no billing

**Key lesson learned:** Store the Tavily key as a plain string in Secrets Manager, not JSON. The code must handle BOTH `{"api_key": "..."}` JSON format AND plain string format. Also: skip gracefully if the key is a placeholder.

---

### IaC: AWS CDK (Python)

**Why:** Same language as the app (Python monorepo). High-level constructs handle IAM wiring automatically. Synths to CloudFormation.

**Critical caveat:** ECS services are NOT in CDK. See "CDK vs CLI" section below.

**What we rejected:**
- Terraform: multi-cloud, but HCL is a separate language from Python app
- CloudFormation YAML: verbose, no logic
- AWS SAM: serverless-only, doesn't fit ECS architecture

---

### Authentication: Amazon Cognito

**Why:** Native AWS integration. API validates JWTs server-side via `AdminInitiateAuth`. No external auth service.

**Key lesson learned:** NEVER call Cognito `AdminInitiateAuth` from the browser. It requires server-side AWS credentials. The frontend calls `POST /api/auth/login` → FastAPI → Cognito → JWT returned to browser.

---

### Frontend: React + shadcn/ui + Tailwind CSS + Vite

**Why:** Modern, polished UI. shadcn/ui components are copied into the project (fully owned, not a runtime dependency). Vite 8 for fast builds.

**Hosting:** S3 + CloudFront. Frontend is static files — no server. CloudFront provides HTTPS, CDN, and proxies `/api/*` → ALB (solves mixed-content HTTPS→HTTP browser block).

---

### Architecture Diagram: Python `diagrams` library + Graphviz

**Why:** Generates professional AWS-style PNG with real service icons automatically from JSON. Claude designs the architecture as structured JSON → `diagrams` library renders it.

**Flow:** Claude → JSON (title, layers, nodes, connections) → `diagrams` renders PNG → uploaded to S3 → presigned URL shown in UI → consultant reviews → approves or requests changes.

---

## 3. Application Architecture

```
Browser (HTTPS)
    │
    ▼
CloudFront CDN
    ├── /* ──────────── S3 (React SPA static files)
    └── /api/* ─────── StripApiPrefix CF Function ──→ ALB (HTTP)
                                                          │
                                                          ▼
                                                   ECS Fargate: API
                                                   (FastAPI, TD:20)
                                                          │
                                    ┌─────────────────────┼────────────────────┐
                                    ▼                     ▼                    ▼
                               Aurora DB             S3 Bucket           SQS Queue
                            (pgvector, jobs,      (raw uploads +      (generation jobs)
                             users, docs,          generated .docx)
                             embeddings)
                                    │
                              ┌─────┘
                              ▼
                   ECS Fargate: Worker
                   (LangChain, TD:25)
                              │
               ┌──────────────┼──────────────┬────────────┐
               ▼              ▼              ▼            ▼
         Bedrock LLM    Bedrock Titan    Tavily       S3
       (Claude 4.6)    (Embeddings v2) (web search) (read raw/
                                                     write output)
```

---

## 4. Detailed User Workflows

### Workflow A: Upload a Document to Knowledge Base

```
1. User opens Documents page
2. Selects file (PDF/DOCX/TXT), picks type + client name
3. Clicks Upload
4. API: validates → uploads to S3 (raw/{id}/filename)
5. API: commits Document record to DB ← COMMIT FIRST
6. API: publishes SQS ingestion message ← THEN SQS
7. Page polls /documents/{id}/status every 4s
8. Worker picks up SQS message:
   Phase 1 LOADING:    downloads from S3, extracts text
   Phase 2 CHUNKING:   RecursiveCharacterTextSplitter (512 chars, 50 overlap)
   Phase 3 EMBEDDING:  Titan Text v2 → 1024-dim vectors (tracks token count)
   Phase 4 STORING:    inserts chunks+vectors into pgvector
9. Status shows: Loading ✓ → Chunking ✓ → Embedding ✓ → Storing ✓ → Indexed ✅
10. Token count + cost displayed (e.g. 2,483 tokens → $0.000050)
```

### Workflow B: Generate a Proposal

```
1. User fills Generate form: doc type, client name, engagement type, requirements
2. Clicks Generate
3. API: creates GenerationJob (status=queued) → COMMIT → publish to SQS
4. Frontend polls /generate/{job_id} every 3s, shows step progress:

   RETRIEVING CONTEXT (pct: 20%)
   → Worker embeds query → cosine similarity search in pgvector
   → Returns top-5 most relevant document chunks

   VALIDATING SOURCES (pct: 35%)
   → Tavily searches live AWS/Azure docs for architecture validation
   → Caches results 24h to preserve free-tier credits

   DRAFTING DOCUMENT (pct: 55%)
   → Claude Sonnet 4.6 prompt:
     System: "You are a Genese proposal writer..."
     Context: retrieved chunks + Tavily sources
     Request: "Generate JSON with keys: [executive_summary, problem_statement, ...]"
   → Claude returns structured JSON with one key per section
   → Tokens captured for cost display

   GENERATING DIAGRAM (pct: 70%)
   → Claude designs architecture as JSON (title, layers, nodes, connections)
   → `diagrams` library renders PNG with real AWS service icons
   → PNG uploaded to S3, URL stored

   AWAITING REVIEW (pct: 80%) ← PAUSES HERE
   → User sees architecture diagram inline
   → Option A: "Approve" → document formatting begins
   → Option B: "Request changes" → Claude redesigns, iterate as needed

   FORMATTING OUTPUT (pct: 92%)
   → python-docx opens Genese branded template (or default)
   → Clears body, keeps styles/header/footer
   → Fills sections with Claude's content
   → Embeds architecture PNG in Architecture section
   → Uploads .docx to S3

   COMPLETE (pct: 100%)
   → Presigned download URL (24h validity)
   → Token count + cost displayed
```

### Workflow C: Search the Knowledge Base

```
1. User types query: "what did we do for fintech clients?"
2. API: embeds query via Titan Text v2
3. pgvector cosine similarity search → top-5 chunks
4. Claude synthesises an AI answer from retrieved chunks
5. Response shows: answer text + source documents with similarity scores
```

### Workflow D: Architecture Review (from History page)

```
Previously: if you closed the tab during awaiting_review, you lost access to review.
Now: History page shows "Review Architecture" button for awaiting_review jobs.
1. Click "Review Architecture" → diagram expands inline
2. See the PNG diagram + iteration number
3. "Approve & Generate Document" → triggers final formatting
4. Or type feedback → "Revise Architecture" → Claude redesigns → review again
```

---

## 5. Technical Workflow: The RAG Pipeline in Detail

```
OFFLINE (ingestion — happens when you upload a doc):
┌─────────────────────────────────────────────────────────┐
│  PDF/DOCX/TXT                                           │
│       ↓                                                 │
│  Text extraction (pypdf / python-docx)                  │
│       ↓                                                 │
│  Chunking: 512 chars, 50 overlap, filter <50 char chunks│
│       ↓                                                 │
│  Titan Text v2: each chunk → 1024-dim float vector     │
│       ↓                                                 │
│  pgvector INSERT: (chunk_text, vector, metadata)        │
└─────────────────────────────────────────────────────────┘

ONLINE (retrieval — happens during generation):
┌─────────────────────────────────────────────────────────┐
│  Query: "ECS Fargate aws_migration banking"             │
│       ↓                                                 │
│  Titan Text v2: query → 1024-dim vector                 │
│       ↓                                                 │
│  pgvector: SELECT chunks ORDER BY embedding <=> query   │
│            LIMIT 5  (cosine distance)                   │
│       ↓                                                 │
│  Top-5 most semantically similar chunks returned       │
│       ↓                                                 │
│  Injected into Claude prompt as "PAST WORK CONTEXT"    │
│       ↓                                                 │
│  Claude generates proposal that references your work   │
└─────────────────────────────────────────────────────────┘
```

**Why cosine similarity?** It finds semantically similar text even when exact words differ. "fintech cloud migration" matches "NepPay moved to AWS" because the vectors are close in 1024-dimensional space.

---

## 6. CDK vs CLI — What Each Covers

### What CDK Deploys (Infrastructure)
```
✅ VPC (2 AZ, public + private subnets, NAT gateway)
✅ S3 buckets (documents + frontend)
✅ CloudFront distribution (SPA + /api/* proxy)
✅ Cognito User Pool + Client
✅ Aurora PostgreSQL Serverless v2 (pgvector)
✅ SQS queue + DLQ
✅ ECR repositories (api + worker)
✅ ECS Cluster
✅ ECS Task Definitions (API + Worker)
✅ ALB + Target Group + Listener
✅ IAM roles and policies
✅ CloudWatch log groups
✅ Secrets Manager (DB credentials, Tavily placeholder)
```

### What CLI Creates (after CDK deploy)
```
⚠️  ECS Services — created via AWS CLI
     Reason: CloudFormation waits up to 3 hours for ECS service stabilization
     This caused major deployment failures during development
     Solution: Deploy infra via CDK, create ECS services via CLI

⚠️  CloudFront /api/* behavior — added via CLI/Python after CDK
     Reason: CDK CloudFront distribution is created without the ALB behavior
     The behavior (StripApiPrefix function + ALB origin) is added post-deploy

⚠️  Database migration — runs as one-off ECS task
     Reason: Aurora is in private subnet, unreachable from outside VPC
     Migration task runs inside VPC using the worker container

⚠️  Docker images — built and pushed via CLI
     Reason: CDK references ECR repos but doesn't build images

⚠️  Cognito users — created via CLI
     Reason: CDK creates the pool, users are created separately

⚠️  Frontend deployment — built + synced to S3 via CLI
     Reason: CDK creates the bucket, frontend is built and synced separately
```

---

## 7. All Issues We Hit and Fixed

1. **CFN ECS stabilization timeout** — CFN waits hours for ECS to stabilize. Fix: remove ECS services from CDK, create via CLI.
2. **Aurora RDS invalid password** — Generated password contained `/`, `@`, `"`. Fix: explicit `exclude_characters` in CDK secret generator.
3. **Mixed content HTTPS→HTTP** — Browser blocks fetch from HTTPS page to HTTP ALB. Fix: CloudFront `/api/*` → ALB proxy.
4. **Cognito login wrong flow** — Browser can't call `AdminInitiateAuth` directly. Fix: backend proxy, frontend calls own API.
5. **pgvector SQL syntax conflict** — `:embedding::vector` conflicts with asyncpg bind variables. Fix: serialize embedding as f-string literal.
6. **Embedding dimension mismatch** — Titan v2 is 1024 dims not 1536. Fix: update schema and constants.
7. **Tavily secret not JSON** — `json.loads()` fails on plain string. Fix: try JSON, fall back to plain string.
8. **`temperature` + `top_p` both set** — Claude rejects both together. Fix: remove `top_p`.
9. **Old Docker image after push** — ECS caches task definition. Fix: register new task definition revision + update service.
10. **SQS race condition** — DB not committed before SQS publish. Fix: commit first, then publish.
11. **`def main():` missing in worker** — strReplace accidentally removed function definition. Fix: re-add.
12. **`@router.get` decorator missing** — Multiple times, strReplace removed the decorator. Fix: always verify routes after edits.
13. **`import json` missing in orchestrator** — `json.dumps()` failed. Fix: add import.
14. **Wrong import path for architecture_generator** — `from .architecture_generator` should be `from ..generation.architecture_generator`. Fix: correct relative import path.
15. **PendingRollbackError on DB write** — Failed transaction before JSONB cast. Fix: `db.rollback()` before execute, use `CAST(:x AS jsonb)` not `::jsonb`.
16. **`logger` not defined** — Used `logger.info()` before defining it. Fix: `import logging; logger = logging.getLogger(__name__)`.

---

## 8. Current Live Deployment

| Resource | Value |
|----------|-------|
| Frontend URL | https://d3gmhvny3loneb.cloudfront.net |
| API URL (internal) | http://Genese-ApiLB-XYr1qAvXxyX7-1479126617.us-east-1.elb.amazonaws.com |
| Account | 654654306837 |
| Region | us-east-1 |
| CFN Stack | GeneseProposalAIStack (CREATE_COMPLETE) |
| API service | genese-api-service, TD:20, 1/1 running |
| Worker service | genese-worker-service, TD:25, 1/1 running |
| Aurora | available, pgvector enabled, 1024-dim |
| Documents | 34 indexed |
| Demo login | demo@genesesolution.com / GeneseDemo123! |

---

## 9. What Could Be Improved

**Security (before public exposure):**
- Add ACM certificate → HTTPS on ALB (currently HTTP-only on ALB, HTTPS only at CloudFront)
- Change `allow_origins=["*"]` to your specific domain
- Add AWS WAF to CloudFront
- Enable MFA on Cognito
- Set `RemovalPolicy.RETAIN` on Aurora + S3 (currently DESTROY — dangerous for production)

**Reliability:**
- `desiredCount=2` on both ECS services with `minimumHealthyPercent=100` (zero-downtime deploys)
- Enable Aurora PITR (Point-in-Time Recovery) backups
- CloudWatch alarm when DLQ depth > 0

**Features:**
- Upload real Genese proposals/SoWs to replace synthetic seed data
- Add Tavily real API key (sign up free at app.tavily.com)
- Streaming generation (Server-Sent Events so consultant sees Claude writing word-by-word)
- CI/CD pipeline (GitHub Actions → ECR push → ECS update)

*End of LastMasterFinalized.md*
