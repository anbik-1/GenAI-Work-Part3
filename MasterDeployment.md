# MasterDeployment.md — Deploy Genese Proposal AI from Scratch

> Precision guide for deploying in any AWS account. Follow in order. Each step has expected output.
> Estimated total time: 45–60 minutes.

---

## Prerequisites

### Tools
```bash
python3 --version     # 3.12+ required
node --version        # 18+ required (for frontend)
aws --version         # AWS CLI v2
docker --version      # Docker Desktop or Docker Engine
pip install aws-cdk-lib constructs   # CDK Python
```

### AWS Account
```bash
# Configure credentials
aws configure
# Or use environment variables: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_DEFAULT_REGION

# Verify
aws sts get-caller-identity
# Must have AdministratorAccess (or scoped CDK + ECS + ECR + Aurora + Cognito permissions)
```

### Get the Code
```bash
git clone https://github.com/anbik-1/anycompanyread.git   # your repo
cd anycompanyread   # the environment root
```

---

## Step 1: Set Your Variables

Run this block once at the start of your terminal session. All subsequent steps use these variables.

```bash
export ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
export REGION=us-east-1   # change if deploying to different region
export STACK_NAME=GeneseProposalAIStack

echo "Account: $ACCOUNT"
echo "Region:  $REGION"
```

---

## Step 2: Create ECR Repositories (Before CDK Deploy)

The CDK stack references existing ECR repos with `from_repository_name()` to avoid "repo already exists" errors. **Create them first.**

```bash
aws ecr create-repository \
  --repository-name genese-proposal-ai-api \
  --region $REGION 2>/dev/null || echo "Already exists"

aws ecr create-repository \
  --repository-name genese-proposal-ai-worker \
  --region $REGION 2>/dev/null || echo "Already exists"

# Verify
aws ecr describe-repositories --region $REGION \
  --query 'repositories[?contains(repositoryName,`genese`)].repositoryName' \
  --output text
# Expected: genese-proposal-ai-api    genese-proposal-ai-worker
```

---

## Step 3: CDK Bootstrap (One-Time Per Account/Region)

```bash
cd genese-proposal-ai/infrastructure
pip install -r requirements.txt

cdk bootstrap aws://$ACCOUNT/$REGION
# Expected: "Environment aws://ACCOUNT/REGION bootstrapped"
```

---

## Step 4: Deploy Infrastructure via CDK

The CDK stack deploys everything **except ECS services** (those are created in Step 7 via CLI).

```bash
cd genese-proposal-ai/infrastructure
cdk deploy --require-approval never 2>&1 | tee /tmp/cdk_deploy.log
```

**Expected duration:** 10–15 minutes (Aurora Serverless takes longest)

**Save outputs** (printed at the end of deploy):
```bash
# Parse and export all outputs
eval $(aws cloudformation describe-stacks --stack-name $STACK_NAME \
  --region $REGION \
  --query 'Stacks[0].Outputs[*].[OutputKey,OutputValue]' \
  --output text | \
  while read key val; do echo "export CF_${key}='${val}'"; done)

# Verify key outputs
echo "API URL:        $CF_ApiUrl"
echo "Target Group:   $CF_TargetGroupArn"
echo "CloudFront:     $CF_CloudFrontUrl"
echo "User Pool:      $CF_UserPoolId"
echo "Client ID:      $CF_UserPoolClientId"
echo "Frontend S3:    $CF_FrontendBucketName"
echo "Docs S3:        $CF_DocumentsBucketName"
echo "DB Secret ARN:  $CF_DbSecretArn"
echo "Tavily Secret:  $CF_TavilySecretArn"
echo "API ECR:        $CF_ApiRepoUri"
echo "Worker ECR:     $CF_WorkerRepoUri"
```

---

## Step 5: Set Tavily API Key

Sign up free at https://app.tavily.com (email only, no credit card):

```bash
aws secretsmanager put-secret-value \
  --secret-id $CF_TavilySecretArn \
  --secret-string '{"api_key":"YOUR_TAVILY_KEY_HERE"}' \
  --region $REGION
echo "Tavily key stored"
```

If skipping Tavily: generation still works, just without live web validation.

---

## Step 6: Build and Push Docker Images

