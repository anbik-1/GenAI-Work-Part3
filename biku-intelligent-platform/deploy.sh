#!/bin/bash
# =============================================================================
# deploy.sh — Biku Intelligent Platform: One-Script Full Deployment
# =============================================================================
#
# USAGE:
#   chmod +x deploy.sh
#   ./deploy.sh
#
# OPTIONAL CONFIGURATION (export before running):
#   export ADMIN_EMAIL="admin@yourcompany.com"
#   export ADMIN_PASSWORD="YourPassword123!"
#   export TAVILY_API_KEY="tvly-xxxxxxxxxxxx"    # from app.tavily.com (free)
#   export AWS_DEFAULT_REGION="us-east-1"
#
# RE-RUNNING: This script is idempotent — safe to run again after code changes.
#   It will update images, update ECS services, and re-sync the frontend.
#
# =============================================================================
# CDK vs CLI — WHY BOTH ARE USED
# =============================================================================
#
#  CDK (AWS Cloud Development Kit) handles INFRASTRUCTURE — things that are
#  permanent, stateful, and rarely change:
#    VPC, subnets, S3, CloudFront, Cognito, Aurora PostgreSQL, SQS, ECR,
#    ECS Cluster, ECS Task Definitions, ALB, IAM roles, Secrets Manager.
#
#  CLI (AWS CLI) handles RUNTIME OPERATIONS — things that depend on images
#  being ready first, or that CloudFormation cannot reliably manage:
#
#    WHY ECS SERVICES ARE CLI AND NOT CDK:
#    CloudFormation waits for ECS services to reach "steady state" (all tasks
#    running and passing health checks). This wait can block for up to 3 HOURS
#    and then roll back the entire stack if it times out. During development
#    this happened repeatedly because:
#      - The Docker image wasn't in ECR yet when CFN tried to start the task
#      - Health check timing caused tasks to fail before CFN gave up waiting
#    The fix: CDK creates the cluster + task definitions. CLI creates the
#    actual services AFTER images are in ECR. CFN never blocks on ECS again.
#
#    WHY CLOUDFRONT /api/* BEHAVIOR IS CLI AND NOT CDK:
#    The CDK CloudFront construct creates the distribution pointing at S3.
#    The ALB origin + StripApiPrefix function need to be added AFTER the
#    ALB DNS name is known (which comes from CDK outputs). Chicken-and-egg.
#
#    WHY DB MIGRATION IS CLI AND NOT CDK:
#    Aurora is in a private subnet — unreachable from the internet.
#    We run the migration as a one-off ECS Fargate task inside the VPC,
#    triggered via CLI after CDK creates the networking.
#
# =============================================================================
# STEP SUMMARY
# =============================================================================
#  Step  1  [TOOL]   Check prerequisites (python3, node, aws, docker, cdk)
#  Step  2  [CLI]    Create ECR repositories (must exist before CDK)
#  Step  3  [CDK]    Bootstrap + deploy all infrastructure
#  Step  4  [CLI]    Read CDK stack outputs into variables
#  Step  5  [CLI]    Store Tavily API key in Secrets Manager
#  Step  6  [CLI]    Build Docker images + push to ECR
#  Step  7  [CLI]    Run DB migration inside VPC via one-off ECS task
#  Step  8  [CLI]    Create ECS services (NOT CDK — see WHY above)
#  Step  9  [CLI]    Add CloudFront /api/* → ALB proxy behavior
#  Step 10  [CLI]    Build React frontend + sync to S3 + invalidate cache
#  Step 11  [CLI]    Create Cognito admin user
#  Step 12  [CLI]    Seed 10 sample documents into knowledge base
#  Step 13  [CHECK]  Verify health, frontend, login all work
# =============================================================================

set -euo pipefail

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
error()   { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }
step()    { echo -e "\n${BLUE}══════════════════════════════════════════════${NC}"; \
            echo -e "${BLUE}  STEP $1${NC}"; \
            echo -e "${BLUE}══════════════════════════════════════════════${NC}"; }
cdk_step()  { echo -e "${GREEN}  [CDK]${NC} $1"; }
cli_step()  { echo -e "${YELLOW}  [CLI]${NC} $1"; }

# ── Configuration ─────────────────────────────────────────────────────────────
REGION="${AWS_DEFAULT_REGION:-us-east-1}"
STACK_NAME="BikuIntelligentPlatformStack"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@bikuplatform.com}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-BikuAdmin2024!}"
TAVILY_API_KEY="${TAVILY_API_KEY:-}"   # Optional — get free key at app.tavily.com
SEED_DOCS=true                          # Set to false to skip seeding sample documents

# =============================================================================
# STEP 1 — Prerequisites Check [TOOL: local checks only, no AWS calls yet]
# =============================================================================
step "1/13: Checking Prerequisites"
echo ""

# Python3
if command -v python3 >/dev/null 2>&1; then
  PY_VER=$(python3 --version 2>&1)
  success "  $PY_VER"
else
  error "python3 not found. Install: sudo dnf install python3   (Amazon Linux) or brew install python3 (macOS)"
fi

# Node.js (needed for frontend build)
if command -v node >/dev/null 2>&1; then
  success "  Node $(node --version)"
else
  error "node not found. Install Node 18+: sudo dnf install nodejs  or  https://nodejs.org"
fi

# AWS CLI
if command -v aws >/dev/null 2>&1; then
  success "  $(aws --version 2>&1 | head -1)"
else
  error "AWS CLI not found. Install: https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2.html"
fi

# Docker — must be running (not just installed)
if docker info >/dev/null 2>&1; then
  success "  Docker running"
else
  error "Docker not running or not installed. Start it: sudo systemctl start docker"
fi

# CDK
if command -v cdk >/dev/null 2>&1; then
  success "  CDK $(cdk --version 2>&1 | head -1)"
else
  warn "  CDK not found — installing via pip..."
  pip install aws-cdk-lib constructs -q
  success "  CDK installed"
fi

