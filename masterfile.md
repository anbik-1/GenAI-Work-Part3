# masterfile.md — Genese Proposal AI: Functionality, Patterns, Deployment & Production Readiness

---

## 1. Functionalities Achieved

| # | Feature | Works? | Evidence |
|---|---------|--------|---------|
| User login/signup | ✅ | JWT token returned, tested live |
| Upload documents (PDF/DOCX/TXT) | ✅ | 10 docs uploaded, 202 response |
| Document chunking + embedding | ✅ | Worker logs: "Ingested X chunks" |
| Knowledge base search (semantic) | ✅ | AI answer + citations returned live |
| Proposal generation (full pipeline) | ✅ | `complete` status, download URL, took ~60s |
| SoW generation | ✅ | Same pipeline, different sections |
| Case study generation | ✅ | Same pipeline |
| Branded .docx download | ✅ | S3 presigned URL returned |
| Job status polling | ✅ | Real-time status: queued→drafting→complete |
| Job history | ✅ | GET /jobs returns past jobs |
| Delete documents from KB | ✅ | DELETE /documents/{id} tested |
| Dark/light mode | ✅ | ThemeProvider working |
| Cognito auth (JWT validation) | ✅ | Protected routes enforce it |
| **Live web validation (Tavily)** | ⚠️ | Skipped — placeholder API key. Works once you add a real key |
| **Sources panel in UI** | ⚠️ | Backend populates it; frontend displays it but Tavily sources empty until key is set |
| **Forgot password flow** | ⚠️ | Code written and route registered. Not tested end-to-end |

---

## 2. System Patterns Used — Detailed Explanation

### Pattern 1: RAG (Retrieval-Augmented Generation)

This is the backbone of the entire app. The problem RAG solves: LLMs don't know your company's internal documents. Instead of fine-tuning (expensive, slow), you retrieve relevant content at generation time.

```
OFFLINE (ingestion):
Document uploaded
    → Chunked into 512-char overlapping pieces
    → Each chunk embedded by Titan Text v2 → 1024-dim float vector
    → Vector + text stored in pgvector (Aurora PostgreSQL)

ONLINE (generation):
"Write a proposal for an AWS migration for a bank"
    → Embed that query → 1024-dim vector
    → Cosine similarity search against all stored vectors
    → Top 5 most similar chunks retrieved
    → Those chunks injected into Claude's prompt as context
    → Claude generates a proposal that references YOUR past work
```

**Why it works:** Cosine similarity finds semantically similar text even when the exact words differ. "fintech cloud migration" matches "NepPay moved to AWS" because the vector representations are close in 1024-dimensional space.

**The pgvector SQL:**
```sql
SELECT content, 1 - (embedding <=> '[0.1, 0.3, ...]'::vector) AS similarity
FROM document_chunks
ORDER BY embedding <=> '[0.1, 0.3, ...]'::vector
LIMIT 5;
```

**Key components involved:**
- Amazon Titan Text v2 (via Bedrock) → generates embeddings
- Aurora PostgreSQL + pgvector → stores and searches vectors
- LangChain RetrievalChain → orchestrates the query embedding + search
- Claude Sonnet 4.6 (via Bedrock) → synthesises retrieved chunks into a proposal

---

### Pattern 2: Async Job Queue (Producer-Consumer)

The API never waits for LLM generation to finish. It returns immediately with a `job_id`. This is the **producer-consumer pattern via SQS**.

```
Browser          FastAPI (Producer)        SQS Queue        Worker (Consumer)
   |                     |                     |                    |
   |-- POST /generate -->|                     |                    |
   |                     |-- send message ---->|                    |
   |<-- 202 job_id ------|                     |                    |
   |                     |                     |<-- poll every 20s--|
   |                     |                     |-- message -------->|
   |                     |                     |   [job_id,         |
   |-- GET /generate/id->|                     |    requirements]   |
   |<-- {status:queued}--|                     |                    |
   |                     |                     |   [run RAG pipeline]
   |-- GET /generate/id->|                     |                    |
   |<-- {status:drafting}|                     |                    |
   |                     |                     |                    |-- update DB
   |-- GET /generate/id->|                     |                    |
   |<-- {status:complete,|                     |                    |
   |    download_url}    |                     |                    |
```

**Why this matters:** LLM generation takes 30–90 seconds. If the API waited synchronously, the HTTP connection would time out, load balancers would cut it, and the user would see an error. The async queue pattern makes the UX smooth — the browser polls every 3 seconds and shows a progress bar.

**SQS durability:** If the worker crashes mid-generation, the message becomes visible again after the visibility timeout (600s) and gets reprocessed. After 3 failures it goes to the Dead Letter Queue (DLQ).