```bash
cd genese-proposal-ai   # repo root

# Authenticate Docker to ECR
aws ecr get-login-password --region $REGION | \
  docker login --username AWS --password-stdin $ACCOUNT.dkr.ecr.$REGION.amazonaws.com

# Build and push API image
docker build -t genese-api -f services/api/Dockerfile services/
docker tag genese-api:latest $CF_ApiRepoUri:latest
docker push $CF_ApiRepoUri:latest
echo "✅ API image pushed"

# Build and push Worker image
docker build -t genese-worker -f services/worker/Dockerfile services/
docker tag genese-worker:latest $CF_WorkerRepoUri:latest
docker push $CF_WorkerRepoUri:latest
echo "✅ Worker image pushed"
```

---

## Step 7: Run Database Migration

Aurora is in a private subnet — run migration as a one-off ECS task inside the VPC.

```bash
# Get private subnet and worker security group
VPC_ID=$(aws ec2 describe-vpcs --region $REGION \
  --filters "Name=tag:Name,Values=${STACK_NAME}/Vpc" \
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

echo "Subnet: $PRIV_SUBNET"
echo "SG: $WORKER_SG"
echo "Worker TD: $WORKER_TD"

# Write migration script to S3
cat > /tmp/migrate.py << 'PYEOF'
import json, boto3, psycopg2
import os

db_secret_arn = os.environ.get("DB_SECRET_ARN", "")
sm = boto3.client("secretsmanager", region_name=os.environ.get("AWS_REGION","us-east-1"))
s = json.loads(sm.get_secret_value(SecretId=db_secret_arn)["SecretString"])
conn = psycopg2.connect(
    host=s["host"], port=int(s.get("port",5432)),
    dbname=s.get("dbname","genese"),
    user=s["username"], password=s["password"]
)
conn.set_isolation_level(0)
cur = conn.cursor()
cur.execute("CREATE EXTENSION IF NOT EXISTS vector;")
cur.execute("""CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cognito_sub VARCHAR(255) UNIQUE NOT NULL,
    email VARCHAR(255) NOT NULL, name VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW()
);""")
cur.execute("""CREATE TABLE IF NOT EXISTS documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    filename VARCHAR(500) NOT NULL, document_type VARCHAR(50) NOT NULL,
    engagement_type VARCHAR(100), client_name VARCHAR(255),
    s3_key VARCHAR(1000) NOT NULL, chunk_count INTEGER DEFAULT 0,
    uploaded_by UUID,
    ingestion_status VARCHAR(50) DEFAULT 'pending',
    embedding_model VARCHAR(255), embedding_tokens INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);""")
cur.execute("""CREATE TABLE IF NOT EXISTS document_chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL, content TEXT NOT NULL,
    embedding vector(1024), metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);""")
cur.execute("CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON document_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists=10);")
cur.execute("""CREATE TABLE IF NOT EXISTS generation_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID, document_type VARCHAR(50) NOT NULL,
    client_name VARCHAR(255) NOT NULL, engagement_type VARCHAR(100) NOT NULL,
    key_requirements TEXT NOT NULL, context_notes TEXT,
    status VARCHAR(50) DEFAULT 'queued', status_detail VARCHAR(255),
    rag_context JSONB, tavily_sources JSONB,
    output_s3_key VARCHAR(1000), error_message TEXT,
    llm_model VARCHAR(255), input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(), completed_at TIMESTAMPTZ
);""")
print("Migration complete — all tables and indexes created")
cur.close(); conn.close()
PYEOF

# Upload to S3
aws s3 cp /tmp/migrate.py s3://$CF_DocumentsBucketName/scripts/migrate.py --region $REGION

# Run migration as ECS one-off task
TASK_ARN=$(aws ecs run-task \
  --cluster genese-proposal-ai \
  --task-definition "$WORKER_TD" \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$PRIV_SUBNET],securityGroups=[$WORKER_SG],assignPublicIp=DISABLED}" \
  --overrides "{\"containerOverrides\":[{\"name\":\"Worker\",\"command\":[\"python3\",\"-c\",\"import boto3,json,os;os.environ.setdefault('DB_SECRET_ARN','$CF_DbSecretArn');b=boto3.client('s3',region_name='$REGION');b.download_file('$CF_DocumentsBucketName','scripts/migrate.py','/tmp/m.py');exec(open('/tmp/m.py').read())\"]}]}" \
  --region $REGION \
  --query 'tasks[0].taskArn' --output text)

echo "Migration task: $TASK_ARN"
TASK_ID=$(echo $TASK_ARN | sed 's/.*\///')
sleep 60

# Verify migration succeeded
EXIT_CODE=$(aws ecs describe-tasks --cluster genese-proposal-ai \
  --tasks $TASK_ID --region $REGION \
  --query 'tasks[0].containers[0].exitCode' --output text)
echo "Migration exit code: $EXIT_CODE"
# Expected: 0
```

