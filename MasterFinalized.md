# MasterFinalized.md — Genese Proposal AI: Complete Technical & Functional Reference

> Everything. Every decision, every service, every workflow, every issue, every improvement path.

---

## 1. The Idea and Origin

**Problem:** Every consulting firm burns enormous hours on proposals that look 80% like the last one. Genese Solution consultants were manually re-reading past proposals, rewriting nearly identical executive summaries, and manually checking AWS docs for current service recommendations.

**The insight:** The consultant should edit, not write. An AI system trained on past Genese proposals should produce a first draft in minutes. The consultant refines it.

**Three core features:**
1. **Proposal/SoW/Case Study Generator** — input client name + requirements → branded .docx in ~60 seconds
2. **Knowledge Base Search** — "what did we do for the last fintech client?" → AI answer with citations
3. **Live Documentation Validation** — architecture claims validated against live AWS/Azure/GCP docs via Tavily

---

## 2. Every Technology Decision — With Reasoning and Alternatives

### LLM: Claude Sonnet 4.6 via Amazon Bedrock

| Aspect | Detail |
|--------|--------|
| Why chosen | Already active in the AWS account. Data stays inside AWS — never leaves your VPC boundary. Strong at structured JSON output needed for proposal sections. |
| Model ID | `us.anthropic.claude-sonnet-4-6` (cross-region inference profile) |
| Pricing | $0.003/1K input tokens · $0.015/1K output tokens |
| Typical cost per proposal | $0.03–$0.08 (800–2,800 tokens) |
| Alternative 1 | Claude Haiku 4.5 — 10x cheaper, less accurate on complex proposals |
| Alternative 2 | Amazon Nova Pro — AWS-native, cheaper, less capable on nuanced consulting text |
| Alternative 3 | GPT-4 via OpenAI API — better creative writing, but data leaves AWS |
| Alternative 4 | Open-source (Llama 3 on vLLM/EC2) — zero per-token cost, but GPU EC2 cost + ops burden |

**Key lesson:** Claude rejects `temperature` and `top_p` together — use only one or neither.

---

### Embeddings: Amazon Titan Text Embeddings v2 via Bedrock

| Aspect | Detail |
|--------|--------|
| Why chosen | AWS-native (no external API call), cheapest embedding option in the account |
| Model ID | `amazon.titan-embed-text-v2:0` |
| Output dimension | **1024** (not 1536 — critical for pgvector schema) |
| Pricing | $0.00002 per 1K tokens |
| Alternative 1 | Cohere Embed v3 on Bedrock — higher quality embeddings, slightly more expensive |
| Alternative 2 | Cohere direct API — data leaves AWS |
| Alternative 3 | OpenAI text-embedding-3-small — data leaves AWS |

**Key lesson:** Titan Text v2 returns `inputTextTokenCount` in the response body — use it for cost tracking. Default dimension is 1024, not 1536.

---

### Vector Database: Aurora PostgreSQL Serverless v2 + pgvector

| Aspect | Detail |
|--------|--------|
| Why chosen | Scales to 0 ACU when idle (near-zero cost), holds all app data (jobs, users, docs, chunks) in one place, SQL familiarity |
| Extension | pgvector with `ivfflat` index (`vector_cosine_ops`) |
| Vector dimension | 1024 (Titan Text v2 output) |
| Min capacity | 0.5 ACU (~$43/month minimum) |
| Alternative 1 | OpenSearch Serverless — managed vector search, but $300–700/month floor cost always-on |
| Alternative 2 | Bedrock Knowledge Bases — fully managed RAG, but less control over chunking/retrieval |
| Alternative 3 | pgvector on RDS PostgreSQL — fixed instance, always-on cost, no auto-pause |
| Alternative 4 | Pinecone/Weaviate — external SaaS, data leaves AWS |

**Key lesson:** pgvector SQL syntax conflict with asyncpg — cannot use `:param::vector` bind variable + cast together. Serialize the embedding as a Python list string and inject as an f-string literal.

---

### Compute: ECS Fargate (API Service + Worker Service)

| Aspect | Detail |
|--------|--------|
| Why chosen | LLM generation takes 30–90 seconds — unsuitable for Lambda (cold starts + 15-min limit). Worker needs a persistent SQS consumer loop. |
| API service | 0.5 vCPU / 1GB RAM, desired=1 |
| Worker service | 1 vCPU / 2GB RAM, desired=1 |
| Alternative 1 | Lambda + API Gateway — cheaper at low traffic, but cold starts hurt UX for long jobs |
| Alternative 2 | Lambda + SQS trigger — viable for worker, eliminates polling, but 15-min cap |
| Alternative 3 | EC2 Auto Scaling — more control, more ops burden |
| Alternative 4 | EKS — over-engineered for this use case |

