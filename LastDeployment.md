# LastDeployment.md
## Genese Proposal AI — Complete Deployment Guide

---

## The 30-Second Version

```bash
git clone https://github.com/anbik-1/GenAI-Work-Part1.git
cd GenAI-Work-Part1/genese-proposal-ai
aws configure                      # needs AdministratorAccess
export TAVILY_API_KEY=tvly-xxx     # optional, from app.tavily.com
chmod +x deploy.sh
./deploy.sh
```

That's it. The script handles everything else. Read the rest of this document to understand exactly what it does and why.

---

## CDK vs CLI — The Core Concept

This app uses **both** CDK and CLI. This is not a limitation — it is the correct pattern.

```
CDK  = "build the stadium"
CLI  = "start the game inside it"
```

CDK manages **permanent infrastructure** — things that are stateful, expensive to recreate, and rarely change.  
CLI manages **runtime operations** — things that depend on code being ready, or that CloudFormation cannot reliably manage.

### What CDK deploys

| Resource | Why CDK |
|---|---|
| VPC (2 AZs, public + private, NAT) | Permanent network foundation |
| S3 — documents bucket | Stateful storage, needs lifecycle rules |
| S3 — frontend bucket | Stateful storage, CloudFront origin |
| CloudFront distribution | Permanent HTTPS endpoint |
| Cognito User Pool + App Client | Auth config, permanent |
| Aurora PostgreSQL Serverless v2 | Database, most expensive/critical resource |
| SQS queue + DLQ | Messaging infrastructure |
| ECR repositories (API + Worker) | Container registries |
| ECS Cluster | Container runtime host |
| ECS Task Definitions (API + Worker) | Task configs: image, CPU, RAM, env vars, IAM |
| ALB + Target Group + HTTP Listener | Load balancer wiring |
| IAM Task Role + Execution Role | Permissions for Bedrock, S3, SQS, Secrets |
| Secrets Manager (DB creds + Tavily) | Secrets storage |
| CloudWatch Log Groups | Observability |

### What CLI manages (after CDK)