# AWS credentials
ACCOUNT=$(aws sts get-caller-identity --query Account --output text 2>/dev/null) || \
  error "AWS credentials not configured. Run: aws configure  (needs AdministratorAccess)"
IDENTITY=$(aws sts get-caller-identity --query Arn --output text 2>/dev/null)
success "  AWS Account $ACCOUNT ($IDENTITY)"
success "  Region: $REGION"

# Directory structure
[[ -f "infrastructure/app.py" ]]  || error "Wrong directory. cd into biku-intelligent-platform/ first"
[[ -d "services/api" ]]           || error "Missing services/api/"
[[ -d "services/worker" ]]        || error "Missing services/worker/"
[[ -d "frontend" ]]               || error "Missing frontend/"
success "  Project structure OK"
echo ""

# =============================================================================
# STEP 2 — Create ECR Repositories [CLI]
# =============================================================================
# WHY CLI and not CDK:
#   The CDK stack uses ecr.Repository.from_repository_name() to reference
#   repos by name. The repos must already exist before CDK runs, otherwise
#   CDK synth fails. We create them first, then CDK just references them.
# =============================================================================
step "2/13: Creating ECR Repositories  [CLI]"
cli_step "ECR repos must exist BEFORE CDK deploys (CDK references them by name)"

for REPO in biku-intelligent-platform-api biku-intelligent-platform-worker; do
  RESULT=$(aws ecr create-repository \
    --repository-name "$REPO" \
    --region "$REGION" \
    --query 'repository.repositoryUri' \
    --output text 2>/dev/null || echo "exists")
  if [[ "$RESULT" == "exists" ]]; then
    info "  Already exists: $REPO"
  else
    success "  Created: $REPO"
  fi
done

# =============================================================================
# STEP 3 — CDK Bootstrap + Deploy [CDK]
# =============================================================================
# WHAT CDK DEPLOYS (everything permanent and stateful):
#   - VPC (2 AZs, public + private subnets, 1 NAT gateway)
#   - S3 bucket for uploaded documents (private)
#   - S3 bucket for frontend static files (private, CloudFront-accessible)
#   - CloudFront distribution (HTTPS, points at S3 for /* by default)
#   - Cognito User Pool + App Client (JWT auth)
#   - Aurora PostgreSQL Serverless v2 (pgvector enabled via migration)
#   - SQS queue (generation jobs) + Dead Letter Queue
#   - ECR repositories (already created above, CDK references them)
#   - ECS Cluster
#   - ECS Task Definitions for API and Worker (with IAM, env vars, logging)
#   - Application Load Balancer + Target Group + HTTP Listener
#   - IAM Task Role (Bedrock, S3, SQS, Secrets) + Execution Role
#   - Secrets Manager (DB credentials auto-generated, Tavily placeholder)
#   - CloudWatch Log Groups
#
# WHAT CDK DOES NOT DEPLOY:
#   - ECS Services (created in Step 8 via CLI — see that step for why)
#   - CloudFront /api/* behavior (added in Step 9 via CLI)
#   - Docker images (built/pushed in Step 6 via CLI)
#   - DB schema (migrated in Step 7 via CLI ECS task)
#   - Cognito users (created in Step 11 via CLI)
# =============================================================================
step "3/13: CDK Bootstrap + Deploy  [CDK]"
cdk_step "Deploying: VPC, S3, CloudFront, Cognito, Aurora, SQS, ECR, ECS cluster+taskdefs, ALB, IAM"
cdk_step "NOT deploying: ECS services, CloudFront API behavior, DB schema, Docker images"
echo ""

cd infrastructure
pip install -r requirements.txt -q

info "Bootstrapping CDK (one-time per account/region — safe to re-run)..."
cdk bootstrap "aws://$ACCOUNT/$REGION" 2>&1 | grep -E "Environment|already|error" || true

info "Running cdk deploy (this takes 10-15 min — Aurora is the slowest resource)..."
cdk deploy --require-approval never 2>&1 | tee /tmp/cdk_output.log | \
  grep -E "GeneseProposalAI|Output|Complete|Error|FAILED|CREATE|UPDATE" || true

STATUS=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --query 'Stacks[0].StackStatus' \
  --output text 2>/dev/null || echo "MISSING")

[[ "$STATUS" == "CREATE_COMPLETE" || "$STATUS" == "UPDATE_COMPLETE" ]] || \
  error "CDK deploy failed. Stack status: $STATUS. Check CloudFormation console."

success "CDK stack status: $STATUS"
cd ..

# =============================================================================
# STEP 4 — Read CDK Outputs [CLI]
# =============================================================================
# WHY: CDK writes resource identifiers (URLs, ARNs, IDs) as CloudFormation
#   stack outputs. We read them here so every subsequent step can use them
#   without hardcoding anything. This makes the script portable across accounts.
# =============================================================================
step "4/13: Reading CDK Stack Outputs  [CLI]"
cli_step "Parsing CloudFormation outputs to get resource IDs for all remaining steps"

