# anshu.md — Genese Proposal AI: Complete Story, Architecture & Learnings

> A personal record of the full journey — from idea to running production app.
> Written for future reference, knowledge transfer, and redeployment.

---

## 1. The Origin — Where the Idea Came From

The idea emerged directly from a real pain point at Genese Solution, a cloud consulting firm:
**every new proposal takes 80% of the same effort as the last one.**

A consultant starting a new AWS migration proposal for a bank goes through the same motions:
- Re-reads the last three similar proposals for inspiration
- Rewrites an executive summary that is 80% identical to previous ones
- Manually checks the AWS documentation to make sure the recommended services are current
- Spends hours reformatting everything to match Genese's branded Word template

The insight was: **the consultant should edit, not write.** An AI that has read all past Genese proposals and knows the current AWS documentation should produce a first draft in minutes. The human then refines it.

This is not a novel idea in the industry — every consulting firm has this problem. The execution detail that makes it practical is the **RAG (Retrieval-Augmented Generation) pipeline**: instead of fine-tuning a model on your documents (expensive, slow), you embed your documents into a vector database and retrieve the most relevant chunks at generation time. The LLM gets your specific context alongside the generation request.

### The Three-Feature Core

1. **Proposal/SoW Generator** — submit client name, engagement type, requirements → get a Genese-branded .docx first draft in ~60 seconds
2. **Knowledge Search** — ask "what did we do for the last fintech client?" and get an AI-synthesised answer with citations from past work
3. **Live Doc Validation** — architecture claims are validated against live AWS/Azure/GCP documentation (via Tavily web search)

---

## 2. The Journey — Phase by Phase

### Phase 1: Inception (AI-DLC workflow)

We followed the AI-DLC workflow methodology. The key decisions made during inception:

**Requirements Analysis**
- Scope: Internal tool for Genese consultants only (not a SaaS product)
- Priority: Demo-grade quality — impressive output, not production hardened
- Language: Python for backend (LangChain/python-docx ecosystem)
- Architecture: AWS-only, everything serverless/managed where possible

**Technology Selection Decisions Made Here:**

| Decision | What We Chose | Why | What We Rejected |
|----------|--------------|-----|------------------|
| LLM | Claude Sonnet 4.6 via Bedrock | Already active in the AWS account, no external API | OpenAI (external), fine-tuned model (too slow) |
| Embeddings | Amazon Titan Text v2 via Bedrock | AWS-native, no data leaves AWS, cheapest option | Cohere (external API = data leaves AWS) |
| Vector DB | Aurora PostgreSQL + pgvector | Scales to zero when idle (cost), SQL familiarity, no new service | OpenSearch Serverless ($300+/mo floor), Pinecone (external) |
| Web Search | Tavily free tier | Purpose-built for LLM agents, no credit card required | Bing/Google (needs billing), no-search (less accurate) |
| Compute | ECS Fargate | LLM generation takes 30s–3min (Lambda 15-min cap is fine but cold starts hurt long jobs), need persistent SQS consumer | Lambda (cold start + 15min cap), EC2 (ops overhead) |
| Orchestration | LangChain | Mature RAG tooling, Bedrock integrations built-in | LlamaIndex (less mature at time), raw boto3 (too much boilerplate) |
| Doc output | python-docx | Python-native, full control over branding | Pandoc (dependency hell), Google Docs API (external) |
| IaC | AWS CDK (Python) | Same language as app, monorepo consistency | Terraform (multi-cloud not needed), SAM (serverless-only) |

**Application Design**
- Single monorepo, two backend services (API container + Worker container)
- API: FastAPI — handles HTTP, auth, job submission, status polling
- Worker: LangChain SQS consumer — does the heavy RAG + generation work
- Decoupled via SQS so the API returns immediately (job_id) and the consultant polls for status

---

## 3. Construction Phase — What We Built

### Monorepo Structure

```
genese-proposal-ai/
├── services/
│   ├── shared/          ← Pydantic models, SQLAlchemy ORM, constants (built first)
│   ├── api/             ← FastAPI HTTP service (ECS Fargate)
│   └── worker/          ← LangChain RAG worker (ECS Fargate)
├── frontend/            ← React + shadcn/ui + Tailwind SPA
├── infrastructure/      ← AWS CDK Python stack
├── scripts/
│   ├── db_migrate.py    ← Creates pgvector schema
│   └── seed_data.py     ← Ingests 10 synthetic Genese-style documents
└── scripts/seed_documents/  ← 10 .txt files (proposals, SoWs, case studies)
```

**Build order matters:** `shared` → `backend` → `frontend` → `infrastructure`
The shared package is the single source of truth for all data shapes (Pydantic + SQLAlchemy).

### The RAG Pipeline (the core of the app)