| Step | Tool | Why not CDK |
|---|---|---|
| ECR repos | CLI (before CDK) | CDK references repos by name — must exist first |
| Docker images | CLI | CDK is not a build system |
| DB migration | CLI (ECS task) | Aurora is in private subnet — no direct access |
| ECS services | CLI | **CFN 3-hour stabilization timeout** — see below |
| CloudFront /api/* behavior | CLI | ALB DNS only known after CDK outputs |
| Frontend build + S3 sync | CLI | App code, not infrastructure |
| Cognito users | CLI | User data, not infrastructure |
| Seed documents | CLI (API calls) | Application data |

---

## Why ECS Services Are CLI — The Critical Lesson

This is the most important thing to understand about this deployment. **ECS services must never be in CDK/CloudFormation for this app.**

Here is what happened repeatedly during development:

1. ECS service added to CDK stack
2. `cdk deploy` runs → CloudFormation creates the ECS service
3. CFN enters a **"wait for stabilization" loop** — it waits for all ECS tasks to be running and healthy
4. ECS task fails to start (image not in ECR yet, or health check timing issue)
5. CFN keeps waiting... 10 min... 30 min... 1 hour...
6. After **3 hours**, CFN times out and **rolls back the entire stack**
7. This destroys Aurora, S3, Cognito, all other infra
8. Full redeploy required from scratch

**The fix:** Remove ECS services from CDK. CDK creates the cluster and task definitions. CLI creates the services after images are in ECR. CloudFormation never waits on ECS again.

```
CDK creates:   ECS Cluster + Task Definitions   ← "the blueprint"
CLI creates:   ECS Services                      ← "start the engine"
```

This is also the pattern recommended by AWS for CI/CD pipelines — deploy infrastructure with CDK, deploy services separately.

---

## Prerequisites

Install these on the machine you're deploying from:

```bash
# 1. Python 3.12+
python3 --version   # must be 3.12 or higher
# Install on Amazon Linux: sudo dnf install python3
# Install on macOS: brew install python3

# 2. Node.js 18+ (for frontend build)
node --version      # must be 18 or higher
# Install on Amazon Linux: sudo dnf install nodejs
# Install on macOS: brew install node

# 3. AWS CLI v2
aws --version
# Install: https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2.html

# 4. Docker (must be running, not just installed)
docker info         # must succeed
# Install on Amazon Linux: sudo dnf install docker && sudo systemctl start docker
# Install on macOS: https://www.docker.com/products/docker-desktop

# 5. CDK (installed automatically by deploy.sh if missing)
cdk --version
# Manual: pip install aws-cdk-lib constructs

# 6. AWS credentials with AdministratorAccess
aws configure
# Enter: AWS Access Key ID, Secret Access Key, Region (us-east-1), output (json)
# Verify: aws sts get-caller-identity
```

---

## Step-by-Step: What deploy.sh Does

### Step 1 — Check Prerequisites `[no AWS calls]`

Verifies all tools are installed and working before touching anything in AWS.  
Exits immediately with a clear error message if anything is missing.

```
Checks: python3, node, aws, docker, cdk, AWS credentials, project directory structure
```

---

### Step 2 — Create ECR Repositories `[CLI]`

```bash
aws ecr create-repository --repository-name genese-proposal-ai-api
aws ecr create-repository --repository-name genese-proposal-ai-worker
```

**Why before CDK:** The CDK stack uses `ecr.Repository.from_repository_name()` — it references repos that already exist rather than creating them. If the repos don't exist, `cdk synth` fails. So we create them first, then CDK just finds them.

**Idempotent:** Running again when repos exist does nothing (no error).

---

### Step 3 — CDK Bootstrap + Deploy `[CDK]`

```bash
cdk bootstrap aws://ACCOUNT/REGION   # one-time per account/region
cdk deploy --require-approval never   # deploys the full infrastructure stack
```

**Bootstrap** creates a CloudFormation stack called `CDKToolkit` in your account — an S3 bucket and IAM roles that CDK uses to store assets during deployment. Safe to re-run, idempotent.

**Deploy** runs `cdk synth` (generates CloudFormation template) then deploys it. Creates all the infrastructure listed in the CDK section above. Takes **10-15 minutes** — Aurora is the slowest resource.

**After deploy:** CloudFormation stack `GeneseProposalAIStack` shows `CREATE_COMPLETE` (or `UPDATE_COMPLETE` on re-run).

---

### Step 4 — Read CDK Outputs `[CLI]`

```bash
aws cloudformation describe-stacks --stack-name GeneseProposalAIStack \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue"
```

CDK writes all resource identifiers (URLs, ARNs, IDs, bucket names) as CloudFormation stack outputs. This step reads them all into shell variables so every subsequent step uses them without hardcoding.

Saved to `/tmp/genese_outputs.env` — you can `source` this file to get all variables in a new terminal:

```bash
source /tmp/genese_outputs.env
echo $API_URL      # http://Genese-ApiLB-xxx.us-east-1.elb.amazonaws.com
echo $CF_URL       # https://dxxxx.cloudfront.net
```

---

### Step 5 — Tavily API Key `[CLI]`

```bash
aws secretsmanager put-secret-value \
  --secret-id $TAVILY_SECRET_ARN \
  --secret-string '{"api_key":"tvly-xxx"}'
```

CDK created the secret with a placeholder value. This step puts the real key in.

**Tavily is optional.** If not set, proposal generation still works — it just skips the live AWS/GCP documentation validation step. Set it for better architecture accuracy.

**Get a free key** (1,000 req/month, no credit card): https://app.tavily.com

---

### Step 6 — Build and Push Docker Images `[CLI]`

```bash
# Authenticate
aws ecr get-login-password | docker login --username AWS --password-stdin ACCOUNT.dkr.ecr.REGION.amazonaws.com

# API image: FastAPI server
docker build -t genese-api -f services/api/Dockerfile services/
docker push API_REPO_URI:latest

# Worker image: LangChain + Bedrock
docker build -t genese-worker -f services/worker/Dockerfile services/
docker push WORKER_REPO_URI:latest
```

**Two images, same build context (`services/`):**
- `services/api/Dockerfile` — FastAPI, handles HTTP requests, 0.5 vCPU / 1GB RAM
- `services/worker/Dockerfile` — LangChain worker, handles LLM jobs, 1 vCPU / 2GB RAM. Includes `apt-get install graphviz` for architecture diagram rendering.

**Why images must be pushed BEFORE ECS services are created (Step 8):** If ECS tries to pull an image that doesn't exist in ECR, the task fails to start. The service enters a crash loop. By pushing images first, services start cleanly on first try.

---

### Step 7 — Database Migration `[CLI: one-off ECS Fargate task]`

```bash
# Upload migration script to S3
aws s3 cp /tmp/db_migrate.py s3://DOCS_BUCKET/scripts/db_migrate.py

# Run as one-off ECS task inside the VPC
aws ecs run-task \
  --cluster genese-proposal-ai \
  --task-definition WORKER_TD \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[PRIV_SUBNET],securityGroups=[WORKER_SG],...}" \
  --overrides '{"containerOverrides":[{"name":"Worker","command":["python3","..."]}]}'
```

**Why an ECS task and not a direct connection:** Aurora PostgreSQL is in a **private subnet** with no public IP. You cannot connect to it from your laptop or from outside the VPC. The solution: launch a temporary Fargate task inside the same VPC, let it connect to Aurora privately, run the migration, then exit.

**What the migration creates:**
```sql
CREATE EXTENSION IF NOT EXISTS vector;          -- pgvector extension

CREATE TABLE users (...);                        -- Cognito user records
CREATE TABLE documents (...);                    -- Uploaded files + status + tokens
CREATE TABLE document_chunks (                   -- Text chunks + 1024-dim embeddings
    embedding vector(1024), ...);
CREATE INDEX idx_chunks_embedding                -- ivfflat cosine similarity index
    ON document_chunks USING ivfflat (...);
CREATE TABLE generation_jobs (...);              -- Job tracking + arch diagram + tokens
```

Script waits 90 seconds for the task to complete, then checks exit code.

---

### Step 8 — Create ECS Services `[CLI — never CDK]`

```bash
# API service — attached to ALB Target Group
aws ecs create-service \
  --service-name genese-api-service \
  --task-definition API_TD \
  --load-balancers "targetGroupArn=TG_ARN,containerName=Api,containerPort=8000" \
  --health-check-grace-period-seconds 60 \
  ...

# Worker service — no ALB, polls SQS
aws ecs create-service \
  --service-name genese-worker-service \
  --task-definition WORKER_TD \
  ...
```

**On re-run:** If services already exist, registers a new task definition revision (picks up new image) and calls `update-service` with `maximumPercent=200, minimumHealthyPercent=100` — this is a **rolling zero-downtime deployment**.

**Why `maximumPercent=200, minimumHealthyPercent=100`:** During a rolling update, ECS starts a new task before stopping the old one. At peak there are 2 tasks (200%). At minimum there is always 1 running (100%). Zero downtime.

**Waits for:** Both services to reach `runningCount=1` before moving on (polls every 20s, up to 5 min).

---

### Step 9 — CloudFront /api/* Proxy `[CLI]`

```bash
# Create StripApiPrefix edge function
aws cloudfront create-function --name StripApiPrefix \
  --function-code fileb:///tmp/cf_func.js

# Update CloudFront distribution: add ALB origin + /api/* cache behavior
aws cloudfront update-distribution --id CF_ID \
  --distribution-config file:///tmp/cf_updated.json
```

**The problem it solves:** The frontend is served over HTTPS from CloudFront. If the browser tries to call `http://alb-domain/generate` directly, browsers block it as "mixed content" (HTTPS page → HTTP request). To fix this, all API calls go through CloudFront at `/api/*`.

**How it works:**
```
Browser: https://cf-domain/api/generate
  → CloudFront sees /api/* → route to ALB origin
  → StripApiPrefix function runs: /api/generate → /generate
  → ALB receives: http://alb/generate
  → ECS API task handles it
```

**StripApiPrefix** is a CloudFront Function (not Lambda) — runs at the CDN edge in <1ms, strips the `/api` prefix before the request reaches the ALB.

**Idempotent:** Checks if `/api/*` behavior already exists before adding it.

---

### Step 10 — Build and Deploy Frontend `[CLI]`

```bash
cd frontend
VITE_API_URL="/api" npm run build
aws s3 sync dist/ s3://FRONTEND_BUCKET/ --delete
aws cloudfront create-invalidation --paths "/*"
```

Builds the React app with Vite. `VITE_API_URL="/api"` means all API calls use a relative path — no hardcoded domains. Works regardless of which CloudFront URL is assigned.

`--delete` removes files from S3 that no longer exist in the build (important for clean deploys).

CloudFront invalidation clears cached copies at the CDN edge so users immediately get the new version.

---

### Step 11 — Create Cognito Admin User `[CLI]`

```bash
aws cognito-idp admin-create-user --username admin@company.com ...
aws cognito-idp admin-set-user-password --password "..." --permanent
```

`admin-set-user-password --permanent` is important: without `--permanent`, Cognito puts the user in `FORCE_CHANGE_PASSWORD` state and login fails until they change it. The `--permanent` flag bypasses this.

---

### Step 12 — Seed Documents `[CLI: API calls]`

Uploads 10 synthetic documents (proposals, SoWs, case studies) via the `/documents/upload` API endpoint. Worker picks them up from SQS, indexes them into pgvector.

**For production:** replace synthetic docs with your real Genese proposals. Better RAG context = better generated proposals.

---

### Step 13 — Verify `[CHECK]`

Three checks:
1. `GET /health` on ALB → `{"status":"healthy"}`
2. `GET /` on CloudFront → HTTP 200
3. `POST /api/auth/login` through CloudFront → returns `idToken`

If check 3 fails with "CloudFront may still be deploying" — wait 2-3 minutes and check manually. CloudFront propagation takes time.

---

## When to Re-run deploy.sh

The script is **fully idempotent** — safe to run anytime.

| Scenario | What to do |
|---|---|
| First deployment | `./deploy.sh` |
| Changed API/Worker code | `./deploy.sh` (rebuilds images, rolling ECS update) |
| Changed frontend code | `./deploy.sh` (rebuilds, re-syncs S3, invalidates CDN) |
| Changed CDK infrastructure | `./deploy.sh` (CDK deploy detects diff, updates only changed resources) |
| Adding Tavily key | `export TAVILY_API_KEY=xxx && ./deploy.sh` |
| New environment (new AWS account) | `aws configure` + `./deploy.sh` |

---

## When to Run Individual CLI Commands (Not the Full Script)

Sometimes you only need to do one thing:

### Push a code change quickly
```bash
source /tmp/genese_outputs.env    # get saved variables

# API only
docker build -t genese-api -f services/api/Dockerfile services/
docker tag genese-api:latest $API_REPO_URI:latest
docker push $API_REPO_URI:latest

# Register new task def + rolling update
CURR_TD=$(aws ecs describe-services --cluster genese-proposal-ai \
  --services genese-api-service --region us-east-1 \
  --query 'services[0].taskDefinition' --output text)
TD_JSON=$(aws ecs describe-task-definition --task-definition "$CURR_TD" \
  --region us-east-1 --query 'taskDefinition' --output json | \
  python3 -c "import sys,json;td=json.load(sys.stdin);print(json.dumps({k:td[k] for k in ['family','networkMode','containerDefinitions','requiresCompatibilities','cpu','memory','taskRoleArn','executionRoleArn']}))")
echo $TD_JSON > /tmp/new_td.json
NEW_ARN=$(aws ecs register-task-definition --cli-input-json file:///tmp/new_td.json \
  --region us-east-1 --query 'taskDefinition.taskDefinitionArn' --output text)
aws ecs update-service --cluster genese-proposal-ai --service genese-api-service \
  --task-definition $NEW_ARN \
  --deployment-configuration "maximumPercent=200,minimumHealthyPercent=100" \
  --region us-east-1
```

### Frontend only
```bash
source /tmp/genese_outputs.env
cd frontend && VITE_API_URL="/api" npm run build
aws s3 sync dist/ s3://$CF_FRONTEND_BUCKET/ --delete --region us-east-1
aws cloudfront create-invalidation --distribution-id $CF_DIST_ID --paths "/*"
```

### Add a Cognito user
```bash
aws cognito-idp admin-create-user \
  --user-pool-id USER_POOL_ID \
  --username email@company.com \
  --temporary-password "Temp1234!" \
  --message-action SUPPRESS \
  --user-attributes Name=email,Value=email@company.com Name=name,Value="Full Name"

aws cognito-idp admin-set-user-password \
  --user-pool-id USER_POOL_ID \
  --username email@company.com \
  --password "YourPassword123!" \
  --permanent
```

### Check ECS service health
```bash
aws ecs describe-services --cluster genese-proposal-ai \
  --services genese-api-service genese-worker-service \
  --region us-east-1 \
  --query 'services[*].{name:serviceName,running:runningCount,desired:desiredCount,status:status}'
```

### View live logs
```bash
# API logs
aws logs tail /genese/api --follow --region us-east-1

# Worker logs
aws logs tail /genese/worker --follow --region us-east-1
```

---

## Teardown (Delete Everything)

```bash
# 1. Scale services to 0 (drain tasks)
aws ecs update-service --cluster genese-proposal-ai --service genese-api-service \
  --desired-count 0 --region us-east-1
aws ecs update-service --cluster genese-proposal-ai --service genese-worker-service \
  --desired-count 0 --region us-east-1
sleep 30

# 2. Delete services
aws ecs delete-service --cluster genese-proposal-ai --service genese-api-service --region us-east-1
aws ecs delete-service --cluster genese-proposal-ai --service genese-worker-service --region us-east-1

# 3. Delete ECR images (required — CDK can't delete non-empty repos)
aws ecr batch-delete-image --repository-name genese-proposal-ai-api \
  --image-ids imageTag=latest --region us-east-1
aws ecr batch-delete-image --repository-name genese-proposal-ai-worker \
  --image-ids imageTag=latest --region us-east-1

# 4. CDK destroy (deletes all infrastructure)
cd infrastructure && cdk destroy --all
```

---

## Troubleshooting

| Problem | Likely cause | Fix |
|---|---|---|
| `cdk deploy` hangs for hours | ECS service in CDK | Remove ECS from CDK — use CLI (see Step 8) |
| `MasterUserPassword invalid` | Forbidden chars (`/`, `@`) in DB password | Check `exclude_characters` in CDK secret |
| ALB returns 503 | ECS task not running | Check `runningCount`: `aws ecs describe-services ...` |
| Browser `NetworkError` | HTTPS→HTTP mixed content | Ensure CloudFront /api/* behavior is configured |
| Document stuck `pending` | SQS race condition | Ensure DB commit before SQS publish in API code |
| `@router.get` decorator missing | strReplace removed it | Check all route decorators after editing routers |
| Tavily `Expecting value` error | Key stored as JSON, read as plain string | Handle both JSON `{"api_key":"x"}` and plain string |
| `temperature + top_p` error | Claude rejects both together | Remove `top_p` from model kwargs |
| Old code still running after push | Task def not updated | Register new TD revision + update-service |
| Login returns `FORCE_CHANGE_PASSWORD` | User created without `--permanent` | Run `admin-set-user-password --permanent` |
| CloudFront returns old frontend | Cache not invalidated | `aws cloudfront create-invalidation --paths "/*"` |

---

*End of LastDeployment.md*
