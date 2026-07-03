#!/bin/bash
# =============================================================================
# deploy.sh — Genese Proposal AI: One-Script Full Deployment
# =============================================================================
# Run from the genese-proposal-ai/ directory:
#   chmod +x deploy.sh
#   ./deploy.sh
#
# What this script does (in order):
#   1. Checks prerequisites
#   2. Creates ECR repositories
#   3. CDK bootstrap + deploy (infrastructure)
#   4. Parses CDK outputs
#   5. Sets Tavily API key (optional)
#   6. Builds and pushes Docker images
#   7. Runs DB migration (via ECS task)
#   8. Creates ECS services (via CLI — NOT CDK)
#   9. Adds CloudFront /api/* proxy (via CLI)
#  10. Builds and deploys frontend to S3
#  11. Creates Cognito admin user
#  12. Seeds knowledge base with sample documents
#  13. Verifies everything is working
# =============================================================================

set -euo pipefail

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
error()   { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }
step()    { echo -e "\n${BLUE}═══════════════════════════════════════${NC}"; echo -e "${BLUE}STEP $1${NC}"; echo -e "${BLUE}═══════════════════════════════════════${NC}"; }

# ── Configuration (edit these) ─────────────────────────────────────────────────
REGION="${AWS_DEFAULT_REGION:-us-east-1}"
STACK_NAME="GeneseProposalAIStack"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@genesesolution.com}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-GeneseAdmin123!}"
TAVILY_API_KEY="${TAVILY_API_KEY:-}"   # Set this or export TAVILY_API_KEY=your-key
SEED_DOCS=true                          # Set to false to skip seeding sample documents

# ── Step 1: Prerequisites ──────────────────────────────────────────────────────
step "1/13: Checking Prerequisites"

echo ""
echo "Pre-flight checklist:"

# Python
if command -v python3 >/dev/null 2>&1; then
  PY_VER=$(python3 --version 2>&1 | grep -oP '3\.\d+')
  success "  python3 $PY_VER"
else
  error "python3 not found. Install Python 3.12+: sudo dnf install python3"
fi

# Node
if command -v node >/dev/null 2>&1; then
  NODE_VER=$(node --version)
  success "  node $NODE_VER"
else
  error "node not found. Install Node.js 18+: sudo dnf install nodejs"
fi

# AWS CLI
if command -v aws >/dev/null 2>&1; then
  success "  aws CLI $(aws --version 2>&1 | head -1)"
else
  error "aws CLI not found. Install: https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2.html"
fi

# Docker
if docker info >/dev/null 2>&1; then
  success "  docker running"
else
  error "Docker not running. Start Docker first: sudo systemctl start docker"
fi

# CDK
if command -v cdk >/dev/null 2>&1; then
  success "  cdk $(cdk --version 2>&1 | head -1)"
else
  warn "  cdk not found — installing..."
  pip install aws-cdk-lib constructs -q && success "  cdk installed"
fi

# AWS credentials
ACCOUNT=$(aws sts get-caller-identity --query Account --output text 2>/dev/null) || \
  error "AWS credentials not configured. Run: aws configure"
IDENTITY=$(aws sts get-caller-identity --query Arn --output text 2>/dev/null)
success "  AWS Account: $ACCOUNT ($IDENTITY)"

# Correct directory
[[ -f "infrastructure/app.py" ]] || \
  error "Wrong directory. Run from genese-proposal-ai/: cd genese-proposal-ai && ./deploy.sh"
[[ -d "services/api" ]] || error "Missing services/api directory"
[[ -d "services/worker" ]] || error "Missing services/worker directory"
[[ -d "frontend" ]] || error "Missing frontend directory"
success "  Directory structure OK"

echo ""

# ── Step 2: Create ECR Repositories ────────────────────────────────────────────
step "2/13: Creating ECR Repositories"