```
User submits generation request
    │
    ▼ API (FastAPI)
    1. Creates GenerationJob record in Aurora DB (status: queued)
    2. Publishes SQS message with job_id
    3. Returns job_id immediately (202 Accepted)
    
    ▼ SQS queue
    
    ▼ Worker (LangChain)
    4. Embeds query using Amazon Titan Text v2 → 1024-dim vector
    5. Cosine similarity search in pgvector → top 5 relevant document chunks
    6. (Optional) Tavily search → live AWS/Azure/GCP doc snippets
    7. Claude Sonnet 4.6 prompt:
       - System: "You are a Genese proposal writer..."
       - Context: retrieved chunks + Tavily sources
       - Request: generate JSON with one key per proposal section
    8. Parse Claude's JSON response → section dict
    9. python-docx fills Genese-branded template with sections
    10. Upload .docx to S3 → generate presigned URL
    11. Update GenerationJob (status: complete, download URL)
    
    ▼ Frontend polls GET /generate/{job_id}
    12. Shows status progression in real-time
    13. Download button appears when complete
```

### Database Schema (pgvector)

```sql
-- 4 tables total
users           -- Cognito sub → internal user record
documents       -- Uploaded documents (filename, type, S3 key, chunk count)
document_chunks -- id, content, embedding vector(1024), document_id FK
generation_jobs -- Full job record: inputs, status, rag_context (JSONB), 
                   tavily_sources (JSONB), output_s3_key, error_message
```

The key design: `document_chunks.embedding` is `vector(1024)` — matching Amazon Titan Text v2's actual output dimension. The `ivfflat` index enables fast approximate nearest-neighbour search.

---

## 4. Every Problem We Faced and How We Solved It

This section is the most valuable for future reference. Every bug was a real production lesson.

---

### Problem 1: ECS Service CloudFormation Stabilization Timeout

**What happened:** CDK deploys ECS services via CloudFormation. CFN waits for the ECS service to reach "steady state" — meaning desired tasks are running and healthy. This wait can take up to 3 hours before CFN gives up. Our ECS task couldn't pull its image from ECR fast enough during the first deploy, causing CFN to time out and trigger a rollback.

**Why it happened:** On first deploy, the ECR repo exists but the image hasn't been pushed yet. ECS tries to pull → fails → CFN times out. Also, IAM policy propagation takes a few seconds and the execution role sometimes wasn't fully ready when the task tried to pull.

**How we fixed it:** Removed ECS services from CDK entirely. CDK creates all infrastructure (VPC, ALB, task definitions, cluster, IAM) but ECS services are created with AWS CLI after the stack deploys successfully. This bypasses CFN's 3-hour ECS stabilization wait completely.

```bash
# After cdk deploy succeeds:
aws ecs create-service \
  --cluster genese-proposal-ai \
  --service-name genese-api-service \
  --task-definition <TD_ARN> \
  --load-balancers "targetGroupArn=<TG_ARN>,containerName=Api,containerPort=8000" \
  --health-check-grace-period-seconds 60 \
  --deployment-configuration "maximumPercent=100,minimumHealthyPercent=0"
```

**Lesson:** Never let CloudFormation manage ECS service resources if you have strict deploy time requirements. CDK/CFN + ECS services is notoriously slow. The pattern is: CDK for infra, CLI/pipeline for service updates.

---

### Problem 2: Aurora RDS Password Invalid Characters

**What happened:** The CDK `SecretStringGenerator` auto-generated a password for Aurora. The generated password contained characters that RDS forbids (`/`, `@`, `"`, `space`). Aurora rejected the cluster creation with `MasterUserPassword is not a valid password`.

**How we fixed it:** Extended the `exclude_characters` list in the CDK secret generator:

```python
generate_secret_string=secretsmanager.SecretStringGenerator(
    secret_string_template='{"username":"genese","dbname":"genese"}',
    generate_string_key="password",
    exclude_characters=' %+~`#$&*()|[]{}:;<>?!\'/\"\\@/',
    password_length=32,
)
```

**Lesson:** Always explicitly exclude RDS-forbidden characters when auto-generating DB passwords. The CDK default exclusion list is not sufficient for RDS.

---

### Problem 3: Frontend Mixed-Content Error (HTTPS → HTTP)

**What happened:** The frontend is served over HTTPS (CloudFront). The API URL was `http://...elb.amazonaws.com`. Browsers block fetch() calls from HTTPS pages to HTTP endpoints — "mixed content". This showed as "NetworkError when attempting to fetch resource" in the browser.

