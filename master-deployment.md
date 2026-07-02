# master-deployment.md — Deploy Genese Proposal AI from Scratch

> Follow this guide precisely to deploy the full application in a new AWS account.
> Estimated time: 45–60 minutes end-to-end.

---

## Prerequisites

### Tools Required
```bash
# Python 3.12+
python3 --version

# Node.js 18+ (for frontend build)
node --version

# AWS CLI v2
aws --version

# Docker (for building container images)
docker --version

# AWS CDK CLI
pip install aws-cdk-lib constructs
# or
npm install -g aws-cdk
```

### AWS Account Setup
- IAM user or role with `AdministratorAccess` (for initial deploy)
- AWS CLI configured: `aws configure`
- Verify: `aws sts get-caller-identity`

### Get the Code
```bash
# Clone your repository
git clone https://github.com/anbik-1/anycompanyread.git  # your repo
cd anycompanyread/genese-proposal-ai   # adjust path as needed
```

---

## Step 1: Configure the CDK Stack

The full CDK stack is at `infrastructure/stacks/genese_stack.py`.

Install CDK Python dependencies:
```bash
cd infrastructure
pip install -r requirements.txt
```

### Bootstrap CDK (one-time per account/region)
```bash
export CDK_DEFAULT_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
export CDK_DEFAULT_REGION=us-east-1   # change if deploying to different region
cdk bootstrap aws://$CDK_DEFAULT_ACCOUNT/$CDK_DEFAULT_REGION
```

---

## Step 2: Deploy Infrastructure (CDK — no ECS services)

```bash
cd infrastructure
cdk deploy --require-approval never
```

**Expected duration:** ~10–15 minutes (Aurora Serverless takes the longest)

**What gets created:**
- VPC (2 AZ, public + private subnets, NAT gateway)
- S3 buckets (frontend + documents)
- CloudFront distribution (SPA + API proxy)
- Cognito User Pool + Client
- Aurora PostgreSQL Serverless v2 (pgvector ready)
- SQS queue + DLQ
- ECR repositories (api + worker)
- ECS Cluster + Task Definitions (services created in Step 6)
- ALB + Target Group
- IAM roles, security groups, CloudWatch log groups
- Secrets Manager secrets (DB credentials, Tavily placeholder)

**Save the outputs** (shown at end of `cdk deploy`):
```
Outputs:
  ApiUrl          = http://<alb-dns>
  TargetGroupArn  = arn:aws:elasticloadbalancing:...
  AlbArn          = arn:aws:elasticloadbalancing:...
  CloudFrontUrl   = https://<cf-domain>.cloudfront.net
  UserPoolId      = us-east-1_XXXXXXXXX
  UserPoolClientId = XXXXXXXXXXXXXXXXXXXXXXXXXX
  DocumentsBucketName = genese-proposal-ai-docs-<account>-<region>
  FrontendBucketName  = genese-proposal-ai-frontend-<account>-<region>
  ApiRepoUri      = <account>.dkr.ecr.<region>.amazonaws.com/genese-proposal-ai-api
  WorkerRepoUri   = <account>.dkr.ecr.<region>.amazonaws.com/genese-proposal-ai-worker
  DbSecretArn     = arn:aws:secretsmanager:...
  TavilySecretArn = arn:aws:secretsmanager:...
```

Store these in environment variables:
```bash
export API_URL="<ApiUrl>"
export TG_ARN="<TargetGroupArn>"
export CF_URL="<CloudFrontUrl>"
export USER_POOL_ID="<UserPoolId>"
export USER_POOL_CLIENT_ID="<UserPoolClientId>"
export DOCS_BUCKET="<DocumentsBucketName>"
export FRONTEND_BUCKET="<FrontendBucketName>"
export API_REPO="<ApiRepoUri>"
export WORKER_REPO="<WorkerRepoUri>"
export DB_SECRET_ARN="<DbSecretArn>"
export TAVILY_SECRET_ARN="<TavilySecretArn>"
```