get_output() {
  aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$REGION" \
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

# Validate critical outputs
[[ -z "$API_URL" ]]          && error "Missing CDK output: ApiUrl"
[[ -z "$CF_URL" ]]           && error "Missing CDK output: CloudFrontUrl"
[[ -z "$CF_FRONTEND_BUCKET" ]] && error "Missing CDK output: FrontendBucketName"
[[ -z "$API_REPO_URI" ]]     && error "Missing CDK output: ApiRepoUri"
[[ -z "$WORKER_REPO_URI" ]]  && error "Missing CDK output: WorkerRepoUri"
[[ -z "$TARGET_GROUP_ARN" ]] && error "Missing CDK output: TargetGroupArn"

success "  API URL:          $API_URL"
success "  CloudFront URL:   $CF_URL"
success "  Frontend Bucket:  $CF_FRONTEND_BUCKET"
success "  Docs Bucket:      $CF_DOCS_BUCKET"
success "  User Pool:        $USER_POOL_ID"
success "  API ECR:          $API_REPO_URI"
success "  Worker ECR:       $WORKER_REPO_URI"

# Save for reference / sourcing later
cat > /tmp/biku_outputs.env << ENVEOF
export API_URL="$API_URL"
export CF_URL="$CF_URL"
export CF_FRONTEND_BUCKET="$CF_FRONTEND_BUCKET"
export CF_DOCS_BUCKET="$CF_DOCS_BUCKET"
export USER_POOL_ID="$USER_POOL_ID"
export USER_POOL_CLIENT_ID="$USER_POOL_CLIENT_ID"
export API_REPO_URI="$API_REPO_URI"
export WORKER_REPO_URI="$WORKER_REPO_URI"
export DB_SECRET_ARN="$DB_SECRET_ARN"
export TAVILY_SECRET_ARN="$TAVILY_SECRET_ARN"
export TARGET_GROUP_ARN="$TARGET_GROUP_ARN"
export ALB_DNS="$ALB_DNS"
ENVEOF
info "  All outputs saved to /tmp/biku_outputs.env (source this to reuse variables)"

# =============================================================================
# STEP 5 — Set Tavily API Key [CLI]
# =============================================================================
# WHY: CDK creates a Secrets Manager secret with a placeholder value.
#   We update it here with the real key if provided.
#   If not provided, the app still works — Tavily is optional. Generation
#   just won't do live web validation of architecture recommendations.
#   Get a free key (1000 req/month) at: https://app.tavily.com
# =============================================================================
step "5/13: Tavily API Key  [CLI]"
cli_step "CDK already created the secret. This step puts the real value in."

if [[ -n "$TAVILY_API_KEY" ]]; then
  aws secretsmanager put-secret-value \
    --secret-id "$TAVILY_SECRET_ARN" \
    --secret-string "{\"api_key\":\"$TAVILY_API_KEY\"}" \
    --region "$REGION" > /dev/null
  success "  Tavily API key stored in Secrets Manager"
else
  warn "  No TAVILY_API_KEY set — skipping. App works without it."
  warn "  To add later:"
  warn "    export TAVILY_API_KEY=tvly-xxx"
  warn "    aws secretsmanager put-secret-value \\"
  warn "      --secret-id $TAVILY_SECRET_ARN \\"
  warn "      --secret-string '{\"api_key\":\"\$TAVILY_API_KEY\"}'"
fi

# =============================================================================
# STEP 6 — Build and Push Docker Images [CLI]
# =============================================================================
# WHY CLI and not CDK:
#   CDK is infrastructure-as-code, not a build system. It knows about ECR
#   repos and task definitions but doesn't build images.
#   Images must be in ECR BEFORE ECS services start (Step 8), otherwise
#   ECS tasks fail to start (image pull error).
#
# TWO IMAGES:
#   genese-api    — FastAPI server (0.5 vCPU / 1GB RAM)
#                   Handles: HTTP requests, auth, DB reads/writes, SQS publish
#                   Build context: services/ directory
#                   Dockerfile: services/api/Dockerfile
#
#   genese-worker — LangChain + Bedrock worker (1 vCPU / 2GB RAM)
#                   Handles: RAG retrieval, Claude calls, diagram generation, .docx
#                   Build context: services/ directory
#                   Dockerfile: services/worker/Dockerfile
#                   Includes: graphviz (apt) + diagrams library (pip) for arch diagrams
# =============================================================================
step "6/13: Building and Pushing Docker Images  [CLI]"
cli_step "Building 2 images: API (FastAPI) and Worker (LangChain+Bedrock)"

info "  Authenticating Docker to ECR..."
aws ecr get-login-password --region "$REGION" | \
  docker login --username AWS --password-stdin \
  "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com" 2>&1 | grep -E "Login|Error" || true

info "  Building API image..."
docker build -t biku-api -f services/api/Dockerfile services/ 2>&1 | tail -2
docker tag biku-api:latest "$API_REPO_URI:latest"
docker push "$API_REPO_URI:latest" 2>&1 | tail -2
success "  API image pushed to ECR"

info "  Building Worker image (includes graphviz for architecture diagrams)..."
docker build -t biku-worker -f services/worker/Dockerfile services/ 2>&1 | tail -2
docker tag biku-worker:latest "$WORKER_REPO_URI:latest"
docker push "$WORKER_REPO_URI:latest" 2>&1 | tail -2
success "  Worker image pushed to ECR"

# =============================================================================
# STEP 7 — Run Database Migration [CLI: one-off ECS Fargate task]
# =============================================================================
# WHY CLI and not CDK:
#   Aurora PostgreSQL is in a PRIVATE subnet — no public internet access.
#   You cannot connect to it from your laptop or this EC2 directly.
#   Solution: run a one-off ECS Fargate task INSIDE the VPC using the same
#   subnets and security groups as the worker. The task:
#     1. Downloads the migration script from S3 (uploaded here)
#     2. Connects to Aurora using credentials from Secrets Manager
#     3. Creates all tables and indexes
#     4. Exits with code 0 on success
#
# TABLES CREATED:
#   users             — Cognito user records
#   documents         — Uploaded document metadata + indexing status + tokens
#   document_chunks   — Text chunks + 1024-dim pgvector embeddings
#   generation_jobs   — Job tracking, status, output, arch diagram, tokens
# =============================================================================
step "7/13: Database Migration  [CLI: one-off ECS task inside VPC]"
cli_step "Aurora is in a private subnet — migration runs as a Fargate task inside the VPC"

VPC_ID=$(aws ec2 describe-vpcs --region "$REGION" \
  --filters "Name=tag:Name,Values=${STACK_NAME}/Vpc" \
  --query 'Vpcs[0].VpcId' --output text)

PRIV_SUBNET=$(aws ec2 describe-subnets --region "$REGION" \
  --filters "Name=vpc-id,Values=$VPC_ID" "Name=tag:aws-cdk:subnet-type,Values=Private" \
  --query 'Subnets[0].SubnetId' --output text)

WORKER_SG=$(aws ec2 describe-security-groups --region "$REGION" \
  --filters "Name=vpc-id,Values=$VPC_ID" "Name=group-name,Values=*WorkerSG*" \
  --query 'SecurityGroups[0].GroupId' --output text)

WORKER_TD=$(aws ecs list-task-definitions --region "$REGION" \
  --query 'taskDefinitionArns[?contains(@,`WorkerTask`)][-1]' --output text)

info "  VPC: $VPC_ID | Subnet: $PRIV_SUBNET | SG: $WORKER_SG"

cat > /tmp/db_migrate.py << 'PYEOF'
import json, boto3, psycopg2, os, sys
region = os.environ.get("AWS_REGION", "us-east-1")
sm = boto3.client("secretsmanager", region_name=region)
secret_arn = os.environ.get("DB_SECRET_ARN", "")
if not secret_arn:
    print("ERROR: DB_SECRET_ARN not set"); sys.exit(1)
s = json.loads(sm.get_secret_value(SecretId=secret_arn)["SecretString"])
conn = psycopg2.connect(host=s["host"], port=int(s.get("port", 5432)),
    dbname=s.get("dbname", "biku"), user=s["username"], password=s["password"])
conn.set_isolation_level(0)
cur = conn.cursor()

# Extensions
cur.execute("CREATE EXTENSION IF NOT EXISTS vector;")

# users table (includes role for RBAC)
cur.execute("""CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cognito_sub VARCHAR(255) UNIQUE NOT NULL,
    email VARCHAR(255) NOT NULL,
    name VARCHAR(255),
    role VARCHAR(20) DEFAULT 'member',
    created_at TIMESTAMPTZ DEFAULT NOW());""")
cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'member';")

# documents table
cur.execute("""CREATE TABLE IF NOT EXISTS documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    filename VARCHAR(500) NOT NULL, document_type VARCHAR(50) NOT NULL,
    engagement_type VARCHAR(100), client_name VARCHAR(255),
    s3_key VARCHAR(1000) NOT NULL, chunk_count INTEGER DEFAULT 0, uploaded_by UUID,
    ingestion_status VARCHAR(50) DEFAULT 'pending',
    embedding_model VARCHAR(255), embedding_tokens INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW());""")

# document_chunks table with pgvector
cur.execute("""CREATE TABLE IF NOT EXISTS document_chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL, content TEXT NOT NULL,
    embedding vector(1024), metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW());""")
cur.execute("""CREATE INDEX IF NOT EXISTS idx_chunks_embedding
    ON document_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists=10);""")

# generation_jobs table — all columns including v2/v3/v4 additions
cur.execute("""CREATE TABLE IF NOT EXISTS generation_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID,
    document_type VARCHAR(50) NOT NULL,
    client_name VARCHAR(255) NOT NULL,
    engagement_type VARCHAR(100) NOT NULL,
    key_requirements TEXT NOT NULL,
    context_notes TEXT,
    status VARCHAR(50) DEFAULT 'queued',
    status_detail VARCHAR(255),
    rag_context JSONB,
    tavily_sources JSONB,
    output_s3_key VARCHAR(1000),
    error_message TEXT,
    llm_model VARCHAR(255),
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    arch_json JSONB,
    arch_s3_key VARCHAR(1000),
    arch_iteration INTEGER DEFAULT 0,
    sections_content JSONB,
    drawio_s3_key VARCHAR(1000),
    pdf_s3_key VARCHAR(1000),
    proposal_score JSONB,
    sme_report JSONB,
    outcome VARCHAR(20) DEFAULT 'pending',
    template_name VARCHAR(100),
    plain_text_instructions TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ);""")

# Ensure all columns exist (idempotent for existing installs)
for col_sql in [
    "ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS sections_content JSONB;",
    "ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS drawio_s3_key VARCHAR(1000);",
    "ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS pdf_s3_key VARCHAR(1000);",
    "ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS proposal_score JSONB;",
    "ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS sme_report JSONB;",
    "ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS outcome VARCHAR(20) DEFAULT 'pending';",
    "ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS template_name VARCHAR(100);",
    "ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS plain_text_instructions TEXT;",
]:
    cur.execute(col_sql)

# arch_references table for style reference images
cur.execute("""CREATE TABLE IF NOT EXISTS arch_references (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    engagement_type VARCHAR(100) DEFAULT 'general',
    s3_key VARCHAR(1000) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW());""")

print("Migration complete — all tables, indexes, and columns created")
cur.close(); conn.close()
PYEOF

aws s3 cp /tmp/db_migrate.py "s3://$CF_DOCS_BUCKET/scripts/db_migrate.py" \
  --region "$REGION" > /dev/null
info "  Migration script uploaded to S3"

info "  Launching one-off Fargate task for migration..."
MIGRATE_TASK=$(aws ecs run-task \
  --cluster biku-intelligent-platform \
  --task-definition "$WORKER_TD" \
  --launch-type FARGATE \
  --network-configuration \
    "awsvpcConfiguration={subnets=[$PRIV_SUBNET],securityGroups=[$WORKER_SG],assignPublicIp=DISABLED}" \
  --overrides "{\"containerOverrides\":[{\"name\":\"Worker\",\"command\":[\"python3\",\"-c\",\
\"import boto3;b=boto3.client('s3',region_name='$REGION');\
b.download_file('$CF_DOCS_BUCKET','scripts/db_migrate.py','/tmp/m.py');\
exec(open('/tmp/m.py').read())\"]}]}" \
  --region "$REGION" \
  --query 'tasks[0].taskArn' --output text)

MIGRATE_ID=$(echo "$MIGRATE_TASK" | sed 's/.*\///')
info "  Task ID: $MIGRATE_ID — waiting 90s for completion..."
sleep 90

EXIT_CODE=$(aws ecs describe-tasks \
  --cluster biku-intelligent-platform \
  --tasks "$MIGRATE_ID" \
  --region "$REGION" \
  --query 'tasks[0].containers[0].exitCode' \
  --output text 2>/dev/null || echo "unknown")

if [[ "$EXIT_CODE" == "0" ]]; then
  success "  Database migration succeeded"
else
  warn "  Migration exit code: $EXIT_CODE"
  warn "  To check logs: aws logs tail /ecs/biku-intelligent-platform-worker --since 5m --region $REGION"
fi

# =============================================================================
# STEP 8 — Create ECS Services [CLI — intentionally NOT CDK]
# =============================================================================
# WHY CLI AND NOT CDK (THIS IS THE MOST IMPORTANT DEVIATION):
#
#   We learned this the hard way. When ECS services are in CDK/CloudFormation,
#   CFN enters a "wait for stabilization" loop that can run for 3 HOURS before
#   timing out and rolling back the ENTIRE stack. This destroys Aurora, S3,
#   Cognito, and all other infra — requiring a full redeploy from scratch.
#
#   Root cause: ECS service stabilization requires:
#     1. ECS task starts (image must exist in ECR ✓ — we just pushed)
#     2. Container passes health check (ALB pings /health every 30s)
#     3. Target group registers the task as healthy
#   If anything in this chain is slow, CFN waits... and waits... and rolls back.
#
#   The CLI approach: we create the service AFTER images are in ECR and AFTER
#   we have all the networking details. If it fails, only the service is
#   affected — the rest of the infrastructure stays intact.
#
# TWO SERVICES:
#   genese-api-service     — FastAPI HTTP server, connected to ALB Target Group
#                            Runs 1 task (scale to 2 for HA)
#   genese-worker-service  — SQS consumer, no ALB attachment
#                            Runs 1 task (scale out to handle more jobs)
#
# IDEMPOTENCY: If services already exist, this step updates them instead.
# =============================================================================
step "8/13: Creating ECS Services  [CLI — must NOT be CDK]"
cli_step "REASON: CloudFormation ECS stabilization waits 3+ hours and rolls back everything"
cli_step "CLI creates services after images are ready — safe, fast, no CFN risk"

API_SG=$(aws ec2 describe-security-groups --region "$REGION" \
  --filters "Name=vpc-id,Values=$VPC_ID" "Name=group-name,Values=*ApiSG*" \
  --query 'SecurityGroups[0].GroupId' --output text)

PRIV_SUBNETS=$(aws ec2 describe-subnets --region "$REGION" \
  --filters "Name=vpc-id,Values=$VPC_ID" "Name=tag:aws-cdk:subnet-type,Values=Private" \
  --query 'Subnets[*].SubnetId' --output text | tr '\t' ',')

API_TD=$(aws ecs list-task-definitions --region "$REGION" \
  --query 'taskDefinitionArns[?contains(@,`ApiTask`)][-1]' --output text)

info "  API SG: $API_SG | Worker SG: $WORKER_SG"
info "  Private subnets: $PRIV_SUBNETS"

# ── API Service ───────────────────────────────────────────────────────────────
API_STATUS=$(aws ecs describe-services \
  --cluster biku-intelligent-platform \
  --services biku-api-service \
  --region "$REGION" \
  --query 'services[0].status' \
  --output text 2>/dev/null || echo "MISSING")

if [[ "$API_STATUS" == "ACTIVE" ]]; then
  info "  API service exists — updating task definition to use new image..."
  TD_JSON=$(aws ecs describe-task-definition \
    --task-definition "$API_TD" --region "$REGION" \
    --query 'taskDefinition' --output json | \
    python3 -c "import sys,json; td=json.load(sys.stdin); \
      print(json.dumps({k:td[k] for k in ['family','networkMode','containerDefinitions',\
      'requiresCompatibilities','cpu','memory','taskRoleArn','executionRoleArn']}))")
  echo "$TD_JSON" > /tmp/new_api_td.json
  NEW_API_ARN=$(aws ecs register-task-definition \
    --cli-input-json file:///tmp/new_api_td.json \
    --region "$REGION" \
    --query 'taskDefinition.taskDefinitionArn' --output text)
  aws ecs update-service \
    --cluster biku-intelligent-platform \
    --service biku-api-service \
    --task-definition "$NEW_API_ARN" \
    --deployment-configuration "maximumPercent=200,minimumHealthyPercent=100" \
    --region "$REGION" > /dev/null
  success "  API service updated (rolling deploy — zero downtime)"
else
  aws ecs create-service \
    --cluster biku-intelligent-platform \
    --service-name biku-api-service \
    --task-definition "$API_TD" \
    --desired-count 1 \
    --launch-type FARGATE \
    --network-configuration \
      "awsvpcConfiguration={subnets=[$PRIV_SUBNETS],securityGroups=[$API_SG],assignPublicIp=DISABLED}" \
    --load-balancers \
      "targetGroupArn=$TARGET_GROUP_ARN,containerName=Api,containerPort=8000" \
    --health-check-grace-period-seconds 60 \
    --deployment-configuration "maximumPercent=100,minimumHealthyPercent=0" \
    --region "$REGION" > /dev/null
  success "  API service created"
fi

# ── Worker Service ─────────────────────────────────────────────────────────────
WORKER_STATUS=$(aws ecs describe-services \
  --cluster biku-intelligent-platform \
  --services biku-worker-service \
  --region "$REGION" \
  --query 'services[0].status' \
  --output text 2>/dev/null || echo "MISSING")

if [[ "$WORKER_STATUS" == "ACTIVE" ]]; then
  info "  Worker service exists — updating task definition..."
  TD_JSON_W=$(aws ecs describe-task-definition \
    --task-definition "$WORKER_TD" --region "$REGION" \
    --query 'taskDefinition' --output json | \
    python3 -c "import sys,json; td=json.load(sys.stdin); \
      print(json.dumps({k:td[k] for k in ['family','networkMode','containerDefinitions',\
      'requiresCompatibilities','cpu','memory','taskRoleArn','executionRoleArn']}))")
  echo "$TD_JSON_W" > /tmp/new_worker_td.json
  NEW_WORKER_ARN=$(aws ecs register-task-definition \
    --cli-input-json file:///tmp/new_worker_td.json \
    --region "$REGION" \
    --query 'taskDefinition.taskDefinitionArn' --output text)
  aws ecs update-service \
    --cluster biku-intelligent-platform \
    --service biku-worker-service \
    --task-definition "$NEW_WORKER_ARN" \
    --deployment-configuration "maximumPercent=200,minimumHealthyPercent=100" \
    --region "$REGION" > /dev/null
  success "  Worker service updated (rolling deploy — zero downtime)"
else
  aws ecs create-service \
    --cluster biku-intelligent-platform \
    --service-name biku-worker-service \
    --task-definition "$WORKER_TD" \
    --desired-count 1 \
    --launch-type FARGATE \
    --network-configuration \
      "awsvpcConfiguration={subnets=[$PRIV_SUBNETS],securityGroups=[$WORKER_SG],assignPublicIp=DISABLED}" \
    --deployment-configuration "maximumPercent=200,minimumHealthyPercent=100" \
    --region "$REGION" > /dev/null
  success "  Worker service created"
fi

info "  Waiting for both services to reach runningCount=1 (up to 5 min)..."
for i in $(seq 1 18); do
  API_R=$(aws ecs describe-services --cluster biku-intelligent-platform \
    --services biku-api-service --region "$REGION" \
    --query 'services[0].runningCount' --output text 2>/dev/null || echo 0)
  WRK_R=$(aws ecs describe-services --cluster biku-intelligent-platform \
    --services biku-worker-service --region "$REGION" \
    --query 'services[0].runningCount' --output text 2>/dev/null || echo 0)
  echo -e "    [${i}/18] API running=$API_R  Worker running=$WRK_R"
  [[ "$API_R" == "1" && "$WRK_R" == "1" ]] && break
  sleep 20
done
sleep 10
HEALTH_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$API_URL/health" 2>/dev/null || echo "000")
[[ "$HEALTH_CODE" == "200" ]] && success "  API responding (HTTP $HEALTH_CODE)" || \
  warn "  API health: HTTP $HEALTH_CODE (may still be starting — continuing)"

# =============================================================================
# STEP 9 — CloudFront /api/* Proxy [CLI]
# =============================================================================
# WHY CLI and not CDK:
#   CDK creates the CloudFront distribution pointing at the S3 frontend bucket.
#   We need to ADD a second origin (the ALB) and a cache behavior for /api/*.
#   This can't be done cleanly in CDK because the ALB DNS name only exists
#   after the CDK deploy is complete — it's a dependency ordering problem.
#
# WHAT THIS DOES:
#   Browser hits https://cloudfront-domain/api/generate
#     → CloudFront sees /api/* → routes to ALB origin
#     → StripApiPrefix function removes /api prefix → /generate
#     → ALB forwards to ECS API task port 8000
#   This is how HTTPS (CloudFront) talks to HTTP (ALB) without browser
#   "mixed content" errors.
#
# StripApiPrefix function: CloudFront JS function (not Lambda) that runs at
#   the edge before the request hits the ALB. Strips the /api prefix.
# =============================================================================
step "9/13: CloudFront /api/* Proxy  [CLI]"
cli_step "Adding ALB origin + StripApiPrefix function to existing CloudFront distribution"

CF_DIST_ID=$(aws cloudfront list-distributions \
  --query "DistributionList.Items[?contains(to_string(Origins.Items[0].DomainName),'biku-intelligent-platform-frontend')].Id" \
  --output text)

[[ -z "$CF_DIST_ID" ]] && error "Could not find CloudFront distribution. Check CDK deployed correctly."
info "  CloudFront distribution: $CF_DIST_ID"

# Check if already configured
EXISTING_BEHAVIOR=$(aws cloudfront get-distribution-config \
  --id "$CF_DIST_ID" \
  --query "DistributionConfig.CacheBehaviors.Items[?PathPattern=='/api/*'].PathPattern" \
  --output text 2>/dev/null || echo "")

if [[ -n "$EXISTING_BEHAVIOR" ]]; then
  success "  /api/* behavior already configured — skipping"
else
  info "  Creating StripApiPrefix CloudFront Function..."
  cat > /tmp/cf_func.js << 'JSEOF'
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri.startsWith("/api")) { request.uri = uri.slice(4) || "/"; }
  return request;
}
JSEOF

  CF_FUNC_ARN=$(aws cloudfront create-function \
    --name "StripApiPrefix" \
    --function-config '{"Comment":"Strip /api prefix before forwarding to ALB","Runtime":"cloudfront-js-2.0"}' \
    --function-code fileb:///tmp/cf_func.js \
    --region us-east-1 \
    --query 'FunctionSummary.FunctionMetadata.FunctionARN' \
    --output text 2>/dev/null || \
    aws cloudfront describe-function --name StripApiPrefix \
      --query 'FunctionSummary.FunctionMetadata.FunctionARN' --output text)

  FUNC_ETAG=$(aws cloudfront describe-function --name StripApiPrefix \
    --query 'ETag' --output text 2>/dev/null || echo "")
  if [[ -n "$FUNC_ETAG" ]]; then
    aws cloudfront publish-function \
      --name StripApiPrefix --if-match "$FUNC_ETAG" > /dev/null 2>&1 || true
  fi

  CF_ETAG=$(aws cloudfront get-distribution-config \
    --id "$CF_DIST_ID" --query 'ETag' --output text)
  aws cloudfront get-distribution-config \
    --id "$CF_DIST_ID" --query 'DistributionConfig' --output json > /tmp/cf_config.json

  python3 << PYEOF