**How we fixed it:** Added an `/api/*` behavior to CloudFront pointing to the ALB as an origin. Also added a CloudFront Function to strip the `/api` prefix before forwarding to the ALB (which doesn't expect the `/api` prefix):

```javascript
// CloudFront Function: StripApiPrefix
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri.startsWith("/api")) {
    request.uri = uri.slice(4) || "/";
  }
  return request;
}
```

The frontend is rebuilt with `VITE_API_URL=/api` so all API calls become same-origin HTTPS through CloudFront.

**Lesson:** When hosting a SPA on CloudFront and an API on ALB, always proxy the API through CloudFront. Never expose the ALB HTTP URL to the browser directly when CloudFront is in the stack.

---

### Problem 4: Cognito Login — Wrong Auth Flow

**What happened:** The frontend AuthContext was calling Cognito's `/oauth2/token` endpoint directly with `grant_type: password`. This requires a Cognito Hosted UI domain to be configured, which we never set up. The login failed silently with "Invalid credentials".

**Root cause:** We assumed Cognito supports direct Resource Owner Password Credentials (ROPC) from the browser. It does, but only via the hosted UI domain or a backend intermediary. The `AdminInitiateAuth` flow (which we use in the backend) requires server-side calls with the User Pool ID — it can't be called from the browser because it requires AWS credentials.

**How we fixed it:** Changed the frontend to call `POST /api/auth/login` on our own FastAPI backend. The backend uses Cognito `AdminInitiateAuth` server-side and returns the JWT tokens to the frontend. The frontend stores the `idToken` in localStorage and sends it as `Authorization: Bearer <token>` on subsequent requests.

**Lesson:** Never try to call Cognito `AdminInitiateAuth` from the browser. Use a backend proxy. The browser should only interact with your own API, which handles the Cognito integration server-side.

---

### Problem 5: pgvector SQL Syntax Error with asyncpg

**What happened:** The search endpoint used SQLAlchemy's `text()` with a named bind parameter:
```sql
WHERE dc.embedding <=> :embedding::vector
```
asyncpg (the async PostgreSQL driver) saw `:embedding` as a named bind variable AND `::vector` as a PostgreSQL type cast. The combination caused a syntax error: `syntax error at or near ":"`.

**How we fixed it:** Serialized the embedding vector as a Python list string literal and used an f-string to inject it directly into the SQL:
```python
embedding_str = "[" + ",".join(str(x) for x in query_embedding) + "]"
sql = text(f"""
    SELECT ... 
    WHERE dc.embedding <=> '{embedding_str}'::vector
    LIMIT :top_k
""")
```

This is safe because `embedding_str` is a float array serialized by Python — not user input — so there is no SQL injection risk.

**The same bug existed in the worker's `retrieval_chain.py`** and was fixed the same way.

**Lesson:** When using pgvector with SQLAlchemy's `text()` and asyncpg, you cannot mix named bind parameters (`:param`) with PostgreSQL type casts (`::type`) in the same query. Use either all positional parameters (`$1`, `$2`) or inline the vector as a string literal.

---

### Problem 6: Embedding Dimension Mismatch (1536 vs 1024)

**What happened:** The database schema and shared constants defined `vector(1536)` — the dimension for OpenAI's `text-embedding-ada-002`. But Amazon Titan Text Embeddings v2 returns 1024 dimensions by default. When the worker tried to insert embeddings, Aurora rejected them: `expected 1536 dimensions, not 1024`.

**How we fixed it:**
1. Updated `EMBEDDING_DIMENSION = 1024` in `constants.py`
2. Updated `DocumentChunk.embedding = Column(Vector(1024))` in ORM
3. Dropped and recreated `document_chunks` table via an ECS one-off task:
```sql
DROP TABLE IF EXISTS document_chunks CASCADE;
CREATE TABLE document_chunks (
    ...
    embedding vector(1024),
    ...
);
```

**Lesson:** Always verify the actual output dimension of your embedding model before creating the DB schema. Titan Text v2 supports configurable dimensions (256, 512, 1024) — 1024 is the default. If you want 1536 for compatibility with other models, you can configure it, but then you need a larger index.

---

### Problem 7: Tavily Secret Not JSON

**What happened:** The Tavily secret in Secrets Manager was stored as a plain string `REPLACE_WITH_TAVILY_KEY` (the CDK placeholder). The worker's `get_tavily_api_key()` function did `json.loads(secret_string)` — which throws `JSONDecodeError: Expecting value: line 1 column 1 (char 0)` because a plain string is not valid JSON.

This error propagated up through the entire generation pipeline, crashing every generation job for hours before we found it with a full traceback.

**How we fixed it:**
```python
try:
    secret = json.loads(raw)  # Try JSON first ({"api_key": "..."})
    return secret.get("api_key", "")
except json.JSONDecodeError:
    return raw.strip()  # Fall back to plain string
```
And in `validation_chain.py`:
```python
if not api_key or api_key == "REPLACE_WITH_TAVILY_KEY" or len(api_key) < 10:
    return []  # Skip Tavily gracefully
```

**Lesson:** Any code that reads from Secrets Manager must handle both JSON and plain-string formats. Also: always validate that placeholder values in secrets are replaced before deploying to production. Use a deploy script that checks for placeholders.

---

### Problem 8: `temperature` and `top_p` Cannot Both Be Set (Claude Sonnet 4.6)

**What happened:** The `bedrock.py` config set both `temperature=0.3` and `top_p=0.9` in LangChain's `ChatBedrock` model kwargs. Claude Sonnet 4.6 returns a `ValidationException`: `temperature and top_p cannot be used together`.

**How we fixed it:** Removed `top_p` from model kwargs. Only `temperature` is needed.

**Lesson:** Claude's API (unlike OpenAI's) does not allow `temperature` and `top_p` together. When migrating patterns from OpenAI to Claude, remove `top_p` (or `top_k`).

---

### Problem 9: ECR Image Caching — ECS Pulls Old Image