---

---

## Step 8: Create ECS Services via CLI

**Why CLI and not CDK?** CloudFormation waits up to 3 hours for ECS service stabilization. Creating services via CLI bypasses this entirely.

```bash
# Get required IDs
API_SG=$(aws ec2 describe-security-groups --region $REGION \
  --filters "Name=vpc-id,Values=$VPC_ID" "Name=group-name,Values=*ApiSG*" \
  --query 'SecurityGroups[0].GroupId' --output text)

PRIV_SUBNETS=$(aws ec2 describe-subnets --region $REGION \
  --filters "Name=vpc-id,Values=$VPC_ID" \
  "Name=tag:aws-cdk:subnet-type,Values=Private" \
  --query 'Subnets[*].SubnetId' --output text | tr '\t' ',')

API_TD=$(aws ecs list-task-definitions --region $REGION \
  --query 'taskDefinitionArns[?contains(@,`ApiTask`)][-1]' --output text)

WORKER_TD=$(aws ecs list-task-definitions --region $REGION \
  --query 'taskDefinitionArns[?contains(@,`WorkerTask`)][-1]' --output text)

echo "API SG:     $API_SG"
echo "Worker SG:  $WORKER_SG"
echo "Subnets:    $PRIV_SUBNETS"
echo "API TD:     $API_TD"
echo "Worker TD:  $WORKER_TD"

# Create API service
aws ecs create-service \
  --cluster genese-proposal-ai \
  --service-name genese-api-service \
  --task-definition "$API_TD" \
  --desired-count 1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$PRIV_SUBNETS],securityGroups=[$API_SG],assignPublicIp=DISABLED}" \
  --load-balancers "targetGroupArn=$CF_TargetGroupArn,containerName=Api,containerPort=8000" \
  --health-check-grace-period-seconds 60 \
  --deployment-configuration "maximumPercent=200,minimumHealthyPercent=100" \
  --region $REGION \
  --query 'service.{status:status,desired:desiredCount}' --output json
# Expected: {"status": "ACTIVE", "desiredCount": 1}

# Create Worker service
aws ecs create-service \
  --cluster genese-proposal-ai \
  --service-name genese-worker-service \
  --task-definition "$WORKER_TD" \
  --desired-count 1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$PRIV_SUBNETS],securityGroups=[$WORKER_SG],assignPublicIp=DISABLED}" \
  --deployment-configuration "maximumPercent=200,minimumHealthyPercent=100" \
  --region $REGION \
  --query 'service.{status:status,desired:desiredCount}' --output json
# Expected: {"status": "ACTIVE", "desiredCount": 1}

# Wait for both to be running (takes ~2-3 min)
for i in $(seq 1 15); do
  API_R=$(aws ecs describe-services --cluster genese-proposal-ai \
    --services genese-api-service --region $REGION \
    --query 'services[0].runningCount' --output text)
  WRK_R=$(aws ecs describe-services --cluster genese-proposal-ai \
    --services genese-worker-service --region $REGION \
    --query 'services[0].runningCount' --output text)
  echo "[$i] API=$API_R Worker=$WRK_R"
  [[ "$API_R" == "1" && "$WRK_R" == "1" ]] && echo "✅ Both running" && break
  sleep 20
done

# Verify API health
curl -s "$CF_ApiUrl/health"
# Expected: {"status":"healthy","service":"genese-proposal-ai-api"}
```

---

## Step 9: Add CloudFront API Proxy

Routes `https://<cf-domain>/api/*` → ALB, avoiding HTTPS→HTTP mixed-content browser errors.