import json
with open('/tmp/cf_config.json') as f:
    config = json.load(f)

alb_dns = "$ALB_DNS"
func_arn = "$CF_FUNC_ARN"

existing_ids = [o['Id'] for o in config['Origins']['Items']]
if 'Genese-API-ALB' not in existing_ids:
    config['Origins']['Items'].append({
        "Id": "Genese-API-ALB", "DomainName": alb_dns,
        "CustomOriginConfig": {
            "HTTPPort": 80, "HTTPSPort": 443,
            "OriginProtocolPolicy": "http-only",
            "OriginSslProtocols": {"Quantity": 1, "Items": ["TLSv1.2"]},
            "OriginReadTimeout": 60, "OriginKeepaliveTimeout": 5
        },
        "OriginPath": "", "CustomHeaders": {"Quantity": 0, "Items": []},
        "ConnectionAttempts": 3, "ConnectionTimeout": 10,
        "OriginShield": {"Enabled": False}, "OriginAccessControlId": ""
    })
    config['Origins']['Quantity'] += 1

api_behavior = {
    "PathPattern": "/api/*", "TargetOriginId": "Genese-API-ALB",
    "ViewerProtocolPolicy": "https-only",
    "AllowedMethods": {
        "Quantity": 7,
        "Items": ["GET","HEAD","OPTIONS","PUT","POST","PATCH","DELETE"],
        "CachedMethods": {"Quantity": 2, "Items": ["GET","HEAD"]}
    },
    "Compress": True,
    "CachePolicyId": "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
    "OriginRequestPolicyId": "216adef6-5c7f-47e4-b989-5492eafa07d3",
    "TrustedSigners": {"Enabled": False, "Quantity": 0},
    "TrustedKeyGroups": {"Enabled": False, "Quantity": 0},
    "LambdaFunctionAssociations": {"Quantity": 0, "Items": []},
    "FunctionAssociations": {
        "Quantity": 1 if func_arn else 0,
        "Items": [{"FunctionARN": func_arn, "EventType": "viewer-request"}] if func_arn else []
    },
    "FieldLevelEncryptionId": "", "SmoothStreaming": False,
    "GrpcConfig": {"Enabled": False}
}