for REPO in genese-proposal-ai-api genese-proposal-ai-worker; do
  aws ecr create-repository --repository-name "$REPO" --region "$REGION" \
    --query 'repository.repositoryUri' --output text 2>/dev/null \
    && success "Created ECR: $REPO" \
    || info "ECR already exists: $REPO"
done

# ── Step 3: CDK Bootstrap + Deploy ─────────────────────────────────────────────
step "3/13: CDK Bootstrap + Deploy"

cd infrastructure
pip install -r requirements.txt -q

info "Bootstrapping CDK (one-time per account/region)..."
cdk bootstrap "aws://$ACCOUNT/$REGION" 2>&1 | grep -E "Environment|Trusted|error" || true

info "Deploying CDK stack (10-15 minutes for Aurora)..."
cdk deploy --require-approval never 2>&1 | tee /tmp/cdk_output.log | \
  grep -E "GeneseProposalAI|Output|Error|COMPLETE|FAILED" || true

# Check deployment succeeded
STATUS=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --region "$REGION" --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo "MISSING")
[[ "$STATUS" == "CREATE_COMPLETE" || "$STATUS" == "UPDATE_COMPLETE" ]] || \
  error "CDK deploy failed. Stack status: $STATUS"
success "CDK stack deployed: $STATUS"
cd ..

# ── Step 4: Parse CDK Outputs ──────────────────────────────────────────────────
step "4/13: Reading CDK Outputs"

