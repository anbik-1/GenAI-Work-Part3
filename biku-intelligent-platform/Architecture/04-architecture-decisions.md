# Architecture Decisions Log — Genese Proposal AI

> **Format**: Architecture Decision Records (ADR)
> **Last Updated**: 2026-07-03

Each record covers: Context, Decision, Alternatives Considered, Reasons, and Consequences.

---

## ADR Index

| ID | Title | Status |
|----|-------|--------|
| [ADR-001](#adr-001-ecs-fargate-over-lambda-for-compute) | ECS Fargate over Lambda for compute | Accepted |
| [ADR-002](#adr-002-aurora-postgresql--pgvector-over-dedicated-vector-db) | Aurora PostgreSQL + pgvector over dedicated vector DB | Accepted |
| [ADR-003](#adr-003-cdk-for-infrastructure--cli-for-ecs-services) | CDK for infrastructure + CLI for ECS services | Accepted |
| [ADR-004](#adr-004-two-separate-ecs-containers-api--worker) | Two separate ECS containers (API + Worker) | Accepted |
| [ADR-005](#adr-005-cognito-admininitiateauth-via-backend-proxy) | Cognito AdminInitiateAuth via backend proxy | Accepted |
| [ADR-006](#adr-006-amazon-titan-text-v2-for-embeddings) | Amazon Titan Text v2 for embeddings | Accepted |
| [ADR-007](#adr-007-model-id-configurable-via-env-var) | Model ID configurable via env var | Accepted |
| [ADR-008](#adr-008-role-based-access-stored-in-db-not-cognito-groups) | Role-based access stored in DB, not Cognito groups | Accepted |
| [ADR-009](#adr-009-interactive-sme-review-not-silent-improvement) | Interactive SME review (not silent improvement) | Accepted |
| [ADR-010](#adr-010-cloudfront-api-proxy-to-avoid-mixed-content) | CloudFront /api/* proxy to avoid mixed content | Accepted |

---

## ADR-001: ECS Fargate over Lambda for compute

**Status**: Accepted

### Context

LLM generation jobs take 30–90 seconds to complete. The system requires an async worker pattern that can continuously poll a queue and process long-running tasks without artificial time constraints.

### Decision

Use **ECS Fargate** with two services: an **API service** and a **Worker service**.

### Alternatives Considered

| Option | Reason Rejected |
|--------|----------------|
| **AWS Lambda** | 15-minute execution limit; cold starts add latency; not suitable for a continuous SQS consumer loop |
| **EC2** | Operational burden of managing instances, patching, scaling groups |
| **AWS App Runner** | Less control over async worker patterns; designed for synchronous HTTP workloads |

### Reasons

- LLM jobs routinely exceed Lambda-friendly durations (30–90 seconds, sometimes longer).
- The SQS consumer pattern requires a process that runs forever, polling for new messages — fundamentally incompatible with Lambda's invocation model.
- API and Worker have **different scaling profiles**: API scales on HTTP request volume, Worker scales on SQS queue depth. Separate services allow independent auto-scaling.

### Consequences

- ECS services **must be created via AWS CLI** after CDK deployment — they cannot be managed as CDK/CloudFormation resources. CloudFormation's 3-hour ECS service stabilization timeout caused repeated full-stack rollbacks during development (see also ADR-003).

---

## ADR-002: Aurora PostgreSQL + pgvector over dedicated vector DB

**Status**: Accepted

### Context

The RAG (Retrieval-Augmented Generation) pipeline requires vector similarity search to find relevant document chunks. Several purpose-built vector database options were evaluated alongside a PostgreSQL extension approach.

### Decision

Use **Aurora PostgreSQL Serverless v2** with the **pgvector extension** for all vector storage and similarity search.

### Alternatives Considered

| Option | Reason Rejected |
|--------|----------------|
| **OpenSearch Serverless** | $300–700/month floor cost regardless of usage — unacceptable for a system that may be idle |
| **Pinecone** | External SaaS; data leaves AWS, creating compliance and data sovereignty concerns |
| **Weaviate** | Additional service to manage; separate operational complexity |

### Reasons

- Aurora Serverless v2 **scales to 0 ACU when idle**, resulting in near-zero idle cost — critical for a workload with variable usage patterns.
- SQL familiarity lowers the learning curve and simplifies querying across relational and vector data in the same engine.
- A **single database** serves all data needs: job metadata, document storage, and vector embeddings — eliminating cross-service joins and synchronization issues.
- Data remains within AWS, satisfying data residency requirements.

### Consequences

- pgvector cosine similarity queries **must use f-string literal embedding values** in SQL. The `asyncpg` driver conflicts with the `:param::vector` parameter binding syntax, requiring the embedding vector to be interpolated directly into the query string as a literal.

---

## ADR-003: CDK for infrastructure + CLI for ECS services

**Status**: Accepted

### Context

The project requires repeatable, version-controlled infrastructure provisioning. All AWS resources (VPC, Aurora, S3, Cognito, ALB, ECR, CloudFront, etc.) need to be defined as code.

### Decision

**AWS CDK** deploys all infrastructure. **AWS CLI scripts** create ECS services as a post-deployment step outside of CDK/CloudFormation control.

### Alternatives Considered

| Option | Reason Rejected |
|--------|----------------|
| **Terraform** | Team not familiar with HCL; CDK allows Python — same language as the application |
| **CloudFormation YAML** | Verbose, less expressive than CDK constructs; same stabilization timeout problem |
| **Fully manual** | Not repeatable; no version control; error-prone |

### Reasons

- CDK is written in **Python**, the same language as the application, reducing context switching and enabling shared utilities.
- CDK's high-level constructs **automatically wire IAM permissions**, reducing the risk of misconfigured roles.
- ECS services are excluded from CDK specifically to avoid the CloudFormation stabilization timeout problem (see critical lesson below).

### Critical Lesson

> ⚠️ **CloudFormation waits up to 3 hours for ECS service stabilization.** If the container image is not present in ECR at deploy time, or if the health check fails, CloudFormation will roll back the **entire stack** — destroying Aurora, S3, Cognito, and all other resources along with it.
>
> Removing ECS service definitions from CDK was **mandatory** to prevent catastrophic rollbacks during iterative development.

### Consequences

- A separate CLI-based deployment script (e.g., `deploy-services.sh`) must be run after `cdk deploy` to create or update ECS services.
- ECS service configuration (task definition revisions, desired count, etc.) is managed outside the CDK stack lifecycle.

---

## ADR-004: Two separate ECS containers (API + Worker)

**Status**: Accepted

### Context

The system handles two fundamentally different workload types: synchronous HTTP API requests (milliseconds to seconds) and asynchronous LLM generation jobs (30–90 seconds). These have conflicting resource and scaling requirements.

### Decision

Run two separate ECS services:

| Service | Image | Resources | Role |
|---------|-------|-----------|------|
| **API** | FastAPI app | 0.5 vCPU / 1 GB RAM | Handles HTTP requests, auth, job submission |
| **Worker** | LangChain worker | 1 vCPU / 2 GB RAM | Polls SQS, runs LLM generation pipeline |

### Alternatives Considered

| Option | Reason Rejected |
|--------|----------------|
| **Single container running both** | LLM jobs would block HTTP request handling; cannot scale components independently |
| **Lambda for worker** | See ADR-001 — Lambda's execution model is incompatible with long-running SQS consumer loops |

### Reasons

- API and Worker have **different scaling needs**: API scales on request rate (ALB target tracking), Worker scales on SQS queue depth.
- LLM generation jobs must **never block HTTP endpoints** — keeping them in separate processes ensures API responsiveness.
- Worker's higher memory allocation (2 GB) accommodates LangChain and embedding model operations without impacting the leaner API container.

### Consequences

- **SQS** is the decoupling mechanism between the API (producer) and Worker (consumer).
- **Critical bug discovered**: The DB record for a job **must be committed before publishing the job ID to SQS**. If the SQS message is published first, the Worker may pick it up and query the DB before the API's transaction commits — finding no record and failing. Always: write to DB → commit → then publish to SQS.

---

## ADR-005: Cognito AdminInitiateAuth via backend proxy

**Status**: Accepted

### Context

The application requires user authentication. Cognito was selected as the identity provider, but the specific auth flow needed careful consideration given browser security constraints.

### Decision

The **frontend calls its own API** (`POST /auth/login`), and the **FastAPI backend calls Cognito's `AdminInitiateAuth`** server-side using AWS SDK credentials.

### Alternatives Considered

| Option | Reason Rejected |
|--------|----------------|
| **Direct Cognito SDK calls from browser** | `AdminInitiateAuth` requires AWS credentials — cannot be exposed to a browser client |
| **Cognito Hosted UI** | Poor UX customization; redirects away from the application |
| **Auth0** | External SaaS dependency; adds cost and data residency concerns |
| **Clerk** | External SaaS dependency; adds cost and vendor lock-in |

### Reasons

- `AdminInitiateAuth` is a **server-side only** API call that requires AWS IAM credentials with Cognito permissions. It cannot be safely invoked from a browser.
- Routing all auth through the backend keeps credentials server-side and enables centralized logging, rate limiting, and error handling.

### Consequences

- **All authentication flows** — login, signup, token refresh, and password reset — are proxied through the FastAPI backend. There is no direct browser-to-Cognito communication.
- The backend must have an IAM role with `cognito-idp:AdminInitiateAuth` and related permissions.

---

## ADR-006: Amazon Titan Text v2 for embeddings

**Status**: Accepted

### Context

The RAG pipeline requires text embeddings to convert document chunks and queries into vectors for similarity search. Multiple embedding providers were evaluated.

### Decision

Use **Amazon Titan Text Embeddings v2** via **Amazon Bedrock**.

### Alternatives Considered

| Option | Reason Rejected |
|--------|----------------|
| **OpenAI text-embedding-3** | Data leaves AWS; external API dependency; ongoing per-token cost at higher rate |
| **Cohere Embed v3** | External SaaS; data leaves AWS |

### Reasons

- Data **stays within AWS** — embeddings are generated without sending text to external services.
- **Lowest cost** of evaluated options: $0.00002 per 1,000 tokens.
- No external API key management — uses existing AWS IAM credentials via Bedrock.

### Critical Lesson

> ⚠️ **Titan Text Embeddings v2 outputs 1024 dimensions, NOT 1536.**
>
> This caused a schema mismatch bug: the `pgvector` column was initially created with `vector(1536)` (matching OpenAI's dimensions), causing all embedding inserts to fail.
>
> **Always verify the actual output dimensions of an embedding model before defining the vector column schema.** Do not assume dimensions based on other providers.

### Consequences

- The `pgvector` column must be defined as `vector(1024)`.
- Any future model swap to a different embedding provider requires a schema migration to change the vector dimension.

---

## ADR-007: Model ID configurable via env var

**Status**: Accepted

### Context

The system uses Amazon Bedrock LLMs for proposal generation. Different use cases or cost optimization scenarios may require switching between models (e.g., Claude Sonnet vs. Claude Haiku). Hardcoding the model ID would require code changes and redeployment for every switch.

### Decision

Store the LLM model ID in the **`BEDROCK_LLM_MODEL_ID` environment variable** on the ECS task definition. The API enforces a **validated whitelist** of permitted model IDs. Model selection follows a priority chain:

```
per-request model_id  >  BEDROCK_LLM_MODEL_ID env var  >  hardcoded default
```

### Alternatives Considered

| Option | Reason Rejected |
|--------|----------------|
| **AWS Secrets Manager** | Overkill for non-secret configuration; adds latency and cost for a simple string |
| **SSM Parameter Store** | More complex retrieval; env vars are simpler for task-definition-level config |

### Reasons

- An env var on the ECS task definition means **no code deployment is needed** to switch models — only a task definition update and service rolling update.
- A whitelist in the API **prevents abuse**: callers cannot request arbitrary Bedrock model IDs that the system has not been approved to use.

### Consequences

- Switching models requires: (1) updating the ECS task definition with the new `BEDROCK_LLM_MODEL_ID` value, and (2) triggering a **service rolling update** to redeploy tasks with the new environment variable.
- The whitelist must be maintained as new approved models are added.

---

## ADR-008: Role-based access stored in DB, not Cognito groups

**Status**: Accepted

### Context

The application needs to distinguish between `admin` users (who can manage other users) and `member` users (standard access). This distinction must be enforced on protected endpoints.

### Decision

Store a **`role` column** (`admin` | `member`) on the `users` table. Every admin endpoint performs a **DB query** to verify the authenticated user's role before proceeding.

### Alternatives Considered

| Option | Reason Rejected |
|--------|----------------|
| **Cognito Groups** | More complex to configure; requires parsing group claims from the JWT; adds Cognito-side management overhead |
| **Separate IAM roles** | Not applicable for application-level RBAC; IAM roles govern AWS service access, not application authorization |

### Reasons

- Simpler implementation: the `users` table already exists, and adding a `role` column requires minimal schema change.
- Avoids the complexity of JWT group claim extraction and Cognito group management.
- Role checks are consistent and auditable through the same DB connection already used for all other data access.

### Consequences

- The **public `/signup` endpoint has been removed**. Self-registration is not permitted.
- Only admin users can create new accounts via the protected endpoint: `POST /auth/admin/create-user`.
- Every admin-gated endpoint incurs an additional DB query to verify role — negligible overhead given existing DB usage patterns.

---

## ADR-009: Interactive SME review (not silent improvement)

**Status**: Accepted

### Context

The proposal generation pipeline included a Subject Matter Expert (SME) review stage that used an LLM to identify issues and suggest improvements to generated documents. The initial implementation silently applied all AI-suggested changes without user awareness or consent.

### Decision

SME review **pauses the pipeline** at a `sme_reviewing` job status. The system presents a **full review report** to the user containing:

- Findings (issues identified)
- Discrepancies (inconsistencies with source material)
- Proposed changes (specific suggested edits)

The user then explicitly chooses to **Apply** or **Skip** the SME suggestions.

### Alternatives Considered

| Option | Reason Rejected |
|--------|----------------|
| **Silent auto-apply** | User has no visibility into what the AI changed; unacceptable for professional documents |
| **No SME review** | Loses the quality improvement benefit of the review stage entirely |

### Reasons

> **The user must remain in control.** Blind AI modifications to professional proposal documents are a liability — inaccurate or misapplied changes could damage client relationships or misrepresent the company's capabilities.

The interactive model preserves the quality benefit of SME review while ensuring human oversight of every suggested change.

### Consequences

- New job status: **`sme_reviewing`** — the pipeline pauses here awaiting user action.
- New API endpoints:
  - `GET /sme-report` — returns the full SME review findings for a job
  - `POST /sme-apply` — applies the approved suggestions and advances the pipeline
- The frontend must handle the `sme_reviewing` status by surfacing the review UI instead of a generic "processing" indicator.

---

## ADR-010: CloudFront /api/* proxy to avoid mixed content

**Status**: Accepted

### Context

The React frontend is served over **HTTPS** via CloudFront. The Application Load Balancer (ALB) serving the FastAPI backend operates over **HTTP only**. Browsers enforce mixed content policy: an HTTPS page cannot make HTTP `fetch` requests — they are silently blocked or result in errors.

### Decision

Configure a **CloudFront cache behavior** for the `/api/*` path that routes requests to the ALB origin. A **CloudFront Function (`StripApiPrefix`)** strips the `/api` prefix from the URL before forwarding to the ALB.

```
Browser (HTTPS)  →  CloudFront (/api/*)  →  CF Function strips /api  →  ALB (HTTP)  →  FastAPI
```

### Alternatives Considered

| Option | Reason Rejected |
|--------|----------------|
| **ACM certificate on ALB (HTTPS)** | Adds cost and certificate management complexity; requires custom domain on ALB |
| **Serve frontend from EC2/ALB** | Loses CloudFront CDN benefits (caching, global edge, DDoS protection); more complex deployment |

### Reasons

- CloudFront handles **HTTPS termination** at the edge. The ALB-to-origin leg is HTTP within AWS's internal network — acceptable for this architecture.
- This approach eliminates mixed content errors with zero changes to the FastAPI application.
- All requests to the backend appear to come from a single HTTPS origin (`https://<cloudfront-domain>/api/*`), simplifying CORS configuration.

### Consequences

- The **`StripApiPrefix` CloudFront Function** is a required component. It must rewrite `/api/v1/jobs` → `/v1/jobs` (or equivalent) before the request reaches the ALB, since FastAPI routes do not include the `/api` prefix.
- Any new API path must remain under the `/api/*` cache behavior pattern to be correctly routed.
- CloudFront caching must be **disabled** (or set to no-cache) for API responses to prevent stale data being served from edge nodes.

---

*End of Architecture Decisions Log*