existing_behaviors = config.get('CacheBehaviors', {}).get('Items', [])
patterns = [b['PathPattern'] for b in existing_behaviors]
if '/api/*' not in patterns:
    existing_behaviors.insert(0, api_behavior)
    config['CacheBehaviors'] = {"Quantity": len(existing_behaviors), "Items": existing_behaviors}

with open('/tmp/cf_updated.json', 'w') as f:
    json.dump(config, f)
print("  CloudFront config written")
PYEOF

  aws cloudfront update-distribution \
    --id "$CF_DIST_ID" \
    --distribution-config file:///tmp/cf_updated.json \
    --if-match "$CF_ETAG" > /dev/null

  success "  /api/* behavior added to CloudFront"
  info "  Waiting for CloudFront to deploy (~2 min)..."
  aws cloudfront wait distribution-deployed --id "$CF_DIST_ID" 2>/dev/null || \
    info "  CloudFront still propagating — continuing (it finishes within 5 min)"
fi

# =============================================================================
# STEP 10 — Build and Deploy Frontend [CLI]
# =============================================================================
# WHY CLI and not CDK:
#   CDK creates the S3 bucket but doesn't build or deploy your app code.
#   Frontend must be built AFTER CDK so we know the CloudFront URL to set
#   as VITE_API_URL. In this case VITE_API_URL="/api" (relative path)
#   which means it always points to the same domain — no hardcoded URLs.
# =============================================================================
step "10/13: Build and Deploy Frontend  [CLI]"
cli_step "Building React app and syncing to S3. Invalidating CloudFront cache."

