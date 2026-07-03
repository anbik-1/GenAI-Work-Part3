# LastDeployment.md
## Deploy Genese Proposal AI — From Zero to Running

> This guide works in any AWS account. Follow steps in order.
> Total time: ~45–60 minutes.
>
> **Important:** This app uses BOTH CDK AND CLI.
> CDK deploys infrastructure. CLI creates ECS services, DB migration, and frontend.
> Do NOT try to do everything through CDK — it will fail (ECS stabilization timeout).

---

## Prerequisites

```bash
# Required tools
python3 --version     # 3.12+
node --version        # 18+
aws --version         # AWS CLI v2
docker --version      # Docker Engine
pip install aws-cdk-lib constructs   # CDK Python

# AWS credentials configured
aws sts get-caller-identity          # Must succeed, needs AdministratorAccess
export ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
export REGION=us-east-1              # Change if needed
```

---

## Step 1: Clone and Prepare

```bash
git clone https://github.com/anbik-1/anycompanyread.git
cd anycompanyread/genese-proposal-ai
```

---

## Step 2: Create ECR Repositories FIRST

**⚠️ Must do this BEFORE `cdk deploy`.**
The CDK stack uses `from_repository_name()` — repos must exist.

```bash
aws ecr create-repository --repository-name genese-proposal-ai-api --region $REGION 2>/dev/null || echo "exists"
aws ecr create-repository --repository-name genese-proposal-ai-worker --region $REGION 2>/dev/null || echo "exists"
```

---

## Step 3: CDK Bootstrap (one-time per account/region)

```bash
cd infrastructure
pip install -r requirements.txt
cdk bootstrap aws://$ACCOUNT/$REGION
```

---

## Step 4: CDK Deploy (Infrastructure Only — NOT ECS services)

```bash
cdk deploy --require-approval never 2>&1 | tee /tmp/cdk_output.log
```

**Duration:** ~10–15 minutes (Aurora is the slowest)

**After deploy, export all outputs:**

```bash
# Parse and export CDK outputs to environment variables
while IFS=$'\t' read -r key val; do
  export "CF_${key}=${val}"
done < <(aws cloudformation describe-stacks --stack-name GeneseProposalAIStack \
  --region $REGION \
  --query 'Stacks[0].Outputs[*].[OutputKey,OutputValue]' \
  --output text)

# Verify
echo "API URL:     $CF_ApiUrl"
echo "CF URL:      $CF_CloudFrontUrl"
echo "User Pool:   $CF_UserPoolId"
echo "Client ID:   $CF_UserPoolClientId"
echo "Frontend S3: $CF_FrontendBucketName"
echo "Docs S3:     $CF_DocumentsBucketName"
echo "API ECR:     $CF_ApiRepoUri"
echo "Worker ECR:  $CF_WorkerRepoUri"
echo "DB Secret:   $CF_DbSecretArn"
echo "Tavily Sec:  $CF_TavilySecretArn"
echo "TG ARN:      $CF_TargetGroupArn"
```

---

## Step 5: Set Tavily API Key (optional but recommended)

Sign up free at https://app.tavily.com (email only, no credit card):

```bash
aws secretsmanager put-secret-value \
  --secret-id $CF_TavilySecretArn \
  --secret-string '{"api_key":"YOUR_TAVILY_KEY"}' \
  --region $REGION
```

---

## Step 6: Build and Push Docker Images

```bash
cd ..  # back to genese-proposal-ai root

# Authenticate to ECR
aws ecr get-login-password --region $REGION | \
  docker login --username AWS --password-stdin $ACCOUNT.dkr.ecr.$REGION.amazonaws.com

# Build and push API
docker build -t genese-api -f services/api/Dockerfile services/
docker tag genese-api:latest $CF_ApiRepoUri:latest
docker push $CF_ApiRepoUri:latest
echo "API pushed"

# Build and push Worker
docker build -t genese-worker -f services/worker/Dockerfile services/
docker tag genese-worker:latest $CF_WorkerRepoUri:latest
docker push $CF_WorkerRepoUri:latest
echo "Worker pushed"
```

---

## Step 7: Run Database Migration (via ECS — Aurora is in private subnet)