---

## Step 3: Set Tavily API Key

Sign up at https://app.tavily.com (free, no credit card):

```bash
aws secretsmanager put-secret-value \
  --secret-id $TAVILY_SECRET_ARN \
  --secret-string "{\"api_key\":\"YOUR_TAVILY_KEY_HERE\"}" \
  --region us-east-1
```

If you don't have a Tavily key yet, skip this step — generation still works (without live web validation).

---

## Step 4: Build and Push Docker Images

```bash
# Authenticate to ECR
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REGION=us-east-1
aws ecr get-login-password --region $REGION | \
  docker login --username AWS --password-stdin $ACCOUNT.dkr.ecr.$REGION.amazonaws.com

# Build API image
cd /path/to/genese-proposal-ai
docker build -t genese-api -f services/api/Dockerfile services/
docker tag genese-api:latest $API_REPO:latest
docker push $API_REPO:latest

# Build Worker image
docker build -t genese-worker -f services/worker/Dockerfile services/
docker tag genese-worker:latest $WORKER_REPO:latest
docker push $WORKER_REPO:latest
```

---

## Step 5: Run Database Migration

The migration creates the pgvector extension and all 4 tables. It runs inside ECS because Aurora is in a private subnet.

First, get the private subnet and security group IDs:
```bash
VPC_ID=$(aws ec2 describe-vpcs --region $REGION \
  --filters "Name=tag:Name,Values=GeneseProposalAIStack/Vpc" \
  --query 'Vpcs[0].VpcId' --output text)

PRIV_SUBNET=$(aws ec2 describe-subnets --region $REGION \
  --filters "Name=vpc-id,Values=$VPC_ID" \
              "Name=tag:aws-cdk:subnet-type,Values=Private" \
  --query 'Subnets[0].SubnetId' --output text)

WORKER_SG=$(aws ec2 describe-security-groups --region $REGION \
  --filters "Name=vpc-id,Values=$VPC_ID" "Name=group-name,Values=*WorkerSG*" \
  --query 'SecurityGroups[0].GroupId' --output text)

WORKER_TD=$(aws ecs list-task-definitions --region $REGION \
  --query 'taskDefinitionArns[?contains(@,`WorkerTask`)][-1]' --output text)
```

Run migration as a one-off ECS task:
```bash
TASK_ARN=$(aws ecs run-task \
  --cluster genese-proposal-ai \
  --task-definition $WORKER_TD \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$PRIV_SUBNET],securityGroups=[$WORKER_SG],assignPublicIp=DISABLED}" \
  --overrides '{"containerOverrides":[{"name":"Worker","command":["python3","-c","
import sys,json,boto3,psycopg2
sm=boto3.client(\"secretsmanager\",region_name=\"us-east-1\")
s=json.loads(sm.get_secret_value(SecretId=\"'"$DB_SECRET_ARN"'\")[\"SecretString\"])
conn=psycopg2.connect(host=s[\"host\"],port=5432,dbname=s.get(\"dbname\",\"genese\"),user=s[\"username\"],password=s[\"password\"])
conn.set_isolation_level(0)
cur=conn.cursor()
cur.execute(\"CREATE EXTENSION IF NOT EXISTS vector;\")
cur.execute(\"CREATE TABLE IF NOT EXISTS users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), cognito_sub VARCHAR(255) UNIQUE NOT NULL, email VARCHAR(255) NOT NULL, name VARCHAR(255), created_at TIMESTAMPTZ DEFAULT NOW());\")
cur.execute(\"CREATE TABLE IF NOT EXISTS documents (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), filename VARCHAR(500) NOT NULL, document_type VARCHAR(50) NOT NULL, engagement_type VARCHAR(100), client_name VARCHAR(255), s3_key VARCHAR(1000) NOT NULL, chunk_count INTEGER DEFAULT 0, uploaded_by UUID, created_at TIMESTAMPTZ DEFAULT NOW());\")
cur.execute(\"CREATE TABLE IF NOT EXISTS document_chunks (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), document_id UUID, chunk_index INTEGER NOT NULL, content TEXT NOT NULL, embedding vector(1024), metadata JSONB, created_at TIMESTAMPTZ DEFAULT NOW());\")
cur.execute(\"CREATE TABLE IF NOT EXISTS generation_jobs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID, document_type VARCHAR(50) NOT NULL, client_name VARCHAR(255) NOT NULL, engagement_type VARCHAR(100) NOT NULL, key_requirements TEXT NOT NULL, context_notes TEXT, status VARCHAR(50) DEFAULT '"'"'queued'"'"', status_detail VARCHAR(255), rag_context JSONB, tavily_sources JSONB, output_s3_key VARCHAR(1000), error_message TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), completed_at TIMESTAMPTZ);\")
print(\"Migration complete!\")
cur.close()
conn.close()
"]}]}' \
  --region $REGION \
  --query 'tasks[0].taskArn' --output text)

echo "Migration task: $TASK_ARN"
# Wait and check
sleep 60
aws ecs describe-tasks --cluster genese-proposal-ai --tasks $TASK_ARN \
  --region $REGION --query 'tasks[0].containers[0].exitCode' --output text
# Should output: 0
```