```bash
# Get CF distribution ID
CF_ID=$(aws cloudfront list-distributions \
  --query "DistributionList.Items[?contains(to_string(Origins.Items[0].DomainName),'genese-proposal-ai-frontend')].Id" \
  --output text)
echo "CloudFront ID: $CF_ID"

ALB_DNS=$(echo $CF_ApiUrl | sed 's|http://||')
echo "ALB DNS: $ALB_DNS"

# Create CloudFront Function to strip /api prefix
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
  --region us-east-1 \
  --query 'FunctionSummary.FunctionMetadata.FunctionARN' --output text

# Publish function
FUNC_ETAG=$(aws cloudfront describe-function --name StripApiPrefix \
  --query 'ETag' --output text)
CF_FUNC_ARN=$(aws cloudfront publish-function \
  --name StripApiPrefix --if-match $FUNC_ETAG \
  --query 'FunctionSummary.FunctionMetadata.FunctionARN' --output text)
echo "Function ARN: $CF_FUNC_ARN"

# Update CloudFront distribution config
ETAG=$(aws cloudfront get-distribution-config --id $CF_ID --query 'ETag' --output text)
aws cloudfront get-distribution-config --id $CF_ID \
  --query 'DistributionConfig' --output json > /tmp/cf_config.json

python3 << PYEOF
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

# Add /api/* behavior
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
        "Items": [{"FunctionARN": "$CF_FUNC_ARN", "EventType": "viewer-request"}]
    },
    "FieldLevelEncryptionId": "", "SmoothStreaming": False,
    "GrpcConfig": {"Enabled": False}
}
config['CacheBehaviors'] = {"Quantity": 1, "Items": [api_behavior]}

with open('/tmp/cf_updated.json', 'w') as f:
    json.dump(config, f)
print("Config updated")
PYEOF

aws cloudfront update-distribution \
  --id $CF_ID \
  --distribution-config file:///tmp/cf_updated.json \
  --if-match $ETAG \
  --query 'Distribution.Status' --output text

# Wait for deployment (~2 min)
aws cloudfront wait distribution-deployed --id $CF_ID
echo "✅ CloudFront updated"
```

---

---

## Step 10: Build and Deploy Frontend

```bash
cd genese-proposal-ai/frontend
npm install

# Build with your deployed API URL (via CloudFront proxy)
VITE_API_URL="/api" npm run build

# Sync to S3
aws s3 sync dist/ s3://$CF_FrontendBucketName/ --delete --region $REGION

# Invalidate CloudFront cache
aws cloudfront create-invalidation --distribution-id $CF_ID --paths "/*" \
  --query 'Invalidation.Status' --output text
# Expected: InProgress (completes in ~30s)
```

---

## Step 11: Create Cognito User

```bash
# Create admin user
aws cognito-idp admin-create-user \
  --user-pool-id $CF_UserPoolId \
  --username admin@yourcompany.com \
  --temporary-password "TempPass123!" \
  --message-action SUPPRESS \
  --user-attributes \
    Name=email,Value=admin@yourcompany.com \
    Name=name,Value="Your Name" \
  --region $REGION \
  --query 'User.UserStatus' --output text
# Expected: FORCE_CHANGE_PASSWORD

# Set permanent password (skip forced password change)
aws cognito-idp admin-set-user-password \
  --user-pool-id $CF_UserPoolId \
  --username admin@yourcompany.com \
  --password "YourSecurePass123!" \
  --permanent \
  --region $REGION
echo "✅ User created"
```

---

## Step 12: Seed the Knowledge Base

### Option A: Synthetic documents (quick demo)

```bash
cd genese-proposal-ai

# Get token
TOKEN=$(curl -s -X POST "$CF_ApiUrl/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@yourcompany.com","password":"YourSecurePass123!"}' | \
  python3 -c "import sys,json; print(json.load(sys.stdin)['idToken'])")

# Upload all 10 synthetic seed documents
SEED_DIR="scripts/seed_documents"
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

for FILE in "${!META[@]}"; do
  IFS='|' read -r DOC_TYPE ENG_TYPE CLIENT <<< "${META[$FILE]}"
  HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$CF_ApiUrl/documents/upload" \
    -H "Authorization: Bearer $TOKEN" \
    -F "file=@$SEED_DIR/$FILE;type=text/plain" \
    -F "document_type=$DOC_TYPE" \
    -F "engagement_type=$ENG_TYPE" \
    -F "client_name=$CLIENT")
  echo "$FILE → HTTP $HTTP"
  sleep 1
done

echo "Waiting 2 min for worker to index all documents..."
sleep 120
```