**What happened:** When we pushed a new Docker image to ECR (`:latest`) and ran `aws ecs update-service --force-new-deployment`, ECS would sometimes continue running the old image. This happened because ECS task definitions reference images by tag, not by digest. If the task definition revision was the same, ECS could use cached layers.

**How we fixed it:** Every time we push a new image, we also register a **new task definition revision** and update the service to that revision:

```bash
# Register new task def (triggers ECS to pull fresh)
NEW_ARN=$(aws ecs register-task-definition --cli-input-json file://td.json \
  --query 'taskDefinition.taskDefinitionArn' --output text)

# Update service with new TD revision
aws ecs update-service --service genese-worker-service \
  --task-definition $NEW_ARN --force-new-deployment
```

**Lesson:** Always use image digests (sha256) in production task definitions, not `:latest` tags. In development, register a new task definition revision each time you push to guarantee ECS pulls the new image.

---

### Problem 10: `minimumHealthyPercent=0` — Zero-Downtime Gap

**What happened:** We set `minimumHealthyPercent=0` to allow rolling updates with only 1 task. This means during a deployment, ECS stops the old task BEFORE starting the new one. This creates a ~30–60 second window where the service has 0 running tasks and the ALB returns 503.

**How we fixed it (for the demo):** We accepted this behavior since it's a single-task demo. For production, set `desiredCount=2` with `minimumHealthyPercent=50` — ECS then keeps one task alive while replacing the other.

**Lesson:** `minimumHealthyPercent=0` with `desiredCount=1` always creates a deployment gap. Acceptable for dev/demo, never acceptable for production.

---

## 5. Architecture Decisions and Tradeoffs

### Why ECS Fargate over Lambda for the Worker