**Key components involved:**
- FastAPI API (producer) → publishes job message to SQS
- Amazon SQS → durable queue with 600s visibility timeout
- LangChain Worker (consumer) → long-polling SQS loop
- Aurora PostgreSQL → shared job state (status updates)
- React frontend → polls GET /generate/{job_id} every 3 seconds

---

### Pattern 3: Layered Service Architecture (Separation of Concerns)

The app is split into two clearly separated layers with a queue between them:

```
Layer 1: API Service (FastAPI)
  Responsibility: HTTP, auth, DB reads/writes, S3 operations, SQS publish
  Does NOT: call Bedrock, run LangChain, process documents

Layer 2: Worker Service (LangChain)
  Responsibility: embedding, retrieval, generation, docx creation
  Does NOT: handle HTTP, manage user sessions, care about the web layer
```

They share only:
- The same Aurora PostgreSQL database (different tables / same schema)
- The same S3 bucket (different prefixes: `raw/` uploads vs `generated/` outputs)
- SQS as the handoff mechanism (never direct calls between services)

**Why this matters:** You can scale each layer independently. If generation is slow, add more worker tasks. If the API is under HTTP load, add more API tasks. They don't share a process and cannot block each other.

**In practice for Genese:** During a busy proposal day, 5 consultants submit jobs simultaneously. The SQS queue absorbs all 5 requests. One worker processes them sequentially (or you spin up 5 workers for parallelism) without any API service being affected.

---

### Pattern 4: Presigned URL Pattern (Secure File Delivery)

Generated `.docx` files are stored in S3 with no public access. When the job is complete, the API generates a **presigned URL** — a time-limited, cryptographically signed URL that gives one-time read access to a specific S3 object.

```
Worker → uploads .docx → s3://docs-bucket/generated/{job_id}/Client_proposal.docx

Browser polls GET /generate/{job_id}
API checks: job.status == "complete" AND job.output_s3_key exists
    → generates presigned URL (expires in 24 hours)
    → returns URL to browser

Browser → downloads .docx directly from S3 (no API bandwidth used)
```

**Why not just make the bucket public?** Security. The S3 bucket stays completely private. Only authenticated users get the download URL, and it expires after 24 hours. This is the standard AWS pattern for user-specific file delivery.

**Key components involved:**
- Amazon S3 (private bucket) → stores .docx files
- FastAPI `s3.generate_presigned_url()` → creates time-limited download link
- No API bandwidth used for file downloads (browser downloads direct from S3)

---

### Pattern 5: Sidecar Secrets Pattern (Zero Secrets in Code)

No secrets exist in the application code or Docker image. Every secret is read at runtime from AWS Secrets Manager:

```
ECS Task starts
    → IAM task role grants access to specific secret ARNs
    → config.py calls Secrets Manager on first use (cached via @lru_cache)
    → DB password, Tavily key read at runtime
    → Stored in memory only (never written to disk or logs)
```

The IAM role is the identity — no API keys, no passwords in environment variables that could be leaked via `printenv` or CloudWatch logs accidentally.

**Key components involved:**
- AWS Secrets Manager → stores DB credentials, Tavily API key
- IAM task role → grants ECS tasks access to specific secrets only
- Python `@lru_cache` decorator → reads secret once, caches for process lifetime

---

### Pattern 6: CloudFront as Unified Entry Point (Reverse Proxy Aggregation)

```
All user traffic → CloudFront (HTTPS everywhere)
    /              → S3 (React SPA — static files)
    /api/*         → ALB → ECS API (strips /api prefix via CF Function first)
    /images/*      → S3 images bucket (future use)
```

The browser never knows the ALB exists. It only ever talks to one HTTPS domain. The CloudFront Function `StripApiPrefix` rewrites `/api/auth/login` → `/auth/login` before forwarding to the ALB.

