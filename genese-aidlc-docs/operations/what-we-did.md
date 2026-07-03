# What We Did — Operations Work on Genese Proposal AI

Everything below happened during development but falls squarely under the Operations phase. Documented here so it is traceable and reproducible.

---

## 1. Deployment

### Infrastructure Provisioned via CDK
- VPC (2 AZ, public + private, 1 NAT gateway)
- S3 (documents bucket + frontend bucket)
- CloudFront distribution (HTTPS, SPA hosting)
- Cognito User Pool + App Client
- Aurora PostgreSQL Serverless v2 (pgvector)
- SQS queue + Dead Letter Queue
- ECR repositories (API + Worker)
- ECS Cluster + Task Definitions (API + Worker)
- ALB + Target Group + HTTP Listener
- IAM roles (Task Role, Execution Role)
- Secrets Manager (DB credentials, Tavily key)
- CloudWatch Log Groups

### Services Created via CLI (not CDK — by design)
- `genese-api-service` — ECS Fargate, 1 task, attached to ALB
- `genese-worker-service` — ECS Fargate, 1 task, SQS consumer

**Why CLI:** CloudFormation's ECS stabilization wait caused repeated 3-hour timeouts and full stack rollbacks during development. Moved ECS services to CLI permanently.

### Post-CDK CLI Operations
- Added CloudFront `/api/*` cache behavior (ALB origin + StripApiPrefix function)
- Built and pushed Docker images to ECR (API + Worker)
- Ran DB migration as one-off ECS Fargate task (Aurora is in private subnet)
- Created Cognito demo user (`demo@genesesolution.com`)
- Seeded 10 synthetic documents into pgvector knowledge base
- Built and synced React frontend to S3
- Invalidated CloudFront cache after each frontend deploy

### Deployment Artifact
- `deploy.sh` — 970-line idempotent bash script, handles all 13 deployment steps
- `LastDeployment.md` — full written guide explaining every step and all CDK/CLI decisions

---

## 2. Incident Response and Root Cause Analysis

Every issue below was found in production (live on AWS), root-caused, and fixed.

### RCA-01: CFN ECS Stabilization Timeout
- **Symptom:** `cdk deploy` hung for 3 hours then rolled back the entire stack
- **Root cause:** CloudFormation waits for ECS service "steady state" — tasks must be running and health-check passing. If anything is slow, CFN waits up to 3 hours then destroys everything.
- **Fix:** Removed ECS services from CDK. Created via CLI after images are in ECR.
- **Impact:** Prevented multiple full-redeploy cycles.

### RCA-02: Aurora Password Forbidden Characters
- **Symptom:** Aurora cluster failed to create — `MasterUserPassword` validation error
- **Root cause:** CDK's auto-generated password contained `/`, `@`, `"` — all forbidden in Aurora RDS passwords
- **Fix:** Added `exclude_characters: "/@\"'\\ "` to the Secrets Manager secret in CDK

### RCA-03: Mixed Content HTTPS → HTTP
- **Symptom:** Browser blocked all API calls with `NetworkError`
- **Root cause:** Frontend served over HTTPS (CloudFront). API calls went to HTTP ALB directly. Browsers block mixed-content requests.
- **Fix:** CloudFront `/api/*` behavior proxies HTTPS → ALB over HTTP internally. Browser never sees HTTP.

### RCA-04: Cognito Login From Browser
- **Symptom:** Login failed — `NotAuthorizedException` from browser
- **Root cause:** `AdminInitiateAuth` requires server-side AWS credentials. Cannot be called from a browser.
- **Fix:** Backend `/auth/login` endpoint proxies to Cognito. Frontend only talks to its own API.

### RCA-05: pgvector SQL Syntax Conflict
- **Symptom:** `asyncpg` threw `SyntaxError` on vector similarity queries
- **Root cause:** `:embedding::vector` — asyncpg interprets `:param` as a bind variable and `::` as a cast, producing invalid SQL
- **Fix:** Serialize vector as Python list string and embed directly in f-string: `f"... <=> '{embedding_str}'::vector ..."`

### RCA-06: Embedding Dimension Mismatch
- **Symptom:** pgvector `INSERT` failed — dimension mismatch (1536 vs 1024)
- **Root cause:** Assumed Titan Text Embeddings v2 outputs 1536 dims (same as OpenAI). Actual output is 1024.
- **Fix:** Updated schema (`vector(1024)`), constants (`EMBEDDING_DIM = 1024`), and ORM model.

### RCA-07: Tavily Secret Format Mismatch
- **Symptom:** Worker crashed with `json.JSONDecodeError: Expecting value`
- **Root cause:** Code called `json.loads()` on the secret value, but the secret was stored as a plain string, not JSON.
- **Fix:** Added fallback — try JSON parse first, if it fails treat as plain string. Also handle placeholder values gracefully.

### RCA-08: Claude Rejects temperature + top_p Together
- **Symptom:** Bedrock returned `ValidationException` on every generation call
- **Root cause:** Claude models reject requests that set both `temperature` and `top_p` simultaneously
- **Fix:** Removed `top_p` from model kwargs. Keep only `temperature`.

### RCA-09: SQS Race Condition
- **Symptom:** Jobs submitted and immediately processed by worker — but worker found no DB record. Job silently dropped. Status stayed `queued` forever.
- **Root cause:** API published SQS message before the DB `INSERT` was committed. Worker received message, queried DB, found nothing.
- **Fix:** Commit DB transaction first, then publish to SQS. Two lines swapped.