get_output() {
  aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
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

success "API URL:     $API_URL"
success "CloudFront:  $CF_URL"
success "User Pool:   $USER_POOL_ID"

# Save outputs for reference
cat > /tmp/genese_outputs.env << EOF
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
EOF
info "Outputs saved to /tmp/genese_outputs.env"

# ── Step 5: Set Tavily API Key ─────────────────────────────────────────────────
step "5/13: Tavily API Key"

if [[ -n "$TAVILY_API_KEY" ]]; then
  aws secretsmanager put-secret-value \
    --secret-id "$TAVILY_SECRET_ARN" \
    --secret-string "{\"api_key\":\"$TAVILY_API_KEY\"}" \
    --region "$REGION" > /dev/null
  success "Tavily API key stored"
else
  warn "No TAVILY_API_KEY set. Generation works without it (no live web validation)."
  warn "To add later: aws secretsmanager put-secret-value --secret-id $TAVILY_SECRET_ARN --secret-string '{\"api_key\":\"YOUR_KEY\"}'"
fi

# ── Step 6: Build and Push Docker Images ───────────────────────────────────────
step "6/13: Building and Pushing Docker Images"

info "Authenticating to ECR..."
aws ecr get-login-password --region "$REGION" | \
  docker login --username AWS --password-stdin "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com" 2>&1 | \
  grep -E "Login|Error" || true

info "Building API image..."
docker build -t genese-api -f services/api/Dockerfile services/ 2>&1 | tail -3
docker tag genese-api:latest "$API_REPO_URI:latest"
docker push "$API_REPO_URI:latest" 2>&1 | tail -3
success "API image pushed"

info "Building Worker image..."
docker build -t genese-worker -f services/worker/Dockerfile services/ 2>&1 | tail -3
docker tag genese-worker:latest "$WORKER_REPO_URI:latest"
docker push "$WORKER_REPO_URI:latest" 2>&1 | tail -3
success "Worker image pushed"

# ── Step 7: Database Migration ─────────────────────────────────────────────────
step "7/13: Running Database Migration"

# Get VPC networking details
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

# Write migration script
cat > /tmp/db_migrate.py << 'PYEOF'
import json, boto3, psycopg2, os, sys
region = os.environ.get("AWS_REGION","us-east-1")
sm = boto3.client("secretsmanager", region_name=region)
secret_arn = os.environ.get("DB_SECRET_ARN","")
if not secret_arn:
    print("ERROR: DB_SECRET_ARN not set"); sys.exit(1)
s = json.loads(sm.get_secret_value(SecretId=secret_arn)["SecretString"])
conn = psycopg2.connect(host=s["host"],port=int(s.get("port",5432)),
    dbname=s.get("dbname","genese"),user=s["username"],password=s["password"])
conn.set_isolation_level(0)
cur = conn.cursor()
cur.execute("CREATE EXTENSION IF NOT EXISTS vector;")
cur.execute("""CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cognito_sub VARCHAR(255) UNIQUE NOT NULL, email VARCHAR(255) NOT NULL,
    name VARCHAR(255), created_at TIMESTAMPTZ DEFAULT NOW());""")
cur.execute("""CREATE TABLE IF NOT EXISTS documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    filename VARCHAR(500) NOT NULL, document_type VARCHAR(50) NOT NULL,
    engagement_type VARCHAR(100), client_name VARCHAR(255),
    s3_key VARCHAR(1000) NOT NULL, chunk_count INTEGER DEFAULT 0, uploaded_by UUID,
    ingestion_status VARCHAR(50) DEFAULT 'pending',
    embedding_model VARCHAR(255), embedding_tokens INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW());""")
cur.execute("""CREATE TABLE IF NOT EXISTS document_chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL, content TEXT NOT NULL,
    embedding vector(1024), metadata JSONB, created_at TIMESTAMPTZ DEFAULT NOW());""")
cur.execute("""CREATE INDEX IF NOT EXISTS idx_chunks_embedding
    ON document_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists=10);""")
cur.execute("""CREATE TABLE IF NOT EXISTS generation_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID, document_type VARCHAR(50) NOT NULL,
    client_name VARCHAR(255) NOT NULL, engagement_type VARCHAR(100) NOT NULL,
    key_requirements TEXT NOT NULL, context_notes TEXT,
    status VARCHAR(50) DEFAULT 'queued', status_detail VARCHAR(255),
    rag_context JSONB, tavily_sources JSONB, output_s3_key VARCHAR(1000),
    error_message TEXT, llm_model VARCHAR(255),
    input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
    arch_json JSONB, arch_s3_key VARCHAR(1000), arch_iteration INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(), completed_at TIMESTAMPTZ);""")
print("Migration complete — all tables created"); cur.close(); conn.close()
PYEOF

aws s3 cp /tmp/db_migrate.py "s3://$CF_DOCS_BUCKET/scripts/db_migrate.py" --region "$REGION" > /dev/null

info "Running migration inside VPC via ECS task..."
MIGRATE_TASK=$(aws ecs run-task \
  --cluster genese-proposal-ai \
  --task-definition "$WORKER_TD" \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$PRIV_SUBNET],securityGroups=[$WORKER_SG],assignPublicIp=DISABLED}" \
  --overrides "{\"containerOverrides\":[{\"name\":\"Worker\",\"command\":[\"python3\",\"-c\",\"import boto3;b=boto3.client('s3',region_name='$REGION');b.download_file('$CF_DOCS_BUCKET','scripts/db_migrate.py','/tmp/m.py');exec(open('/tmp/m.py').read())\"]}]}" \
  --region "$REGION" \
  --query 'tasks[0].taskArn' --output text)

MIGRATE_ID=$(echo "$MIGRATE_TASK" | sed 's/.*\///')
info "Migration task: $MIGRATE_ID (waiting 60s...)"
sleep 60

EXIT_CODE=$(aws ecs describe-tasks --cluster genese-proposal-ai \
  --tasks "$MIGRATE_ID" --region "$REGION" \
  --query 'tasks[0].containers[0].exitCode' --output text 2>/dev/null || echo "unknown")

[[ "$EXIT_CODE" == "0" ]] && success "Database migration succeeded" || \
  warn "Migration exit code: $EXIT_CODE — check logs if there are issues"

# ── Step 8: Create ECS Services via CLI ────────────────────────────────────────
step "8/13: Creating ECS Services"
# NOTE: ECS services are created via CLI intentionally.
# CloudFormation waits 3 hours for ECS stabilization — this caused
# repeated deployment failures. CLI bypasses CFN's wait entirely.