### Option B: Upload your real documents

```bash
# Upload any PDF, DOCX, or TXT
curl -X POST "$CF_ApiUrl/documents/upload" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@/path/to/your-proposal.pdf;type=application/pdf" \
  -F "document_type=proposal" \
  -F "engagement_type=aws_migration" \
  -F "client_name=Your Client Name"
```

---

## Step 13: Verify Everything Works

```bash
# Variables must be set from Step 1
TOKEN=$(curl -s -X POST "$CF_ApiUrl/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@yourcompany.com","password":"YourSecurePass123!"}' | \
  python3 -c "import sys,json; print(json.load(sys.stdin)['idToken'])")

echo "=== 1. API Health ===" && curl -s "$CF_ApiUrl/health"
echo ""
echo "=== 2. Documents ===" && \
  curl -s "$CF_ApiUrl/documents" -H "Authorization: Bearer $TOKEN" | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print(f'{d[\"total\"]} docs indexed')"

echo "=== 3. Search ===" && \
  curl -s -X POST "$CF_ApiUrl/search" \
    -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
    -d '{"query":"AWS migration banking","top_k":2}' | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print('PASS' if 'answer' in d else 'FAIL: '+str(d)[:200])"

echo "=== 4. Generate ===" && \
  JOB=$(curl -s -X POST "$CF_ApiUrl/generate" \
    -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
    -d '{"document_type":"proposal","client_name":"Test Co","engagement_type":"aws_migration","key_requirements":"Migrate to AWS"}') && \
  JOB_ID=$(echo $JOB | python3 -c "import sys,json; print(json.load(sys.stdin).get('job_id',''))") && \
  echo "Job: $JOB_ID" && sleep 10 && \
  curl -s "$CF_ApiUrl/generate/$JOB_ID" -H "Authorization: Bearer $TOKEN" | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print(f'Status: {d[\"status\"]} | Tokens: {d.get(\"input_tokens\",0)}in+{d.get(\"output_tokens\",0)}out')"

echo "=== 5. Frontend ===" && \
  curl -s -o /dev/null -w "HTTP %{http_code}" "$CF_CloudFrontUrl"

echo "=== 6. CF Login Proxy ===" && \
  curl -s -X POST "$CF_CloudFrontUrl/api/auth/login" \
    -H "Content-Type: application/json" \
    -d '{"email":"admin@yourcompany.com","password":"YourSecurePass123!"}' | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print('PASS' if d.get('idToken') else 'FAIL')"
```

---

## Step 14: Update Application Code

### Deploy new API version
```bash
cd genese-proposal-ai

# 1. Edit code
# 2. Build and push new image
docker build -t genese-api -f services/api/Dockerfile services/
docker tag genese-api:latest $CF_ApiRepoUri:latest
docker push $CF_ApiRepoUri:latest

# 3. Register new task definition and update service (zero-downtime rolling update)
CURRENT_TD=$(aws ecs describe-services --cluster genese-proposal-ai \
  --services genese-api-service --region $REGION \
  --query 'services[0].taskDefinition' --output text)
TD_JSON=$(aws ecs describe-task-definition --task-definition "$CURRENT_TD" \
  --region $REGION --query 'taskDefinition' --output json | \
  python3 -c "import sys,json; td=json.load(sys.stdin); print(json.dumps({k:td[k] for k in ['family','networkMode','containerDefinitions','requiresCompatibilities','cpu','memory','taskRoleArn','executionRoleArn']}))")
echo $TD_JSON > /tmp/new_td.json
NEW_ARN=$(aws ecs register-task-definition --cli-input-json file:///tmp/new_td.json \
  --region $REGION --query 'taskDefinition.taskDefinitionArn' --output text)
aws ecs update-service --cluster genese-proposal-ai \
  --service genese-api-service --task-definition $NEW_ARN \
  --deployment-configuration "maximumPercent=200,minimumHealthyPercent=100" \
  --region $REGION
echo "Rolling update started — API stays live throughout"
```