**Key lesson:** Never let CloudFormation manage ECS services — CFN waits up to 3 hours for ECS service stabilization. Create ECS services via CLI after CDK deploys the infrastructure.

---

### Job Queue: Amazon SQS

| Aspect | Detail |
|--------|--------|
| Why chosen | Decouples API (HTTP) from Worker (LLM processing). API returns job_id instantly; worker processes async. |
| Queue type | Standard (not FIFO — ordering not required) |
| Visibility timeout | 600 seconds (10 min — covers worst-case generation time) |
| DLQ | After 3 failures → dead letter queue |
| Alternative 1 | Redis/Celery — popular but requires managing a Redis instance |
| Alternative 2 | EventBridge — event-driven, but more complex for simple job queuing |

**Key lesson:** SQS message may arrive at worker BEFORE the API transaction commits to Aurora. Always commit to DB first, THEN publish to SQS.

---

### Web Search: Tavily

| Aspect | Detail |
|--------|--------|
| Why chosen | Purpose-built for LLM agents, no credit card required for free tier (1,000/month) |
| Free tier | 1,000 API credits/month, no credit card |
| Sign up | app.tavily.com — email only |
| Result caching | 24-hour TTL in Redis to minimize credit usage |
| Alternative 1 | Bing Search API — Microsoft, requires billing |
| Alternative 2 | AWS Bedrock Web Search (via Agents) — managed, but less flexible |
| Alternative 3 | Direct doc scraping — no external service, but brittle |

**Key lesson:** Store Tavily key as plain string in Secrets Manager — the config code must handle both `{"api_key": "..."}` JSON format AND plain string format. Use `json.loads()` with `except json.JSONDecodeError` fallback.

---

### Document Generation: python-docx