**Why this matters for security:** Without this, the frontend (served over HTTPS) would need to call the ALB directly over HTTP — browsers block this as "mixed content". CloudFront terminates HTTPS and forwards to ALB over HTTP internally (within AWS's network).

**Key components involved:**
- CloudFront distribution → unified HTTPS entry point
- CloudFront Function (StripApiPrefix) → URL rewriting
- S3 (frontend bucket) → static SPA hosting
- ALB → routes to ECS API tasks

---

### Pattern Summary Table

| Pattern | Problem Solved | Key AWS Services |
|---------|---------------|-----------------|
| RAG | LLM doesn't know your docs | Bedrock (Titan + Claude), pgvector, Aurora |
| Async Job Queue | LLM generation is slow (30–90s) | SQS, ECS Worker, Aurora |
| Layered Services | API and worker have different scaling needs | ECS Fargate (2 services), SQS |
| Presigned URLs | Secure file delivery without public S3 | S3, IAM |
| Sidecar Secrets | No hardcoded credentials anywhere | Secrets Manager, IAM task roles |
| CloudFront Proxy | HTTPS everywhere, no mixed content | CloudFront, CF Functions, ALB |

---

## 3. Honest Assessment of the Deployment File

**Short answer: 80% of it will work first try. 20% needs your specific context filled in.**

### Things That Will Work Exactly As Written
- CDK install, bootstrap, deploy ✅
- Docker build + ECR push ✅
- DB migration ✅
- ECS service creation commands ✅
- Cognito user creation ✅
- Frontend build + S3 sync ✅
- Seed documents upload ✅

### Things That Need Your Input

| Step | What You Need to Do | Why |
|------|--------------------|----|
| `$API_REPO` and `$WORKER_REPO` | Fill in from CDK outputs | Different every deploy |
| `$DB_SECRET_ARN` | Fill in from CDK outputs | Different every deploy |
| `$CF_ID` | Fill in from CDK outputs | Different every deploy |
| `$TG_ARN` (target group ARN) | Fill in from CDK outputs | Different every deploy |
| Tavily API key | Sign up at app.tavily.com (free, no credit card) | Can't pre-fill |
| Email/password in Cognito step | Replace placeholder values | Your choice |
| `$ALB_DNS` in CloudFront update | Fill in from CDK outputs | Different every deploy |

### Steps That Are More Complex Than They Look

**Step 7 (CloudFront proxy update)** is the most fragile step. The Python script manipulates the CloudFront distribution JSON config. If CloudFront's API returns a slightly different schema than expected, it could fail. Alternative: do it manually in the AWS Console:
1. Go to CloudFront → your distribution → Behaviors → Create behavior
2. Path pattern: `/api/*`
3. Origin: your ALB
4. Cache policy: `CachingDisabled`
5. Origin request policy: `AllViewer`
6. Associate the `StripApiPrefix` function on viewer-request

**ECR repos must exist before `cdk deploy`** — the stack uses `from_repository_name()` to reference existing repos (to avoid the "repo already exists" CloudFormation conflict). If you run `cdk deploy` before creating the repos, it will fail. Create them first:
```bash
aws ecr create-repository --repository-name genese-proposal-ai-api --region us-east-1
aws ecr create-repository --repository-name genese-proposal-ai-worker --region us-east-1
```

**Correct order matters:**
```
1. Create ECR repos (manual CLI)
2. cdk deploy (creates everything except ECS services)
3. Build + push Docker images to ECR
4. Run DB migration (ECS one-off task)
5. Create ECS services (CLI)
6. CloudFront proxy setup
7. Build + deploy frontend
8. Create Cognito user
9. Seed documents
```

If you do steps 3 and 5 before step 2, or step 5 before step 3, it will fail.

**My recommendation:** Use the deployment file as a reference guide, not a blind copy-paste script. Read each step before running it. Every command has an expected output — check it before moving on.

---

## 4. What You Must Do Before Going Public (Production Readiness)

This app is currently **demo-grade**. Here is every gap between current state and "safe to expose publicly."

### 🔴 Critical Security — Fix Before Any Public Exposure

| Issue | Current State | What to Do |
|-------|--------------|-----------|
| **HTTP ALB** | ALB serves HTTP only (port 80) | Request an ACM certificate for your domain in AWS Certificate Manager. Add HTTPS listener (port 443) to the ALB. Redirect HTTP → HTTPS. |
| **CORS is wildcard** | `allow_origins=["*"]` in FastAPI | Change to your specific domain: `allow_origins=["https://proposals.genesesolution.com"]` |
| **No rate limiting** | Any user can spam 1000 generation jobs | Add AWS WAF rate-based rule on CloudFront (max X requests/IP/minute) OR add FastAPI middleware (slowapi library) |
| **No WAF** | CloudFront has no WAF | Enable AWS WAF on CloudFront with `AWSManagedRulesCommonRuleSet` and `AWSManagedRulesBotControlRuleSet` |
| **Demo credentials in docs** | `GeneseDemo123!` is documented everywhere | Delete the demo user. Create real user accounts with strong passwords. Enable MFA if possible. |
| **Tavily key is placeholder** | `REPLACE_WITH_TAVILY_KEY` | Either add a real key or ensure the graceful-skip code is in place (it is) |
| **Cognito self-signup disabled** | Good for internal tool | If making public: add email verification, CAPTCHA (Cognito Advanced Security) |

---

### 🟡 Reliability — Fix Before Sustained Use

| Issue | Current State | What to Do |
|-------|--------------|-----------|
| **Single ECS task** | 1 API task + 1 Worker task | Set `desiredCount=2` on both services. Set `minimumHealthyPercent=50`. This gives zero-downtime deploys and basic redundancy. |
| **No health alerts** | Jobs can silently fail for hours | Add CloudWatch Alarm: DLQ message count > 0 → SNS notification → your email/Slack |
| **Aurora auto-pause** | Aurora pauses after 5 min idle (cold start = 30–60s) | For production: set `serverless_v2_min_capacity=1` so it never pauses |
| **`RemovalPolicy.DESTROY`** | Running `cdk destroy` deletes ALL data permanently | Change Aurora cluster and S3 buckets to `RemovalPolicy.RETAIN` in CDK |
| **No Aurora backups** | No Point-in-Time Recovery | Enable automated backups in Aurora: `backup_retention=Duration.days(7)` in CDK |
| **No job retry logic** | A failed job stays failed | Add a "retry" button in the UI that re-submits the same job parameters |

---

### 🟢 Performance — Nice to Have

| Issue | Current State | What to Do |
|-------|--------------|-----------|
| **pgvector index** | `ivfflat` with `lists=10` (small) | When knowledge base exceeds 1000 chunks, run: `REINDEX INDEX idx_chunks_embedding` with `lists=100` |
| **No embedding cache** | Re-embeds the same query every time | Cache frequent search queries in Redis/ElastiCache with TTL |
| **Worker processes 1 job at a time** | Sequential processing | Increase `sqs_max_messages=1` to higher, add concurrency handling in worker |
| **Large model context** | All 5 RAG chunks always sent | Add relevance threshold — only send chunks with similarity > 0.7 |

---

### 🔵 Observability — Fix Before Production

| Issue | Current State | What to Do |
|-------|--------------|-----------|
| **Basic text logs** | CloudWatch has raw logs | Add structured JSON logging throughout + CloudWatch Log Insights dashboard |
| **No metrics** | No visibility into usage, latency, errors | Create CloudWatch Dashboard: generation success rate, p95 latency, active jobs, DLQ depth |
| **No tracing** | Can't trace a request end-to-end | Add AWS X-Ray SDK to API and Worker, enable active tracing on ECS tasks |
| **No uptime monitoring** | No alerting if app goes down | Add CloudWatch Synthetic Canary pinging `/health` every 1 minute |

---

### 💰 Cost Before Scaling

At current demo scale (~$95/month):

| Service | Cost |
|---------|------|
| Aurora Serverless v2 (0.5 ACU min) | ~$43/mo |
| ECS Fargate (2 tasks, 24/7) | ~$35/mo |
| ALB | ~$16/mo |
| CloudFront | ~$1/mo at low traffic |
| Bedrock Claude Sonnet 4.6 | ~$3/proposal (3M input + 1M output tokens) |
| Bedrock Titan embeddings | ~$0.002/document ingested |
| S3 + SQS + Secrets Manager | ~$2/mo |

**Before public launch, add a budget alert:**
```bash
aws budgets create-budget --account-id $(aws sts get-caller-identity --query Account --output text) \
  --budget '{"BudgetName":"GenProposalAI-Alert","BudgetLimit":{"Amount":"150","Unit":"USD"},"TimeUnit":"MONTHLY","BudgetType":"COST"}' \
  --notifications-with-subscribers '[{"Notification":{"NotificationType":"ACTUAL","ComparisonOperator":"GREATER_THAN","Threshold":80},"Subscribers":[{"SubscriptionType":"EMAIL","Address":"your@email.com"}]}]'
```

---

### Production Readiness Checklist (Prioritised)

**Must do (security):**
- [ ] Add ACM certificate + HTTPS listener on ALB
- [ ] Change CORS from `*` to your domain
- [ ] Add WAF to CloudFront
- [ ] Delete demo user / rotate all passwords
- [ ] Add rate limiting (WAF or FastAPI)

**Should do (reliability):**
- [ ] Set `desiredCount=2` on both ECS services
- [ ] Change `RemovalPolicy.DESTROY` → `RETAIN` on Aurora + S3
- [ ] Enable Aurora PITR backups
- [ ] Add DLQ alarm → email notification
- [ ] Set Aurora min capacity to 1 (no auto-pause)

**Nice to have (operations):**
- [ ] Add real Tavily API key
- [ ] Set up CI/CD pipeline (GitHub Actions)
- [ ] Add CloudWatch Dashboard
- [ ] Configure custom domain + Route 53

**Estimated effort:** 2–3 focused days to cover everything in the "Must do" and "Should do" lists.