```bash
# Get VPC resources
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

# Upload migration script to S3
cat > /tmp/migrate.py << 'PYEOF'
import json, boto3, psycopg2, os
sm = boto3.client("secretsmanager", region_name=os.environ.get("AWS_REGION","us-east-1"))
secret_arn = os.environ.get("DB_SECRET_ARN","")
s = json.loads(sm.get_secret_value(SecretId=secret_arn)["SecretString"])
conn = psycopg2.connect(host=s["host"],port=int(s.get("port",5432)),
    dbname=s.get("dbname","genese"),user=s["username"],password=s["password"])
conn.set_isolation_level(0)
cur = conn.cursor()
cur.execute("CREATE EXTENSION IF NOT EXISTS vector;")
cur.execute("""CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cognito_sub VARCHAR(255) UNIQUE NOT NULL,
    email VARCHAR(255) NOT NULL, name VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW());""")
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
cur.execute("CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON document_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists=10);")
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
print("Migration complete!")
cur.close(); conn.close()
PYEOF

DOCS_BUCKET=$CF_DocumentsBucketName
aws s3 cp /tmp/migrate.py s3://$DOCS_BUCKET/scripts/migrate.py --region $REGION

# Run migration as ECS task
TASK_ARN=$(aws ecs run-task \
  --cluster genese-proposal-ai \
  --task-definition "$WORKER_TD" \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$PRIV_SUBNET],securityGroups=[$WORKER_SG],assignPublicIp=DISABLED}" \
  --overrides "{\"containerOverrides\":[{\"name\":\"Worker\",\"command\":[\"python3\",\"-c\",\"import boto3;b=boto3.client('s3',region_name='$REGION');b.download_file('$DOCS_BUCKET','scripts/migrate.py','/tmp/m.py');exec(open('/tmp/m.py').read())\"]}]}" \
  --region $REGION \
  --query 'tasks[0].taskArn' --output text)

TASK_ID=$(echo $TASK_ARN | sed 's/.*\///')
echo "Migration task: $TASK_ID"
sleep 60

EXIT=$(aws ecs describe-tasks --cluster genese-proposal-ai --tasks $TASK_ID \
  --region $REGION --query 'tasks[0].containers[0].exitCode' --output text)
echo "Exit code: $EXIT"  # Must be 0
```

---

## Step 8: Create ECS Services via CLI

**⚠️ This is CLI, not CDK — by design. CDK ECS services cause 3-hour CFN timeouts.**

```bash
# Get required IDs
API_SG=$(aws ec2 describe-security-groups --region $REGION \
  --filters "Name=vpc-id,Values=$VPC_ID" "Name=group-name,Values=*ApiSG*" \
  --query 'SecurityGroups[0].GroupId' --output text)

PRIV_SUBNETS=$(aws ec2 describe-subnets --region $REGION \
  --filters "Name=vpc-id,Values=$VPC_ID" "Name=tag:aws-cdk:subnet-type,Values=Private" \
  --query 'Subnets[*].SubnetId' --output text | tr '\t' ',')

API_TD=$(aws ecs list-task-definitions --region $REGION \
  --query 'taskDefinitionArns[?contains(@,`ApiTask`)][-1]' --output text)

WORKER_TD=$(aws ecs list-task-definitions --region $REGION \
  --query 'taskDefinitionArns[?contains(@,`WorkerTask`)][-1]' --output text)

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
  --deployment-configuration "maximumPercent=100,minimumHealthyPercent=0" \
  --region $REGION

# Create Worker service
WORKER_SG=$(aws ec2 describe-security-groups --region $REGION \
  --filters "Name=vpc-id,Values=$VPC_ID" "Name=group-name,Values=*WorkerSG*" \
  --query 'SecurityGroups[0].GroupId' --output text)

aws ecs create-service \
  --cluster genese-proposal-ai \
  --service-name genese-worker-service \
  --task-definition "$WORKER_TD" \
  --desired-count 1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$PRIV_SUBNETS],securityGroups=[$WORKER_SG],assignPublicIp=DISABLED}" \
  --deployment-configuration "maximumPercent=200,minimumHealthyPercent=100" \
  --region $REGION

# Wait for both to be running
for i in $(seq 1 15); do
  API_R=$(aws ecs describe-services --cluster genese-proposal-ai \
    --services genese-api-service --region $REGION \
    --query 'services[0].runningCount' --output text)
  WRK_R=$(aws ecs describe-services --cluster genese-proposal-ai \
    --services genese-worker-service --region $REGION \
    --query 'services[0].runningCount' --output text)
  echo "[$i] API=$API_R Worker=$WRK_R"
  [[ "$API_R" == "1" && "$WRK_R" == "1" ]] && echo "Both running" && break
  sleep 20
done

# Verify API health
curl -s "$CF_ApiUrl/health"
# Expected: {"status":"healthy","service":"genese-proposal-ai-api"}
```