| Aspect | Detail |
|--------|--------|
| Why chosen | Full control over Genese branding (colors, fonts, headers, footers). Pure Python, no external service. |
| Branding | Genese Blue (#004E96), Orange (#F57C00), custom header/footer |
| Alternative 1 | Pandoc — powerful but complex dependency |
| Alternative 2 | Google Docs API — external service, requires OAuth |
| Alternative 3 | LibreOffice headless — heavy dependency, complex Docker setup |

---

### IaC: AWS CDK (Python)

| Aspect | Detail |
|--------|--------|
| Why chosen | Same language as the app (Python monorepo consistency). High-level constructs handle IAM wiring automatically. |
| Note | ECS services NOT in CDK — deployed via CLI to avoid CFN ECS stabilization timeout |
| Alternative 1 | Terraform — multi-cloud, large ecosystem, but HCL is a separate language |
| Alternative 2 | CloudFormation YAML — verbose, no logic |
| Alternative 3 | AWS SAM — serverless-only, doesn't fit this architecture |

---

### Authentication: Amazon Cognito

| Aspect | Detail |
|--------|--------|
| Why chosen | Native AWS integration, API Gateway/FastAPI JWT validation, no external service |
| Auth flow | `AdminInitiateAuth` (server-side) — NOT browser-direct OAuth2 |
| Self-signup | Disabled (internal tool — admin creates users) |
| Alternative 1 | Auth0/Okta — better DX, enterprise SSO, but external |
| Alternative 2 | Custom JWT — never build your own auth |

**Key lesson:** Never call Cognito `AdminInitiateAuth` from the browser — it requires server-side AWS credentials. The frontend calls your FastAPI backend which calls Cognito server-side and returns JWT tokens.

---

### Frontend: React + shadcn/ui + Tailwind CSS

| Aspect | Detail |
|--------|--------|
| Why chosen | Modern, polished UI without custom CSS. shadcn/ui components are copied into the project (fully owned). |
| Build tool | Vite 8 |
| State management | React Context (no Redux — demo simplicity) |
| Alternative 1 | Next.js SSR — better SEO, but overkill for internal tool |
| Alternative 2 | Vue/Angular — team preference, functionally equivalent |

---

### Hosting: S3 + CloudFront

| Aspect | Detail |
|--------|--------|
| Why chosen | Static SPA hosting — no server needed. CloudFront provides HTTPS and proxies `/api/*` to ALB. |
| Critical detail | Frontend served over HTTPS + ALB on HTTP = browser blocks mixed-content. CloudFront `/api/*` behavior solves this. |
| CF Function | `StripApiPrefix` — rewrites `/api/auth/login` → `/auth/login` before forwarding to ALB |

---

---

## 3. Detailed System Workflows

### Workflow A: Document Ingestion (RAG Knowledge Base Building)

```
User uploads file (PDF/DOCX/TXT) via Documents page
        │
        ▼
POST /documents/upload (FastAPI)
  1. Validate file type and size (max 50MB)
  2. Upload raw file to S3: raw/{doc_id}/{filename}
  3. CREATE document record in Aurora (status=pending, chunk_count=0)
  4. COMMIT to Aurora ← CRITICAL: must commit before SQS publish
  5. Publish SQS message: {job_type:"ingestion", document_id, s3_key, ...}
  6. Return 202 Accepted with document_id
        │
        ▼
SQS Queue (genese-generation-jobs)
        │
        ▼
Worker SQS Consumer (polling every 20s)
  Phase 1 - LOADING    (set ingestion_status="loading")
    → Download file from S3
    → Extract text: PDF→pypdf, DOCX→python-docx, TXT→decode
    → Timing: ~0.1–0.3s

  Phase 2 - CHUNKING   (set ingestion_status="chunking")
    → RecursiveCharacterTextSplitter
    → chunk_size=512 chars, chunk_overlap=50 chars
    → Filter chunks < 50 chars
    → Timing: ~0.0–0.1s

  Phase 3 - EMBEDDING  (set ingestion_status="embedding")
    → For each chunk: call Bedrock Titan Text v2
    → Returns 1024-dimensional float vector per chunk
    → Captures inputTextTokenCount per chunk for cost tracking
    → Timing: ~0.1s per chunk (1–10s total depending on doc size)

  Phase 4 - STORING    (set ingestion_status="storing")
    → INSERT document_chunks rows with embedding vectors
    → UPDATE documents.chunk_count, embedding_model, embedding_tokens
    → Timing: ~0.02–0.2s

  COMPLETE (set ingestion_status="complete")
        │
        ▼
Frontend polls GET /documents/{id}/status every 4s
  Returns: {status, phase_label, phases[], chunk_count, tokens, cost_usd}
  Shows: Loading ✓ → Chunking ✓ → Embedding ⟳ → Storing → ✅ Indexed
```

---

### Workflow B: Proposal Generation (RAG + LLM Pipeline)

```
User fills form: doc_type, client_name, engagement_type, requirements
        │
        ▼
POST /generate (FastAPI)
  1. Get/create User record in Aurora
  2. CREATE GenerationJob record (status="queued")
  3. COMMIT to Aurora ← CRITICAL: before SQS publish
  4. Publish SQS: {job_type:"generation", job_id, requirements, ...}
  5. Return 202: {job_id, status:"queued"}
        │
        ▼
Frontend polls GET /generate/{job_id} every 3s
  Shows step progress: queued → retrieving → validating → drafting → formatting → complete
  Shows model badge, token counter (live after complete)
        │
        ▼
Worker processes generation job:

  Step 1 - RETRIEVING CONTEXT (set status="retrieving_context")
    → Embed query: "{doc_type} {engagement_type} {requirements}"
    → pgvector cosine similarity search: top-5 chunks
    → SQL: SELECT ... ORDER BY embedding <=> '{vector}'::vector LIMIT 5
    → Store rag_context JSONB on job record

  Step 2 - VALIDATING SOURCES (set status="validating_sources")
    → Check Tavily API key (skip gracefully if placeholder/empty)
    → Search: "{client} {engagement_type} AWS best practices documentation"
    → Cache result in Redis (TTL 24h) to preserve free-tier credits
    → Store tavily_sources JSONB on job record

  Step 3 - DRAFTING (set status="drafting_document")
    → Build LangChain prompt:
        SYSTEM: "You are a Genese proposal writer..."
        HUMAN:  doc_type + client + requirements
                + retrieved RAG chunks (context)
                + Tavily sources (validation)
                + "Return JSON with keys: {sections}"
    → Invoke ChatBedrock (Claude Sonnet 4.6)
    → Capture usage_metadata: input_tokens, output_tokens
    → Store llm_model, input_tokens, output_tokens on job
    → Parse JSON response → sections dict

  Step 4 - FORMATTING (set status="formatting_output")
    → python-docx fills Genese branded template:
        Header: "GENESE SOLUTION | Confidential"
        Title: doc_type + client_name
        Sections: each key from Claude's JSON response
        Footer: copyright + confidentiality notice
        Colors: Genese Blue #004E96, Orange #F57C00
    → Upload .docx to S3: generated/{job_id}/{client}_{doc_type}.docx

  COMPLETE (set status="complete", output_s3_key, completed_at)
        │
        ▼
Frontend receives complete status
  → Fetches GET /generate/{job_id} → download_url (S3 presigned URL, 24h)
  → Shows: model badge + token panel + cost display + Download button
  → Shows: RAG sources used (filename, excerpt, similarity %)
  → Shows: Tavily web sources (URL, title, excerpt) if available
```

---

### Workflow C: Knowledge Base Search

```
User types query: "what did we do for the last fintech client?"
        │
        ▼
POST /search (FastAPI)
  1. Embed query via Bedrock Titan Text v2 → 1024-dim vector
  2. pgvector similarity search (top-K, default 5)
     Optional filters: document_type, engagement_type
  3. Pass retrieved chunks as context to Claude Sonnet 4.6
  4. Claude synthesises an answer citing the sources
  5. Return: {answer, sources: [{filename, excerpt, similarity_score}]}
        │
        ▼
Frontend displays:
  - AI-synthesised answer
  - Source documents with similarity scores
  - Filter by document type and engagement type
```

---

### Workflow D: User Authentication Flow

```
User opens app → ProtectedRoute checks localStorage token
  → Token present: skip login, load app
  → No token: redirect to /login
        │
        ▼
/login page
  User enters email + password
  POST /api/auth/login → FastAPI auth router
    → cognito.admin_initiate_auth(ADMIN_USER_PASSWORD_AUTH)
    → Returns {idToken, accessToken, refreshToken}
  Frontend stores idToken in localStorage
  Redirects to /generate
        │
        ▼
All subsequent API calls:
  Authorization: Bearer {idToken}
  FastAPI middleware validates JWT against Cognito JWKs
  Extracts userId (Cognito sub) from claims
```

---

## 4. Detailed Functional Requirements — Achieved

| ID | Requirement | Status | How Implemented |
|----|-------------|--------|----------------|
| FR-1.1 | Upload PDF/DOCX/TXT documents | ✅ | POST /documents/upload, max 50MB |
| FR-1.2 | Chunk documents (512 chars, 50 overlap) | ✅ | LangChain RecursiveCharacterTextSplitter |
| FR-1.3 | Embed chunks with Titan Text v2 | ✅ | Bedrock direct API with token tracking |
| FR-1.4 | Store vectors in pgvector | ✅ | Aurora PostgreSQL + ivfflat index |
| FR-1.5 | Real-time ingestion progress | ✅ | 4-phase status: loading/chunking/embedding/storing |
| FR-1.6 | Show embedding tokens + cost | ✅ | $0.00002/1K tokens, shown per document |
| FR-2.1 | Semantic search with AI answer | ✅ | pgvector cosine + Claude synthesis |
| FR-2.2 | Show source citations | ✅ | filename, excerpt, similarity score |
| FR-3.1 | Generate proposals | ✅ | Full RAG→validate→draft→format pipeline |
| FR-3.2 | Generate SoWs | ✅ | Same pipeline, different section keys |
| FR-3.3 | Generate case studies | ✅ | Same pipeline, different section keys |
| FR-3.4 | Real-time job progress | ✅ | 5-step progress bar with live polling |
| FR-3.5 | Show model + token usage | ✅ | Model badge, input/output token counts |
| FR-3.6 | Show generation cost | ✅ | Computed client-side: $0.003/1K in + $0.015/1K out |
| FR-3.7 | Show RAG sources used | ✅ | Sources panel with similarity scores |
| FR-3.8 | Show Tavily web sources | ✅ | When key configured, shows URLs + excerpts |
| FR-3.9 | Download branded .docx | ✅ | S3 presigned URL, 24h validity |
| FR-4.1 | Job history | ✅ | GET /jobs, all past generations |
| FR-5.1 | Cognito authentication | ✅ | AdminInitiateAuth, JWT validation |
| FR-5.2 | Dark/light mode | ✅ | ThemeProvider + Tailwind dark class |
| FR-5.3 | Responsive design | ✅ | Tailwind responsive utilities |

---

---

## 5. Every Issue Solved — Root Cause and Fix

### Issue 1: CloudFormation ECS Stabilization Timeout
**Symptom:** `cdk deploy` runs for 3 hours then fails with "Exceeded attempts to wait"  
**Root cause:** CFN waits for ECS service to reach steady state. Without images in ECR, tasks fail to start → CFN times out.  
**Fix:** Remove ECS services from CDK entirely. Deploy infra via CDK, create ECS services via AWS CLI after images are pushed. CFN never waits on ECS again.

### Issue 2: Aurora RDS Invalid Password
**Symptom:** `MasterUserPassword is not a valid password`  
**Root cause:** CDK `SecretStringGenerator` default exclude list doesn't cover all RDS-forbidden characters (`/`, `@`, `"`, space).  
**Fix:** Add explicit `exclude_characters=' %+~\`#$&*()|[]{}:;<>?!\'/\"\\@/'` to the generator.

### Issue 3: Mixed-Content HTTPS→HTTP Browser Block
**Symptom:** "NetworkError when attempting to fetch resource" in browser  
**Root cause:** Frontend served over HTTPS (CloudFront). API on HTTP (ALB). Browsers block cross-origin HTTP calls from HTTPS pages.  
**Fix:** Add `/api/*` cache behavior on CloudFront pointing to ALB + a CloudFront Function that strips the `/api` prefix before forwarding.

### Issue 4: Cognito Login Wrong Auth Flow
**Symptom:** "Invalid credentials" even with correct password  
**Root cause:** Frontend was calling Cognito's `/oauth2/token` endpoint directly (requires Hosted UI domain). AdminInitiateAuth requires server-side AWS credentials.  
**Fix:** Frontend calls `POST /api/auth/login` on FastAPI. FastAPI calls `cognito.admin_initiate_auth()` server-side and returns JWT tokens.

### Issue 5: pgvector SQL Syntax Error with asyncpg
**Symptom:** `syntax error at or near ":"` in search queries  
**Root cause:** asyncpg treats `:embedding` as a named bind variable AND `::vector` as a type cast — they conflict.  
**Fix:** Serialize the embedding vector as a Python list string, inject directly as an f-string literal in the SQL. Safe because it's float data, not user input.
```python
embedding_str = "[" + ",".join(str(x) for x in query_embedding) + "]"
sql = text(f"... WHERE embedding <=> '{embedding_str}'::vector ...")
```

### Issue 6: Embedding Dimension Mismatch (1536 vs 1024)
**Symptom:** `expected 1536 dimensions, not 1024` on INSERT  
**Root cause:** Titan Text v2 outputs 1024 dims by default (not 1536 like OpenAI's ada-002).  
**Fix:** Update schema to `vector(1024)`, update ORM column, drop+recreate the `document_chunks` table.

### Issue 7: Tavily Secret Not JSON — `json.loads()` Crash
**Symptom:** `Expecting value: line 1 column 1 (char 0)` on every generation job  
**Root cause:** Tavily secret in Secrets Manager was stored as plain string `REPLACE_WITH_TAVILY_KEY`. Worker did `json.loads(secret)` which fails on non-JSON.  
**Fix:** Handle both formats in `get_tavily_api_key()`:
```python
try:
    return json.loads(raw).get("api_key", "")
except json.JSONDecodeError:
    return raw.strip()  # plain string fallback
```
And in `validation_chain.py`: skip gracefully if key is placeholder or < 10 chars.

### Issue 8: `temperature` + `top_p` Conflict (Claude Sonnet 4.6)
**Symptom:** `ValidationException: temperature and top_p cannot be used together`  
**Root cause:** LangChain ChatBedrock model_kwargs had both `temperature=0.3` and `top_p=0.9`.  
**Fix:** Remove `top_p` — use only `temperature`.

### Issue 9: ECS Old Image Running After New Push
**Symptom:** New code not running after `docker push :latest`  
**Root cause:** ECS task definitions reference images by tag (`:latest`), not by digest. `force-new-deployment` reuses the same task definition — ECS may use cached layers.  
**Fix:** Register a new task definition revision after every push, then update the service to that revision:
```bash
NEW_ARN=$(aws ecs register-task-definition --cli-input-json file://td.json ...)
aws ecs update-service --task-definition $NEW_ARN --service <name>
```

### Issue 10: SQS Document Race Condition (Pending Forever)
**Symptom:** Uploaded documents stay in "pending" status forever, never processed  
**Root cause:** API published SQS message BEFORE committing the DB transaction. Worker received message, queried DB, found nothing (uncommitted), gave up. After 3 retries → DLQ silently.  
**Fix:** Commit DB transaction first, THEN publish SQS:
```python
db.add(document)
await db.flush()
await db.commit()  # ← commit BEFORE SQS
publish_job(msg.model_dump())  # ← SQS after commit
```

### Issue 11: ECS Deployment Gap (503 During Updates)
**Symptom:** ALB returns 503 for 2–3 minutes during every deployment  
**Root cause:** `minimumHealthyPercent=0` with `desiredCount=1` means ECS stops old task before starting new one.  
**Fix for production:** Set `maximumPercent=200, minimumHealthyPercent=100`. ECS starts new task first, waits for health check, then stops old task. Zero downtime.  
**Current state (demo):** Uses rolling restart for simplicity. Use `minimumHealthyPercent=100` for production.

### Issue 12: Backfill of ingestion_status After ALTER TABLE
**Symptom:** All existing documents showed "Pending" even after being indexed  
**Root cause:** `ingestion_status` column added via `ALTER TABLE ADD COLUMN ... DEFAULT 'pending'`. Existing documents with chunks > 0 needed to be backfilled to `'complete'`.  
**Fix:** One-time SQL:
```sql
UPDATE documents SET ingestion_status = 'complete', 
  embedding_model = 'amazon.titan-embed-text-v2:0'
WHERE chunk_count > 0 AND (ingestion_status IS NULL OR ingestion_status = 'pending');
```

---

## 6. Current Deployment State

| Resource | Value |
|----------|-------|
| Frontend URL | https://d3gmhvny3loneb.cloudfront.net |
| API URL (internal) | http://Genese-ApiLB-XYr1qAvXxyX7-1479126617.us-east-1.elb.amazonaws.com |
| CloudFormation Stack | GeneseProposalAIStack (CREATE_COMPLETE) |
| ECS API Service | genese-api-service, TD:12, 1/1 running |
| ECS Worker Service | genese-worker-service, TD:13, 1/1 running |
| Aurora Cluster | geneseproposalaistack-auroracluster... (available) |
| Cognito User Pool | us-east-1_ThM2KRVkt |
| Cognito Client | 19ufsosadrbr5fqlhleargbrbi |
| SQS Queue | genese-generation-jobs |
| ECR API | genese-proposal-ai-api:latest |
| ECR Worker | genese-proposal-ai-worker:latest |
| S3 Documents | genese-proposal-ai-docs-654654306837-us-east-1 |
| S3 Frontend | genese-proposal-ai-frontend-654654306837-us-east-1 |
| DB Secret | /genese/db-credentials |
| Tavily Secret | /genese/tavily-api-key (set placeholder — update to real key) |
| Demo login | demo@genesesolution.com / GeneseDemo123! |
| Region | us-east-1 |
| Account | 654654306837 |

---

## 7. What Can Be Improved

### Short Term (days)
1. **Add real Tavily key** — sign up at app.tavily.com (free, no credit card) → live web validation works
2. **Upload real Genese documents** — replace 10 synthetic docs with actual past proposals. RAG quality improves dramatically.
3. **Set desiredCount=2 on both services** with `minimumHealthyPercent=100` for zero-downtime deployments
4. **Change `RemovalPolicy.DESTROY` → `RETAIN`** on Aurora + S3 in CDK before any production use

### Medium Term (weeks)
5. **Streaming generation** — Server-Sent Events so consultant sees Claude writing the proposal word-by-word
6. **Re-ingestion on re-upload** — currently re-uploading same file creates duplicate chunks
7. **Section-level editing** — edit individual sections in browser before downloading
8. **Feedback loop** — thumbs up/down per generation → improves RAG retrieval scoring
9. **Semantic chunking** — split by proposal section boundaries, not character count
10. **CI/CD pipeline** — GitHub Actions: push → build → ECR → register TD → update service

### Long Term (months)
11. **Multi-tenant** — per-company knowledge bases (Genese Nepal, India, UK)
12. **Fine-tuned embeddings** — train on consulting domain text for better retrieval
13. **Agentic research** — multi-step agent identifies knowledge gaps, searches for missing info
14. **Template library** — multiple branded .docx templates per engagement type

---

## 8. How It Could Be Done Differently

| Approach | When to Use | Tradeoff |
|----------|------------|----------|
| **Bedrock Knowledge Bases** | Want 0→working RAG in 1 day | Less control, OpenSearch Serverless floor cost |
| **Lambda for Worker** | Very spiky usage (days idle) | Cold starts, 15-min cap, connection pooling complexity |
| **AppSync subscriptions** | Real-time push instead of polling | More complexity for marginal UX improvement |
| **Open-source LLM on GPU** | Strict data residency in VPC | GPU EC2 cost, ops burden, model quality trade-off |
| **Serverless Aurora v1** | Lowest cost, rarely used | Slower cold start, older Postgres version |
| **DynamoDB for jobs** | Very high job volume, simple schema | Loses SQL flexibility, joins harder |

---

---

## 9. Detailed Technical Architecture

### Infrastructure Diagram

```
Internet
    │ HTTPS
    ▼
CloudFront (E31C3VQPMUFTQZ — d3gmhvny3loneb.cloudfront.net)
    │
    ├── /* (default)     → S3 Frontend Bucket (React SPA)
    │                       + SPA fallback: 403/404 → index.html
    │
    └── /api/* ──────── StripApiPrefix CF Function ──→ ALB (HTTP:80)
                                                         │
                                                         ▼
                                                   ECS Fargate: API Service
                                                   (FastAPI, 0.5 vCPU, 1GB)
                                                         │
                                    ┌────────────────────┼──────────────────────┐
                                    ▼                    ▼                      ▼
                               Aurora               S3 Bucket              SQS Queue
                            PostgreSQL          Documents/Generated        Jobs/DLQ
                            (pgvector)
                                    │
                          ┌─────────┘
                          ▼
                    ECS Fargate: Worker Service
                    (LangChain, 1 vCPU, 2GB)
                          │
             ┌────────────┼────────────┬────────────┐
             ▼            ▼            ▼            ▼
        Bedrock        Bedrock      Tavily        S3
      (Claude 4.6)  (Titan Text v2) (web search) (read raw/
      LLM calls      Embeddings                   write generated)
```

### Network Architecture

```
VPC (vpc-0dd58bd2463d505d3)
├── Public Subnets (2 AZs)
│   └── ALB (internet-facing)
│
└── Private Subnets (2 AZs)
    ├── ECS API tasks
    ├── ECS Worker tasks
    └── Aurora PostgreSQL cluster
    
NAT Gateway: Worker → Bedrock/Tavily outbound
Security Groups:
  AlbSG   → ApiSG:8000 (ALB → API)
  ApiSG   → DbSG:5432  (API → Aurora)
  WorkerSG → DbSG:5432 (Worker → Aurora)
```

### Database Schema

```sql
-- Users (synced from Cognito)
users (id UUID PK, cognito_sub VARCHAR UNIQUE, email, name, created_at)

-- Knowledge base documents
documents (
  id UUID PK, filename, document_type, engagement_type, client_name,
  s3_key, chunk_count, uploaded_by UUID FK users,
  ingestion_status VARCHAR,   -- pending/loading/chunking/embedding/storing/complete/failed
  embedding_model VARCHAR,    -- amazon.titan-embed-text-v2:0
  embedding_tokens INTEGER,   -- for cost tracking
  created_at
)

-- Vector embeddings (the heart of RAG)
document_chunks (
  id UUID PK, document_id UUID FK documents CASCADE DELETE,
  chunk_index INTEGER, content TEXT,
  embedding vector(1024),     -- Titan Text v2, 1024 dims
  metadata JSONB, created_at
)
INDEX: ivfflat (embedding vector_cosine_ops)  -- fast ANN search

-- Generation jobs
generation_jobs (
  id UUID PK, user_id UUID FK users,
  document_type, client_name, engagement_type, key_requirements, context_notes,
  status VARCHAR,          -- queued/retrieving_context/validating_sources/drafting_document/formatting_output/complete/failed
  status_detail VARCHAR,
  rag_context JSONB,       -- [{source_document, excerpt, similarity_score}]
  tavily_sources JSONB,    -- [{url, title, excerpt}]
  output_s3_key VARCHAR,
  error_message TEXT,
  llm_model VARCHAR,       -- us.anthropic.claude-sonnet-4-6
  input_tokens INTEGER,    -- for cost tracking
  output_tokens INTEGER,
  created_at, completed_at
)
```

### API Endpoints

| Method | Path | Auth | Service | Purpose |
|--------|------|------|---------|---------|
| GET | /health | No | API | ALB health check |
| POST | /auth/login | No | API→Cognito | Exchange credentials for JWT |
| POST | /auth/signup | No | API→Cognito | Register new user |
| POST | /auth/forgot-password | No | API→Cognito | Initiate password reset |
| POST | /auth/confirm-forgot-password | No | API→Cognito | Complete password reset |
| GET | /documents | Yes | API→Aurora | List all knowledge base docs |
| POST | /documents/upload | Yes | API→S3→SQS | Upload + queue ingestion |
| DELETE | /documents/{id} | Yes | API→S3→Aurora | Delete doc + all chunks |
| GET | /documents/{id}/status | Yes | API→Aurora | Real-time ingestion progress |
| POST | /search | Yes | API→Bedrock→Aurora | Semantic search + AI answer |
| POST | /generate | Yes | API→Aurora→SQS | Submit generation job |
| GET | /generate/{job_id} | Yes | API→Aurora | Poll job status + tokens + cost |
| GET | /jobs | Yes | API→Aurora | List all past jobs for user |

### Frontend Pages

| Route | Page | Key Features |
|-------|------|-------------|
| /login | LoginPage | Cognito login form |
| /generate | GeneratePage | Form + step progress + model badge + token/cost panel |
| /search | SearchPage | Query box + AI answer + cited sources |
| /documents | DocumentsPage | Upload + real-time 4-phase indexing status + tokens/cost |
| /history | HistoryPage | Past jobs with status badges + download links |

### Code Structure

```
genese-proposal-ai/
├── services/
│   ├── shared/                    ← Pydantic schemas, SQLAlchemy ORM, constants
│   │   ├── models/orm.py          ← User, Document, DocumentChunk, GenerationJob
│   │   ├── schemas/schemas.py     ← All request/response Pydantic models
│   │   └── constants.py          ← Model IDs, pricing, chunk config, status values
│   │
│   ├── api/                       ← FastAPI service (ECS, 0.5 vCPU/1GB)
│   │   └── src/
│   │       ├── main.py            ← App factory, CORS, router registration
│   │       ├── core/
│   │       │   ├── config.py      ← pydantic-settings + Secrets Manager
│   │       │   ├── database.py    ← Async SQLAlchemy (asyncpg)
│   │       │   ├── auth.py        ← Cognito JWT middleware
│   │       │   ├── s3.py          ← Upload, presigned URLs
│   │       │   └── sqs.py         ← Job publisher
│   │       └── routers/
│   │           ├── auth.py        ← Login, signup, password reset
│   │           ├── documents.py   ← Upload, list, delete, status
│   │           ├── generate.py    ← Submit job, poll status
│   │           ├── search.py      ← Semantic search + Claude synthesis
│   │           ├── jobs.py        ← Job history
│   │           └── health.py      ← Health check
│   │
│   └── worker/                    ← LangChain worker (ECS, 1 vCPU/2GB)
│       └── src/
│           ├── main.py            ← SQS consumer loop
│           ├── core/
│           │   ├── config.py      ← Settings + Secrets Manager (sync)
│           │   ├── database.py    ← Sync SQLAlchemy (psycopg2)
│           │   ├── bedrock.py     ← ChatBedrock + BedrockEmbeddings
│           │   └── redis_cache.py ← Tavily response caching
│           ├── ingestion/
│           │   ├── document_loader.py  ← S3→text (PDF/DOCX/TXT)
│           │   ├── text_splitter.py    ← Chunk text
│           │   ├── embedder.py         ← Titan Text v2 + token tracking
│           │   └── vector_store.py     ← pgvector INSERT
│           ├── chains/
│           │   ├── retrieval_chain.py  ← Cosine similarity search
│           │   ├── validation_chain.py ← Tavily + Redis cache
│           │   ├── generation_chain.py ← LangChain + Claude + token capture
│           │   └── orchestrator.py     ← Full pipeline coordinator
│           └── generation/
│               └── docx_builder.py    ← python-docx branded output
│
├── frontend/                      ← React SPA (S3+CloudFront)
│   └── src/
│       ├── pages/                 ← GeneratePage, SearchPage, DocumentsPage, etc.
│       ├── contexts/              ← AuthContext, JobContext
│       ├── components/            ← shadcn/ui, layout, custom
│       └── lib/                   ← api.ts (HTTP client), utils.ts
│
├── infrastructure/                ← AWS CDK (Python)
│   └── stacks/genese_stack.py    ← Full AWS stack
│
└── scripts/
    ├── db_migrate.py              ← pgvector schema creation
    ├── seed_data.py               ← Upload synthetic documents
    └── seed_documents/            ← 10 Genese-style .txt files
```

---

## 10. Production Readiness Checklist

### Security (Must Do Before Public Exposure)
- [ ] Add ACM certificate + HTTPS on ALB (currently HTTP on ALB, only HTTPS at CloudFront)
- [ ] Change `allow_origins=["*"]` to your domain in FastAPI CORS
- [ ] Add AWS WAF to CloudFront (rate limiting, bot protection)
- [ ] Delete demo user / enforce strong passwords
- [ ] Add Tavily real API key (stored in Secrets Manager)
- [ ] Set `self_sign_up_enabled=False` (already done) + consider MFA

### Reliability (Must Do for Sustained Use)
- [ ] `desiredCount=2` on both ECS services + `minimumHealthyPercent=100`
- [ ] `RemovalPolicy.RETAIN` on Aurora cluster and S3 buckets
- [ ] Enable Aurora automated backups (PITR, 7-day retention)
- [ ] CloudWatch alarm: DLQ depth > 0 → email/Slack alert
- [ ] Set Aurora `serverless_v2_min_capacity=1` (no auto-pause in production)

### Monitoring
- [ ] CloudWatch Dashboard: generation success rate, p95 latency, queue depth
- [ ] AWS X-Ray tracing on API and Worker
- [ ] Synthetic canary pinging `/health` every minute

---

---

*MasterFinalized.md — Complete reference for Genese Proposal AI. For deployment instructions see MasterDeployment.md.*