API_SG=$(aws ec2 describe-security-groups --region "$REGION" \
  --filters "Name=vpc-id,Values=$VPC_ID" "Name=group-name,Values=*ApiSG*" \
  --query 'SecurityGroups[0].GroupId' --output text)

PRIV_SUBNETS=$(aws ec2 describe-subnets --region "$REGION" \
  --filters "Name=vpc-id,Values=$VPC_ID" "Name=tag:aws-cdk:subnet-type,Values=Private" \
  --query 'Subnets[*].SubnetId' --output text | tr '\t' ',')

API_TD=$(aws ecs list-task-definitions --region "$REGION" \
  --query 'taskDefinitionArns[?contains(@,`ApiTask`)][-1]' --output text)

# Create API service (if not exists)
EXISTING=$(aws ecs describe-services --cluster genese-proposal-ai \
  --services genese-api-service --region "$REGION" \
  --query 'services[0].status' --output text 2>/dev/null || echo "MISSING")

if [[ "$EXISTING" == "ACTIVE" || "$EXISTING" == "DRAINING" ]]; then
  warn "API service exists (status=$EXISTING), updating task definition..."
  TD_JSON=$(aws ecs describe-task-definition --task-definition "$API_TD" \
    --region "$REGION" --query 'taskDefinition' --output json | \
    python3 -c "import sys,json;td=json.load(sys.stdin);print(json.dumps({k:td[k] for k in ['family','networkMode','containerDefinitions','requiresCompatibilities','cpu','memory','taskRoleArn','executionRoleArn']}))")
  echo "$TD_JSON" > /tmp/new_api_td.json
  NEW_ARN=$(aws ecs register-task-definition --cli-input-json file:///tmp/new_api_td.json \
    --region "$REGION" --query 'taskDefinition.taskDefinitionArn' --output text)
  aws ecs update-service --cluster genese-proposal-ai --service genese-api-service \
    --task-definition "$NEW_ARN" \
    --deployment-configuration "maximumPercent=200,minimumHealthyPercent=100" \
    --region "$REGION" > /dev/null
else
  aws ecs create-service \
    --cluster genese-proposal-ai \
    --service-name genese-api-service \
    --task-definition "$API_TD" \
    --desired-count 1 \
    --launch-type FARGATE \
    --network-configuration "awsvpcConfiguration={subnets=[$PRIV_SUBNETS],securityGroups=[$API_SG],assignPublicIp=DISABLED}" \
    --load-balancers "targetGroupArn=$TARGET_GROUP_ARN,containerName=Api,containerPort=8000" \
    --health-check-grace-period-seconds 60 \
    --deployment-configuration "maximumPercent=100,minimumHealthyPercent=0" \
    --region "$REGION" > /dev/null
fi
success "API service configured"

# Create Worker service (if not exists)
EXISTING_W=$(aws ecs describe-services --cluster genese-proposal-ai \
  --services genese-worker-service --region "$REGION" \
  --query 'services[0].status' --output text 2>/dev/null || echo "MISSING")

if [[ "$EXISTING_W" == "ACTIVE" ]]; then
  warn "Worker service exists, updating task definition..."
  TD_JSON_W=$(aws ecs describe-task-definition --task-definition "$WORKER_TD" \
    --region "$REGION" --query 'taskDefinition' --output json | \
    python3 -c "import sys,json;td=json.load(sys.stdin);print(json.dumps({k:td[k] for k in ['family','networkMode','containerDefinitions','requiresCompatibilities','cpu','memory','taskRoleArn','executionRoleArn']}))")
  echo "$TD_JSON_W" > /tmp/new_worker_td.json
  NEW_W_ARN=$(aws ecs register-task-definition --cli-input-json file:///tmp/new_worker_td.json \
    --region "$REGION" --query 'taskDefinition.taskDefinitionArn' --output text)
  aws ecs update-service --cluster genese-proposal-ai --service genese-worker-service \
    --task-definition "$NEW_W_ARN" \
    --deployment-configuration "maximumPercent=200,minimumHealthyPercent=100" \
    --region "$REGION" > /dev/null