---

## Step 6: Create ECS Services (CLI — bypasses CFN ECS timeout)

Get required values:
```bash
API_SG=$(aws ec2 describe-security-groups --region $REGION \
  --filters "Name=vpc-id,Values=$VPC_ID" "Name=group-name,Values=*ApiSG*" \
  --query 'SecurityGroups[0].GroupId' --output text)

# Get both private subnets
PRIV_SUBNETS=$(aws ec2 describe-subnets --region $REGION \
  --filters "Name=vpc-id,Values=$VPC_ID" "Name=tag:aws-cdk:subnet-type,Values=Private" \
  --query 'Subnets[*].SubnetId' --output text | tr '\t' ',')

API_TD=$(aws ecs list-task-definitions --region $REGION \
  --query 'taskDefinitionArns[?contains(@,`ApiTask`)][-1]' --output text)

WORKER_TD=$(aws ecs list-task-definitions --region $REGION \
  --query 'taskDefinitionArns[?contains(@,`WorkerTask`)][-1]' --output text)

echo "API TD: $API_TD"
echo "Worker TD: $WORKER_TD"
echo "API SG: $API_SG"
echo "Worker SG: $WORKER_SG"
echo "Subnets: $PRIV_SUBNETS"
```

Create API service (with ALB load balancer):
```bash
aws ecs create-service \
  --cluster genese-proposal-ai \
  --service-name genese-api-service \
  --task-definition $API_TD \
  --desired-count 1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$PRIV_SUBNETS],securityGroups=[$API_SG],assignPublicIp=DISABLED}" \
  --load-balancers "targetGroupArn=$TG_ARN,containerName=Api,containerPort=8000" \
  --health-check-grace-period-seconds 60 \
  --deployment-configuration "maximumPercent=100,minimumHealthyPercent=0" \
  --region $REGION
```

Create Worker service (no load balancer):
```bash
aws ecs create-service \
  --cluster genese-proposal-ai \
  --service-name genese-worker-service \
  --task-definition $WORKER_TD \
  --desired-count 1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$PRIV_SUBNETS],securityGroups=[$WORKER_SG],assignPublicIp=DISABLED}" \
  --deployment-configuration "maximumPercent=100,minimumHealthyPercent=0" \
  --region $REGION
```

Wait for both to reach 1 running task:
```bash
for i in $(seq 1 20); do
  API_R=$(aws ecs describe-services --cluster genese-proposal-ai \
    --services genese-api-service --region $REGION \
    --query 'services[0].runningCount' --output text)
  WRK_R=$(aws ecs describe-services --cluster genese-proposal-ai \
    --services genese-worker-service --region $REGION \
    --query 'services[0].runningCount' --output text)
  echo "[$i] API=$API_R Worker=$WRK_R"
  [[ "$API_R" == "1" && "$WRK_R" == "1" ]] && break
  sleep 20
done
```