cd frontend
info "  Installing npm dependencies..."
npm install --silent
info "  Building React app (VITE_API_URL=/api)..."
VITE_API_URL="/api" npm run build 2>&1 | tail -4
info "  Syncing to S3..."
aws s3 sync dist/ "s3://$CF_FRONTEND_BUCKET/" \
  --delete --region "$REGION" --quiet
success "  Frontend deployed to S3"
info "  Invalidating CloudFront cache (old files cleared from edge)..."
aws cloudfront create-invalidation \
  --distribution-id "$CF_DIST_ID" \
  --paths "/*" > /dev/null
success "  CloudFront cache invalidated"
cd ..

# =============================================================================
# STEP 11 — Create Cognito Admin User [CLI]
# =============================================================================
# WHY CLI and not CDK:
#   CDK creates the Cognito User Pool and App Client (the "schema").
#   User accounts are data, not infrastructure — created via CLI.
#   admin-create-user creates the user, admin-set-user-password sets a
#   permanent password (skips the "change password on first login" flow).
# =============================================================================
step "11/13: Creating Admin User  [CLI]"
cli_step "CDK created the User Pool. CLI creates the actual user account."

aws cognito-idp admin-create-user \
  --user-pool-id "$USER_POOL_ID" \
  --username "$ADMIN_EMAIL" \
  --temporary-password "Temp1234!" \
  --message-action SUPPRESS \
  --user-attributes \
    "Name=email,Value=$ADMIN_EMAIL" \
    "Name=name,Value=Admin" \
  --region "$REGION" > /dev/null 2>&1 \
  && info "  User created" \
  || info "  User already exists"