Lambda was rejected for the worker because:
- LLM generation takes 30–90 seconds (acceptable within Lambda's 15-min limit, but cold starts add 3–5 seconds and make the UX worse)
- The SQS consumer loop is a long-running process — Lambda needs to be triggered per message, not run a while loop
- Loading LangChain + all dependencies on cold start is heavy (~400MB)

ECS Fargate is the right model for "always-on, long-running async workers".

### Why Aurora PostgreSQL + pgvector over OpenSearch Serverless

OpenSearch Serverless was originally planned but rejected because:
- Minimum cost floor: ~$300–700/month (always-on OCUs) even with zero traffic
- Aurora Serverless v2 scales to 0.5 ACU minimum and can auto-pause after 5 minutes of inactivity
- pgvector in PostgreSQL is mature, handles 1M+ vectors easily for an internal tool
- SQL familiarity: the rest of the application data (jobs, users, documents) is also in the same Aurora cluster

**Tradeoff accepted:** pgvector's `ivfflat` index requires a minimum number of vectors before it's effective (we set `lists=10` which requires at least 390 vectors for optimal performance). For a small knowledge base, a full table scan is actually fine.

### Why Synchronous psycopg2 in Worker, Async asyncpg in API

The API uses async SQLAlchemy (asyncpg driver) because FastAPI is async and concurrency matters for handling multiple HTTP requests simultaneously.

The Worker uses sync SQLAlchemy (psycopg2 driver) because the SQS consumer loop is synchronous Python — there's no async event loop, and LangChain's synchronous chain API is simpler to work with.

**Tradeoff:** This means the worker can't do async DB operations. For this use case, it doesn't matter — the worker processes one job at a time and latency inside the worker is dominated by LLM inference time (30–90s), not DB access (<100ms).

### Why CloudFront in Front of Everything

CloudFront serves two purposes:
1. **HTTPS termination** for the frontend (S3 doesn't provide HTTPS on custom origins by default)
2. **Same-origin proxy** for the API — the frontend calls `/api/*` which CloudFront forwards to the ALB, eliminating mixed-content browser errors

The `/api/*` → ALB behavior with the `StripApiPrefix` CloudFront Function is a critical architectural detail. Without it, the browser would be making HTTP requests to the ALB directly from an HTTPS page.

### Why the API Auth Router Was Separate from Lambda Handlers

The original code (written as Lambda handlers) had to be rewritten as a proper FastAPI router for the containerized API. Lambda handlers have a specific signature (`def handler(event, context)`) that doesn't map to FastAPI's dependency injection system.

**Lesson learned:** When migrating from Lambda to ECS containers, rewrite handlers as proper framework routes (FastAPI routers, Express routes, etc.) rather than trying to adapt the Lambda handler pattern.

---

## 6. How It Can Be Improved

### Short Term (1–2 weeks)

1. **Real Tavily integration** — Get a free API key from `app.tavily.com`, update the secret, and live web validation becomes active. This significantly improves proposal accuracy for current AWS service recommendations.

2. **Upload real Genese documents** — The current knowledge base has 10 synthetic documents. Replace with real past proposals/SoWs. The RAG quality improvement is dramatic — 10 synthetic docs → 50+ real docs improves relevance from "plausible" to "actually based on our work".

3. **Add document re-ingestion** — If you delete a document and re-upload it, the old embeddings remain in `document_chunks`. Add a cleanup step that deletes old chunks when a document is re-uploaded.

4. **CI/CD pipeline** — Currently deployed manually. Add GitHub Actions: push to main → build images → push to ECR → register new task definition → update ECS services.

5. **Fix the deployment gap** — Set `desiredCount=2` on the API service with `minimumHealthyPercent=50` for zero-downtime deployments.

### Medium Term (1–2 months)

6. **Streaming generation** — Instead of polling every 3 seconds, use Server-Sent Events (SSE) to stream Claude's response to the browser in real time. The consultant sees the proposal being written word by word.

7. **Human-in-the-loop editing** — After generation, allow the consultant to edit sections in the browser before downloading. Store revision history.

8. **Multi-format support** — The docx_builder currently produces one template. Add Genese's actual branded templates for proposal vs SoW vs case study with proper logos, fonts, and colour schemes.

9. **Feedback loop** — Add a "thumbs up/down" on generated proposals. Store feedback to identify which past documents are most useful for retrieval (rerank by feedback score).

10. **Chunking strategy** — Currently using character-level chunking (512 chars, 50 overlap). Upgrade to semantic chunking (split on section boundaries) for consulting documents. Proposals have clear section structure — chunk by section, not by character count.

### Long Term

11. **Multi-tenant** — Parameterise per-company knowledge bases. Each Genese country office (Nepal, India, UK) has its own set of proposals.

12. **Fine-tuned embeddings** — Fine-tune the embedding model on consulting domain text for better retrieval accuracy (requires 1000+ labelled query→document pairs).

13. **Agentic research** — Instead of one Tavily search, add a multi-step research agent that: (1) identifies knowledge gaps in the proposal, (2) searches for missing information, (3) synthesises findings into the proposal.

---

## 7. How It Could Be Done Differently

### Alternative 1: AWS Bedrock Knowledge Bases (Managed RAG)

Instead of building the entire RAG pipeline manually (embeddings → pgvector → retrieval → generation), AWS offers **Bedrock Knowledge Bases** as a fully managed service. You upload documents to S3, Bedrock automatically chunks, embeds (Titan), and stores in a managed vector store (OpenSearch Serverless or pgvector on Aurora). You query it with a single API call.

**Why we didn't:** More expensive (OpenSearch Serverless floor cost), less control over chunking/retrieval strategy, harder to customise the generation prompt.

**When you should:** If you want to go from 0 to working RAG in 1 day with zero infrastructure management, Bedrock Knowledge Bases is excellent.

### Alternative 2: Serverless Architecture (Lambda + Aurora Serverless)

Replace ECS Fargate with Lambda functions:
- API: Lambda + API Gateway (instead of FastAPI on ECS)
- Worker: Lambda triggered by SQS

**Tradeoffs:** Lambda cold starts add 2–5 seconds. Lambda has a 15-minute execution limit (fine for most proposals, risky for complex ones). Connection pooling to Aurora requires RDS Proxy (extra cost, extra moving part).

**When you should:** If traffic is very spiky (days with no use, then bursts), Lambda saves more money. For an internal tool used daily, ECS Fargate is simpler and more predictable.

### Alternative 3: AppSync + DynamoDB for the Proposal Status

Instead of polling `GET /generate/{job_id}` every 3 seconds, use AppSync subscriptions to push status updates to the frontend in real time. The worker updates DynamoDB, which triggers a DynamoDB Stream → Lambda → AppSync mutation → WebSocket push to browser.

**Why we didn't:** Significantly more complexity for the same UX outcome. For a demo, polling is fine.

### Alternative 4: Open-Source LLM (Ollama / vLLM on EC2/EKS)

Run an open-source model (Llama 3, Mistral) on a GPU EC2 instance instead of using Bedrock.

**Tradeoffs:** Higher upfront cost and complexity. Better for data-sensitive environments where you can't allow any data to leave your VPC (Bedrock calls, while staying in AWS, still leave the EC2 instance's process boundary). For Genese's internal use with non-secret client data, Bedrock is the right choice.

---

## 8. Current Deployment State (as of 2026-07-02)

### Live URLs
| Resource | URL |
|----------|-----|
| Frontend (CloudFront) | https://d3gmhvny3loneb.cloudfront.net |
| API (ALB, internal use) | http://Genese-ApiLB-XYr1qAvXxyX7-1479126617.us-east-1.elb.amazonaws.com |

### Demo Credentials
- Email: `demo@genesesolution.com`
- Password: `GeneseDemo123!`

### AWS Account & Region
- Account: `654654306837`
- Region: `us-east-1`
- CloudFormation Stack: `GeneseProposalAIStack` (CREATE_COMPLETE)

### Infrastructure Summary
| Service | Resource Name | Notes |
|---------|--------------|-------|
| VPC | GeneseProposalAIStack/Vpc | 2 AZ, public + private subnets, 1 NAT gateway |
| Aurora PostgreSQL | geneseproposalaistack-auroracluster... | Serverless v2, pgvector enabled, 1024-dim |
| ECS Cluster | genese-proposal-ai | |
| ECS API Service | genese-api-service | TD revision :6, 1 task, ALB-registered |
| ECS Worker Service | genese-worker-service | TD revision :10, 1 task |
| ALB | Genese-ApiLB-XYr1qAvXxyX7 | Public, port 80 |
| CloudFront | E31C3VQPMUFTQZ | Frontend + /api/* proxy |
| S3 Frontend | genese-proposal-ai-frontend-654654306837-us-east-1 | |
| S3 Documents | genese-proposal-ai-docs-654654306837-us-east-1 | raw/ and generated/ prefixes |
| Cognito User Pool | us-east-1_ThM2KRVkt | Client: 19ufsosadrbr5fqlhleargbrbi |
| SQS Queue | genese-generation-jobs | Visibility timeout 600s |
| SQS DLQ | genese-generation-jobs-dlq | After 3 failures |
| ECR API | genese-proposal-ai-api | |
| ECR Worker | genese-proposal-ai-worker | |
| Secret: DB | /genese/db-credentials | Host, user, password, dbname |
| Secret: Tavily | /genese/tavily-api-key | Currently: REPLACE_WITH_TAVILY_KEY |
| CloudFront Function | StripApiPrefix | Strips /api prefix before ALB |

### What's Seeded
- 10 synthetic Genese-style documents (4 proposals, 3 SoWs, 3 case studies)
- All embedded into pgvector (1024-dim Titan Text v2)
- Demo user created in Cognito (permanent password)

---

## 9. Complete Final CDK Stack (Copy-Paste Ready)

This is the exact CDK stack that successfully deployed. Save as `infrastructure/stacks/genese_stack.py`.

**Key design choices reflected in this stack:**
- ECS services are NOT included (created via CLI after deploy to avoid CFN timeout)
- ALB is created here (target group referenced in CLI service creation)
- DB password excludes all RDS-forbidden characters
- `RemovalPolicy.DESTROY` throughout (demo account — change for production)

```python
"""Genese Proposal AI — Full AWS CDK Stack.
ECS Services are created via CLI after this stack deploys.
"""
import aws_cdk as cdk
from aws_cdk import (
    Stack, Duration, RemovalPolicy, CfnOutput, SecretValue,
    aws_ec2 as ec2,
    aws_s3 as s3,
    aws_cloudfront as cloudfront,
    aws_cloudfront_origins as origins,
    aws_cognito as cognito,
    aws_rds as rds,
    aws_sqs as sqs,
    aws_ecr as ecr,
    aws_ecs as ecs,
    aws_elasticloadbalancingv2 as elbv2,
    aws_iam as iam,
    aws_logs as logs,
    aws_secretsmanager as secretsmanager,
)
from constructs import Construct


class GeneseProposalAIStack(Stack):

    def __init__(self, scope: Construct, construct_id: str, **kwargs):
        super().__init__(scope, construct_id, **kwargs)

        # ── VPC ──────────────────────────────────────────────────────────────
        vpc = ec2.Vpc(self, "Vpc",
            max_azs=2,
            nat_gateways=1,
            subnet_configuration=[
                ec2.SubnetConfiguration(
                    name="Public",
                    subnet_type=ec2.SubnetType.PUBLIC,
                    cidr_mask=24
                ),
                ec2.SubnetConfiguration(
                    name="Private",
                    subnet_type=ec2.SubnetType.PRIVATE_WITH_EGRESS,
                    cidr_mask=24
                ),
            ],
        )

        # ── S3 ───────────────────────────────────────────────────────────────
        documents_bucket = s3.Bucket(self, "DocumentsBucket",
            bucket_name=f"genese-proposal-ai-docs-{self.account}-{self.region}",
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
            removal_policy=RemovalPolicy.DESTROY,
            auto_delete_objects=True,
            lifecycle_rules=[s3.LifecycleRule(
                id="ArchiveGenerated",
                prefix="generated/",
                transitions=[s3.Transition(
                    storage_class=s3.StorageClass.INFREQUENT_ACCESS,
                    transition_after=Duration.days(30)
                )],
            )],
        )

        frontend_bucket = s3.Bucket(self, "FrontendBucket",
            bucket_name=f"genese-proposal-ai-frontend-{self.account}-{self.region}",
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
            removal_policy=RemovalPolicy.DESTROY,
            auto_delete_objects=True,
        )

        # ── CloudFront ────────────────────────────────────────────────────────
        distribution = cloudfront.Distribution(self, "Distribution",
            default_behavior=cloudfront.BehaviorOptions(
                origin=origins.S3BucketOrigin.with_origin_access_control(
                    frontend_bucket
                ),
                viewer_protocol_policy=cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            ),
            default_root_object="index.html",
            error_responses=[
                cloudfront.ErrorResponse(
                    http_status=404,
                    response_http_status=200,
                    response_page_path="/index.html"
                ),
                cloudfront.ErrorResponse(
                    http_status=403,
                    response_http_status=200,
                    response_page_path="/index.html"
                ),
            ],
        )

        # ── Cognito ───────────────────────────────────────────────────────────
        user_pool = cognito.UserPool(self, "UserPool",
            user_pool_name="genese-proposal-ai",
            self_sign_up_enabled=False,
            sign_in_aliases=cognito.SignInAliases(email=True),
            password_policy=cognito.PasswordPolicy(
                min_length=8,
                require_lowercase=True,
                require_uppercase=True,
                require_digits=True,
                require_symbols=False,
            ),
            removal_policy=RemovalPolicy.DESTROY,
        )

        user_pool_client = cognito.UserPoolClient(self, "UserPoolClient",
            user_pool=user_pool,
            user_pool_client_name="genese-web-client",
            auth_flows=cognito.AuthFlow(
                admin_user_password=True,
                user_password=True,
                user_srp=True
            ),
            generate_secret=False,
        )

        # ── Aurora PostgreSQL Serverless v2 + pgvector ────────────────────────
        db_sg = ec2.SecurityGroup(self, "DbSG", vpc=vpc, description="Aurora SG")

        db_secret = secretsmanager.Secret(self, "DbSecret",
            secret_name="/genese/db-credentials",
            generate_secret_string=secretsmanager.SecretStringGenerator(
                secret_string_template='{"username":"genese","dbname":"genese"}',
                generate_string_key="password",
                # Exclude all RDS-forbidden characters
                exclude_characters=' %+~`#$&*()|[]{}:;<>?!\'/\"\\@/',
                password_length=32,
            ),
        )

        db_cluster = rds.DatabaseCluster(self, "AuroraCluster",
            engine=rds.DatabaseClusterEngine.aurora_postgres(
                version=rds.AuroraPostgresEngineVersion.VER_16_4
            ),
            default_database_name="genese",
            serverless_v2_min_capacity=0.5,
            serverless_v2_max_capacity=4,
            writer=rds.ClusterInstance.serverless_v2("Writer"),
            vpc=vpc,
            vpc_subnets=ec2.SubnetSelection(
                subnet_type=ec2.SubnetType.PRIVATE_WITH_EGRESS
            ),
            security_groups=[db_sg],
            credentials=rds.Credentials.from_secret(db_secret),
            removal_policy=RemovalPolicy.DESTROY,
        )

        # ── SQS Queue + DLQ ───────────────────────────────────────────────────
        dlq = sqs.Queue(self, "GenerationDLQ",
            queue_name="genese-generation-jobs-dlq",
            retention_period=Duration.days(14),
        )

        generation_queue = sqs.Queue(self, "GenerationQueue",
            queue_name="genese-generation-jobs",
            visibility_timeout=Duration.seconds(600),
            retention_period=Duration.days(4),
            dead_letter_queue=sqs.DeadLetterQueue(
                max_receive_count=3,
                queue=dlq
            ),
        )

        # ── ECR Repositories ──────────────────────────────────────────────────
        api_repo = ecr.Repository.from_repository_name(
            self, "ApiRepo", "genese-proposal-ai-api"
        )
        worker_repo = ecr.Repository.from_repository_name(
            self, "WorkerRepo", "genese-proposal-ai-worker"
        )

        # ── Tavily Secret (placeholder — update after deploy) ─────────────────
        tavily_secret = secretsmanager.Secret(self, "TavilySecret",
            secret_name="/genese/tavily-api-key",
            secret_string_value=SecretValue.unsafe_plain_text(
                "REPLACE_WITH_TAVILY_KEY"
            ),
        )

        # ── Common ECS Environment Variables ─────────────────────────────────
        common_env = {
            "AWS_REGION": self.region,
            "DOCUMENTS_BUCKET": documents_bucket.bucket_name,
            "GENERATION_QUEUE_URL": generation_queue.queue_url,
            "COGNITO_USER_POOL_ID": user_pool.user_pool_id,
            "COGNITO_CLIENT_ID": user_pool_client.user_pool_client_id,
            "DB_SECRET_ARN": db_secret.secret_arn,
            "TAVILY_SECRET_ARN": tavily_secret.secret_arn,
            "REDIS_URL": "",
        }

        # ── ECS Cluster ───────────────────────────────────────────────────────
        cluster = ecs.Cluster(self, "Cluster",
            cluster_name="genese-proposal-ai",
            vpc=vpc
        )

        # ── API Task Definition ───────────────────────────────────────────────
        api_task = ecs.FargateTaskDefinition(self, "ApiTask",
            cpu=512,
            memory_limit_mib=1024
        )
        api_task.add_container("Api",
            image=ecs.ContainerImage.from_ecr_repository(api_repo, tag="latest"),
            environment=common_env,
            logging=ecs.LogDrivers.aws_logs(
                stream_prefix="api",
                log_group=logs.LogGroup(
                    self, "ApiLogs",
                    log_group_name="/ecs/genese-api",
                    removal_policy=RemovalPolicy.DESTROY
                ),
            ),
            port_mappings=[ecs.PortMapping(container_port=8000)],
            # No container health check — ALB health check is sufficient
        )

        # ── Worker Task Definition ────────────────────────────────────────────
        worker_task = ecs.FargateTaskDefinition(self, "WorkerTask",
            cpu=1024,
            memory_limit_mib=2048
        )
        worker_task.add_container("Worker",
            image=ecs.ContainerImage.from_ecr_repository(
                worker_repo, tag="latest"
            ),
            environment=common_env,
            logging=ecs.LogDrivers.aws_logs(
                stream_prefix="worker",
                log_group=logs.LogGroup(
                    self, "WorkerLogs",
                    log_group_name="/ecs/genese-worker",
                    removal_policy=RemovalPolicy.DESTROY
                ),
            ),
        )

        # ── Grant Permissions ─────────────────────────────────────────────────
        for task in [api_task, worker_task]:
            documents_bucket.grant_read_write(task.task_role)
            generation_queue.grant_send_messages(task.task_role)
            generation_queue.grant_consume_messages(task.task_role)
            db_secret.grant_read(task.task_role)
            tavily_secret.grant_read(task.task_role)
            task.task_role.add_managed_policy(
                iam.ManagedPolicy.from_aws_managed_policy_name(
                    "AmazonBedrockFullAccess"
                )
            )

        # Cognito permissions for API task
        api_task.task_role.add_to_policy(
            iam.PolicyStatement(
                actions=[
                    "cognito-idp:AdminInitiateAuth",
                    "cognito-idp:AdminConfirmSignUp",
                    "cognito-idp:SignUp",
                    "cognito-idp:ForgotPassword",
                    "cognito-idp:ConfirmForgotPassword",
                ],
                resources=[user_pool.user_pool_arn]
            )
        )

        # ── Security Groups ───────────────────────────────────────────────────
        api_sg = ec2.SecurityGroup(self, "ApiSG",
            vpc=vpc, description="ECS API SG"
        )
        worker_sg = ec2.SecurityGroup(self, "WorkerSG",
            vpc=vpc, description="ECS Worker SG"
        )
        db_sg.add_ingress_rule(api_sg, ec2.Port.tcp(5432), "API to Aurora")
        db_sg.add_ingress_rule(worker_sg, ec2.Port.tcp(5432), "Worker to Aurora")

        # ── ALB (API service created via CLI after deploy) ────────────────────
        alb = elbv2.ApplicationLoadBalancer(self, "ApiLB",
            vpc=vpc,
            internet_facing=True,
        )
        alb_sg = alb.connections.security_groups[0]
        api_sg.add_ingress_rule(alb_sg, ec2.Port.tcp(8000), "ALB to API")

        target_group = elbv2.ApplicationTargetGroup(self, "ApiTG",
            vpc=vpc,
            port=8000,
            protocol=elbv2.ApplicationProtocol.HTTP,
            target_type=elbv2.TargetType.IP,
            health_check=elbv2.HealthCheck(
                path="/health",
                interval=Duration.seconds(30),
                healthy_threshold_count=2,
                unhealthy_threshold_count=3,
            ),
        )

        alb.add_listener("Listener",
            port=80,
            default_target_groups=[target_group],
        )

        # ── CloudFormation Outputs ────────────────────────────────────────────
        CfnOutput(self, "ApiUrl",
            value=f"http://{alb.load_balancer_dns_name}",
            description="API Load Balancer URL"
        )
        CfnOutput(self, "TargetGroupArn",
            value=target_group.target_group_arn,
            description="ALB Target Group ARN"
        )
        CfnOutput(self, "AlbArn",
            value=alb.load_balancer_arn,
            description="ALB ARN"
        )
        CfnOutput(self, "CloudFrontUrl",
            value=f"https://{distribution.distribution_domain_name}",
            description="Frontend CloudFront URL"
        )
        CfnOutput(self, "FrontendBucketName",
            value=frontend_bucket.bucket_name,
            description="Frontend S3 bucket"
        )
        CfnOutput(self, "DocumentsBucketName",
            value=documents_bucket.bucket_name,
            description="Documents S3 bucket"
        )
        CfnOutput(self, "UserPoolId",
            value=user_pool.user_pool_id,
            description="Cognito User Pool ID"
        )
        CfnOutput(self, "UserPoolClientId",
            value=user_pool_client.user_pool_client_id,
            description="Cognito Client ID"
        )
        CfnOutput(self, "ApiRepoUri",
            value=f"{self.account}.dkr.ecr.{self.region}.amazonaws.com/genese-proposal-ai-api",
            description="ECR repo for API image"
        )
        CfnOutput(self, "WorkerRepoUri",
            value=f"{self.account}.dkr.ecr.{self.region}.amazonaws.com/genese-proposal-ai-worker",
            description="ECR repo for Worker image"
        )
        CfnOutput(self, "DbSecretArn",
            value=db_secret.secret_arn,
            description="DB credentials secret ARN"
        )
        CfnOutput(self, "TavilySecretArn",
            value=tavily_secret.secret_arn,
            description="Tavily API key secret ARN"
        )
```

### IMPORTANT: Create ECR Repos Before First Deploy

The CDK stack uses `from_repository_name()` to reference existing ECR repos (avoids the "repo already exists" CFN conflict). You must create the repos **before** running `cdk deploy`:

```bash
aws ecr create-repository --repository-name genese-proposal-ai-api \
  --region us-east-1 2>/dev/null || echo "Already exists"
aws ecr create-repository --repository-name genese-proposal-ai-worker \
  --region us-east-1 2>/dev/null || echo "Already exists"
```

---