Verify API health:
```bash
curl -s "$API_URL/health"
# Expected: {"status":"healthy","service":"genese-proposal-ai-api"}
```

---

## Step 7: Add CloudFront API Proxy

This routes `https://<cf-domain>/api/*` → ALB, eliminating mixed-content browser errors.

Get CloudFront distribution ID:
```bash
CF_ID=$(aws cloudfront list-distributions \
  --query "DistributionList.Items[?contains(to_string(Origins.Items[0].DomainName),'genese-proposal-ai-frontend')].Id" \
  --output text)
echo "CF ID: $CF_ID"
```

Create the StripApiPrefix CloudFront Function:
```bash
cat > /tmp/cf_func.js << 'EOF'
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri.startsWith("/api")) {
    request.uri = uri.slice(4) || "/";
  }
  return request;
}
EOF

aws cloudfront create-function \
  --name "StripApiPrefix" \
  --function-config '{"Comment":"Strip /api prefix","Runtime":"cloudfront-js-2.0"}' \
  --function-code fileb:///tmp/cf_func.js \
  --region us-east-1

# Publish the function
FUNC_ETAG=$(aws cloudfront describe-function --name StripApiPrefix \
  --query 'ETag' --output text)
aws cloudfront publish-function --name StripApiPrefix --if-match $FUNC_ETAG
```

Update CloudFront distribution to add ALB as origin and `/api/*` behavior:
```bash
# Get current config
aws cloudfront get-distribution-config --id $CF_ID \
  --query 'DistributionConfig' --output json > /tmp/cf_config.json
ETAG=$(aws cloudfront get-distribution-config --id $CF_ID --query 'ETag' --output text)

# Get ALB DNS name
ALB_DNS=$(aws elbv2 describe-load-balancers --region $REGION \
  --query "LoadBalancers[?contains(LoadBalancerName,'Genese-ApiLB')].DNSName" \
  --output text)

# Update config with Python
python3 << EOF
import json

with open('/tmp/cf_config.json') as f:
    config = json.load(f)

# Add ALB origin
config['Origins']['Items'].append({
    "Id": "Genese-API-ALB",
    "DomainName": "$ALB_DNS",
    "CustomOriginConfig": {
        "HTTPPort": 80, "HTTPSPort": 443,
        "OriginProtocolPolicy": "http-only",
        "OriginSslProtocols": {"Quantity": 1, "Items": ["TLSv1.2"]},
        "OriginReadTimeout": 60, "OriginKeepaliveTimeout": 5
    },
    "OriginPath": "",
    "CustomHeaders": {"Quantity": 0, "Items": []},
    "ConnectionAttempts": 3, "ConnectionTimeout": 10,
    "OriginShield": {"Enabled": False}, "OriginAccessControlId": ""
})
config['Origins']['Quantity'] += 1

# Add /api/* behavior with StripApiPrefix function
api_behavior = {
    "PathPattern": "/api/*",
    "TargetOriginId": "Genese-API-ALB",
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
        "Quantity": 1,
        "Items": [{"FunctionARN": "$(aws cloudfront describe-function --name StripApiPrefix --query 'FunctionSummary.FunctionMetadata.FunctionARN' --output text)", "EventType": "viewer-request"}]
    },
    "FieldLevelEncryptionId": "",
    "SmoothStreaming": False,
    "GrpcConfig": {"Enabled": False}
}
config['CacheBehaviors'] = {"Quantity": 1, "Items": [api_behavior]}

with open('/tmp/cf_updated.json', 'w') as f:
    json.dump(config, f)
print("Config updated")
EOF

# Apply the update
aws cloudfront update-distribution \
  --id $CF_ID \
  --distribution-config file:///tmp/cf_updated.json \
  --if-match $ETAG \
  --query 'Distribution.Status' --output text

# Wait for deployment (~2 min)
aws cloudfront wait distribution-deployed --id $CF_ID
echo "CloudFront updated"
```