---

## Step 9: Add CloudFront API Proxy

Routes `https://cf-domain/api/*` → ALB. Required to avoid HTTPS→HTTP mixed content browser error.

```bash
# Get CloudFront distribution ID
CF_ID=$(aws cloudfront list-distributions \
  --query "DistributionList.Items[?contains(to_string(Origins.Items[0].DomainName),'genese-proposal-ai-frontend')].Id" \
  --output text)

ALB_DNS=$(echo $CF_ApiUrl | sed 's|http://||')

# Create StripApiPrefix function
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
  --function-config '{"Comment":"Strip /api prefix","Runtime":"cloudfront-js-2.0"}' \
  --function-code fileb:///tmp/cf_func.js \
  --region us-east-1 \
  --query 'FunctionSummary.FunctionMetadata.FunctionARN' --output text

FUNC_ETAG=$(aws cloudfront describe-function --name StripApiPrefix --query 'ETag' --output text)
CF_FUNC_ARN=$(aws cloudfront publish-function --name StripApiPrefix --if-match $FUNC_ETAG \
  --query 'FunctionSummary.FunctionMetadata.FunctionARN' --output text)

# Update CloudFront config
ETAG=$(aws cloudfront get-distribution-config --id $CF_ID --query 'ETag' --output text)
aws cloudfront get-distribution-config --id $CF_ID --query 'DistributionConfig' --output json > /tmp/cf_config.json

python3 << PYEOF
import json

with open('/tmp/cf_config.json') as f:
    config = json.load(f)

config['Origins']['Items'].append({
    "Id": "Genese-API-ALB",
    "DomainName": "$ALB_DNS",
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
config['CacheBehaviors'] = {"Quantity": 1, "Items": [{
    "PathPattern": "/api/*",
    "TargetOriginId": "Genese-API-ALB",
    "ViewerProtocolPolicy": "https-only",
    "AllowedMethods": {"Quantity": 7, "Items": ["GET","HEAD","OPTIONS","PUT","POST","PATCH","DELETE"], "CachedMethods": {"Quantity": 2, "Items": ["GET","HEAD"]}},
    "Compress": True,
    "CachePolicyId": "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
    "OriginRequestPolicyId": "216adef6-5c7f-47e4-b989-5492eafa07d3",
    "TrustedSigners": {"Enabled": False, "Quantity": 0},
    "TrustedKeyGroups": {"Enabled": False, "Quantity": 0},
    "LambdaFunctionAssociations": {"Quantity": 0, "Items": []},
    "FunctionAssociations": {"Quantity": 1, "Items": [{"FunctionARN": "$CF_FUNC_ARN", "EventType": "viewer-request"}]},
    "FieldLevelEncryptionId": "", "SmoothStreaming": False, "GrpcConfig": {"Enabled": False}
}]}

with open('/tmp/cf_updated.json', 'w') as f:
    json.dump(config, f)
print("Config ready")
PYEOF

aws cloudfront update-distribution --id $CF_ID \
  --distribution-config file:///tmp/cf_updated.json \
  --if-match $ETAG \
  --query 'Distribution.Status' --output text

aws cloudfront wait distribution-deployed --id $CF_ID
echo "CloudFront updated"
```

---

## Step 10: Build and Deploy Frontend

```bash
cd frontend
npm install
VITE_API_URL="/api" npm run build
aws s3 sync dist/ s3://$CF_FrontendBucketName/ --delete --region $REGION
aws cloudfront create-invalidation --distribution-id $CF_ID --paths "/*"
cd ..
```

---

## Step 11: Create Cognito User

```bash
aws cognito-idp admin-create-user \
  --user-pool-id $CF_UserPoolId \
  --username admin@yourcompany.com \
  --temporary-password "Temp1234!" \
  --message-action SUPPRESS \
  --user-attributes Name=email,Value=admin@yourcompany.com Name=name,Value="Admin" \
  --region $REGION

aws cognito-idp admin-set-user-password \
  --user-pool-id $CF_UserPoolId \
  --username admin@yourcompany.com \
  --password "YourPassword123!" \
  --permanent \
  --region $REGION
```

---

## Step 12: Seed Knowledge Base (optional but recommended)