aws cognito-idp admin-set-user-password \
  --user-pool-id "$USER_POOL_ID" \
  --username "$ADMIN_EMAIL" \
  --password "$ADMIN_PASSWORD" \
  --permanent \
  --region "$REGION" > /dev/null

success "  Admin user ready: $ADMIN_EMAIL / $ADMIN_PASSWORD"

# =============================================================================
# STEP 12 — Seed Knowledge Base [CLI]
# =============================================================================
# WHY: RAG (Retrieval Augmented Generation) requires documents in the
#   knowledge base BEFORE generation can produce good results. Without
#   documents, Claude generates generic proposals with no Genese context.
#   These 10 synthetic samples (proposals, SoWs, case studies) give the
#   system something to work with immediately.
#   Replace with your REAL Genese documents for production quality.
# =============================================================================
step "12/13: Seeding Knowledge Base  [CLI: API calls]"

if [[ "$SEED_DOCS" == "true" ]] && [[ -d "scripts/seed_documents" ]]; then
  info "  Getting auth token..."
  TOKEN=$(curl -s -X POST "$API_URL/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" | \
    python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('idToken',''))" 2>/dev/null || echo "")

  if [[ -n "$TOKEN" ]]; then
    declare -A META=(
      ["proposal_aws_migration_horizon.txt"]="proposal|aws_migration|Horizon Financial"
      ["proposal_data_platform_retailmax.txt"]="proposal|data_platform|RetailMax Nepal"
      ["proposal_managed_services_medicare.txt"]="proposal|managed_services|MediCare Plus"
      ["proposal_security_audit_bankcorp.txt"]="proposal|security_audit|BankCorp Nepal"
      ["sow_cloud_infrastructure_techventure.txt"]="sow|cloud_native_development|TechVenture"
      ["sow_devops_softglobal.txt"]="sow|devops_transformation|SoftGlobal Nepal"
      ["sow_data_engineering_neptelco.txt"]="sow|data_platform|NepTelco"
      ["case_study_fintech_neppay.txt"]="case_study|aws_migration|NepPay"
      ["case_study_retail_shopnepal.txt"]="case_study|cloud_native_development|ShopNepal"
      ["case_study_healthcare_nphi.txt"]="case_study|data_platform|NPHI"
    )
    SEEDED=0
    for FILE in "${!META[@]}"; do
      FILEPATH="scripts/seed_documents/$FILE"
      [[ -f "$FILEPATH" ]] || continue
      IFS='|' read -r DOC_TYPE ENG_TYPE CLIENT <<< "${META[$FILE]}"
      HTTP=$(curl -s -o /dev/null -w "%{http_code}" \
        -X POST "$API_URL/documents/upload" \
        -H "Authorization: Bearer $TOKEN" \
        -F "file=@$FILEPATH;type=text/plain" \
        -F "document_type=$DOC_TYPE" \
        -F "engagement_type=$ENG_TYPE" \
        -F "client_name=$CLIENT")
      if [[ "$HTTP" == "202" ]]; then
        ((SEEDED++))
        info "    Uploaded: $FILE"
      else
        warn "    $FILE: HTTP $HTTP"
      fi
      sleep 0.5
    done
    success "  Seeded $SEEDED/10 documents — indexing continues in background (~2 min)"
    info "  Replace with real Genese docs via Documents page for production quality"
  else
    warn "  Could not get auth token — skipping seed. Upload docs manually after deploy."
  fi