### RCA-10: Missing `def main():` in Worker
- **Symptom:** Worker container started but immediately exited — no SQS polling
- **Root cause:** A `strReplace` edit accidentally removed the `def main():` function definition while editing the file above it
- **Fix:** Restored the function definition

### RCA-11: Missing `@router.get` Decorator
- **Symptom:** `GET /generate/{job_id}` returned 404 even though the function existed
- **Root cause:** A `strReplace` edit removed the `@router.get("/{job_id}")` decorator line above the function
- **Fix:** Restored the decorator. Happened on two separate routes (`get_job_status`, `get_architecture`).

### RCA-12: Missing `import json` in Orchestrator
- **Symptom:** Worker crashed with `NameError: name 'json' is not defined`
- **Root cause:** `json.dumps()` used in orchestrator but `import json` was never at the top
- **Fix:** Added `import json` to orchestrator.py imports

### RCA-13: Wrong Import Path for architecture_generator
- **Symptom:** Worker crashed with `ModuleNotFoundError`
- **Root cause:** Import path was `from .architecture_generator import ...` (relative to wrong package level)
- **Fix:** Changed to `from ..generation.architecture_generator import ...`

### RCA-14: PendingRollbackError on JSONB Update
- **Symptom:** Architecture diagram saved to S3 but DB update failed — `PendingRollbackError`
- **Root cause:** A previous failed SQL statement left the SQLAlchemy session in a broken transaction state. Subsequent raw SQL failed because the session was in rollback-required state. Also: `::jsonb` cast syntax fails with asyncpg bind params.
- **Fix:** Added `await db.rollback()` before the raw SQL execute. Changed `::jsonb` cast to `CAST(:x AS jsonb)`.

### RCA-15: `logger` Not Defined in Except Block
- **Symptom:** Worker crashed inside an exception handler with `NameError: name 'logger' is not defined`
- **Root cause:** `logger.info(...)` called in orchestrator but `logger` was never defined at module level
- **Fix:** Added `import logging; logger = logging.getLogger(__name__)` at top of orchestrator.py

### RCA-16: ECS Using Stale Docker Image
- **Symptom:** Code changes deployed but old behaviour persisted in production
- **Root cause:** ECS service continued running old task definition. Pushing a new image to ECR doesn't automatically restart tasks.
- **Fix:** After every image push: register a new task definition revision, then call `update-service` with the new revision ARN. ECS performs a rolling replacement.

---

## 3. Monitoring and Observability (What's in Place)

### Logging
- CloudWatch Log Groups: `/genese/api` and `/genese/worker`
- All ECS task stdout/stderr captured automatically
- View live: `aws logs tail /genese/worker --follow --region us-east-1`

### Job Status Tracking
- Every generation job has a `status` column updated at each pipeline stage:
  `queued → retrieving_context → validating_sources → drafting_document → generating_diagram → awaiting_review → formatting_output → complete`
- `error_message` column captures failure reason
- `status_detail` captures the current sub-step message shown in UI

### Token and Cost Tracking
- `input_tokens` and `output_tokens` columns on every job
- `embedding_tokens` on every document
- Cost calculated in UI: `$0.003/1K input, $0.015/1K output, $0.00002/1K embedding`

### Dead Letter Queue
- SQS DLQ configured with `maxReceiveCount=3`
- After 3 delivery failures, message goes to DLQ
- Check DLQ depth: `aws sqs get-queue-attributes --queue-url DLQ_URL --attribute-names ApproximateNumberOfMessages`

### What Is Not Yet in Place
- No CloudWatch Alarms (DLQ depth, ECS crash, Aurora CPU)
- No SNS notifications on failure
- No distributed tracing (X-Ray)
- No dashboard (CloudWatch or Grafana)

---

## 4. Maintenance Operations Performed

### Database Schema Migrations (ALTER TABLE)
All run as one-off ECS tasks inside the VPC:
```sql
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS llm_model VARCHAR(255);
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS input_tokens INTEGER DEFAULT 0;
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS output_tokens INTEGER DEFAULT 0;
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS arch_json JSONB;
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS arch_s3_key VARCHAR(1000);
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS arch_iteration INTEGER DEFAULT 0;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS ingestion_status VARCHAR(50) DEFAULT 'pending';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS embedding_model VARCHAR(255);
ALTER TABLE documents ADD COLUMN IF NOT EXISTS embedding_tokens INTEGER DEFAULT 0;
```

### ECS Service Rolling Updates
Performed on every code change:
1. Build new Docker image
2. Push to ECR
3. Register new task definition revision (same config, new image)
4. Call `update-service` with `maximumPercent=200, minimumHealthyPercent=100`
5. ECS starts new task, drains old task — zero downtime

### Data Seeding
- 10 synthetic documents ingested into pgvector knowledge base
- 34 total documents indexed as of last count

---

## 5. Production Readiness Checklist

Items intentionally deferred (app is in dev/demo phase):

| Item | Status | Action When Ready |
|---|---|---|
| `desiredCount=2` on both services | Not done | `aws ecs update-service --desired-count 2` |
| `RemovalPolicy.RETAIN` on Aurora + S3 | Not done | Update CDK, `cdk deploy` |
| Aurora PITR backups | Not done | Enable in RDS console or CDK |
| WAF on CloudFront | Not done | Add `aws-cdk-lib/aws-wafv2` to CDK |
| ACM cert on ALB (HTTPS end-to-end) | Not done | Add to CDK, update CloudFront to HTTPS origin |
| CORS locked to specific domain | Not done | Change `allow_origins=["*"]` in FastAPI |
| CloudWatch Alarms | Not done | DLQ depth, ECS crash, Aurora CPU |
| Secret rotation | Not done | Enable in Secrets Manager |
