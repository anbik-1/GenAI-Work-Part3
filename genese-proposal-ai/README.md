# Genese Proposal AI

Internal AI system for Genese Solution that generates proposals, SoWs, and case studies faster — by searching past work and live vendor documentation, then drafting Genese-branded output automatically.

## What It Does

1. **Generate** — Submit a client name, engagement type, and key requirements. The system:
   - Searches your past proposals and SoWs (RAG over pgvector)
   - Validates architecture claims against live AWS/Azure/GCP docs (Tavily)
   - Drafts a complete document using Claude Sonnet 4.6
   - Outputs a Genese-branded .docx ready for consultant review

2. **Search** — Ask "What did we do for the last fintech client?" and get an AI-synthesised answer with source citations from past work.

3. **Documents** — Upload past proposals, SoWs, and case studies to grow the knowledge base.

4. **History** — View and download past generated documents.

## Architecture

```
Consultant Browser
      │
      ▼
CloudFront (React SPA)
      │
      ▼
ALB → ECS Fargate: API (FastAPI)
              │
              ├── Aurora PostgreSQL + pgvector (jobs + knowledge base)
              ├── S3 (documents + generated .docx)
              └── SQS (async generation jobs)
                        │
                        ▼
              ECS Fargate: Worker (LangChain)
                        ├── Amazon Bedrock: Claude Sonnet 4.6 (LLM)
                        ├── Amazon Bedrock: Titan Text v2 (embeddings)
                        ├── Aurora pgvector (semantic search)
                        ├── ElastiCache Redis (Tavily cache)
                        └── Tavily API (live web search)
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| LLM | Claude Sonnet 4.6 via Amazon Bedrock |
| Embeddings | Amazon Titan Text v2 via Bedrock |
| Vector DB | Aurora PostgreSQL Serverless v2 + pgvector |
| RAG Framework | LangChain |
| Web Search | Tavily (free tier, no credit card) |
| Compute | ECS Fargate (API + Worker containers) |
| Doc Output | python-docx |
| Frontend | React + TypeScript + shadcn/ui + Tailwind |
| API | FastAPI (Python 3.12) |
| IaC | AWS CDK (Python) |

## Prerequisites

- Python 3.12+
- Node.js 18+
- AWS CLI configured (AdministratorAccess or scoped permissions)
- Docker (for building container images)
- AWS CDK CLI: `pip install aws-cdk-lib`
- Tavily API key (free at `app.tavily.com`, no credit card)

## Deployment Steps

### 1. Install CDK dependencies
```bash
cd infrastructure
pip install -r requirements.txt
```

### 2. Bootstrap CDK (first time only)
```bash
cdk bootstrap
```

### 3. Update Tavily API key
Edit `infrastructure/stacks/genese_stack.py` and replace `REPLACE_WITH_TAVILY_KEY` with your actual Tavily API key, or update the secret after deploy:
```bash
aws secretsmanager put-secret-value \
  --secret-id /genese/tavily-api-key \
  --secret-string '{"api_key":"your-tavily-key"}'
```

### 4. Deploy infrastructure
```bash
cd infrastructure
cdk deploy --require-approval never
```

Note the outputs — you'll need `ApiRepoUri`, `WorkerRepoUri`, `DbSecretArn`.

### 5. Build and push Docker images
```bash
# Authenticate to ECR
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin <ACCOUNT>.dkr.ecr.us-east-1.amazonaws.com

# Build and push API
docker build -t genese-api services/api/
docker tag genese-api:latest <ApiRepoUri>:latest
docker push <ApiRepoUri>:latest

# Build and push Worker
docker build -t genese-worker services/worker/
docker tag genese-worker:latest <WorkerRepoUri>:latest
docker push <WorkerRepoUri>:latest
```

### 6. Run database migration
```bash
pip install psycopg2-binary boto3
python scripts/db_migrate.py --secret-arn <DbSecretArn>
```

### 7. Force ECS to deploy the new images
```bash
aws ecs update-service --cluster genese-proposal-ai --service GeneseProposalAIStack-ApiService --force-new-deployment
aws ecs update-service --cluster genese-proposal-ai --service GeneseProposalAIStack-WorkerService --force-new-deployment
```

### 8. Create first Cognito user
```bash
aws cognito-idp admin-create-user \
  --user-pool-id <UserPoolId> \
  --username admin@genesesolution.com \
  --temporary-password TempPass123! \
  --message-action SUPPRESS
```

### 9. Build and deploy frontend
```bash
cd frontend
npm install
VITE_API_URL=http://<ApiUrl> VITE_COGNITO_URL=https://<UserPoolId>.auth.us-east-1.amazoncognito.com VITE_COGNITO_CLIENT_ID=<UserPoolClientId> npm run build
aws s3 sync dist/ s3://<FrontendBucketName>/ --delete
```

### 10. Seed the knowledge base
```bash
python scripts/seed_data.py \
  --api-url http://<ApiUrl> \
  --email admin@genesesolution.com \
  --password <set-via-cognito>
```

### 11. Access the app
Open `https://<CloudFrontUrl>` and sign in.

## Project Structure

```
genese-proposal-ai/
├── services/
│   ├── shared/          — Shared Pydantic models, SQLAlchemy ORM, constants
│   ├── api/             — FastAPI application (ECS Fargate)
│   └── worker/          — LangChain RAG + generation worker (ECS Fargate)
├── frontend/            — React SPA
├── infrastructure/      — AWS CDK stack (Python)
├── scripts/
│   ├── db_migrate.py    — Creates all DB tables + pgvector extension
│   ├── seed_data.py     — Uploads 10 synthetic documents
│   └── seed_documents/  — 10 Genese-style .txt documents
└── README.md
```

## Tear Down

```bash
cd infrastructure
cdk destroy --all
```

This removes all AWS resources. Note: S3 buckets with `auto_delete_objects=True` will be emptied and deleted.

## Replacing Synthetic Data with Real Genese Documents

After verifying the app works with synthetic data:
1. Go to the Documents page in the UI
2. Upload real Genese proposals, SoWs, and case studies (PDF or DOCX)
3. The synthetic documents can be deleted from the Documents page
4. Search and generation accuracy will improve significantly with real data