```bash
# Get auth token
TOKEN=$(curl -s -X POST "$CF_ApiUrl/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@yourcompany.com","password":"YourPassword123!"}' | \
  python3 -c "import sys,json; print(json.load(sys.stdin)['idToken'])")

# Upload seed documents
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
echo "Waiting 2 minutes for indexing..."
sleep 120
```

---

## Step 13: Verify Everything Works

```bash
echo "=== Health ===" && curl -s "$CF_ApiUrl/health"
echo ""
echo "=== CloudFront ===" && curl -s -o /dev/null -w "HTTP %{http_code}" "$CF_CloudFrontUrl"
echo ""
echo "=== HTTPS Login ===" && \
  curl -s -X POST "$CF_CloudFrontUrl/api/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"admin@yourcompany.com\",\"password\":\"YourPassword123!\"}" | \
  python3 -c "import sys,json;d=json.load(sys.stdin);print('LOGIN OK' if d.get('idToken') else 'FAIL')"
```

---

## Updating the Application

### New API version
```bash
docker build -t genese-api -f services/api/Dockerfile services/
docker tag genese-api:latest $CF_ApiRepoUri:latest
docker push $CF_ApiRepoUri:latest

# Register new task def and update service (rolling update, zero downtime)
CURRENT_TD=$(aws ecs describe-services --cluster genese-proposal-ai \
  --services genese-api-service --region $REGION \
  --query 'services[0].taskDefinition' --output text)
TD_JSON=$(aws ecs describe-task-definition --task-definition "$CURRENT_TD" \
  --region $REGION --query 'taskDefinition' --output json | \
  python3 -c "import sys,json;td=json.load(sys.stdin);print(json.dumps({k:td[k] for k in ['family','networkMode','containerDefinitions','requiresCompatibilities','cpu','memory','taskRoleArn','executionRoleArn']}))")
echo $TD_JSON > /tmp/new_td.json
NEW_ARN=$(aws ecs register-task-definition --cli-input-json file:///tmp/new_td.json \
  --region $REGION --query 'taskDefinition.taskDefinitionArn' --output text)
aws ecs update-service --cluster genese-proposal-ai --service genese-api-service \
  --task-definition $NEW_ARN \
  --deployment-configuration "maximumPercent=200,minimumHealthyPercent=100" \
  --region $REGION
```

### New frontend version
```bash
cd frontend && VITE_API_URL="/api" npm run build
aws s3 sync dist/ s3://$CF_FrontendBucketName/ --delete --region $REGION
aws cloudfront create-invalidation --distribution-id $CF_ID --paths "/*"
```

---

## Teardown

```bash
# Scale services to 0
aws ecs update-service --cluster genese-proposal-ai --service genese-api-service --desired-count 0 --region $REGION
aws ecs update-service --cluster genese-proposal-ai --service genese-worker-service --desired-count 0 --region $REGION
sleep 30

# Delete services
aws ecs delete-service --cluster genese-proposal-ai --service genese-api-service --region $REGION
aws ecs delete-service --cluster genese-proposal-ai --service genese-worker-service --region $REGION

# Delete ECR images (required before CDK can delete)
aws ecr batch-delete-image --repository-name genese-proposal-ai-api --image-ids imageTag=latest --region $REGION 2>/dev/null
aws ecr batch-delete-image --repository-name genese-proposal-ai-worker --image-ids imageTag=latest --region $REGION 2>/dev/null

# Destroy CDK stack (deletes everything else)
cd infrastructure && cdk destroy --all
```

---

## Troubleshooting Quick Reference

| Symptom | Cause | Fix |
|---------|-------|-----|
| `cdk deploy` hangs for hours | ECS service in CDK | Remove ECS from CDK — use CLI (Step 8) |
| `MasterUserPassword invalid` | Forbidden chars in password | Check `exclude_characters` in CDK |
| ALB 503 | ECS task not running | `aws ecs describe-services` — check runningCount |
| `NetworkError` in browser | HTTPS→HTTP mixed content | Ensure CloudFront /api/* behavior (Step 9) |
| Document stuck in pending | SQS race condition | Ensure DB committed before SQS publish |
| Architecture null in response | `@router.get` decorator missing | Check all route decorators after code edits |
| `Expecting value` in worker | Tavily key not JSON format | Handle both JSON and plain string |
| `temperature + top_p` error | Claude rejects both | Remove `top_p` from model_kwargs |
| Old image running after push | ECS task def not updated | Register new task def revision + update service |

*End of LastDeployment.md*