else
  aws ecs create-service \
    --cluster genese-proposal-ai \
    --service-name genese-worker-service \
    --task-definition "$WORKER_TD" \
    --desired-count 1 \
    --launch-type FARGATE \
    --network-configuration "awsvpcConfiguration={subnets=[$PRIV_SUBNETS],securityGroups=[$WORKER_SG],assignPublicIp=DISABLED}" \
    --deployment-configuration "maximumPercent=200,minimumHealthyPercent=100" \
    --region "$REGION" > /dev/null
fi
success "Worker service configured"

info "Waiting for both services to start (up to 5 min)..."
for i in $(seq 1 15); do
  API_R=$(aws ecs describe-services --cluster genese-proposal-ai \
    --services genese-api-service --region "$REGION" \
    --query 'services[0].runningCount' --output text 2>/dev/null || echo 0)
  WRK_R=$(aws ecs describe-services --cluster genese-proposal-ai \
    --services genese-worker-service --region "$REGION" \
    --query 'services[0].runningCount' --output text 2>/dev/null || echo 0)
  info "  API=$API_R Worker=$WRK_R"
  [[ "$API_R" == "1" && "$WRK_R" == "1" ]] && break
  sleep 20
done

# Verify API health
sleep 10
HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "$API_URL/health" 2>/dev/null || echo "000")
[[ "$HEALTH" == "200" ]] && success "API healthy (HTTP $HEALTH)" || warn "API health check: HTTP $HEALTH (may still be starting)"

# ── Step 9: Add CloudFront /api/* Proxy ────────────────────────────────────────
step "9/13: Configuring CloudFront API Proxy"

CF_ID=$(aws cloudfront list-distributions \
  --query "DistributionList.Items[?contains(to_string(Origins.Items[0].DomainName),'genese-proposal-ai-frontend')].Id" \
  --output text)

# Check if /api/* behavior already exists
EXISTING_BEHAVIOR=$(aws cloudfront get-distribution-config --id "$CF_ID" \
  --query "DistributionConfig.CacheBehaviors.Items[?PathPattern=='/api/*'].PathPattern" \
  --output text 2>/dev/null || echo "")

if [[ -n "$EXISTING_BEHAVIOR" ]]; then
  success "CloudFront /api/* behavior already exists"
else
  info "Creating StripApiPrefix CloudFront Function..."
  cat > /tmp/cf_func.js << 'EOF'
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri.startsWith("/api")) { request.uri = uri.slice(4) || "/"; }
  return request;
}
EOF

  # Create function (ignore if exists)
  CF_FUNC_ARN=$(aws cloudfront create-function \
    --name "StripApiPrefix" \
    --function-config '{"Comment":"Strip /api prefix","Runtime":"cloudfront-js-2.0"}' \
    --function-code fileb:///tmp/cf_func.js \
    --region us-east-1 \
    --query 'FunctionSummary.FunctionMetadata.FunctionARN' --output text 2>/dev/null || \
    aws cloudfront describe-function --name StripApiPrefix \
    --query 'FunctionSummary.FunctionMetadata.FunctionARN' --output text)

  FUNC_ETAG=$(aws cloudfront describe-function --name StripApiPrefix \
    --query 'ETag' --output text 2>/dev/null || echo "")
  [[ -n "$FUNC_ETAG" ]] && \
    aws cloudfront publish-function --name StripApiPrefix --if-match "$FUNC_ETAG" > /dev/null 2>&1 || true

  # Update CloudFront distribution
  CF_ETAG=$(aws cloudfront get-distribution-config --id "$CF_ID" --query 'ETag' --output text)
  aws cloudfront get-distribution-config --id "$CF_ID" \
    --query 'DistributionConfig' --output json > /tmp/cf_config.json

  python3 << PYEOF
import json

with open('/tmp/cf_config.json') as f:
    config = json.load(f)

