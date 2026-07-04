# Genese Proposal AI — Deployment Guide

> **Last updated**: 2026-07-03  
> **Stack**: `GeneseProposalAIStack` (CREATE_COMPLETE)  
> **deploy.sh**: 627 lines, idempotent, covers all 13 deployment steps  

---

## Table of Contents

1. [What is CDK?](#1-what-is-cdk)
2. [What is the AWS CLI?](#2-what-is-the-aws-cli)
3. [Why This App Uses Both — The Fundamental Rule](#3-why-this-app-uses-both)
4. [What CDK Deploys vs What CLI Deploys](#4-what-cdk-deploys-vs-what-cli-deploys)
5. [Why ECS Services Must Never Be in CDK](#5-why-ecs-services-must-never-be-in-cdk)
6. [Prerequisites](#6-prerequisites)
7. [First-Time Deployment: Quick Start](#7-first-time-deployment-quick-start)
8. [The 13 Deployment Steps Explained](#8-the-13-deployment-steps-explained)
9. [CDK Stack Outputs Reference](#9-cdk-stack-outputs-reference)
10. [Environment Variables in ECS](#10-environment-variables-in-ecs)
11. [Database Migration Details](#11-database-migration-details)
12. [Rolling Updates (Code Changes)](#12-rolling-updates-code-changes)
13. [Current Live State](#13-current-live-state)
14. [Production Hardening Checklist](#14-production-hardening-checklist)
15. [Troubleshooting](#15-troubleshooting)

---

## 1. What is CDK?

**AWS CDK (Cloud Development Kit)** is a framework for defining cloud infrastructure as code using a real programming language (Python, TypeScript, Java, etc.). You write Python classes; CDK synthesizes them into a CloudFormation template; CloudFormation provisions the actual AWS resources.

CDK is declarative for infrastructure. You describe *what* you want — a VPC, an Aurora cluster, an S3 bucket — and CDK figures out the creation order, dependencies, and update logic. If you re-run CDK after changing a property, it computes the diff and applies only the changes.

```
Your Python code (genese_stack.py)
        ↓  cdk synth
CloudFormation template (.json)
        ↓  cdk deploy
AWS Resources (VPC, S3, Aurora, ...)
```

CDK is the right tool for resources that are:
- **Permanent** — Aurora, S3, Cognito (you don't want these deleted accidentally)
- **Stateful** — databases hold data; buckets hold files
- **Rarely change** — VPC subnets, IAM roles, security groups don't change per-deployment
- **Interdependent** — CDK resolves dependencies (e.g., the Task Definition needs the ECR repo ARN, the IAM role needs the S3 bucket ARN)

In this project, CDK lives in `infrastructure/` and is a single stack: `GeneseProposalAIStack` in `infrastructure/stacks/genese_stack.py`.

---

## 2. What is the AWS CLI?

**AWS CLI (Command Line Interface)** is a tool for issuing imperative commands to AWS APIs directly from a shell. Unlike CDK, it does not maintain state or track what already exists. Each command does exactly what you tell it to, right now.

```bash
aws ecs create-service --cluster genese-proposal-ai --service-name genese-api-service ...
aws s3 sync ./dist s3://genese-proposal-ai-frontend-123456789-us-east-1/
aws cloudfront create-invalidation --distribution-id ABCDEF --paths "/*"
```

CLI is the right tool for operations that are:
- **Imperative** — "run this task now", "push this image", "sync these files"
- **Order-dependent** — must happen after other things are ready
- **Not tracked by CloudFormation** — runtime operations, not infrastructure state
- **Build-system tasks** — Docker builds, npm builds, file uploads

---

## 3. Why This App Uses Both — The Fundamental Rule

**Using both CDK and CLI is intentional design, not a workaround.**

The mental model is:

> **CDK owns the skeleton. CLI puts the flesh on it.**

CDK creates all permanent AWS resources — the VPC, the database, the load balancer, the cluster, the task definitions. These are the bones of the system. They change rarely and must survive reboots, redeployments, and code changes.

CLI performs all the runtime operations that happen *on top of* that infrastructure — building and pushing Docker images, running database migrations, starting ECS services, syncing the frontend. These operations depend on the infrastructure existing first, and some depend on outputs from CDK (like the ALB DNS name) that aren't known until after CDK completes.

There are also cases where CloudFormation's behavior is actively harmful and CLI is the only safe alternative. The most important case is ECS services — explained in full in [Section 5](#5-why-ecs-services-must-never-be-in-cdk).

---

## 4. What CDK Deploys vs What CLI Deploys

### CDK-managed resources (infrastructure/stacks/genese_stack.py)

| Resource | Name / Identifier | Notes |
|----------|-------------------|-------|
| VPC | `GeneseProposalAIStack/Vpc` | 2 AZs, public + private subnets, 1 NAT gateway |
| S3 — Documents | `genese-proposal-ai-docs-{account}-{region}` | Private, no public access; lifecycle rule archives `generated/` after 30 days |
| S3 — Frontend | `genese-proposal-ai-frontend-{account}-{region}` | Private; CloudFront serves files via OAC |
| CloudFront Distribution | Auto-generated domain | Default behavior: S3 frontend; `/api/*` behavior added by CLI (Step 9) |
| Cognito User Pool | `genese-proposal-ai` | Email sign-in, self-signup disabled (internal tool) |
| Cognito App Client | `genese-web-client` | No secret; supports USER_SRP_AUTH, USER_PASSWORD_AUTH |
| Aurora PostgreSQL Serverless v2 | Cluster in private subnet | Engine: 16.4, 0.5–4 ACU, pgvector enabled via migration |
| Aurora Security Group | `DbSG` | Ingress from ApiSG:5432 and WorkerSG:5432 only |
| SQS Queue | `genese-generation-jobs` | Visibility timeout 600s, 4-day retention |
| SQS Dead Letter Queue | `genese-generation-jobs-dlq` | 14-day retention, max receive count 3 |
| ECR Repository — API | `genese-proposal-ai-api` | Referenced with `from_repository_name` (must pre-exist) |
| ECR Repository — Worker | `genese-proposal-ai-worker` | Referenced with `from_repository_name` (must pre-exist) |
| ECS Cluster | `genese-proposal-ai` | Fargate only, no EC2 capacity |
| ECS Task Definition — API | `ApiTask` | 0.5 vCPU / 1 GB RAM, port 8000, health check on `/health` |
| ECS Task Definition — Worker | `WorkerTask` | 1 vCPU / 2 GB RAM, no port mapping |
| ALB | `ApiLB` | Internet-facing, HTTP:80 listener |
| ALB Target Group | `ApiTG` | IP target type, port 8000, health check `/health` |
| IAM Task Role | Auto-generated | Grants: S3 read/write, SQS send/receive, Secrets Manager read, Bedrock full access |
| IAM Execution Role | Auto-generated | Grants: ECR pull, CloudWatch Logs write |
| Secrets Manager — DB | `/genese/db-credentials` | Auto-generated 32-char password |
| Secrets Manager — Tavily | `/genese/tavily-api-key` | Placeholder; real key set in Step 5 |
| CloudWatch Log Groups | `/ecs/genese-api`, `/ecs/genese-worker` | Retention: not set (configure for production) |

### CLI-managed operations (deploy.sh)

| Step | What | Why CLI and not CDK |
|------|------|---------------------|
| Step 2 | Create ECR repositories | CDK uses `from_repository_name()` — repos **must exist before CDK runs**. If CDK tried to create them, a chicken-and-egg problem: CDK synth references the repo, but the repo doesn't exist yet |
| Step 5 | Set Tavily API key in Secrets Manager | CDK creates the secret with a placeholder. The real key is an operational secret, not infrastructure config |
| Step 6 | Build Docker images + push to ECR | CDK is not a build system. `docker build` + `docker push` are imperative build operations |
| Step 7 | Run DB migration (one-off Fargate task) | Aurora is in a private subnet — unreachable from outside the VPC. Must run inside VPC as a Fargate task |
| **Step 8** | **Create ECS services** | **CloudFormation ECS stabilization timeout destroys the entire stack — see Section 5** |
| Step 9 | Add CloudFront `/api/*` behavior | ALB DNS name only known after CDK outputs. Chicken-and-egg with CDK ordering |
| Step 10 | Build React frontend + sync to S3 | `npm run build` + `aws s3 sync` are build + file operations, not infrastructure |
| Step 11 | Create Cognito admin user | Runtime operation; users are not infrastructure |
| Step 12 | Seed knowledge base documents | Optional runtime operation; content is not infrastructure |

---

## 5. Why ECS Services Must Never Be in CDK

This is the single most important architectural decision in the deployment pipeline. It was learned through repeated failure.

### What happens when ECS services are in CloudFormation

When CloudFormation creates an ECS service, it enters a **stabilization wait loop**:

```
CFN creates ECS service
  → ECS tries to start task
  → Task pulls image from ECR
  → Container starts
  → ALB health check polls /health every 30s
  → Target group must register task as healthy
  → CFN waits for runningCount == desiredCount
     ... waiting ...
     ... waiting ...
     ... timeout after up to 3 HOURS ...
  → CFN declares failure
  → CFN ROLLS BACK THE ENTIRE STACK
     → Aurora cluster DELETED
     → S3 buckets DELETED
     → Cognito User Pool DELETED
     → All infrastructure GONE
```

This happened repeatedly during development of this application. The root causes:

1. **Image not in ECR yet**: If CDK creates the ECR repo and the ECS service in the same deployment, the Docker image hasn't been built or pushed yet. ECS tries to pull `genese-api:latest`, gets an image-not-found error, the task fails, and CloudFormation eventually times out.

2. **Health check timing**: Even when the image exists, if the container takes longer than expected to start (e.g., Aurora is still warming up, pgvector extension load is slow), health checks fail during the grace period window, tasks are replaced, the service never stabilizes, and CloudFormation times out.

3. **No partial rollback**: CloudFormation has no concept of "roll back only the ECS service". It's all-or-nothing. A failed ECS service rollback destroys everything in the stack, including Aurora (with `RemovalPolicy.DESTROY` currently set).

### The fix

CDK creates:
- The ECS **cluster** (no blocking wait)
- The ECS **task definitions** (no blocking wait — just registers JSON with ECS)

CLI creates (in Step 8, after images are in ECR):
- The ECS **services** (CLI returns immediately; ECS stabilization happens in the background)

CloudFormation never blocks on ECS service health again. If an ECS service fails to start, only the service is affected — Aurora, S3, Cognito, and all other infrastructure are untouched.

```
CDK deploys:          cluster + task definitions  (no wait)
CLI Step 6:           push images to ECR
CLI Step 8:           create ECS services         (no CFN involvement)
ECS (background):     start tasks, pass health checks
```

### The deploy.sh idempotency guarantee

Because `deploy.sh` checks service status before creating or updating, re-running the script on an environment where services already exist performs a **rolling update** instead of a create:

```bash
# If service exists: update task definition + rolling deploy
aws ecs update-service \
  --cluster genese-proposal-ai \
  --service genese-api-service \
  --task-definition "$NEW_API_ARN" \
  --deployment-configuration "maximumPercent=200,minimumHealthyPercent=100"

# If service is new: create it
aws ecs create-service \
  --cluster genese-proposal-ai \
  --service-name genese-api-service \
  --task-definition "$API_TD" \
  --desired-count 1 \
  ...
```

`maximumPercent=200, minimumHealthyPercent=100` means ECS starts the new task before stopping the old one — zero-downtime rolling deploy.

---

## 6. Prerequisites

All prerequisites are checked automatically by Step 1 of `deploy.sh`. Manual installation instructions are below for each.

| Tool | Required Version | Check | Install |
|------|-----------------|-------|---------|
| Python 3 | 3.12+ | `python3 --version` | `sudo dnf install python3` (Amazon Linux) |
| Node.js | 18+ | `node --version` | `sudo dnf install nodejs` or [nodejs.org](https://nodejs.org) |
| AWS CLI | v2 | `aws --version` | [AWS CLI install guide](https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2.html) |
| Docker | Any recent | `docker info` | `sudo dnf install docker && sudo systemctl start docker` |
| CDK | Any recent | `cdk --version` | Installed automatically by `deploy.sh` if missing |
| AWS credentials | AdministratorAccess | `aws sts get-caller-identity` | `aws configure` |

### AWS IAM permissions required

The IAM user or role running `deploy.sh` needs `AdministratorAccess`. This is because the deployment:
- Creates IAM roles (requires `iam:CreateRole`, `iam:PassRole`)
- Creates a CDK bootstrap stack (requires broad permissions)
- Creates resources across 10+ AWS services

For a production environment, scope the permissions down to the exact services used. For development and first-time deployment, AdministratorAccess is the practical choice.

---

## 7. First-Time Deployment: Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/anbik-1/GenAI-Work-Part1.git
cd GenAI-Work-Part1/genese-proposal-ai

# 2. Configure AWS credentials
aws configure
# Enter: Access Key ID, Secret Access Key, Region (us-east-1), output format (json)

# 3. (Optional) Set Tavily API key for live web search during generation
#    Free tier: 1000 requests/month — get key at https://app.tavily.com
export TAVILY_API_KEY=tvly-xxxxxxxxxxxxxxxx

# 4. (Optional) Override default admin credentials
export ADMIN_EMAIL="admin@yourcompany.com"
export ADMIN_PASSWORD="YourPassword123!"

# 5. Run the deployment
chmod +x deploy.sh
./deploy.sh
```

Total time: **20–30 minutes** on first run (Aurora provisioning is the bottleneck at 10–15 min).

On success, the script prints:

```
╔══════════════════════════════════════════════════════════╗
║        GENESE PROPOSAL AI — DEPLOYMENT COMPLETE          ║
╚══════════════════════════════════════════════════════════╝

  Frontend URL:    https://xxxx.cloudfront.net
  API (internal):  http://xxxx.us-east-1.elb.amazonaws.com
  Admin Login:     admin@genesesolution.com  /  GeneseAdmin123!
```

Open the Frontend URL in a browser and log in.

### Re-running after code changes

`deploy.sh` is **idempotent** — safe to re-run at any time. On subsequent runs:
- CDK detects no infrastructure changes and skips or fast-updates
- Docker images are rebuilt and pushed
- ECS services receive a rolling update with the new images
- The frontend is re-built and re-synced to S3
- ECR repo creation, DB migration, Cognito user creation, and seed docs are all skipped if already done

```bash
# After changing backend code:
./deploy.sh

# After changing only frontend code — same command, same result:
./deploy.sh
```


---

## 8. The 13 Deployment Steps Explained

`deploy.sh` executes these steps in sequence. Each step is explained with the exact commands it runs and the reasoning behind every decision.

---

### Step 1 — Check Prerequisites `[TOOL]`

Verifies that all required tools are installed and that AWS credentials are valid. No AWS API calls yet.

```bash
python3 --version          # must be 3.x
node --version             # must be 18+
aws --version              # must be v2
docker info                # must be running (not just installed)
cdk --version              # auto-installed via pip if missing
aws sts get-caller-identity  # validates credentials + prints account/ARN
```

Also checks that the working directory contains `infrastructure/app.py`, `services/api/`, `services/worker/`, and `frontend/`.

**Why check Docker is running, not just installed**: `docker info` fails if the daemon isn't started. `docker build` later would fail with a confusing error. Early detection here gives a clear message: `sudo systemctl start docker`.

---

### Step 2 — Create ECR Repositories `[CLI]`

```bash
aws ecr create-repository --repository-name genese-proposal-ai-api   --region us-east-1
aws ecr create-repository --repository-name genese-proposal-ai-worker --region us-east-1
```

Two ECR repositories are created before CDK runs:
- `genese-proposal-ai-api` — stores API service images
- `genese-proposal-ai-worker` — stores Worker service images

**Why CLI and not CDK**: The CDK stack references both repos using `ecr.Repository.from_repository_name()`. This method looks up an existing repository by name at synth time. If the repos don't exist when `cdk deploy` runs, the lookup succeeds (CDK doesn't validate existence at synth) but the resulting CloudFormation resources reference repos that don't exist — causing failures when ECS tries to pull images.

Creating them first via CLI, then having CDK reference them, is a clean separation: CDK manages infrastructure around the repos (task definitions, IAM grants), and CLI manages the repos themselves and their contents (images).

If the repos already exist (re-run scenario), the CLI command returns an `RepositoryAlreadyExistsException` which is caught and silently skipped.

---

### Step 3 — CDK Bootstrap + Deploy `[CDK]`

```bash
cd infrastructure
pip install -r requirements.txt -q

# Bootstrap (one-time per account/region — safe to re-run)
cdk bootstrap aws://$ACCOUNT/$REGION

# Deploy everything
cdk deploy --require-approval never
```

**CDK bootstrap** creates a CloudFormation stack called `CDKToolkit` in the account. It provisions an S3 bucket and ECR repository that CDK uses to stage assets (Lambda code, Docker images used by CDK constructs) before deploying your stacks. Bootstrap is idempotent — re-running it on an already-bootstrapped account/region is a no-op.

**`cdk deploy --require-approval never`** synthesizes the stack to a CloudFormation template and calls `cloudformation:CreateStack` or `cloudformation:UpdateStack`. CloudFormation then provisions all resources in dependency order.

Resources deployed by CDK (in approximate CloudFormation creation order):

```
VPC + subnets + route tables + NAT gateway + internet gateway
  ↓
Security groups (DbSG, ApiSG, WorkerSG, AlbSG)
  ↓
Secrets Manager (DbSecret, TavilySecret)
  ↓
Aurora cluster + writer instance  ← slowest: 8-12 minutes
  ↓
S3 buckets (Documents, Frontend)
  ↓
Cognito User Pool + App Client
  ↓
SQS Queue + DLQ
  ↓
ECS Cluster
  ↓
IAM Task Role + Execution Role
  ↓
CloudWatch Log Groups
  ↓
ECS Task Definitions (ApiTask, WorkerTask)
  ↓
ALB + Target Group + Listener
  ↓
CloudFront Distribution (S3 origin only — /api/* added in Step 9)
  ↓
CloudFormation Outputs (URLs, ARNs, IDs)
```

**Why Aurora takes so long**: Aurora Serverless v2 must provision the underlying compute, initialize the PostgreSQL engine, apply parameter groups, and run health checks before CloudFormation marks it `CREATE_COMPLETE`. The 0.5 ACU minimum capacity also means cold start from zero requires extra initialization time.

**Expected duration**: 10–15 minutes total, dominated by Aurora.

---

### Step 4 — Parse CDK Stack Outputs `[CLI]`

```bash
get_output() {
  aws cloudformation describe-stacks \
    --stack-name GeneseProposalAIStack \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" \
    --output text
}

API_URL=$(get_output "ApiUrl")
CF_URL=$(get_output "CloudFrontUrl")
CF_FRONTEND_BUCKET=$(get_output "FrontendBucketName")
CF_DOCS_BUCKET=$(get_output "DocumentsBucketName")
USER_POOL_ID=$(get_output "UserPoolId")
USER_POOL_CLIENT_ID=$(get_output "UserPoolClientId")
API_REPO_URI=$(get_output "ApiRepoUri")
WORKER_REPO_URI=$(get_output "WorkerRepoUri")
DB_SECRET_ARN=$(get_output "DbSecretArn")
TAVILY_SECRET_ARN=$(get_output "TavilySecretArn")
TARGET_GROUP_ARN=$(get_output "TargetGroupArn")
ALB_DNS=$(echo "$API_URL" | sed 's|http://||')
```

CDK writes all resource identifiers as CloudFormation stack outputs. This step reads them all into shell variables. Every subsequent step uses these variables — no hardcoded ARNs, URLs, or IDs anywhere in the script.

All outputs are also saved to `/tmp/genese_outputs.env`. You can `source /tmp/genese_outputs.env` in a new terminal session to get all variables without re-running the script.

---

### Step 5 — Set Tavily API Key `[CLI]`

```bash
aws secretsmanager put-secret-value \
  --secret-id "$TAVILY_SECRET_ARN" \
  --secret-string "{\"api_key\":\"$TAVILY_API_KEY\"}" \
  --region us-east-1
```

CDK created the Secrets Manager secret `/genese/tavily-api-key` with a placeholder value (`REPLACE_WITH_TAVILY_KEY`). This step replaces the placeholder with the real key.

**Why the secret exists at all in CDK**: The ECS task definition references `TAVILY_SECRET_ARN` as an environment variable. The secret ARN must be known at CDK deploy time (so it can be injected into the task definition). CDK creates the secret with a dummy value, and this step fills in the real value.

**Tavily is optional**: The Worker service's `redis_cache.py` and Tavily client both degrade gracefully when the key is invalid or missing. Proposal generation still works without Tavily — it just won't include live web references. Get a free key (1000 requests/month) at [app.tavily.com](https://app.tavily.com).

To add the key after initial deployment:

```bash
export TAVILY_API_KEY=tvly-xxxxxxxxxxxxxxxx
aws secretsmanager put-secret-value \
  --secret-id /genese/tavily-api-key \
  --secret-string "{\"api_key\":\"$TAVILY_API_KEY\"}" \
  --region us-east-1
# Restart worker to pick up the new secret:
aws ecs update-service --cluster genese-proposal-ai \
  --service genese-worker-service --force-new-deployment --region us-east-1
```

---

### Step 6 — Build and Push Docker Images `[CLI]`

```bash
# Authenticate Docker to ECR
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin \
  "$ACCOUNT.dkr.ecr.us-east-1.amazonaws.com"

# Build and push API image
docker build -t genese-api -f services/api/Dockerfile services/
docker tag genese-api:latest "$API_REPO_URI:latest"
docker push "$API_REPO_URI:latest"

# Build and push Worker image
docker build -t genese-worker -f services/worker/Dockerfile services/
docker tag genese-worker:latest "$WORKER_REPO_URI:latest"
docker push "$WORKER_REPO_URI:latest"
```

Both Dockerfiles use `services/` as the build context, which gives them access to `services/shared/` (shared models, constants, schemas used by both API and Worker).

**API image** (`services/api/Dockerfile`): FastAPI application, 0.5 vCPU / 1 GB RAM task. Handles HTTP requests, JWT authentication via Cognito, database reads/writes, and SQS message publishing.

**Worker image** (`services/worker/Dockerfile`): LangChain + Bedrock consumer, 1 vCPU / 2 GB RAM task. Includes `graphviz` (installed via `apt`) and the `diagrams` Python library for architecture diagram generation. Handles SQS polling, RAG retrieval from pgvector, Claude invocation via Bedrock, and document generation.

**Why CLI and not CDK**: CDK is infrastructure-as-code. It defines what should exist in AWS. Building Docker images is a build system operation. CDK has `DockerImageAsset` for bundling images, but using it here would mean CDK uploads images during `cdk deploy` — before the ECR repos exist and before the ECS task definitions are finalized. The explicit CLI sequence (create repos → deploy CDK → build and push images) is clearer and more reliable.

---

### Step 7 — Database Migration `[CLI: one-off ECS Fargate task]`

**The problem**: Aurora PostgreSQL is provisioned in a **private subnet** with no public internet access. You cannot connect to it from:
- Your local laptop (not in the VPC)
- This EC2 instance (not in the same VPC, or not in the same security group)
- Any external tool

**The solution**: Run the migration as a one-off ECS Fargate task inside the VPC, using the Worker task definition (which already has the right security group and IAM role).

```bash
# Find VPC, private subnet, and Worker security group from CDK-created resources
VPC_ID=$(aws ec2 describe-vpcs --filters "Name=tag:Name,Values=GeneseProposalAIStack/Vpc" ...)
PRIV_SUBNET=$(aws ec2 describe-subnets --filters "...subnet-type=Private" ...)
WORKER_SG=$(aws ec2 describe-security-groups --filters "...WorkerSG*" ...)
WORKER_TD=$(aws ecs list-task-definitions --query '...WorkerTask...' ...)

# Upload migration script to S3 (where the Fargate task can download it)
aws s3 cp /tmp/db_migrate.py "s3://$CF_DOCS_BUCKET/scripts/db_migrate.py"

# Launch one-off task — runs migration and exits
aws ecs run-task \
  --cluster genese-proposal-ai \
  --task-definition "$WORKER_TD" \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$PRIV_SUBNET],securityGroups=[$WORKER_SG],assignPublicIp=DISABLED}" \
  --overrides '{"containerOverrides":[{"name":"Worker","command":["python3","-c","...download and run migration..."]}]}'
```

The task runs inside the VPC with:
- Network access to Aurora via the `WorkerSG → DbSG` security group rule (port 5432)
- IAM access to Secrets Manager to read DB credentials
- IAM access to S3 to download the migration script

**Migration is idempotent**: All SQL uses `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`. Re-running on an already-migrated database is safe.

**Tables created by migration v1**:

| Table | Purpose |
|-------|---------|
| `users` | Cognito user records (cognito_sub, email, name) |
| `documents` | Uploaded document metadata (filename, type, s3_key, chunk_count, ingestion_status) |
| `document_chunks` | Text chunks with 1024-dimensional pgvector embeddings |
| `generation_jobs` | Job tracking (status, input params, output s3_key, token counts, arch diagram) |

**Migration v2 additions** (already in current schema via inline migration in deploy.sh):
- `outcome`, `proposal_score`, `pdf_s3_key` columns on `generation_jobs`
- `arch_references` table
- `sections_content` and `drawio_s3_key` columns

The pgvector extension (`CREATE EXTENSION IF NOT EXISTS vector`) is enabled as part of migration. Aurora PostgreSQL 16.4 supports pgvector natively. Embeddings are 1024 dimensions (Amazon Titan Embeddings V2 output size), stored as `vector(1024)` and indexed with `ivfflat` for cosine similarity search.

---

### Step 8 — Create ECS Services `[CLI — must NOT be CDK]`

See [Section 5](#5-why-ecs-services-must-never-be-in-cdk) for the full explanation of why this is CLI and not CDK.

```bash
# API Service — attached to ALB target group
aws ecs create-service \
  --cluster genese-proposal-ai \
  --service-name genese-api-service \
  --task-definition "$API_TD" \
  --desired-count 1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$PRIV_SUBNETS],securityGroups=[$API_SG],assignPublicIp=DISABLED}" \
  --load-balancers "targetGroupArn=$TARGET_GROUP_ARN,containerName=Api,containerPort=8000" \
  --health-check-grace-period-seconds 60 \
  --deployment-configuration "maximumPercent=100,minimumHealthyPercent=0"

# Worker Service — no ALB, polls SQS directly
aws ecs create-service \
  --cluster genese-proposal-ai \
  --service-name genese-worker-service \
  --task-definition "$WORKER_TD" \
  --desired-count 1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$PRIV_SUBNETS],securityGroups=[$WORKER_SG],assignPublicIp=DISABLED}" \
  --deployment-configuration "maximumPercent=200,minimumHealthyPercent=100"
```

After creating services, the script polls every 20 seconds (up to 18 times = 6 minutes) for `runningCount=1` on both services, then performs a final health check against `$API_URL/health`.

**`--health-check-grace-period-seconds 60`** on the API service: gives the FastAPI application 60 seconds to start and connect to Aurora before ALB health checks are evaluated. Without this, the ALB marks the target unhealthy before the app is ready, ECS replaces the task, and the service thrashes.

---

### Step 9 — CloudFront `/api/*` Proxy `[CLI]`

```bash
# Find the CloudFront distribution created by CDK
CF_DIST_ID=$(aws cloudfront list-distributions \
  --query "DistributionList.Items[?contains(...)].Id" --output text)

# Create a CloudFront Function that strips the /api prefix
cat > /tmp/cf_func.js << 'EOF'
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri.startsWith("/api")) { request.uri = uri.slice(4) || "/"; }
  return request;
}
EOF

aws cloudfront create-function \
  --name "StripApiPrefix" \
  --function-config '{"Comment":"Strip /api prefix before forwarding to ALB","Runtime":"cloudfront-js-2.0"}' \
  --function-code fileb:///tmp/cf_func.js

# Add ALB as a second origin + /api/* cache behavior to the distribution
# (done via get-distribution-config → modify JSON → update-distribution)
```

**Why CLI and not CDK**: CDK creates the CloudFront distribution pointing at the S3 frontend bucket. At that point, the ALB doesn't exist yet in the stack (or its DNS name isn't known). To add the ALB as a second origin, we need the ALB DNS name — which only appears in CDK stack outputs *after* CDK has completed. This is a genuine circular dependency: CDK can't define the `/api/*` behavior without knowing the ALB DNS, and the ALB DNS isn't known until CDK runs.

The workaround is to add the `/api/*` behavior post-deployment via CLI, which is also the correct logical sequence: deploy the infrastructure skeleton, then wire up the routing.

**How the proxy works**:

```
Browser → https://xxxx.cloudfront.net/api/generate
  CloudFront: path matches /api/* → route to ALB origin
  StripApiPrefix function: /api/generate → /generate
  ALB: /generate → ECS API task on port 8000
  FastAPI: handles GET/POST /generate
```

This is what allows the React frontend (served from CloudFront at HTTPS) to call the API without a "mixed content" browser error. The ALB uses HTTP internally; CloudFront provides the HTTPS termination.

This step is idempotent — if the `/api/*` behavior already exists, it is skipped.

---

### Step 10 — Build React Frontend + Sync to S3 `[CLI]`

```bash
cd frontend

# Inject runtime configuration — these values come from CDK outputs
cat > src/config.ts << EOF
export const API_BASE_URL = "/api";
export const COGNITO_USER_POOL_ID = "$USER_POOL_ID";
export const COGNITO_CLIENT_ID   = "$USER_POOL_CLIENT_ID";
export const AWS_REGION          = "us-east-1";
EOF

npm install
npm run build   # Vite build → dist/

# Sync to S3 (CloudFront serves from here)
aws s3 sync dist/ "s3://$CF_FRONTEND_BUCKET/" \
  --delete \
  --region us-east-1

# Invalidate CloudFront cache so users get the new version immediately
aws cloudfront create-invalidation \
  --distribution-id "$CF_DIST_ID" \
  --paths "/*"

cd ..
```

The frontend uses Vite + React + TypeScript + Tailwind CSS. The `src/config.ts` file is generated at build time with the actual Cognito pool ID, client ID, and region from CDK outputs. This means the same source code works in any AWS account or region — the config is injected at deploy time.

**`--delete` on s3 sync**: removes files in S3 that no longer exist in the local `dist/` directory. This prevents stale JS chunks from previous builds accumulating in the bucket.

**CloudFront invalidation**: CloudFront caches files at edge locations globally. Without invalidation, users in cached regions would see the old version for up to 24 hours. The `/*` invalidation flushes all cached objects. Note: 1000 invalidation paths/month are free; additional paths are $0.005 each. `/*` counts as 1 path.

---

### Step 11 — Create Cognito Admin User `[CLI]`

```bash
# Create user (admin-create-user sends a temp password email — we override it)
aws cognito-idp admin-create-user \
  --user-pool-id "$USER_POOL_ID" \
  --username "$ADMIN_EMAIL" \
  --user-attributes Name=email,Value="$ADMIN_EMAIL" Name=email_verified,Value=true \
  --message-action SUPPRESS \
  --region us-east-1

# Set permanent password (skips the force-change-password flow)
aws cognito-idp admin-set-user-password \
  --user-pool-id "$USER_POOL_ID" \
  --username "$ADMIN_EMAIL" \
  --password "$ADMIN_PASSWORD" \
  --permanent \
  --region us-east-1
```

**`--message-action SUPPRESS`**: Cognito normally sends a "welcome" email with a temporary password. Since we're immediately setting a permanent password, the welcome email is suppressed to avoid confusion.

**`--permanent`**: Without this flag, the user would be forced to change their password on first login. The `--permanent` flag marks the password as already-set, allowing direct login.

**Idempotency**: If the user already exists (`admin-create-user` returns `UsernameExistsException`), the script catches this and proceeds to `admin-set-user-password` anyway — ensuring the password matches the configured value.

---

### Step 12 — Seed Knowledge Base Documents `[CLI: API calls]`

```bash
# Get auth token
TOKEN=$(curl -s -X POST "$API_URL/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" | \
  python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('idToken',''))")

# Upload each seed document via the API
for FILE in scripts/seed_documents/*.txt; do
  curl -s -X POST "$API_URL/documents/upload" \
    -H "Authorization: Bearer $TOKEN" \
    -F "file=@$FILE;type=text/plain" \
    -F "document_type=proposal" \
    -F "engagement_type=aws_migration" \
    -F "client_name=Sample Client"
  sleep 0.5
done
```

10 synthetic seed documents are uploaded:

| File | Type | Client |
|------|------|--------|
| `proposal_aws_migration_horizon.txt` | proposal | Horizon Financial |
| `proposal_data_platform_retailmax.txt` | proposal | RetailMax Nepal |
| `proposal_managed_services_medicare.txt` | proposal | MediCare Plus |
| `proposal_security_audit_bankcorp.txt` | proposal | BankCorp Nepal |
| `sow_cloud_infrastructure_techventure.txt` | sow | TechVenture |
| `sow_devops_softglobal.txt` | sow | SoftGlobal Nepal |
| `sow_data_engineering_neptelco.txt` | sow | NepTelco |
| `case_study_fintech_neppay.txt` | case_study | NepPay |
| `case_study_retail_shopnepal.txt` | case_study | ShopNepal |
| `case_study_healthcare_nphi.txt` | case_study | NPHI |

Each upload triggers background indexing: the Worker service picks up the document from SQS, chunks it, generates embeddings via Amazon Titan Embeddings V2, and stores the vectors in pgvector. Indexing takes ~2 minutes per document.

**These are synthetic/demo documents.** For production quality, replace them with real Genese proposals, SoWs, and case studies via the Documents page in the UI.

---

### Step 13 — Final Verification `[CHECK]`

```bash
# 1. ALB health check (direct HTTP — tests API is up)
curl -s "$API_URL/health"
# Expected: {"status":"healthy","db":"connected","queue":"reachable"}

# 2. CloudFront frontend (HTTPS — tests S3 + CloudFront)
curl -s -o /dev/null -w "%{http_code}" "$CF_URL"
# Expected: 200

# 3. HTTPS login through CloudFront proxy (tests full stack)
curl -s -X POST "$CF_URL/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}"
# Expected: {"idToken":"eyJ...", "accessToken":"eyJ...", "refreshToken":"eyJ..."}
```

Check 3 validates the entire request path:

```
Browser HTTPS → CloudFront → /api/* behavior → StripApiPrefix function
→ ALB origin → ECS API task → FastAPI /auth/login → Cognito
→ JWT tokens returned
```

If check 3 fails with an HTTP error immediately after deployment, wait 2–3 minutes. CloudFront function publishing and distribution updates take time to propagate globally.


---

## 9. CDK Stack Outputs Reference

After `cdk deploy`, these outputs are available via:

```bash
aws cloudformation describe-stacks \
  --stack-name GeneseProposalAIStack \
  --query 'Stacks[0].Outputs' \
  --output table
```

| Output Key | Example Value | Used In |
|------------|---------------|---------|
| `ApiUrl` | `http://GeneseP-ApiLB-xxxx.us-east-1.elb.amazonaws.com` | Step 8 (health check), Step 12 (seeding), Step 13 (verification) |
| `CloudFrontUrl` | `https://xxxx.cloudfront.net` | Step 10 (frontend URL), Step 13 (verification) |
| `FrontendBucketName` | `genese-proposal-ai-frontend-123456789012-us-east-1` | Step 10 (s3 sync) |
| `DocumentsBucketName` | `genese-proposal-ai-docs-123456789012-us-east-1` | Step 7 (migration script upload) |
| `UserPoolId` | `us-east-1_AbcDef123` | Step 10 (frontend config), Step 11 (Cognito user) |
| `UserPoolClientId` | `1abc2def3ghi4jkl5mno6pqr` | Step 10 (frontend config) |
| `ApiRepoUri` | `123456789012.dkr.ecr.us-east-1.amazonaws.com/genese-proposal-ai-api` | Step 6 (docker push) |
| `WorkerRepoUri` | `123456789012.dkr.ecr.us-east-1.amazonaws.com/genese-proposal-ai-worker` | Step 6 (docker push) |
| `DbSecretArn` | `arn:aws:secretsmanager:us-east-1:123:secret:/genese/db-credentials-xxx` | Step 7 (migration), ECS env vars |
| `TavilySecretArn` | `arn:aws:secretsmanager:us-east-1:123:secret:/genese/tavily-api-key-xxx` | Step 5 (key update), ECS env vars |
| `TargetGroupArn` | `arn:aws:elasticloadbalancing:us-east-1:123:targetgroup/GeneseP-ApiTG-xxx/yyy` | Step 8 (ECS service create) |
| `AlbArn` | `arn:aws:elasticloadbalancing:us-east-1:123:loadbalancer/app/GeneseP-ApiLB-xxx/yyy` | Reference |

All outputs are saved to `/tmp/genese_outputs.env` by Step 4. Source this file to restore variables in a new terminal:

```bash
source /tmp/genese_outputs.env
echo $CF_URL   # https://xxxx.cloudfront.net
```

---

## 10. Environment Variables in ECS

Both the API and Worker task definitions receive these environment variables, injected by CDK at task definition creation time from CDK outputs:

| Variable | Value Source | Purpose |
|----------|-------------|---------|
| `AWS_REGION` | `Stack.region` (CDK) | Region for all boto3 clients |
| `DB_SECRET_ARN` | `db_secret.secret_arn` (CDK) | Read DB credentials from Secrets Manager |
| `TAVILY_SECRET_ARN` | `tavily_secret.secret_arn` (CDK) | Read Tavily API key from Secrets Manager |
| `DOCUMENTS_BUCKET` | `documents_bucket.bucket_name` (CDK) | S3 bucket for document storage and retrieval |
| `GENERATION_QUEUE_URL` | `generation_queue.queue_url` (CDK) | SQS queue URL for job dispatch/consumption |
| `COGNITO_USER_POOL_ID` | `user_pool.user_pool_id` (CDK) | JWT token validation |
| `COGNITO_CLIENT_ID` | `user_pool_client.user_pool_client_id` (CDK) | Cognito auth flows |
| `PYTHONPATH` | `/app` (hardcoded in Dockerfile) | Python module resolution for shared/ package |
| `REDIS_URL` | `""` (empty — ElastiCache not provisioned) | Optional; Tavily cache degrades gracefully if unset |

**How secrets are consumed**: The app uses `boto3.client("secretsmanager").get_secret_value(SecretId=os.environ["DB_SECRET_ARN"])` to read credentials at runtime. Secrets are never stored as environment variable values — only ARNs are in env vars. This means rotating a secret in Secrets Manager takes effect on the next ECS task start without redeploying.

---

## 11. Database Migration Details

### Connection path

```
deploy.sh (on EC2/laptop)
  → aws ecs run-task (Fargate task, inside VPC)
    → security group: WorkerSG → DbSG on port 5432
    → IAM: Worker task role → Secrets Manager read
    → Secrets Manager: /genese/db-credentials
      → host, port, dbname, username, password
    → psycopg2.connect(host=Aurora_cluster_endpoint, ...)
```

### Schema (current state)

```sql
-- pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Users synced from Cognito on first login
CREATE TABLE IF NOT EXISTS users (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cognito_sub  VARCHAR(255) UNIQUE NOT NULL,
    email        VARCHAR(255) NOT NULL,
    name         VARCHAR(255),
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Document metadata (file info, indexing status)
CREATE TABLE IF NOT EXISTS documents (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    filename         VARCHAR(500) NOT NULL,
    document_type    VARCHAR(50) NOT NULL,    -- 'proposal', 'sow', 'case_study'
    engagement_type  VARCHAR(100),
    client_name      VARCHAR(255),
    s3_key           VARCHAR(1000) NOT NULL,
    chunk_count      INTEGER DEFAULT 0,
    uploaded_by      UUID,
    ingestion_status VARCHAR(50) DEFAULT 'pending',
    embedding_model  VARCHAR(255),
    embedding_tokens INTEGER DEFAULT 0,
    created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- Text chunks with vector embeddings (1024-dim, Amazon Titan Embeddings V2)
CREATE TABLE IF NOT EXISTS document_chunks (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    content     TEXT NOT NULL,
    embedding   vector(1024),
    metadata    JSONB,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chunks_embedding
    ON document_chunks USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 10);

-- Generation jobs (proposal/SoW/case study generation requests)
CREATE TABLE IF NOT EXISTS generation_jobs (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID,
    document_type    VARCHAR(50) NOT NULL,
    client_name      VARCHAR(255) NOT NULL,
    engagement_type  VARCHAR(100) NOT NULL,
    key_requirements TEXT NOT NULL,
    context_notes    TEXT,
    status           VARCHAR(50) DEFAULT 'queued',
    status_detail    VARCHAR(255),
    rag_context      JSONB,
    tavily_sources   JSONB,
    output_s3_key    VARCHAR(1000),
    error_message    TEXT,
    llm_model        VARCHAR(255),
    input_tokens     INTEGER DEFAULT 0,
    output_tokens    INTEGER DEFAULT 0,
    arch_json        JSONB,
    arch_s3_key      VARCHAR(1000),
    arch_iteration   INTEGER DEFAULT 0,
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    completed_at     TIMESTAMPTZ
);
```

### Running migration manually

If you need to re-run the migration directly (e.g., after adding a column), you can either:

1. Re-run `./deploy.sh` (Step 7 is idempotent)
2. Trigger just the migration step manually:

```bash
source /tmp/genese_outputs.env

WORKER_TD=$(aws ecs list-task-definitions --region us-east-1 \
  --query 'taskDefinitionArns[?contains(@,`WorkerTask`)][-1]' --output text)

VPC_ID=$(aws ec2 describe-vpcs --region us-east-1 \
  --filters "Name=tag:Name,Values=GeneseProposalAIStack/Vpc" \
  --query 'Vpcs[0].VpcId' --output text)

PRIV_SUBNET=$(aws ec2 describe-subnets --region us-east-1 \
  --filters "Name=vpc-id,Values=$VPC_ID" "Name=tag:aws-cdk:subnet-type,Values=Private" \
  --query 'Subnets[0].SubnetId' --output text)

WORKER_SG=$(aws ec2 describe-security-groups --region us-east-1 \
  --filters "Name=vpc-id,Values=$VPC_ID" "Name=group-name,Values=*WorkerSG*" \
  --query 'SecurityGroups[0].GroupId' --output text)

aws ecs run-task \
  --cluster genese-proposal-ai \
  --task-definition "$WORKER_TD" \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$PRIV_SUBNET],securityGroups=[$WORKER_SG],assignPublicIp=DISABLED}" \
  --overrides "{\"containerOverrides\":[{\"name\":\"Worker\",\"command\":[\"python3\",\"/app/scripts/db_migrate.py\",\"--secret-arn\",\"$DB_SECRET_ARN\",\"--region\",\"us-east-1\"]}]}" \
  --region us-east-1
```

---

## 12. Rolling Updates (Code Changes)

For any code change (API, Worker, or both), the process is:

```bash
# Simply re-run deploy.sh — it handles everything
./deploy.sh
```

What happens under the hood for a code-only change (no infrastructure changes):

1. **Step 2**: ECR repos already exist — skipped
2. **Step 3**: CDK detects no infrastructure diff — fast no-op (< 30 seconds)
3. **Step 4**: Re-reads same outputs
4. **Steps 5, 7**: Tavily key and migration — idempotent skips
5. **Step 6**: Rebuilds Docker images and pushes new `:latest` tags to ECR
6. **Step 8**: Service exists → registers new task definition revision → calls `update-service`
7. **Steps 9–13**: Frontend sync, Cognito user check, verification

### Manual rolling update (without deploy.sh)

If you only changed the API and want a targeted update:

```bash
source /tmp/genese_outputs.env

# 1. Push new image
docker build -t genese-api -f services/api/Dockerfile services/
docker push "$API_REPO_URI:latest"

# 2. Get the current task definition and register a new revision
TD_JSON=$(aws ecs describe-task-definition \
  --task-definition GeneseProposalAIStack-ApiTask \
  --region us-east-1 \
  --query 'taskDefinition' --output json | \
  python3 -c "import sys,json; td=json.load(sys.stdin); \
    print(json.dumps({k:td[k] for k in ['family','networkMode','containerDefinitions',\
    'requiresCompatibilities','cpu','memory','taskRoleArn','executionRoleArn']}))")

NEW_TD_ARN=$(aws ecs register-task-definition \
  --cli-input-json "$TD_JSON" \
  --region us-east-1 \
  --query 'taskDefinition.taskDefinitionArn' --output text)

# 3. Update service — zero downtime
aws ecs update-service \
  --cluster genese-proposal-ai \
  --service genese-api-service \
  --task-definition "$NEW_TD_ARN" \
  --deployment-configuration "maximumPercent=200,minimumHealthyPercent=100" \
  --region us-east-1
```

`maximumPercent=200, minimumHealthyPercent=100` means:
- ECS starts 1 new task (total = 2 running)
- Once the new task passes health checks, ECS stops the old task (total = 1 running)
- At no point does the service have 0 running tasks

This is **zero-downtime rolling deployment** — users experience no interruption.

### Checking ECS service status

```bash
# Check running task count and deployment status
aws ecs describe-services \
  --cluster genese-proposal-ai \
  --services genese-api-service genese-worker-service \
  --region us-east-1 \
  --query 'services[*].{name:serviceName,running:runningCount,desired:desiredCount,deployments:deployments[*].{status:status,count:runningCount}}' \
  --output table

# Tail live logs
aws logs tail /ecs/genese-api   --follow --region us-east-1
aws logs tail /ecs/genese-worker --follow --region us-east-1
```

---

## 13. Current Live State

As of 2026-07-03:

| Component | State | Details |
|-----------|-------|---------|
| CDK Stack | `CREATE_COMPLETE` | `GeneseProposalAIStack` in `us-east-1` |
| API Service | Running | Task Definition revision 23, 1/1 tasks running |
| Worker Service | Running | Task Definition revision 27, 1/1 tasks running |
| Aurora | Available | PostgreSQL 16.4, 0.5–4 ACU serverless v2 |
| Documents indexed | 28 | 28 documents with embeddings in pgvector |
| Generation jobs | 50 | 50 completed jobs in `generation_jobs` table |

### Verify live state

```bash
# Stack status
aws cloudformation describe-stacks \
  --stack-name GeneseProposalAIStack \
  --region us-east-1 \
  --query 'Stacks[0].StackStatus' --output text

# ECS services
aws ecs describe-services \
  --cluster genese-proposal-ai \
  --services genese-api-service genese-worker-service \
  --region us-east-1 \
  --query 'services[*].{name:serviceName,status:status,running:runningCount,td:taskDefinition}' \
  --output table

# Aurora cluster
aws rds describe-db-clusters \
  --region us-east-1 \
  --query 'DBClusters[?DBClusterIdentifier==`GeneseProposalAIStack-AuroraCluster`].{status:Status,engine:EngineVersion}' \
  --output table

# API health
source /tmp/genese_outputs.env
curl -s $API_URL/health | python3 -m json.tool
```

---

## 14. Production Hardening Checklist

The current deployment is in **dev/demo phase**. The following changes are required before handling real customer data or production traffic.

### Critical — Data Safety

- [ ] **Change Aurora `RemovalPolicy` from `DESTROY` to `RETAIN`**
  - Currently: `RemovalPolicy.DESTROY` in `genese_stack.py` — re-running CDK with a breaking change deletes the Aurora cluster and all data
  - Fix: `removal_policy=RemovalPolicy.RETAIN` on `db_cluster`
  - Same change needed for both S3 buckets

- [ ] **Enable Aurora PITR (Point-in-Time Recovery)**
  - Currently: backups disabled (default for new clusters with `RemovalPolicy.DESTROY`)
  - Fix: Enable automated backups with a 7-day retention window in the CDK stack

- [ ] **Set `desiredCount=2` on both ECS services**
  - Currently: 1 task per service — a single task failure = service outage
  - Fix: Update `aws ecs update-service --desired-count 2 --cluster genese-proposal-ai --service genese-api-service`
  - Also update `deploy.sh` default `--desired-count` in Step 8

### Security

- [ ] **Add ACM certificate to ALB (HTTPS on ALB)**
  - Currently: ALB listener is HTTP:80 only; HTTPS is terminated at CloudFront
  - Risk: Traffic between CloudFront and ALB is unencrypted
  - Fix: Request ACM cert for your domain, add HTTPS:443 listener to ALB in CDK

- [ ] **Lock CORS from `*` to specific domain**
  - Currently: FastAPI CORS middleware allows all origins
  - Fix: Set `allow_origins=["https://your-cloudfront-domain.net"]` in the API

- [ ] **Add WAF to CloudFront**
  - Currently: No WAF — CloudFront is exposed to public internet with no rate limiting
  - Fix: Add `aws_wafv2.WebAclAssociation` in CDK or attach via console

- [ ] **Scope down IAM permissions**
  - Currently: Task role has `AmazonBedrockFullAccess` (managed policy)
  - Fix: Replace with inline policy granting only `bedrock:InvokeModel` on specific model ARNs

### Observability

- [ ] **CloudWatch alarms on DLQ message depth**
  - Fix: `aws cloudwatch put-metric-alarm` on `ApproximateNumberOfMessagesVisible` for `genese-generation-jobs-dlq`; alarm at > 0 messages

- [ ] **CloudWatch alarms on ECS task failures**
  - Fix: Alarm on `ECS/ContainerInsights` `RunningTaskCount` dropping below 1 for each service

- [ ] **CloudWatch alarms on Aurora CPU**
  - Fix: Alarm on `AWS/RDS CPUUtilization > 80%` for the Aurora cluster

- [ ] **Set CloudWatch Log Group retention**
  - Currently: Log groups `/ecs/genese-api` and `/ecs/genese-worker` have no retention — logs accumulate indefinitely
  - Fix: Add `retention=logs.RetentionDays.ONE_MONTH` (or appropriate value) in CDK

### Operational

- [ ] **Custom domain + ACM certificate on CloudFront**
  - Currently: Uses auto-generated `xxxx.cloudfront.net` URL
  - Fix: Add `domain_names` and `certificate` to the CloudFront distribution in CDK

- [ ] **Replace seed documents with real Genese content**
  - Currently: 10 synthetic demo documents
  - Fix: Upload real Genese proposals, SoWs, and case studies via the Documents page

---

## 15. Troubleshooting

### CDK deploy fails

```bash
# Check CloudFormation events for the specific failure reason
aws cloudformation describe-stack-events \
  --stack-name GeneseProposalAIStack \
  --region us-east-1 \
  --query 'StackEvents[?ResourceStatus==`CREATE_FAILED`].[LogicalResourceId,ResourceStatusReason]' \
  --output table
```

Common causes:
- **Aurora creation fails**: Insufficient capacity in the region. Try `us-east-1` or `us-west-2`.
- **CDK bootstrap not run**: Run `cdk bootstrap aws://ACCOUNT/REGION` manually first.
- **ECR repos don't exist**: Make sure Step 2 ran successfully before Step 3.

### ECS tasks not starting

```bash
# Check task stopped reason
aws ecs describe-tasks \
  --cluster genese-proposal-ai \
  --tasks $(aws ecs list-tasks --cluster genese-proposal-ai --service-name genese-api-service --region us-east-1 --query 'taskArns[0]' --output text) \
  --region us-east-1 \
  --query 'tasks[0].{status:lastStatus,stopped:stoppedReason,containers:containers[*].{name:name,exit:exitCode,reason:reason}}' \
  --output json

# Check CloudWatch logs
aws logs tail /ecs/genese-api --since 10m --region us-east-1
```

Common causes:
- **ImageNotFound**: Docker image not pushed yet. Run Step 6 manually.
- **ResourceInitializationError: unable to pull secrets**: Execution role missing Secrets Manager permissions (should be handled by CDK, verify the role has the policy).
- **Container exits with code 1**: Check CloudWatch logs for Python traceback.

### API health check failing

```bash
source /tmp/genese_outputs.env
curl -v "$API_URL/health"
```

If the ALB returns 502/503:
1. Check ECS task is running: `aws ecs describe-services --cluster genese-proposal-ai --services genese-api-service --region us-east-1`
2. Check target group health: `aws elbv2 describe-target-health --target-group-arn $TARGET_GROUP_ARN --region us-east-1`
3. Check the container health check: `aws logs tail /ecs/genese-api --since 5m --region us-east-1`

### CloudFront returning 403 on `/api/*`

The most common cause is that Step 9 didn't run or the CloudFront distribution update is still propagating (can take 5–10 minutes).

```bash
# Check if /api/* behavior exists
aws cloudfront get-distribution-config \
  --id "$CF_DIST_ID" \
  --query 'DistributionConfig.CacheBehaviors.Items[*].PathPattern' \
  --output text

# Check distribution status (must be 'Deployed')
aws cloudfront get-distribution \
  --id "$CF_DIST_ID" \
  --query 'Distribution.Status' \
  --output text
```

If the behavior is missing, re-run Step 9 manually by running `./deploy.sh` again (idempotent).

### Aurora connection refused

Aurora is in a private subnet. You **cannot connect directly** from outside the VPC.

Options:
1. Run a one-off ECS task with `psql` (same as the migration approach)
2. Set up an AWS Systems Manager Session Manager tunnel (recommended for production)
3. Use AWS RDS Query Editor (for simple queries in the console)

```bash
# One-off psql via ECS task
aws ecs run-task \
  --cluster genese-proposal-ai \
  --task-definition "$WORKER_TD" \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$PRIV_SUBNET],securityGroups=[$WORKER_SG],assignPublicIp=DISABLED}" \
  --overrides "{\"containerOverrides\":[{\"name\":\"Worker\",\"command\":[\"python3\",\"-c\",\"import boto3,json; sm=boto3.client('secretsmanager',region_name='us-east-1'); s=json.loads(sm.get_secret_value(SecretId='$DB_SECRET_ARN')['SecretString']); print(f\\\"Host: {s['host']}, DB: {s['dbname']}, User: {s['username']}\\\")\"]}]}" \
  --region us-east-1
```

### Cognito login fails after redeploy

If you see `NotAuthorizedException` after a redeploy:
- Verify the User Pool ID and Client ID in the frontend match the CDK outputs
- The frontend config (`src/config.ts`) is regenerated at build time — if Step 10 ran successfully, these should be correct
- Verify the user exists: `aws cognito-idp admin-get-user --user-pool-id $USER_POOL_ID --username $ADMIN_EMAIL --region us-east-1`

---

*This document covers the complete deployment architecture for Genese Proposal AI. For the system architecture overview, see `01-architecture-overview.md`. For API documentation, see the FastAPI auto-generated docs at `$API_URL/docs` (available when the API is running).*