### Deploy new Worker version
```bash
# Same pattern, replace genese-api-service with genese-worker-service
# and $CF_ApiRepoUri with $CF_WorkerRepoUri
```

### Deploy new Frontend
```bash
cd genese-proposal-ai/frontend
VITE_API_URL="/api" npm run build
aws s3 sync dist/ s3://$CF_FrontendBucketName/ --delete --region $REGION
aws cloudfront create-invalidation --distribution-id $CF_ID --paths "/*"
```

---

## Step 15: Teardown

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
  --image-ids imageTag=latest --region $REGION 2>/dev/null
aws ecr batch-delete-image --repository-name genese-proposal-ai-worker \
  --image-ids imageTag=latest --region $REGION 2>/dev/null

# Destroy CDK stack (deletes everything else)
cd genese-proposal-ai/infrastructure
cdk destroy --all
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `cdk deploy` hangs for hours | ECS service in CDK | Don't put ECS services in CDK — use CLI (Step 8) |
| `MasterUserPassword invalid` | RDS forbidden chars in generated password | Check `exclude_characters` in CDK stack |
| ALB returns 503 | ECS task not running / still starting | Check `aws ecs describe-services` runningCount |
| `NetworkError` in browser | HTTPS→HTTP mixed content | Ensure CloudFront /api/* behavior is configured (Step 9) |
| Document stuck in pending | SQS race condition | Run the re-queue script from scripts/ |
| `Expecting value` in worker | Tavily secret is plain string, not JSON | Handle both formats in `get_tavily_api_key()` |
| `temperature + top_p` error | Claude rejects both together | Remove `top_p` from model_kwargs |
| Old image running after push | ECS cached task definition | Register new task definition revision each push |
| ECR auth expired | Docker login token expires after 12h | Re-run `aws ecr get-login-password \| docker login ...` |
| `Cannot find module 'shared'` | PYTHONPATH not set | Check Dockerfiles have `ENV PYTHONPATH=/app` |
| Aurora connection timeout | Migration task in wrong subnet | Use private subnet + worker security group in ECS run-task |
| `Exceeds max token` error | Proposal too long | Reduce `max_tokens` or simplify requirements |

---

## Complete CDK Stack Code

Save as `genese-proposal-ai/infrastructure/stacks/genese_stack.py`:

```python
"""Genese Proposal AI — Full AWS CDK Stack.
ECS Services are created via CLI after this stack deploys (Step 8).
"""
import aws_cdk as cdk
from aws_cdk import (
    Stack, Duration, RemovalPolicy, CfnOutput, SecretValue,
    aws_ec2 as ec2, aws_s3 as s3, aws_cloudfront as cloudfront,
    aws_cloudfront_origins as origins, aws_cognito as cognito,
    aws_rds as rds, aws_sqs as sqs, aws_ecr as ecr, aws_ecs as ecs,
    aws_elasticloadbalancingv2 as elbv2, aws_iam as iam,
    aws_logs as logs, aws_secretsmanager as secretsmanager,
)
from constructs import Construct


class GeneseProposalAIStack(Stack):

    def __init__(self, scope: Construct, construct_id: str, **kwargs):
        super().__init__(scope, construct_id, **kwargs)

        # VPC
        vpc = ec2.Vpc(self, "Vpc", max_azs=2, nat_gateways=1,
            subnet_configuration=[
                ec2.SubnetConfiguration(name="Public", subnet_type=ec2.SubnetType.PUBLIC, cidr_mask=24),
                ec2.SubnetConfiguration(name="Private", subnet_type=ec2.SubnetType.PRIVATE_WITH_EGRESS, cidr_mask=24),
            ])

        # S3
        documents_bucket = s3.Bucket(self, "DocumentsBucket",
            bucket_name=f"genese-proposal-ai-docs-{self.account}-{self.region}",
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
            removal_policy=RemovalPolicy.DESTROY, auto_delete_objects=True,
            lifecycle_rules=[s3.LifecycleRule(id="ArchiveGenerated", prefix="generated/",
                transitions=[s3.Transition(storage_class=s3.StorageClass.INFREQUENT_ACCESS,
                    transition_after=Duration.days(30))])])

        frontend_bucket = s3.Bucket(self, "FrontendBucket",
            bucket_name=f"genese-proposal-ai-frontend-{self.account}-{self.region}",
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
            removal_policy=RemovalPolicy.DESTROY, auto_delete_objects=True)

        # CloudFront (SPA hosting — /api/* behavior added via CLI in Step 9)
        distribution = cloudfront.Distribution(self, "Distribution",
            default_behavior=cloudfront.BehaviorOptions(
                origin=origins.S3BucketOrigin.with_origin_access_control(frontend_bucket),
                viewer_protocol_policy=cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS),
            default_root_object="index.html",
            error_responses=[
                cloudfront.ErrorResponse(http_status=404, response_http_status=200, response_page_path="/index.html"),
                cloudfront.ErrorResponse(http_status=403, response_http_status=200, response_page_path="/index.html")])

        # Cognito
        user_pool = cognito.UserPool(self, "UserPool",
            user_pool_name="genese-proposal-ai", self_sign_up_enabled=False,
            sign_in_aliases=cognito.SignInAliases(email=True),
            password_policy=cognito.PasswordPolicy(min_length=8, require_lowercase=True,
                require_uppercase=True, require_digits=True, require_symbols=False),
            removal_policy=RemovalPolicy.DESTROY)

        user_pool_client = cognito.UserPoolClient(self, "UserPoolClient",
            user_pool=user_pool, user_pool_client_name="genese-web-client",
            auth_flows=cognito.AuthFlow(admin_user_password=True, user_password=True, user_srp=True),
            generate_secret=False)

        # Aurora PostgreSQL Serverless v2 + pgvector
        db_sg = ec2.SecurityGroup(self, "DbSG", vpc=vpc, description="Aurora SG")
        db_secret = secretsmanager.Secret(self, "DbSecret",
            secret_name="/genese/db-credentials",
            generate_secret_string=secretsmanager.SecretStringGenerator(
                secret_string_template='{"username":"genese","dbname":"genese"}',
                generate_string_key="password",
                exclude_characters=' %+~`#$&*()|[]{}:;<>?!\'/\"\\@/',
                password_length=32))

        db_cluster = rds.DatabaseCluster(self, "AuroraCluster",
            engine=rds.DatabaseClusterEngine.aurora_postgres(
                version=rds.AuroraPostgresEngineVersion.VER_16_4),
            default_database_name="genese",
            serverless_v2_min_capacity=0.5, serverless_v2_max_capacity=4,
            writer=rds.ClusterInstance.serverless_v2("Writer"),
            vpc=vpc, vpc_subnets=ec2.SubnetSelection(subnet_type=ec2.SubnetType.PRIVATE_WITH_EGRESS),
            security_groups=[db_sg], credentials=rds.Credentials.from_secret(db_secret),
            removal_policy=RemovalPolicy.DESTROY)

        # SQS Queue + DLQ
        dlq = sqs.Queue(self, "GenerationDLQ", queue_name="genese-generation-jobs-dlq",
            retention_period=Duration.days(14))
        generation_queue = sqs.Queue(self, "GenerationQueue",
            queue_name="genese-generation-jobs", visibility_timeout=Duration.seconds(600),
            retention_period=Duration.days(4),
            dead_letter_queue=sqs.DeadLetterQueue(max_receive_count=3, queue=dlq))

        # ECR Repos (must exist before cdk deploy — see Step 2)
        api_repo = ecr.Repository.from_repository_name(self, "ApiRepo", "genese-proposal-ai-api")
        worker_repo = ecr.Repository.from_repository_name(self, "WorkerRepo", "genese-proposal-ai-worker")

        # Tavily secret placeholder (update in Step 5)
        tavily_secret = secretsmanager.Secret(self, "TavilySecret",
            secret_name="/genese/tavily-api-key",
            secret_string_value=SecretValue.unsafe_plain_text("REPLACE_WITH_TAVILY_KEY"))

        # ECS Cluster + Task Definitions
        cluster = ecs.Cluster(self, "Cluster", cluster_name="genese-proposal-ai", vpc=vpc)
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

        api_task = ecs.FargateTaskDefinition(self, "ApiTask", cpu=512, memory_limit_mib=1024)
        api_task.add_container("Api",
            image=ecs.ContainerImage.from_ecr_repository(api_repo, tag="latest"),
            environment=common_env,
            logging=ecs.LogDrivers.aws_logs(stream_prefix="api",
                log_group=logs.LogGroup(self, "ApiLogs", log_group_name="/ecs/genese-api",
                    removal_policy=RemovalPolicy.DESTROY)),
            port_mappings=[ecs.PortMapping(container_port=8000)])

        worker_task = ecs.FargateTaskDefinition(self, "WorkerTask", cpu=1024, memory_limit_mib=2048)
        worker_task.add_container("Worker",
            image=ecs.ContainerImage.from_ecr_repository(worker_repo, tag="latest"),
            environment=common_env,
            logging=ecs.LogDrivers.aws_logs(stream_prefix="worker",
                log_group=logs.LogGroup(self, "WorkerLogs", log_group_name="/ecs/genese-worker",
                    removal_policy=RemovalPolicy.DESTROY)))

        # IAM permissions
        for task in [api_task, worker_task]:
            documents_bucket.grant_read_write(task.task_role)
            generation_queue.grant_send_messages(task.task_role)
            generation_queue.grant_consume_messages(task.task_role)
            db_secret.grant_read(task.task_role)
            tavily_secret.grant_read(task.task_role)
            task.task_role.add_managed_policy(
                iam.ManagedPolicy.from_aws_managed_policy_name("AmazonBedrockFullAccess"))

        api_task.task_role.add_to_policy(iam.PolicyStatement(
            actions=["cognito-idp:AdminInitiateAuth","cognito-idp:AdminConfirmSignUp",
                     "cognito-idp:SignUp","cognito-idp:ForgotPassword",
                     "cognito-idp:ConfirmForgotPassword"],
            resources=[user_pool.user_pool_arn]))

        # Security groups
        api_sg = ec2.SecurityGroup(self, "ApiSG", vpc=vpc, description="ECS API SG")
        worker_sg = ec2.SecurityGroup(self, "WorkerSG", vpc=vpc, description="ECS Worker SG")
        db_sg.add_ingress_rule(api_sg, ec2.Port.tcp(5432), "API to Aurora")
        db_sg.add_ingress_rule(worker_sg, ec2.Port.tcp(5432), "Worker to Aurora")

        # ALB (ECS services created via CLI in Step 8)
        alb = elbv2.ApplicationLoadBalancer(self, "ApiLB", vpc=vpc, internet_facing=True)
        alb_sg = alb.connections.security_groups[0]
        api_sg.add_ingress_rule(alb_sg, ec2.Port.tcp(8000), "ALB to API")
        target_group = elbv2.ApplicationTargetGroup(self, "ApiTG",
            vpc=vpc, port=8000, protocol=elbv2.ApplicationProtocol.HTTP,
            target_type=elbv2.TargetType.IP,
            health_check=elbv2.HealthCheck(path="/health", interval=Duration.seconds(30),
                healthy_threshold_count=2, unhealthy_threshold_count=3))
        alb.add_listener("Listener", port=80, default_target_groups=[target_group])

        # Outputs
        CfnOutput(self, "ApiUrl", value=f"http://{alb.load_balancer_dns_name}")
        CfnOutput(self, "TargetGroupArn", value=target_group.target_group_arn)
        CfnOutput(self, "AlbArn", value=alb.load_balancer_arn)
        CfnOutput(self, "CloudFrontUrl", value=f"https://{distribution.distribution_domain_name}")
        CfnOutput(self, "FrontendBucketName", value=frontend_bucket.bucket_name)
        CfnOutput(self, "DocumentsBucketName", value=documents_bucket.bucket_name)
        CfnOutput(self, "UserPoolId", value=user_pool.user_pool_id)
        CfnOutput(self, "UserPoolClientId", value=user_pool_client.user_pool_client_id)
        CfnOutput(self, "ApiRepoUri", value=f"{self.account}.dkr.ecr.{self.region}.amazonaws.com/genese-proposal-ai-api")
        CfnOutput(self, "WorkerRepoUri", value=f"{self.account}.dkr.ecr.{self.region}.amazonaws.com/genese-proposal-ai-worker")
        CfnOutput(self, "DbSecretArn", value=db_secret.secret_arn)
        CfnOutput(self, "TavilySecretArn", value=tavily_secret.secret_arn)
```

---

*End of MasterDeployment.md*