alb_dns = "$ALB_DNS"
func_arn = "$CF_FUNC_ARN"

# Add ALB origin if not present
existing_ids = [o['Id'] for o in config['Origins']['Items']]
if 'Genese-API-ALB' not in existing_ids:
    config['Origins']['Items'].append({
        "Id": "Genese-API-ALB", "DomainName": alb_dns,
        "CustomOriginConfig": {"HTTPPort": 80, "HTTPSPort": 443,
            "OriginProtocolPolicy": "http-only",
            "OriginSslProtocols": {"Quantity": 1, "Items": ["TLSv1.2"]},
            "OriginReadTimeout": 60, "OriginKeepaliveTimeout": 5},
        "OriginPath": "", "CustomHeaders": {"Quantity": 0, "Items": []},
        "ConnectionAttempts": 3, "ConnectionTimeout": 10,
        "OriginShield": {"Enabled": False}, "OriginAccessControlId": ""
    })
    config['Origins']['Quantity'] += 1

api_behavior = {
    "PathPattern": "/api/*", "TargetOriginId": "Genese-API-ALB",
    "ViewerProtocolPolicy": "https-only",
    "AllowedMethods": {"Quantity": 7,
        "Items": ["GET","HEAD","OPTIONS","PUT","POST","PATCH","DELETE"],
        "CachedMethods": {"Quantity": 2, "Items": ["GET","HEAD"]}},
    "Compress": True,
    "CachePolicyId": "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
    "OriginRequestPolicyId": "216adef6-5c7f-47e4-b989-5492eafa07d3",
    "TrustedSigners": {"Enabled": False, "Quantity": 0},
    "TrustedKeyGroups": {"Enabled": False, "Quantity": 0},
    "LambdaFunctionAssociations": {"Quantity": 0, "Items": []},
    "FunctionAssociations": {"Quantity": 1 if func_arn else 0,
        "Items": [{"FunctionARN": func_arn, "EventType": "viewer-request"}] if func_arn else []},
    "FieldLevelEncryptionId": "", "SmoothStreaming": False, "GrpcConfig": {"Enabled": False}
}

existing_behaviors = config.get('CacheBehaviors', {}).get('Items', [])
patterns = [b['PathPattern'] for b in existing_behaviors]
if '/api/*' not in patterns:
    existing_behaviors.insert(0, api_behavior)
    config['CacheBehaviors'] = {"Quantity": len(existing_behaviors), "Items": existing_behaviors}

with open('/tmp/cf_updated.json', 'w') as f:
    json.dump(config, f)
print("CloudFront config updated")
PYEOF

  aws cloudfront update-distribution --id "$CF_ID" \
    --distribution-config file:///tmp/cf_updated.json \
    --if-match "$CF_ETAG" > /dev/null
  success "CloudFront /api/* behavior added"
  info "Waiting for CloudFront deployment (~2 min)..."
  aws cloudfront wait distribution-deployed --id "$CF_ID" 2>/dev/null || \
    info "CloudFront still deploying (continuing anyway)"
fi

# ── Step 10: Build and Deploy Frontend ─────────────────────────────────────────
step "10/13: Building and Deploying Frontend"

cd frontend
npm install --silent
VITE_API_URL="/api" npm run build 2>&1 | tail -4
aws s3 sync dist/ "s3://$CF_FRONTEND_BUCKET/" --delete --region "$REGION" \
  --quiet && success "Frontend synced to S3"
aws cloudfront create-invalidation --distribution-id "$CF_ID" --paths "/*" \
  --query 'Invalidation.Status' --output text > /dev/null
success "CloudFront cache invalidated"
cd ..

# ── Step 11: Create Cognito Admin User ──────────────────────────────────────────
step "11/13: Creating Admin User"

aws cognito-idp admin-create-user \
  --user-pool-id "$USER_POOL_ID" \
  --username "$ADMIN_EMAIL" \
  --temporary-password "Temp1234!" \
  --message-action SUPPRESS \
  --user-attributes "Name=email,Value=$ADMIN_EMAIL" "Name=name,Value=Admin" \
  --region "$REGION" > /dev/null 2>&1 || info "User already exists"

