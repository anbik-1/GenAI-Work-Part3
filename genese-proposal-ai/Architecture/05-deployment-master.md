# Genese Proposal AI — Master Deployment Guide

> **This is the definitive, single source of truth for deploying Genese Proposal AI from scratch in any AWS account.**
> Last updated: 2026-07-03

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture Summary](#2-architecture-summary)
3. [Prerequisites](#3-prerequisites)
4. [CDK vs CLI — The Critical Distinction](#4-cdk-vs-cli--the-critical-distinction)
5. [Infrastructure Deployed by CDK](#5-infrastructure-deployed-by-cdk)
6. [Steps Handled by CLI (Post-CDK)](#6-steps-handled-by-cli-post-cdk)
7. [Quick Start — Full Deploy from Scratch](#7-quick-start--full-deploy-from-scratch)
8. [Step-by-Step Deployment Reference](#8-step-by-step-deployment-reference)
9. [Environment Variables Reference](#9-environment-variables-reference)
10. [Database Migrations](#10-database-migrations)
11. [Rolling Updates (Code Changes Only)](#11-rolling-updates-code-changes-only)
12. [Verification Checklist](#12-verification-checklist)
13. [Production Hardening Checklist](#13-production-hardening-checklist)
14. [Teardown](#14-teardown)
15. [Current Live State](#15-current-live-state)
16. [Troubleshooting](#16-troubleshooting)

---

## 1. Overview

Genese Proposal AI is a full-stack AI-powered proposal generation platform running on AWS. The deployment is split into two distinct phases:

- **CDK Phase**: Provisions all persistent infrastructure (VPC, Aurora, S3, Cognito, SQS, ECR references, ECS cluster + task definitions, ALB, IAM, Secrets Manager, CloudWatch).
- **CLI Phase**: Handles everything that would cause CloudFormation to time out or that requires runtime values only available after CDK completes.

The master deployment script `deploy.sh` (at the root of `genese-proposal-ai/`) orchestrates all 13 steps in the correct order and is fully **idempotent** — safe to re-run at any point without causing duplicate resources or failures.

**Estimated deploy time from scratch**: 25–40 minutes (CDK alone takes 10–15 min for Aurora provisioning).

---

## 2. Architecture Summary

```
Internet
   │
   ▼
CloudFront (d3gmhvny3loneb.cloudfront.net)
   ├── /* → S3 frontend bucket (React SPA)
   └── /api/* → ALB (StripApiPrefix CF Function removes /api prefix)
                    │
                    ▼
              ALB (HTTP:80)
                    │
          ┌─────────┴─────────┐
          ▼                   ▼
    ECS API Service     (health check)
    (genese-api-service)
          │
          ├── Reads/writes Aurora PostgreSQL (private subnet)
          ├── Reads/writes S3 docs bucket
          ├── Publishes to SQS queue
          └── Calls Cognito (auth), Bedrock (LLM), Secrets Manager

    ECS Worker Service
    (genese-worker-service)
          │
          ├── Polls SQS queue
          ├── Reads Aurora PostgreSQL
          ├── Reads/writes S3 docs bucket
          └── Calls Bedrock (Claude Sonnet) for generation

Aurora PostgreSQL 16.4 Serverless v2
    ├── pgvector extension
    └── Private subnet only (no public access)
```

| Component | Service | Notes |
|---|---|---|
| Frontend CDN | CloudFront | SPA + /api/* proxy |
| Frontend Hosting | S3 | React build artifacts |
| API Server | ECS Fargate (API service) | FastAPI |
| Background Worker | ECS Fargate (Worker service) | SQS consumer |
| Database | Aurora PostgreSQL 16.4 Serverless v2 | pgvector, private |
| Job Queue | SQS | genese-generation-jobs + DLQ |
| Auth | Cognito User Pool | No self sign-up |
| LLM | Amazon Bedrock | Claude Sonnet (default) |
| Secrets | Secrets Manager | DB creds + Tavily key |
| Container Registry | ECR | 2 repos (api + worker) |
| Networking | VPC | 2 AZs, public+private, 1 NAT |

---

## 3. Prerequisites

All of the following must be installed and available in `$PATH` on the deployment machine before running `deploy.sh`.

| Tool | Minimum Version | Check Command |
|---|---|---|
| Python | 3.9+ | `python3 --version` |
| Node.js | 18+ | `node --version` |
| npm | 8+ | `npm --version` |
| AWS CLI | v2 | `aws --version` |
| AWS CDK | 2.x | `cdk --version` |
| Docker | Any recent | `docker --version` |
| Docker daemon | Running | `docker info` |

**AWS credentials** must have `AdministratorAccess` (or equivalent) on the target account. The CDK bootstrap and Aurora provisioning require broad permissions.

```bash
# Verify credentials are working
aws sts get-caller-identity

# Expected output shape:
# {
#     "UserId": "...",
#     "Account": "654654306837",
#     "Arn": "arn:aws:iam::654654306837:..."
# }
```

**Install CDK globally if not present:**
```bash
npm install -g aws-cdk
```

**Tavily API key** (optional — enables web search in proposal generation):
```bash
export TAVILY_API_KEY=tvly-your-key-here
# If not set, deploy.sh skips this step; Tavily features will be disabled
```

---

## 4. CDK vs CLI — The Critical Distinction

Understanding this split is essential. **Never move ECS service creation into CDK.**

### Why ECS Services Are CLI-Only — Not CDK

> **This burned us repeatedly in development. Do not revert this decision.**

When CloudFormation deploys an ECS Service resource, it waits for the service to reach **steady state** — meaning all desired tasks are running AND health checks are passing. This requires:
1. Docker images already in ECR ✓ (only available after CDK runs)
2. Database schema already migrated ✓ (only possible after Aurora is up)
3. All environment variables resolving correctly ✓

If any health check fails, CloudFormation waits up to **3 hours** before timing out — then **rolls back the ENTIRE stack**, deleting Aurora, S3 buckets, Cognito, and everything else.

**The fix**: CDK creates the ECS cluster and task definitions only. The `deploy.sh` script creates the actual ECS services via CLI *after* images are in ECR and migrations have run.

### Responsibility Matrix

| Resource | Deployed By | Reason |
|---|---|---|
| VPC, subnets, NAT gateway | CDK | Pure infrastructure, no runtime deps |
| S3 buckets (docs + frontend) | CDK | Stateful, must persist |
| CloudFront distribution (SPA only) | CDK | Base distribution without /api/* |
| Cognito User Pool + App Client | CDK | Auth infrastructure |
| Aurora PostgreSQL Serverless v2 | CDK | Stateful DB, ~10 min to provision |
| SQS queue + DLQ | CDK | Messaging infrastructure |
| ECR repositories | **CLI (before CDK)** | CDK references them by name; must pre-exist |
| ECS Cluster | CDK | Just the cluster shell |
| ECS Task Definitions | CDK | Contains container specs and env vars |
| ALB + Target Group + Listener | CDK | Load balancer wiring |
| IAM Task Role + Execution Role | CDK | Permissions |
| Secrets Manager secrets | CDK | Secret placeholders (values set by CLI) |
| CloudWatch log groups | CDK | Log destinations |
| **ECS Services** | **CLI (after CDK)** | **Avoids 3-hour CFN timeout + stack rollback** |
| Docker image build + push | CLI | Requires running Docker daemon |
| DB schema migrations | CLI | Aurora is private; runs as Fargate task |
| CloudFront /api/* behavior | CLI | Requires ALB URL from CDK outputs |
| CloudFront StripApiPrefix function | CLI | Requires CloudFront dist ID from CDK |
| Frontend build + S3 sync | CLI | Requires Cognito IDs + CloudFront URL |
| Cognito user creation | CLI | Requires User Pool ID from CDK outputs |
| Knowledge base seeding | CLI (optional) | Requires API to be running |

---

## 5. Infrastructure Deployed by CDK

The CDK stack is defined in `infrastructure/lib/genese-proposal-ai-stack.ts`. Running `cdk deploy` creates all of the following in a single CloudFormation stack named `GeneseProposalAIStack`.

### 5.1 VPC

- **2 Availability Zones** (us-east-1a, us-east-1b)
- Public subnets (ALB, NAT gateway)
- Private subnets (Aurora, ECS tasks)
- **1 NAT Gateway** (outbound internet for private tasks)

### 5.2 S3 Buckets

| Bucket | Name Pattern | Purpose |
|---|---|---|
| Documents | `genese-proposal-ai-docs-{account}-{region}` | Uploaded docs, embeddings, scripts |
| Frontend | `genese-proposal-ai-frontend-{account}-{region}` | React build artifacts |

> ⚠️ **Warning**: Both buckets currently have `RemovalPolicy.DESTROY`. See [Section 13](#13-production-hardening-checklist) to change this before going to production.

### 5.3 CloudFront Distribution

- Origin: Frontend S3 bucket (OAC)
- Default behavior: `/*` → S3 (SPA mode with 403/404 → index.html)
- **`/api/*` behavior is NOT added by CDK** — added by CLI in Step 9

### 5.4 Cognito

- **User Pool**: `self_sign_up_enabled = False` (admin creates all users)
- **App Client**: No client secret (SPA-compatible)
- Password policy: minimum 8 chars

### 5.5 Aurora PostgreSQL

- Engine: PostgreSQL 16.4
- Mode: Serverless v2
- Capacity: **0.5 ACU minimum, 4 ACU maximum**
- Extensions: `pgvector` (installed during migration)
- Subnet: Private only — **no public access**
- Credentials stored in: `/genese/db-credentials` (Secrets Manager)

> ℹ️ Aurora Serverless v2 scales to zero after ~5 minutes of inactivity and cold-starts in ~1-2 seconds on first query.

### 5.6 SQS

| Queue | Name | Configuration |
|---|---|---|
| Main queue | `genese-generation-jobs` | Visibility timeout: 600s |
| Dead-letter queue | `genese-generation-jobs-dlq` | maxReceiveCount: 3 |

### 5.7 ECR Repositories

CDK **references** these repos by name in the task definitions. They must exist before `cdk deploy` runs — created by CLI in Step 2.

| Repo Name | Image Used By |
|---|---|
| `genese-proposal-ai-api` | API ECS task |
| `genese-proposal-ai-worker` | Worker ECS task |

### 5.8 ECS Cluster + Task Definitions

**Cluster**: `genese-proposal-ai`

| Task Definition | CPU | Memory | Container Name |
|---|---|---|---|
| API | 0.5 vCPU (512) | 1 GB (1024 MB) | `Api` |
| Worker | 1 vCPU (1024) | 2 GB (2048 MB) | `Worker` |

Both task definitions include all required environment variables referencing CDK outputs (see [Section 9](#9-environment-variables-reference)).

### 5.9 ALB

- **Scheme**: Internet-facing
- **Listener**: HTTP:80
- **Target group**: Points at API ECS service (registered by CLI)
- Health check: `GET /health` on port 8000

### 5.10 IAM Roles

| Role | Permissions Granted |
|---|---|
| Task Role | Bedrock (InvokeModel), S3 (read/write docs bucket), SQS (send/receive/delete), Secrets Manager (GetSecretValue) |
| Execution Role | ECR pull, CloudWatch Logs write |

### 5.11 Secrets Manager

| Secret Path | Contents | Set By |
|---|---|---|
| `/genese/db-credentials` | `{ "username": "...", "password": "...", "host": "...", "port": 5432, "dbname": "..." }` | CDK (auto-rotated) |
| `/genese/tavily-api-key` | `{ "TAVILY_API_KEY": "tvly-..." }` | CLI (Step 5) |

### 5.12 CloudWatch Log Groups

| Log Group | Used By |
|---|---|
| `/ecs/genese-api` | API container logs |
| `/ecs/genese-worker` | Worker container logs |

---

## 6. Steps Handled by CLI (Post-CDK)

These 8 actions are intentionally NOT in CDK and are executed by `deploy.sh` after `cdk deploy` completes.

| Step | Action | Why CLI |
|---|---|---|
| 2 | Create ECR repos | Must exist before CDK runs |
| 5 | Store Tavily key in Secrets Manager | Runtime secret, not infrastructure |
| 6 | Build + push Docker images | Requires Docker daemon, builds from source |
| 7 | Run DB migration via Fargate | Aurora is private; needs VPC network access |
| 8 | Create ECS services | Avoids 3-hour CFN stabilization timeout |
| 9 | Add CloudFront /api/* + CF Function | Needs ALB URL from CDK outputs |
| 10 | Build React frontend + S3 sync | Needs Cognito IDs + CloudFront URL from CDK |
| 11 | Create Cognito admin user | Needs User Pool ID from CDK outputs |

---

## 7. Quick Start — Full Deploy from Scratch

```bash
# 1. Clone the repository
git clone https://github.com/anbik-1/GenAI-Work-Part1.git
cd GenAI-Work-Part1/genese-proposal-ai

# 2. Configure AWS credentials for the target account
aws configure
# Enter: Access Key ID, Secret Access Key, Region (us-east-1), Output format (json)

# 3. (Optional) Set Tavily API key for web search features
export TAVILY_API_KEY=tvly-your-key-here

# 4. Run the master deployment script
./deploy.sh
```

`deploy.sh` is idempotent. If it fails at any step, fix the issue and re-run — it will skip already-completed steps.

**Total time**: ~25–40 minutes (Aurora provisioning dominates)

---

## 8. Step-by-Step Deployment Reference

This section documents exactly what `deploy.sh` does at each of its 13 steps. Use this for manual deployments, debugging, or understanding the script internals.

### Step 1 — [CHECK] Verify Prerequisites

`deploy.sh` checks that all required tools are in `$PATH` and that Docker is running. It exits immediately if any prerequisite is missing.

```bash
# Manually verify each prerequisite
python3 --version          # Must be 3.9+
node --version             # Must be v18+
npm --version
aws --version              # Must be aws-cli/2.x
cdk --version              # Must be 2.x
docker --version
docker info                # Must succeed — daemon must be running
aws sts get-caller-identity  # Must return your account ID
```

---

### Step 2 — [CLI] Create ECR Repositories

ECR repos **must exist before CDK runs** because CDK references them by name in the task definitions. This step is idempotent — if the repos already exist the AWS CLI returns a `RepositoryAlreadyExistsException` which the script ignores.

```bash
AWS_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
AWS_REGION=us-east-1

# Create API image repository
aws ecr create-repository \
  --repository-name genese-proposal-ai-api \
  --region $AWS_REGION \
  --image-scanning-configuration scanOnPush=true \
  2>/dev/null || echo "ECR repo genese-proposal-ai-api already exists"

# Create Worker image repository
aws ecr create-repository \
  --repository-name genese-proposal-ai-worker \
  --region $AWS_REGION \
  --image-scanning-configuration scanOnPush=true \
  2>/dev/null || echo "ECR repo genese-proposal-ai-worker already exists"

# Verify both repos exist
aws ecr describe-repositories \
  --repository-names genese-proposal-ai-api genese-proposal-ai-worker \
  --region $AWS_REGION \
  --query 'repositories[].repositoryUri' \
  --output table
```

---

### Step 3 — [CDK] Bootstrap + Deploy Infrastructure

This step runs CDK bootstrap (one-time per account/region) and then deploys the full `GeneseProposalAIStack`. **This takes 10–15 minutes** — most of the time is Aurora Serverless v2 provisioning.

```bash
cd infrastructure

# Install CDK dependencies
npm install

# Bootstrap CDK in target account/region (idempotent — safe to re-run)
cdk bootstrap aws://$AWS_ACCOUNT/$AWS_REGION

# Deploy the stack (auto-approves all changes)
cdk deploy GeneseProposalAIStack --require-approval never --outputs-file cdk-outputs.json

cd ..
```

**What CloudFormation creates** (in dependency order):
1. VPC + subnets + NAT gateway
2. Security groups
3. IAM roles
4. Secrets Manager placeholders
5. S3 buckets
6. Aurora cluster + instance
7. SQS queues
8. ECS cluster
9. CloudWatch log groups
10. ECS task definitions
11. ALB + target group + listener
12. CloudFront distribution (SPA only)
13. Cognito User Pool + App Client

The `--outputs-file cdk-outputs.json` flag writes all stack outputs to a local file used by subsequent steps.

---

### Step 4 — [CLI] Parse CDK Stack Outputs

After CDK completes, the script reads `cdk-outputs.json` and exports all values as shell variables for use in subsequent steps.

```bash
# Parse outputs from CDK
OUTPUTS_FILE=infrastructure/cdk-outputs.json

DB_SECRET_ARN=$(cat $OUTPUTS_FILE | python3 -c "import sys,json; o=json.load(sys.stdin)['GeneseProposalAIStack']; print(o['DbSecretArn'])")
DOCUMENTS_BUCKET=$(cat $OUTPUTS_FILE | python3 -c "import sys,json; o=json.load(sys.stdin)['GeneseProposalAIStack']; print(o['DocumentsBucketName'])")
FRONTEND_BUCKET=$(cat $OUTPUTS_FILE | python3 -c "import sys,json; o=json.load(sys.stdin)['GeneseProposalAIStack']; print(o['FrontendBucketName'])")
CLOUDFRONT_ID=$(cat $OUTPUTS_FILE | python3 -c "import sys,json; o=json.load(sys.stdin)['GeneseProposalAIStack']; print(o['CloudFrontDistributionId'])")
CLOUDFRONT_URL=$(cat $OUTPUTS_FILE | python3 -c "import sys,json; o=json.load(sys.stdin)['GeneseProposalAIStack']; print(o['CloudFrontUrl'])")
COGNITO_USER_POOL_ID=$(cat $OUTPUTS_FILE | python3 -c "import sys,json; o=json.load(sys.stdin)['GeneseProposalAIStack']; print(o['UserPoolId'])")
COGNITO_CLIENT_ID=$(cat $OUTPUTS_FILE | python3 -c "import sys,json; o=json.load(sys.stdin)['GeneseProposalAIStack']; print(o['UserPoolClientId'])")
ALB_DNS=$(cat $OUTPUTS_FILE | python3 -c "import sys,json; o=json.load(sys.stdin)['GeneseProposalAIStack']; print(o['AlbDnsName'])")
GENERATION_QUEUE_URL=$(cat $OUTPUTS_FILE | python3 -c "import sys,json; o=json.load(sys.stdin)['GeneseProposalAIStack']; print(o['GenerationQueueUrl'])")
TAVILY_SECRET_ARN=$(cat $OUTPUTS_FILE | python3 -c "import sys,json; o=json.load(sys.stdin)['GeneseProposalAIStack']; print(o['TavilySecretArn'])")
API_TASK_DEF=$(cat $OUTPUTS_FILE | python3 -c "import sys,json; o=json.load(sys.stdin)['GeneseProposalAIStack']; print(o['ApiTaskDefinitionArn'])")
WORKER_TASK_DEF=$(cat $OUTPUTS_FILE | python3 -c "import sys,json; o=json.load(sys.stdin)['GeneseProposalAIStack']; print(o['WorkerTaskDefinitionArn'])")
API_SG=$(cat $OUTPUTS_FILE | python3 -c "import sys,json; o=json.load(sys.stdin)['GeneseProposalAIStack']; print(o['ApiSecurityGroupId'])")
WORKER_SG=$(cat $OUTPUTS_FILE | python3 -c "import sys,json; o=json.load(sys.stdin)['GeneseProposalAIStack']; print(o['WorkerSecurityGroupId'])")
PRIVATE_SUBNET_1=$(cat $OUTPUTS_FILE | python3 -c "import sys,json; o=json.load(sys.stdin)['GeneseProposalAIStack']; print(o['PrivateSubnet1Id'])")
PRIVATE_SUBNET_2=$(cat $OUTPUTS_FILE | python3 -c "import sys,json; o=json.load(sys.stdin)['GeneseProposalAIStack']; print(o['PrivateSubnet2Id'])")
TARGET_GROUP_ARN=$(cat $OUTPUTS_FILE | python3 -c "import sys,json; o=json.load(sys.stdin)['GeneseProposalAIStack']; print(o['ApiTargetGroupArn'])")

echo "All CDK outputs parsed successfully."
```

---

### Step 5 — [CLI] Store Tavily API Key in Secrets Manager

The Secrets Manager secret `/genese/tavily-api-key` is created by CDK as an empty placeholder. This step writes the actual value.

```bash
if [ -n "$TAVILY_API_KEY" ]; then
  aws secretsmanager put-secret-value \
    --secret-id "$TAVILY_SECRET_ARN" \
    --secret-string "{\"TAVILY_API_KEY\": \"$TAVILY_API_KEY\"}" \
    --region $AWS_REGION
  echo "Tavily API key stored in Secrets Manager."
else
  echo "TAVILY_API_KEY not set — skipping. Tavily web search will be disabled."
fi
```

---

### Step 6 — [CLI] Build and Push Docker Images

Builds both service images from the monorepo `services/` directory and pushes them to ECR.

```bash
# Authenticate Docker to ECR
aws ecr get-login-password --region $AWS_REGION | \
  docker login --username AWS --password-stdin $AWS_ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com

API_REPO=$AWS_ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com/genese-proposal-ai-api
WORKER_REPO=$AWS_ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com/genese-proposal-ai-worker

# Build API image
# Context is services/ — the Dockerfile is at services/api/Dockerfile
docker build \
  -t genese-api:latest \
  -f services/api/Dockerfile \
  services/

# Build Worker image
docker build \
  -t genese-worker:latest \
  -f services/worker/Dockerfile \
  services/

# Tag and push API
docker tag genese-api:latest $API_REPO:latest
docker push $API_REPO:latest

# Tag and push Worker
docker tag genese-worker:latest $WORKER_REPO:latest
docker push $WORKER_REPO:latest

echo "Images pushed:"
echo "  API:    $API_REPO:latest"
echo "  Worker: $WORKER_REPO:latest"
```

---

### Step 7 — [CLI] Run Database Migration as Fargate Task

Aurora PostgreSQL is deployed in private subnets with no public access. The only way to run migrations is from within the VPC using a Fargate task.

`deploy.sh` runs the worker container with a migration command override. The worker image already contains all migration scripts.

**Migration history:**

| Version | Changes |
|---|---|
| v1 | `CREATE TABLE users, documents, document_chunks, generation_jobs` + `pgvector` extension |
| v2 | `ADD COLUMN outcome, proposal_score, pdf_s3_key, sme_report` to jobs; `ADD COLUMN role` to users |
| v3 | `ADD COLUMN template_name` to generation_jobs |
| v4 | `ADD COLUMN plain_text_instructions` to generation_jobs |

```bash
# Run all migrations via one-off Fargate task inside the VPC
MIGRATION_TASK_ARN=$(aws ecs run-task \
  --cluster genese-proposal-ai \
  --task-definition $WORKER_TASK_DEF \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={
    subnets=[$PRIVATE_SUBNET_1,$PRIVATE_SUBNET_2],
    securityGroups=[$WORKER_SG],
    assignPublicIp=DISABLED
  }" \
  --overrides '{
    "containerOverrides": [{
      "name": "Worker",
      "command": ["python3", "src/db_migrate.py"]
    }]
  }' \
  --region $AWS_REGION \
  --query 'tasks[0].taskArn' \
  --output text)

echo "Migration task started: $MIGRATION_TASK_ARN"

# Wait for the migration task to complete
aws ecs wait tasks-stopped \
  --cluster genese-proposal-ai \
  --tasks $MIGRATION_TASK_ARN \
  --region $AWS_REGION

# Check exit code
EXIT_CODE=$(aws ecs describe-tasks \
  --cluster genese-proposal-ai \
  --tasks $MIGRATION_TASK_ARN \
  --region $AWS_REGION \
  --query 'tasks[0].containers[0].exitCode' \
  --output text)

if [ "$EXIT_CODE" != "0" ]; then
  echo "ERROR: Migration task failed with exit code $EXIT_CODE"
  echo "Check logs: aws logs get-log-events --log-group-name /ecs/genese-worker --log-stream-name ecs/Worker/..."
  exit 1
fi

echo "Database migration completed successfully."
```

**To run a specific migration manually** (e.g., if adding a new version):
```bash
# Upload migration script to S3 (accessible from within VPC)
aws s3 cp services/worker/src/db_migration_v4.py \
  s3://$DOCUMENTS_BUCKET/scripts/db_migration_v4.py

# Run as one-off task with S3 download + execute
aws ecs run-task \
  --cluster genese-proposal-ai \
  --task-definition $WORKER_TASK_DEF \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={
    subnets=[$PRIVATE_SUBNET_1],
    securityGroups=[$WORKER_SG],
    assignPublicIp=DISABLED
  }" \
  --overrides '{
    "containerOverrides": [{
      "name": "Worker",
      "command": [
        "python3", "-c",
        "import boto3,os; s3=boto3.client(\"s3\"); s3.download_file(os.environ[\"DOCUMENTS_BUCKET\"],\"scripts/db_migration_v4.py\",\"/tmp/migrate.py\"); exec(open(\"/tmp/migrate.py\").read())"
      ]
    }]
  }' \
  --region $AWS_REGION
```

---

### Step 8 — [CLI] Create ECS Services

> ⚠️ **NEVER put ECS services in CDK.** See [Section 4](#4-cdk-vs-cli--the-critical-distinction) for the full explanation.

This step creates two long-running ECS Fargate services. It is idempotent — if the services already exist, the `aws ecs create-service` call returns `ServiceAlreadyExistsException` and the script continues.

```bash
# Create API service
aws ecs create-service \
  --cluster genese-proposal-ai \
  --service-name genese-api-service \
  --task-definition $API_TASK_DEF \
  --desired-count 1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={
    subnets=[$PRIVATE_SUBNET_1,$PRIVATE_SUBNET_2],
    securityGroups=[$API_SG],
    assignPublicIp=DISABLED
  }" \
  --load-balancers "targetGroupArn=$TARGET_GROUP_ARN,containerName=Api,containerPort=8000" \
  --health-check-grace-period-seconds 60 \
  --deployment-configuration "maximumPercent=200,minimumHealthyPercent=100" \
  --region $AWS_REGION \
  2>/dev/null || echo "API service already exists"

# Create Worker service (no ALB — polls SQS)
aws ecs create-service \
  --cluster genese-proposal-ai \
  --service-name genese-worker-service \
  --task-definition $WORKER_TASK_DEF \
  --desired-count 1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={
    subnets=[$PRIVATE_SUBNET_1,$PRIVATE_SUBNET_2],
    securityGroups=[$WORKER_SG],
    assignPublicIp=DISABLED
  }" \
  --deployment-configuration "maximumPercent=200,minimumHealthyPercent=100" \
  --region $AWS_REGION \
  2>/dev/null || echo "Worker service already exists"

echo "Waiting for services to reach steady state (~2-3 minutes)..."
aws ecs wait services-stable \
  --cluster genese-proposal-ai \
  --services genese-api-service genese-worker-service \
  --region $AWS_REGION

echo "Both ECS services are running."
```

---

### Step 9 — [CLI] Add CloudFront /api/* Proxy + StripApiPrefix Function

The CloudFront distribution created by CDK serves the React SPA. This step adds an `/api/*` behavior that proxies requests to the ALB, and a CloudFront Function that strips the `/api` prefix before forwarding to the ALB (so `/api/v1/health` becomes `/v1/health`).

```bash
# Create the StripApiPrefix CloudFront Function
FUNCTION_CODE='
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri.startsWith("/api")) {
    request.uri = uri.substring(4) || "/";
  }
  return request;
}'

# Create function (or update if exists)
FUNCTION_ARN=$(aws cloudfront create-function \
  --name StripApiPrefix \
  --function-config "Comment=Strip /api prefix before forwarding to ALB,Runtime=cloudfront-js-1.0" \
  --function-code "$FUNCTION_CODE" \
  --region us-east-1 \
  --query 'FunctionSummary.FunctionMetadata.FunctionARN' \
  --output text 2>/dev/null) || \
FUNCTION_ARN=$(aws cloudfront describe-function \
  --name StripApiPrefix \
  --region us-east-1 \
  --query 'FunctionSummary.FunctionMetadata.FunctionARN' \
  --output text)

# Publish the function
aws cloudfront publish-function \
  --name StripApiPrefix \
  --if-match $(aws cloudfront describe-function --name StripApiPrefix \
    --query 'ETag' --output text) \
  --region us-east-1

# Get current CloudFront distribution config
ETAG=$(aws cloudfront get-distribution-config \
  --id $CLOUDFRONT_ID \
  --query 'ETag' \
  --output text)

aws cloudfront get-distribution-config \
  --id $CLOUDFRONT_ID \
  --query 'DistributionConfig' \
  > /tmp/cf-config.json

# Add /api/* cache behavior pointing to ALB
# (deploy.sh uses Python to inject the behavior into the JSON)
python3 scripts/add_api_behavior.py \
  --config /tmp/cf-config.json \
  --alb-dns $ALB_DNS \
  --function-arn $FUNCTION_ARN \
  --output /tmp/cf-config-updated.json

aws cloudfront update-distribution \
  --id $CLOUDFRONT_ID \
  --if-match $ETAG \
  --distribution-config file:///tmp/cf-config-updated.json

echo "CloudFront /api/* behavior added. Distribution update takes ~1-2 minutes to propagate."
```

---

### Step 10 — [CLI] Build React Frontend + Sync to S3 + Invalidate CDN

The React frontend needs to know the Cognito User Pool ID, Client ID, and the API URL at build time. These values are injected as environment variables before `npm run build`.

```bash
cd frontend

# Install dependencies
npm install

# Set build-time environment variables
export REACT_APP_USER_POOL_ID=$COGNITO_USER_POOL_ID
export REACT_APP_CLIENT_ID=$COGNITO_CLIENT_ID
export REACT_APP_API_URL=https://$CLOUDFRONT_URL
export REACT_APP_AWS_REGION=$AWS_REGION

# Build production bundle
npm run build

cd ..

# Sync build output to S3 frontend bucket
# --delete removes old files not in the new build
aws s3 sync frontend/build/ s3://$FRONTEND_BUCKET/ \
  --delete \
  --region $AWS_REGION

# Invalidate CloudFront cache so users get the new version immediately
aws cloudfront create-invalidation \
  --distribution-id $CLOUDFRONT_ID \
  --paths "/*" \
  --region us-east-1

echo "Frontend deployed. CloudFront cache invalidation in progress (~30 seconds)."
```

---

### Step 11 — [CLI] Create Cognito Admin User

Creates the two default application users. Cognito User Pool has `self_sign_up_enabled=False`, so all users must be created by an admin.

```bash
# Create admin user
aws cognito-idp admin-create-user \
  --user-pool-id $COGNITO_USER_POOL_ID \
  --username admin@genesesolution.com \
  --temporary-password "TempPass123!" \
  --user-attributes \
    Name=email,Value=admin@genesesolution.com \
    Name=email_verified,Value=true \
  --message-action SUPPRESS \
  --region $AWS_REGION \
  2>/dev/null || echo "Admin user already exists"

# Set permanent password (skips forced-change-on-first-login)
aws cognito-idp admin-set-user-password \
  --user-pool-id $COGNITO_USER_POOL_ID \
  --username admin@genesesolution.com \
  --password "GeneseAdmin2024!" \
  --permanent \
  --region $AWS_REGION

# Create demo user
aws cognito-idp admin-create-user \
  --user-pool-id $COGNITO_USER_POOL_ID \
  --username demo@genesesolution.com \
  --temporary-password "TempPass123!" \
  --user-attributes \
    Name=email,Value=demo@genesesolution.com \
    Name=email_verified,Value=true \
  --message-action SUPPRESS \
  --region $AWS_REGION \
  2>/dev/null || echo "Demo user already exists"

aws cognito-idp admin-set-user-password \
  --user-pool-id $COGNITO_USER_POOL_ID \
  --username demo@genesesolution.com \
  --password "GeneseDemo2024!" \
  --permanent \
  --region $AWS_REGION

echo "Cognito users created:"
echo "  admin@genesesolution.com / GeneseAdmin2024!"
echo "  demo@genesesolution.com  / GeneseDemo2024!"
```

---

### Step 12 — [CLI] Seed Knowledge Base (Optional)

Seeds 10 sample proposal documents into the system. This step is skipped if the `--skip-seed` flag is passed to `deploy.sh` or if the API is not yet reachable.

```bash
# This step calls the API directly to upload sample documents
# The API must be running (Step 8 complete) before this runs

API_BASE_URL="https://$CLOUDFRONT_URL"

# Login to get auth token
TOKEN=$(curl -s -X POST "$API_BASE_URL/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@genesesolution.com","password":"GeneseAdmin2024!"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

# Upload each sample document
for doc in sample-documents/*.pdf; do
  curl -s -X POST "$API_BASE_URL/api/v1/documents/upload" \
    -H "Authorization: Bearer $TOKEN" \
    -F "file=@$doc" \
    -F "title=$(basename $doc .pdf)"
  echo "Uploaded: $doc"
done

echo "Knowledge base seeding complete."
```

---

### Step 13 — [CHECK] Verify Deployment

`deploy.sh` runs a series of health checks and prints a summary.

```bash
# Check ALB health endpoint (direct)
echo "Checking ALB health..."
curl -f http://$ALB_DNS/health && echo "ALB: OK" || echo "ALB: FAILED"

# Check CloudFront frontend
echo "Checking CloudFront frontend..."
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" https://$CLOUDFRONT_URL)
[ "$HTTP_STATUS" = "200" ] && echo "Frontend: OK ($HTTP_STATUS)" || echo "Frontend: FAILED ($HTTP_STATUS)"

# Check API via CloudFront
echo "Checking API via CloudFront..."
curl -f https://$CLOUDFRONT_URL/api/health && echo "API via CDN: OK" || echo "API via CDN: FAILED"

# Check ECS service status
echo "Checking ECS services..."
aws ecs describe-services \
  --cluster genese-proposal-ai \
  --services genese-api-service genese-worker-service \
  --region $AWS_REGION \
  --query 'services[].{Name:serviceName, Desired:desiredCount, Running:runningCount, Status:status}' \
  --output table

echo ""
echo "============================================"
echo "  Genese Proposal AI deployment complete!"
echo "============================================"
echo "  Frontend:  https://$CLOUDFRONT_URL"
echo "  API (ALB): http://$ALB_DNS"
echo "  Admin:     admin@genesesolution.com / GeneseAdmin2024!"
echo "  Demo:      demo@genesesolution.com  / GeneseDemo2024!"
echo "============================================"
```

---

## 9. Environment Variables Reference

These variables are set in the ECS task definitions by CDK. They are resolved at task launch time from CDK stack outputs and Secrets Manager.

| Variable | Source | Used By | Description |
|---|---|---|---|
| `DB_SECRET_ARN` | CDK output | API, Worker | ARN of `/genese/db-credentials` Secrets Manager secret |
| `TAVILY_SECRET_ARN` | CDK output | API | ARN of `/genese/tavily-api-key` Secrets Manager secret |
| `DOCUMENTS_BUCKET` | CDK output | API, Worker | S3 bucket name for document storage |
| `GENERATION_QUEUE_URL` | CDK output | API, Worker | SQS queue URL for generation jobs |
| `AWS_REGION` | CDK output | API, Worker | AWS region (e.g., `us-east-1`) |
| `COGNITO_USER_POOL_ID` | CDK output | API | Cognito User Pool ID for JWT validation |
| `COGNITO_CLIENT_ID` | CDK output | API | Cognito App Client ID |
| `BEDROCK_LLM_MODEL_ID` | Optional override | Worker | Bedrock model ID. Default: `us.anthropic.claude-sonnet-4-6` |

**The database connection string is NOT an environment variable.** The API and Worker fetch the full DB credentials JSON from Secrets Manager at startup using `DB_SECRET_ARN`. This avoids putting passwords in task definition plaintext.

**To override the Bedrock model** (e.g., to use Claude 3 Haiku for cost savings):
```bash
# Update the task definition with a new env var override
aws ecs describe-task-definition \
  --task-definition genese-worker \
  --region us-east-1 \
  --query 'taskDefinition' > /tmp/worker_td.json

# Edit /tmp/worker_td.json to add/change BEDROCK_LLM_MODEL_ID in environment[]
# Then register a new revision:
aws ecs register-task-definition \
  --cli-input-json file:///tmp/worker_td.json \
  --region us-east-1
```

---

## 10. Database Migrations

Aurora PostgreSQL is in private subnets. **There is no way to connect to it from outside the VPC.** All schema changes must be run as a Fargate task inside the VPC.

### Migration Versions

| Version | File | Schema Changes |
|---|---|---|
| v1 | `db_migrate.py` (initial) | CREATE TABLE `users`; CREATE TABLE `documents`; CREATE TABLE `document_chunks`; CREATE TABLE `generation_jobs`; CREATE EXTENSION `pgvector` |
| v2 | `db_migration_v2.py` | ALTER TABLE `generation_jobs` ADD COLUMN `outcome`, `proposal_score`, `pdf_s3_key`, `sme_report`; ALTER TABLE `users` ADD COLUMN `role` |
| v3 | `db_migration_v3.py` | ALTER TABLE `generation_jobs` ADD COLUMN `template_name` |
| v4 | `db_migration_v4.py` | ALTER TABLE `generation_jobs` ADD COLUMN `plain_text_instructions` |

### Running a Migration Manually

All migrations are idempotent (use `ADD COLUMN IF NOT EXISTS` and `CREATE TABLE IF NOT EXISTS`).

```bash
# Set these from your CDK outputs first
CLUSTER=genese-proposal-ai
WORKER_TASK_DEF=<worker-task-def-arn-from-cdk-outputs>
PRIVATE_SUBNET_1=<subnet-id>
WORKER_SG=<security-group-id>
AWS_REGION=us-east-1

# Run the latest migration
aws ecs run-task \
  --cluster $CLUSTER \
  --task-definition $WORKER_TASK_DEF \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={
    subnets=[$PRIVATE_SUBNET_1],
    securityGroups=[$WORKER_SG],
    assignPublicIp=DISABLED
  }" \
  --overrides '{"containerOverrides":[{
    "name":"Worker",
    "command":["python3","src/db_migrate.py"]
  }]}' \
  --region $AWS_REGION

# Monitor migration logs
aws logs tail /ecs/genese-worker --follow --region $AWS_REGION
```

### Adding a New Migration (v5+)

1. Create `services/worker/src/db_migration_v5.py` with idempotent SQL
2. Add it to `db_migrate.py` migration sequence
3. Rebuild and push the worker image (Step 6)
4. Run the migration task (above command)

---

## 11. Rolling Updates (Code Changes Only)

Use this when you have updated application code but the infrastructure has not changed. This does NOT re-run CDK.

### Update API Service

```bash
AWS_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
AWS_REGION=us-east-1
API_REPO=$AWS_ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com/genese-proposal-ai-api

# 1. Build new image
docker build \
  -t genese-api:latest \
  -f services/api/Dockerfile \
  services/

# 2. Push to ECR
aws ecr get-login-password --region $AWS_REGION | \
  docker login --username AWS --password-stdin $AWS_ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com

docker tag genese-api:latest $API_REPO:latest
docker push $API_REPO:latest

# 3. Get current task definition ARN
CURR_TD=$(aws ecs describe-services \
  --cluster genese-proposal-ai \
  --services genese-api-service \
  --region $AWS_REGION \
  --query 'services[0].taskDefinition' \
  --output text)

# 4. Extract task definition JSON (only the fields needed for re-registration)
TD_JSON=$(aws ecs describe-task-definition \
  --task-definition "$CURR_TD" \
  --region $AWS_REGION \
  --query 'taskDefinition' \
  --output json | python3 -c "
import sys, json
td = json.load(sys.stdin)
keys = ['family','networkMode','containerDefinitions','requiresCompatibilities',
        'cpu','memory','taskRoleArn','executionRoleArn']
print(json.dumps({k: td[k] for k in keys}))
")

echo "$TD_JSON" > /tmp/new_td.json

# 5. Register new task definition revision
NEW_ARN=$(aws ecs register-task-definition \
  --cli-input-json file:///tmp/new_td.json \
  --region $AWS_REGION \
  --query 'taskDefinition.taskDefinitionArn' \
  --output text)

echo "New task definition: $NEW_ARN"

# 6. Rolling update (zero downtime — 200% max, 100% min healthy)
aws ecs update-service \
  --cluster genese-proposal-ai \
  --service genese-api-service \
  --task-definition $NEW_ARN \
  --deployment-configuration "maximumPercent=200,minimumHealthyPercent=100" \
  --region $AWS_REGION

# 7. Wait for rollout to complete
aws ecs wait services-stable \
  --cluster genese-proposal-ai \
  --services genese-api-service \
  --region $AWS_REGION

echo "API rolling update complete."
```

### Update Worker Service

Same process, replace `genese-proposal-ai-api` with `genese-proposal-ai-worker` and `genese-api-service` with `genese-worker-service`.

### Update Frontend Only

```bash
cd frontend
npm install
export REACT_APP_USER_POOL_ID=<cognito-user-pool-id>
export REACT_APP_CLIENT_ID=<cognito-client-id>
export REACT_APP_API_URL=https://d3gmhvny3loneb.cloudfront.net
export REACT_APP_AWS_REGION=us-east-1
npm run build
cd ..

aws s3 sync frontend/build/ s3://<frontend-bucket>/ --delete
aws cloudfront create-invalidation --distribution-id <dist-id> --paths "/*"
```

---

## 12. Verification Checklist

Run these checks after any deployment or update to confirm everything is working.

```bash
# 1. ECS service status
aws ecs describe-services \
  --cluster genese-proposal-ai \
  --services genese-api-service genese-worker-service \
  --region us-east-1 \
  --query 'services[].{Name:serviceName,Desired:desiredCount,Running:runningCount,Status:status}' \
  --output table

# Expected:
# | genese-api-service    | 1 | 1 | ACTIVE |
# | genese-worker-service | 1 | 1 | ACTIVE |

# 2. ALB health check
curl -f http://Genese-ApiLB-XYr1qAvXxyX7-1479126617.us-east-1.elb.amazonaws.com/health
# Expected: {"status":"healthy"}

# 3. Frontend loads via CloudFront
curl -s -o /dev/null -w "%{http_code}" https://d3gmhvny3loneb.cloudfront.net
# Expected: 200

# 4. API accessible via CloudFront /api/* proxy
curl -f https://d3gmhvny3loneb.cloudfront.net/api/health
# Expected: {"status":"healthy"}

# 5. Cognito login works
aws cognito-idp initiate-auth \
  --auth-flow USER_PASSWORD_AUTH \
  --client-id <cognito-client-id> \
  --auth-parameters USERNAME=admin@genesesolution.com,PASSWORD=GeneseAdmin2024! \
  --region us-east-1 \
  --query 'AuthenticationResult.AccessToken' \
  --output text
# Expected: long JWT token string (not "None")

# 6. SQS queue is reachable
aws sqs get-queue-attributes \
  --queue-url <generation-queue-url> \
  --attribute-names ApproximateNumberOfMessages \
  --region us-east-1
# Expected: {"Attributes": {"ApproximateNumberOfMessages": "0"}}

# 7. Check recent API logs
aws logs tail /ecs/genese-api --since 5m --region us-east-1

# 8. Check recent Worker logs
aws logs tail /ecs/genese-worker --since 5m --region us-east-1
```

---

## 13. Production Hardening Checklist

The following items are **not yet implemented** in the current deployment. Address these before serving production traffic.

| Item | Current State | Action Required | Priority |
|---|---|---|---|
| ECS desired count | `desiredCount=1` on both services | Set `desiredCount=2` for HA | High |
| Aurora RemovalPolicy | `DESTROY` — deletes DB on `cdk destroy` | Change to `RemovalPolicy.RETAIN` in CDK | Critical |
| S3 RemovalPolicy | `DESTROY` — deletes buckets on `cdk destroy` | Change to `RemovalPolicy.RETAIN` in CDK | Critical |
| Aurora PITR backups | Not configured | Enable Point-in-Time Recovery on Aurora cluster | High |
| WAF on CloudFront | Not configured | Attach AWS WAF WebACL to CloudFront distribution | High |
| HTTPS on ALB | HTTP only (port 80) | Add ACM certificate + HTTPS:443 listener on ALB | High |
| CORS policy | `allow_origins=["*"]` | Lock CORS to `https://d3gmhvny3loneb.cloudfront.net` | Medium |
| CloudWatch alarms | Not configured | Create alarms for: DLQ depth > 0, ECS task crashes, Aurora CPU > 80% | Medium |
| Secrets rotation | Not configured | Enable automatic rotation for `/genese/db-credentials` | Medium |
| VPC Flow Logs | Not configured | Enable for security audit trail | Low |

### Changing RemovalPolicy (Critical — Do This Before Production)

In `infrastructure/lib/genese-proposal-ai-stack.ts`, find the Aurora cluster and S3 bucket constructs and change:

```typescript
// BEFORE (destroys data on cdk destroy):
removalPolicy: cdk.RemovalPolicy.DESTROY

// AFTER (retains data — must delete manually):
removalPolicy: cdk.RemovalPolicy.RETAIN
```

Then redeploy: `cd infrastructure && cdk deploy GeneseProposalAIStack`

---

## 14. Teardown

Use this to completely remove all AWS resources. **This will destroy all data if RemovalPolicy is still set to DESTROY.**

```bash
AWS_REGION=us-east-1

# Step 1: Scale down ECS services to 0 (allows service deletion)
aws ecs update-service \
  --cluster genese-proposal-ai \
  --service genese-api-service \
  --desired-count 0 \
  --region $AWS_REGION

aws ecs update-service \
  --cluster genese-proposal-ai \
  --service genese-worker-service \
  --desired-count 0 \
  --region $AWS_REGION

# Wait for tasks to stop
sleep 30

# Step 2: Delete ECS services
aws ecs delete-service \
  --cluster genese-proposal-ai \
  --service genese-api-service \
  --region $AWS_REGION

aws ecs delete-service \
  --cluster genese-proposal-ai \
  --service genese-worker-service \
  --region $AWS_REGION

# Step 3: Delete ECR images (required before ECR repos can be deleted)
aws ecr batch-delete-image \
  --repository-name genese-proposal-ai-api \
  --image-ids imageTag=latest \
  --region $AWS_REGION

aws ecr batch-delete-image \
  --repository-name genese-proposal-ai-worker \
  --image-ids imageTag=latest \
  --region $AWS_REGION

# Step 4: Delete ECR repositories
aws ecr delete-repository \
  --repository-name genese-proposal-ai-api \
  --force \
  --region $AWS_REGION

aws ecr delete-repository \
  --repository-name genese-proposal-ai-worker \
  --force \
  --region $AWS_REGION

# Step 5: Destroy all CDK-managed infrastructure
# WARNING: With RemovalPolicy.DESTROY, this deletes Aurora, S3, Cognito, everything
cd infrastructure
cdk destroy GeneseProposalAIStack --force
cd ..

echo "Teardown complete. All resources removed."
```

> ⚠️ If `cdk destroy` fails due to non-empty S3 buckets, empty them first:
> ```bash
> aws s3 rm s3://<frontend-bucket>/ --recursive
> aws s3 rm s3://<docs-bucket>/ --recursive
> ```

---

## 15. Current Live State

This section documents the deployed state as of 2026-07-03.

| Resource | Value |
|---|---|
| AWS Account | `654654306837` |
| Region | `us-east-1` |
| CDK Stack | `GeneseProposalAIStack` (CREATE_COMPLETE) |
| API Service | `genese-api-service` — Task Definition rev 27, 1/1 running |
| Worker Service | `genese-worker-service` — Task Definition rev 28, 1/1 running |
| Frontend URL | `https://d3gmhvny3loneb.cloudfront.net` |
| API URL (ALB) | `http://Genese-ApiLB-XYr1qAvXxyX7-1479126617.us-east-1.elb.amazonaws.com` |
| Admin user | `admin@genesesolution.com` / `GeneseAdmin2024!` |
| Demo user | `demo@genesesolution.com` / `GeneseDemo2024!` |

### Verify Current Live State

```bash
# Check stack status
aws cloudformation describe-stacks \
  --stack-name GeneseProposalAIStack \
  --region us-east-1 \
  --query 'Stacks[0].{Status:StackStatus,Updated:LastUpdatedTime}' \
  --output table

# Check running task counts
aws ecs describe-services \
  --cluster genese-proposal-ai \
  --services genese-api-service genese-worker-service \
  --region us-east-1 \
  --query 'services[].{Service:serviceName,Running:runningCount,TaskDef:taskDefinition}' \
  --output table
```

---

## 16. Troubleshooting

### ECS task keeps stopping / not starting

```bash
# Check stopped task reason
aws ecs list-tasks \
  --cluster genese-proposal-ai \
  --service genese-api-service \
  --desired-status STOPPED \
  --region us-east-1

aws ecs describe-tasks \
  --cluster genese-proposal-ai \
  --tasks <task-arn> \
  --region us-east-1 \
  --query 'tasks[0].{StopCode:stopCode,StopReason:stoppedReason,Containers:containers[0].reason}'

# Check container logs
aws logs tail /ecs/genese-api --since 10m --region us-east-1
```

**Common causes:**
- Image not in ECR — run Step 6 again
- DB migration not run — run Step 7 again
- Secrets Manager secret value missing — check `/genese/db-credentials` has the right format

### ALB health check failing

```bash
# Check target group health
TARGET_GROUP_ARN=$(aws elbv2 describe-target-groups \
  --names genese-api-tg \
  --region us-east-1 \
  --query 'TargetGroups[0].TargetGroupArn' \
  --output text)

aws elbv2 describe-target-health \
  --target-group-arn $TARGET_GROUP_ARN \
  --region us-east-1
```

**Common causes:**
- Health check path wrong (should be `GET /health`)
- API container not listening on port 8000
- Security group not allowing ALB → ECS traffic on port 8000

### CloudFront /api/* returns 403 or 502

```bash
# Check CloudFront distribution behaviors
aws cloudfront get-distribution-config \
  --id <cloudfront-id> \
  --query 'DistributionConfig.CacheBehaviors' \
  --output json
```

**Common causes:**
- `/api/*` behavior not added (Step 9 not run)
- StripApiPrefix function not published
- ALB DNS name incorrect in CloudFront origin

### Aurora connection refused

Aurora is private — it can only be reached from within the VPC. If you need to inspect the database:

```bash
# Use a temporary Fargate task as a bastion
aws ecs run-task \
  --cluster genese-proposal-ai \
  --task-definition <worker-task-def> \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={
    subnets=[<private-subnet-id>],
    securityGroups=[<worker-sg-id>],
    assignPublicIp=DISABLED
  }" \
  --overrides '{
    "containerOverrides":[{
      "name":"Worker",
      "command":["python3","-c","
import json,boto3,psycopg2
sm=boto3.client(\"secretsmanager\")
creds=json.loads(sm.get_secret_value(SecretId=\"/genese/db-credentials\")[\"SecretString\"])
conn=psycopg2.connect(host=creds[\"host\"],dbname=creds[\"dbname\"],user=creds[\"username\"],password=creds[\"password\"])
cur=conn.cursor()
cur.execute(\"SELECT tablename FROM pg_tables WHERE schemaname=\\\"public\\\"\")
print(cur.fetchall())
      "]
    }]
  }' \
  --region us-east-1

aws logs tail /ecs/genese-worker --since 2m --region us-east-1
```

### Cognito login fails

```bash
# List users in pool
aws cognito-idp list-users \
  --user-pool-id <user-pool-id> \
  --region us-east-1

# Check user status (must be CONFIRMED, not FORCE_CHANGE_PASSWORD)
aws cognito-idp admin-get-user \
  --user-pool-id <user-pool-id> \
  --username admin@genesesolution.com \
  --region us-east-1 \
  --query '{Status:UserStatus,Enabled:Enabled}'

# If status is FORCE_CHANGE_PASSWORD, set permanent password again:
aws cognito-idp admin-set-user-password \
  --user-pool-id <user-pool-id> \
  --username admin@genesesolution.com \
  --password "GeneseAdmin2024!" \
  --permanent \
  --region us-east-1
```

### CDK deploy fails mid-way

CDK/CloudFormation will automatically roll back on failure. Check the CloudFormation events for the specific error:

```bash
aws cloudformation describe-stack-events \
  --stack-name GeneseProposalAIStack \
  --region us-east-1 \
  --query 'StackEvents[?ResourceStatus==`CREATE_FAILED`].{Resource:LogicalResourceId,Reason:ResourceStatusReason}' \
  --output table
```

After fixing the root cause, re-run `./deploy.sh` — it is idempotent and will continue from where it left off.

---

*This document is auto-generated by the deployment_master agent. For changes to the deployment process, update both `deploy.sh` and this document together.*