else
  info "  Skipping (SEED_DOCS=false or scripts/seed_documents/ not found)"
fi

# =============================================================================
# STEP 13 — Final Verification [CHECK]
# =============================================================================
step "13/13: Final Verification"

echo ""
PASS=0; FAIL=0

# 1. ALB health check
HEALTH=$(curl -s "$API_URL/health" 2>/dev/null || echo "{}")
if echo "$HEALTH" | python3 -c \
  "import sys,json;d=json.load(sys.stdin);exit(0 if d.get('status')=='healthy' else 1)" 2>/dev/null; then
  success "  API health endpoint OK"
  ((PASS++))
else
  warn "  API health: $HEALTH"
  ((FAIL++))
fi

# 2. Frontend via CloudFront
CF_HTTP=$(curl -s -o /dev/null -w "%{http_code}" "$CF_URL" 2>/dev/null || echo "000")
if [[ "$CF_HTTP" == "200" ]]; then
  success "  Frontend accessible via CloudFront (HTTP $CF_HTTP)"
  ((PASS++))
else
  warn "  Frontend: HTTP $CF_HTTP"
  ((FAIL++))
fi

# 3. Login via HTTPS CloudFront proxy
CF_LOGIN=$(curl -s -X POST "$CF_URL/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" 2>/dev/null || echo "{}")
if echo "$CF_LOGIN" | python3 -c \
  "import sys,json;d=json.load(sys.stdin);exit(0 if d.get('idToken') else 1)" 2>/dev/null; then
  success "  HTTPS login works (CloudFront → ALB → API → Cognito)"
  ((PASS++))
else
  warn "  HTTPS login failed — CloudFront may still be propagating (wait 2-3 min and retry)"
  ((FAIL++))
fi

echo ""
echo -e "  Checks passed: ${GREEN}$PASS${NC} / Failed: ${FAIL:+${RED}}$FAIL${NC}"

# =============================================================================
# DEPLOYMENT SUMMARY
# =============================================================================
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║        BIKU INTELLIGENT PLATFORM — DEPLOYMENT COMPLETE          ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${BLUE}Frontend URL:${NC}    $CF_URL"
echo -e "  ${BLUE}API (internal):${NC}  $API_URL"
echo -e "  ${BLUE}Admin Login:${NC}     $ADMIN_EMAIL  /  $ADMIN_PASSWORD"
echo -e "  ${BLUE}User Pool:${NC}       $USER_POOL_ID"
echo -e "  ${BLUE}Account/Region:${NC}  $ACCOUNT / $REGION"
echo ""
echo -e "  ${YELLOW}What CDK managed:${NC}"
echo -e "    VPC · S3 · CloudFront · Cognito · Aurora · SQS · ECR"
echo -e "    ECS cluster · Task Definitions · ALB · IAM · Secrets Manager"
echo ""
echo -e "  ${YELLOW}What CLI managed:${NC}"
echo -e "    ECR repos · Docker images · DB migration · ECS services"
echo -e "    CloudFront /api/* behavior · Frontend deploy · Cognito user · Seed docs"
echo ""
echo -e "  ${YELLOW}Next steps:${NC}"
echo -e "  1. Open $CF_URL — log in with $ADMIN_EMAIL"
if [[ -z "$TAVILY_API_KEY" ]]; then
echo -e "  2. Add Tavily key (free): export TAVILY_API_KEY=tvly-xxx && ./deploy.sh"
fi
echo -e "  3. Upload your REAL Genese proposals in the Documents page"
echo -e "  4. Try generating a proposal!"
echo ""
echo -e "  ${YELLOW}To deploy code changes:${NC}  ./deploy.sh   (safe to re-run anytime)"
echo -e "  ${YELLOW}Saved outputs:${NC}            source /tmp/biku_outputs.env"
echo ""