---

## Step 8: Build and Deploy Frontend

```bash
cd /path/to/genese-proposal-ai/frontend

# Install dependencies
npm install

# Build with your deployed URLs
VITE_API_URL="/api" npm run build

# Sync to S3
aws s3 sync dist/ s3://$FRONTEND_BUCKET/ --delete --region $REGION

# Invalidate CloudFront cache
aws cloudfront create-invalidation --distribution-id $CF_ID --paths "/*"
```

---

## Step 9: Create Demo User in Cognito

```bash
# Create user
aws cognito-idp admin-create-user \
  --user-pool-id $USER_POOL_ID \
  --username your.email@genesesolution.com \
  --temporary-password "TempPass123!" \
  --message-action SUPPRESS \
  --user-attributes \
    Name=email,Value=your.email@genesesolution.com \
    Name=name,Value="Your Name" \
  --region $REGION

# Set permanent password (skip the forced-change-on-first-login)
aws cognito-idp admin-set-user-password \
  --user-pool-id $USER_POOL_ID \
  --username your.email@genesesolution.com \
  --password "YourSecurePassword123!" \
  --permanent \
  --region $REGION
```

---

## Step 10: Seed Knowledge Base with Documents

### Option A: Use the synthetic seed documents (quick demo)
```bash
cd /path/to/genese-proposal-ai

# Login to get token
TOKEN=$(curl -s -X POST "$API_URL/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"your.email@genesesolution.com","password":"YourSecurePassword123!"}' | \
  python3 -c "import sys,json; print(json.load(sys.stdin)['idToken'])")

# Upload seed documents
SEED_DIR="scripts/seed_documents"
declare -A META=(
  ["proposal_aws_migration_horizon.txt"]="proposal|aws_migration|Horizon Financial Group"
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

for FILE in "${!META[@]}"; do
  IFS='|' read -r DOC_TYPE ENG_TYPE CLIENT <<< "${META[$FILE]}"
  curl -s -o /dev/null -w "$FILE: %{http_code}\n" \
    -X POST "$API_URL/documents/upload" \
    -H "Authorization: Bearer $TOKEN" \
    -F "file=@$SEED_DIR/$FILE;type=text/plain" \
    -F "document_type=$DOC_TYPE" \
    -F "engagement_type=$ENG_TYPE" \
    -F "client_name=$CLIENT"
  sleep 1
done

echo "Wait 2-3 minutes for worker to embed all documents..."
sleep 120
```

### Option B: Upload your real Genese documents
```bash
# Upload any PDF, DOCX, or TXT file
curl -X POST "$API_URL/documents/upload" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@/path/to/your-proposal.pdf;type=application/pdf" \
  -F "document_type=proposal" \
  -F "engagement_type=aws_migration" \
  -F "client_name=Client Name"
```

---

## Step 11: Verify Everything Works

```bash
echo "=== Health ===" && curl -s "$API_URL/health"
echo ""

echo "=== Login ===" && \
TOKEN=$(curl -s -X POST "$API_URL/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"your.email@genesesolution.com","password":"YourSecurePassword123!"}' | \
  python3 -c "import sys,json;print(json.load(sys.stdin)['idToken'])")
[[ -n "$TOKEN" ]] && echo "✅ Login OK" || echo "❌ Login FAILED"

echo "=== Documents ===" && \
curl -s "$API_URL/documents" -H "Authorization: Bearer $TOKEN" | \
  python3 -c "import sys,json;d=json.load(sys.stdin);print(f'✅ {d[\"total\"]} documents')"

echo "=== Search ===" && \
curl -s -X POST "$API_URL/search" \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{"query":"AWS migration","top_k":2}' | \
  python3 -c "import sys,json;d=json.load(sys.stdin);print('✅ Search OK' if 'answer' in d else f'❌ {d}')"

echo "=== Frontend ===" && \
curl -s -o /dev/null -w "HTTP %{http_code}" "$CF_URL"
```

