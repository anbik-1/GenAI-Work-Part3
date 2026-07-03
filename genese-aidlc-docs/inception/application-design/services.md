# Application Design — Services & Infrastructure

## Service Architecture

```
Consultant Browser
      │
      │ HTTPS
      ▼
CloudFront ──► S3 (React SPA)
      │
      │ /api/*  (proxy to ALB)
      ▼
Application Load Balancer (public subnet)
      │
      ▼
ECS Fargate: API Service (private subnet)
  FastAPI containers (desired: 1, max: 3)
      │
      ├── Aurora PostgreSQL Serverless v2 (pgvector) ← jobs + documents + users
      ├── S3 (raw uploads + generated .docx)
      ├── SQS (publish generation jobs)
      └── Cognito (JWT validation)
      │
      ▼
Amazon SQS: generation-jobs queue
      │
      ▼
ECS Fargate: Worker Service (private subnet)
  LangChain worker containers (desired: 1, max: 5)
      │
      ├── Amazon Bedrock: Titan Text v2 (embeddings)
      ├── Amazon Bedrock: Claude Sonnet 4.6 (generation)
      ├── Aurora PostgreSQL Serverless v2 (pgvector reads/writes)
      ├── ElastiCache Redis (Tavily response cache)
      ├── S3 (read raw docs, write generated .docx)
      └── Tavily API (external web search — 1 external call)
```

## AWS Infrastructure Plan (CDK Stack)

### Networking
- VPC with 2 AZs: public subnets (ALB) + private subnets (ECS, Aurora, Redis)
- NAT Gateway for Worker outbound (Tavily calls, Bedrock, SQS)
- Security Groups: ALB → API task, API task → Aurora, Worker task → Aurora/Redis

### Compute (ECS Fargate)
- ECS Cluster: `genese-proposal-ai`
- **API Service**: 0.5 vCPU / 1GB RAM, desired=1, max=3, health check `/health`
- **Worker Service**: 1 vCPU / 2GB RAM, desired=1, max=5
  - Auto-scaling policy: scale out when SQS ApproximateNumberOfMessages > 2
- Task roles: IAM with least-privilege (Bedrock, S3, SQS, Secrets Manager, Aurora)

### Database (Aurora PostgreSQL Serverless v2)
- Engine: PostgreSQL 16
- Min ACU: 0.5, Max ACU: 4
- Auto-pause after 5 minutes of inactivity
- pgvector extension enabled via init script
- Credentials in Secrets Manager

### Storage
- S3 bucket: `genese-proposal-ai-documents-{account}-{region}`
  - Prefixes: `/raw/` (uploads), `/generated/` (output .docx)
  - Lifecycle: move to IA after 30 days
  - No public access
- CloudFront OAC for frontend bucket

### Queue
- SQS Standard Queue: `genese-generation-jobs`
- Visibility timeout: 600s (10 min — max generation time)
- DLQ: `genese-generation-jobs-dlq` (after 3 failures)

### Cache
- ElastiCache Redis Serverless: Tavily cache (TTL 24h)
- Private subnet, encrypted in transit

### Security
- Cognito User Pool: `genese-proposal-ai`
  - Email/password auth
  - Auto-confirm for internal demo
- Secrets Manager: `/genese/tavily-api-key`, `/genese/db-credentials`
- All containers use task roles (no hardcoded keys)

### Observability
- CloudWatch Log Groups: `/ecs/genese-api`, `/ecs/genese-worker`
- CloudWatch Dashboard: job metrics, queue depth, error rate
- CloudWatch Alarm: DLQ depth > 0 (generation failures)

## CDK Stack Structure
```
infrastructure/
├── app.py                           ← CDK app entry point
└── stacks/
    └── genese_stack.py              ← Single stack (all resources)
        Defines in order:
        1. VPC + subnets + security groups
        2. S3 buckets + CloudFront
        3. Cognito User Pool + Client
        4. Aurora Serverless v2 cluster
        5. ElastiCache Redis Serverless
        6. SQS queue + DLQ
        7. ECR repositories (api + worker)
        8. ECS Cluster + task definitions
        9. ECS Services (API + Worker) with auto-scaling
        10. ALB + target group + listener
        11. Secrets Manager secrets
        12. IAM roles + policies
        13. CloudWatch logs + dashboard + alarms
        14. CloudFormation outputs (API URL, CloudFront URL, etc.)
```