aws cognito-idp admin-set-user-password \
  --user-pool-id "$USER_POOL_ID" \
  --username "$ADMIN_EMAIL" \
  --password "$ADMIN_PASSWORD" \
  --permanent \
  --region "$REGION" > /dev/null
success "Admin user: $ADMIN_EMAIL / $ADMIN_PASSWORD"

# ── Step 12: Seed Knowledge Base ───────────────────────────────────────────────
step "12/13: Seeding Knowledge Base"

if [[ "$SEED_DOCS" == "true" ]] && [[ -d "scripts/seed_documents" ]]; then
  info "Getting auth token..."
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
      HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API_URL/documents/upload" \
        -H "Authorization: Bearer $TOKEN" \
        -F "file=@$FILEPATH;type=text/plain" \
        -F "document_type=$DOC_TYPE" \
        -F "engagement_type=$ENG_TYPE" \
        -F "client_name=$CLIENT")
      [[ "$HTTP" == "202" ]] && ((SEEDED++)) || warn "$FILE: HTTP $HTTP"
      sleep 0.5
    done
    success "Seeded $SEEDED/10 documents — indexing in background (~2 min)"
  else
    warn "Could not get auth token for seeding. Seed manually later."
  fi
else
  info "Skipping seed docs (SEED_DOCS=false or scripts/seed_documents not found)"
fi

# ── Step 13: Final Verification ────────────────────────────────────────────────
step "13/13: Final Verification"

# Health check
HEALTH=$(curl -s "$API_URL/health" 2>/dev/null || echo "{}")
if echo "$HEALTH" | python3 -c "import sys,json;d=json.load(sys.stdin);exit(0 if d.get('status')=='healthy' else 1)" 2>/dev/null; then
  success "API health check passed"
else
  warn "API health: $HEALTH"
fi

# CloudFront check
CF_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$CF_URL" 2>/dev/null || echo "000")
[[ "$CF_STATUS" == "200" ]] && success "Frontend accessible (HTTP $CF_STATUS)" || warn "Frontend: HTTP $CF_STATUS"

# HTTPS login test
CF_LOGIN=$(curl -s -X POST "$CF_URL/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" 2>/dev/null || echo "{}")
if echo "$CF_LOGIN" | python3 -c "import sys,json;d=json.load(sys.stdin);exit(0 if d.get('idToken') else 1)" 2>/dev/null; then
  success "HTTPS login works"
else
  warn "HTTPS login failed (CloudFront may still be deploying, wait 2-3 min)"
fi

# ── Summary ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║     GENESE PROPOSAL AI — DEPLOYMENT COMPLETE         ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${BLUE}Frontend URL:${NC}  $CF_URL"
echo -e "  ${BLUE}API URL:${NC}       $API_URL"
echo -e "  ${BLUE}Admin Login:${NC}   $ADMIN_EMAIL / $ADMIN_PASSWORD"
echo -e "  ${BLUE}User Pool:${NC}     $USER_POOL_ID"
echo -e "  ${BLUE}AWS Account:${NC}   $ACCOUNT / $REGION"
echo ""
echo -e "  ${YELLOW}Next steps:${NC}"
echo -e "  1. Open $CF_URL in your browser"
echo -e "  2. Log in with $ADMIN_EMAIL"
if [[ -z "$TAVILY_API_KEY" ]]; then
echo -e "  3. Add Tavily API key for live docs: export TAVILY_API_KEY=xxx && ./deploy.sh"
fi
echo -e "  4. Upload your real Genese proposals in the Documents page"
echo -e "  5. Try generating a proposal!"
echo ""
echo -e "  ${YELLOW}To redeploy after code changes:${NC}  ./deploy.sh"
echo -e "  ${YELLOW}Outputs saved to:${NC}               /tmp/genese_outputs.env"
echo ""