---

## Step 12: Updating the Application

### Push a New API Version
```bash
# Edit code, then:
docker build -t genese-api -f services/api/Dockerfile services/
docker tag genese-api:latest $API_REPO:latest
docker push $API_REPO:latest

# Register new task def and update service
CURRENT_TD=$(aws ecs describe-services --cluster genese-proposal-ai \
  --services genese-api-service --region $REGION \
  --query 'services[0].taskDefinition' --output text)
TASK_JSON=$(aws ecs describe-task-definition --task-definition $CURRENT_TD \
  --region $REGION --query 'taskDefinition' --output json | \
  python3 -c "import sys,json;td=json.load(sys.stdin);print(json.dumps({k:td[k] for k in ['family','networkMode','containerDefinitions','requiresCompatibilities','cpu','memory','taskRoleArn','executionRoleArn']}))")
echo $TASK_JSON > /tmp/new_td.json
NEW_ARN=$(aws ecs register-task-definition --cli-input-json file:///tmp/new_td.json \
  --region $REGION --query 'taskDefinition.taskDefinitionArn' --output text)
aws ecs update-service --cluster genese-proposal-ai \
  --service genese-api-service --task-definition $NEW_ARN --region $REGION
```

### Push a New Worker Version
```bash
# Same pattern as above, for genese-worker-service
```

### Update Frontend
```bash
cd frontend && VITE_API_URL="/api" npm run build
aws s3 sync dist/ s3://$FRONTEND_BUCKET/ --delete --region $REGION
aws cloudfront create-invalidation --distribution-id $CF_ID --paths "/*"
```

---

## Teardown (Remove All Resources)

```bash
# Delete ECS services first
aws ecs update-service --cluster genese-proposal-ai \
  --service genese-api-service --desired-count 0 --region $REGION
aws ecs update-service --cluster genese-proposal-ai \
  --service genese-worker-service --desired-count 0 --region $REGION
sleep 30
aws ecs delete-service --cluster genese-proposal-ai \
  --service genese-api-service --region $REGION
aws ecs delete-service --cluster genese-proposal-ai \
  --service genese-worker-service --region $REGION

# Delete ECR images (required before CDK can delete repos)
aws ecr batch-delete-image --repository-name genese-proposal-ai-api \
  --image-ids imageTag=latest --region $REGION
aws ecr batch-delete-image --repository-name genese-proposal-ai-worker \
  --image-ids imageTag=latest --region $REGION

# Destroy CDK stack (deletes everything else)
cd infrastructure
cdk destroy --all
```

**Note:** If CDK destroy fails on ECR repos (images present), manually delete the images first as shown above.

---

## Troubleshooting Reference

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| ECS task not starting | Image not in ECR | Push image first, then create service |
| CFN stack stuck in `CREATE_IN_PROGRESS` | ECS service wait | Don't put ECS services in CDK stack — use CLI |
| `ALB returns 503` | ECS task not running | Check `aws ecs describe-services` runningCount |
| `NetworkError` on login | Mixed-content HTTPS→HTTP | Ensure CloudFront /api/* proxy is configured |
| `Expecting value: line 1 column 1` | Tavily secret not JSON | Fix `get_tavily_api_key()` to handle plain strings |
| Embedding dimension error | Wrong vector dimension | Titan Text v2 = 1024 dims (not 1536) |
| `temperature and top_p` error | Claude rejects both | Remove `top_p` from model_kwargs |
| Search returns 500 | `:embedding::vector` SQL syntax | Use f-string with literal embedding, not bind param |
| Old image running after push | ECS task def not updated | Register new task definition revision, then update service |
| `MasterUserPassword invalid` | RDS forbidden chars in secret | Exclude `/`, `@`, `"`, `space` from SecretStringGenerator |

---
