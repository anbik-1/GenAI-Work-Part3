# Genese Proposal AI — Requirements Document

## Intent Analysis

- **User Request**: Internal AI system for Genese Solution that generates proposals, SoWs, and case studies faster by searching past work and live vendor documentation, then drafting branded output automatically.
- **Request Type**: New Project (Greenfield)
- **Scope Estimate**: Large — multi-component AI system (RAG pipeline + agentic generation + async worker + web API + frontend UI)
- **Complexity Estimate**: High — LLM orchestration, vector search, async job processing, document generation, real-time web validation
- **Priority**: Internal productivity tool — consultant edits, not writes. Speed and accuracy over perfection.
- **Purpose**: Eliminate 80% of repetitive proposal writing at Genese Solution consulting firm

---

## Technology Decisions

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Language | Python 3.12 | LangChain, python-docx, pgvector — all native Python |
| LLM | Claude Sonnet 4.6 via Amazon Bedrock | Confirmed active in account; stays in AWS |
| Embeddings | Amazon Titan Text Embeddings v2 via Bedrock | AWS-native, cheapest, no external call |
| Vector DB | Aurora PostgreSQL Serverless v2 + pgvector | Scales to zero, SQL familiarity, cheaper than OpenSearch at low volume |
| RAG Framework | LangChain | Mature RAG tooling, Bedrock + pgvector integrations |
| Web Search | Tavily (free tier, 1k/mo) | No credit card required; only necessary external service |
| Compute | ECS Fargate (API container + Worker container) | Long-running LLM tasks (30s–3min) unsuitable for Lambda |
| Job Queue | Amazon SQS | Decouples API from Worker; handles async generation |
| Doc Generation | python-docx + branded template | Genese-branded .docx output |
| Storage | Amazon S3 | Raw document ingestion + generated .docx delivery |
| Auth | Amazon Cognito | JWT-secured API; internal users only |
| IaC | AWS CDK (Python) | Same language as app; all-in-AWS |
| Container Registry | Amazon ECR | Private container images |
| Frontend | React + TypeScript + Tailwind CSS | Consultant-facing UI |
| API Framework | FastAPI (Python) | Async, fast, OpenAPI docs auto-generated |

---

## Functional Requirements

### FR-1: Document Ingestion & Knowledge Base

**FR-1.1**: The system shall accept document uploads (PDF, DOCX, TXT) via the web UI or S3 upload. Maximum file size: 50MB per document.

**FR-1.2**: The system shall chunk uploaded documents into overlapping segments (512 tokens, 50-token overlap) using LangChain text splitters.

**FR-1.3**: The system shall embed each chunk using Amazon Titan Text Embeddings v2 and store the vector + metadata in Aurora PostgreSQL (pgvector).

**FR-1.4**: Metadata stored per chunk: document_id, filename, document_type (proposal/sow/case_study/other), client_name, engagement_type, date_created, chunk_index, source_text.

**FR-1.5**: The system shall support bulk ingestion of multiple documents in one operation.

**FR-1.6**: The system shall provide a document library view showing all ingested documents with metadata, upload date, and chunk count.

**FR-1.7**: Users shall be able to delete documents from the knowledge base (removes all associated chunks and embeddings).

### FR-2: Intelligent Knowledge Search (RAG)

**FR-2.1**: The system shall accept a natural language query and return the top-K (default K=5) most semantically similar past document chunks.

**FR-2.2**: Each search result shall include: source document name, relevant excerpt, similarity score, and document metadata.

**FR-2.3**: The system shall support filtered search: filter by document_type, engagement_type, or date range.

**FR-2.4**: The system shall provide a standalone "Knowledge Search" interface where consultants can ask questions like "What did we do for the last fintech client?" and receive an AI-synthesized answer with source citations.

**FR-2.5**: Answers shall cite specific source documents with page/chunk references.

### FR-3: Live Documentation Validation

**FR-3.1**: During proposal generation, the system shall use Tavily to search live AWS, Azure, and GCP documentation to validate architecture recommendations.

**FR-3.2**: Validation shall return: relevant doc URL, excerpt, and confidence that the recommendation is current/accurate.

**FR-3.3**: Validated sources shall be cited inline in the generated proposal.

**FR-3.4**: The system shall cache Tavily results (TTL: 24 hours) in Redis/ElastiCache to avoid burning free-tier credits on repeated lookups.

**FR-3.5**: If Tavily is unavailable or credits exhausted, generation proceeds without external validation (graceful degradation).

### FR-4: Proposal & SoW Generation

**FR-4.1**: The system shall accept a generation request with: document_type (proposal/sow/case_study), client_name, engagement_type, key_requirements (free text), and optional context notes.

**FR-4.2**: Generation pipeline shall execute as an async job via SQS:
1. Retrieve relevant past work via RAG (FR-2)
2. Validate key tech claims via Tavily (FR-3)
3. Draft document using Claude Sonnet 4.6 with retrieved context
4. Format into Genese-branded .docx using python-docx template

**FR-4.3**: The system shall use a structured prompt that instructs Claude to:
- Follow Genese's standard proposal structure (Executive Summary, Problem Statement, Proposed Solution, Architecture, Team, Timeline, Investment/Pricing, Next Steps)
- Write in Genese's brand voice (professional, consultative, outcome-focused)
- Cite retrieved past work where relevant
- Include validated architecture recommendations with sources

**FR-4.4**: Generation status shall be trackable via job_id (queued → processing → complete → failed).

**FR-4.5**: Completed documents shall be stored in S3 and accessible via a time-limited presigned URL (valid 24 hours).

**FR-4.6**: Users can download the generated .docx directly from the UI.

**FR-4.7**: The system shall support regeneration of a document with modified inputs without starting from scratch.

### FR-5: Consultant UI

**FR-5.1**: The system shall provide a web UI accessible to Genese consultants after Cognito login.

**FR-5.2**: The UI shall have four main sections:
  - **Generate** — create new proposals/SoWs/case studies
  - **Search** — query the knowledge base
  - **Documents** — manage the knowledge base (upload, view, delete)
  - **History** — past generated documents with download links

**FR-5.3**: Generation form shall show real-time job status with progress indication (queued → retrieving context → drafting → formatting → ready).

**FR-5.4**: The UI shall display retrieved RAG context and Tavily sources used in generation (transparency panel).

**FR-5.5**: Generated document preview shall show a summary before download.

**FR-5.6**: The UI shall support dark/light mode.

### FR-6: Synthetic Seed Data (Build Phase)

**FR-6.1**: The system shall include a seed script that generates and ingests 10 synthetic Genese-style documents:
- 4 proposals (AWS migration, data platform, managed services, security audit)
- 3 SoWs (cloud infrastructure setup, data engineering, DevSecOps)
- 3 case studies (fintech, retail, healthcare clients)

**FR-6.2**: Seed data shall be realistic enough to demonstrate RAG retrieval working correctly during demo/testing.

---

## Non-Functional Requirements

### NFR-1: Async Generation
- Proposal generation must be fully async — API returns job_id immediately; consultant polls for status.
- Target generation time: < 3 minutes for a standard 5-page proposal.

### NFR-2: Scalability
- ECS Fargate worker auto-scales: 1–5 worker tasks based on SQS queue depth.
- Aurora Serverless v2 scales automatically; minimum ACUs set to 0.5 (cost optimization).

### NFR-3: Security
- All API endpoints (except health check) require valid Cognito JWT.
- S3 presigned URLs for document download (no public buckets).
- Tavily API key stored in AWS Secrets Manager.
- VPC with private subnets for Aurora and ECS tasks; ALB in public subnet.
- No secrets in environment variables; all via Secrets Manager / Parameter Store.

### NFR-4: Observability
- CloudWatch logs for API and Worker containers.
- CloudWatch metrics: job_queue_depth, generation_success_rate, generation_duration_p95.
- Structured JSON logging throughout.

### NFR-5: Cost Optimization
- Aurora Serverless v2 with auto-pause (scales to 0 ACUs after 5 min idle).
- ECS tasks: 0.5 vCPU / 1GB RAM for API; 1 vCPU / 2GB RAM for Worker.
- S3 lifecycle rules: move generated docs to Infrequent Access after 30 days.
- Tavily: cache responses 24h to minimize credit usage.

### NFR-6: Simplicity & Maintainability
- Clear separation: API (FastAPI) handles HTTP; Worker handles LLM/RAG/generation.
- LangChain chains are composable and testable.
- CDK stack clearly documented with inline comments.
- README with full setup, architecture, and testing instructions.

---

## AWS Services Summary

| Service | Purpose |
|---------|---------|
| Amazon Bedrock | Claude Sonnet 4.6 (LLM) + Titan Text v2 (embeddings) |
| Amazon ECS Fargate | API container + Worker container |
| Amazon ECR | Private Docker image registry |
| Amazon SQS | Async job queue (API → Worker) |
| Aurora PostgreSQL Serverless v2 | Vector store (pgvector) + application DB |
| Amazon S3 | Raw document storage + generated .docx output |
| Amazon CloudFront | Frontend CDN + presigned URL delivery |
| Amazon Cognito | User authentication (JWT) |
| Amazon ALB | Load balancer for ECS API service |
| AWS Secrets Manager | Tavily API key + DB credentials |
| Amazon ElastiCache (Redis) | Tavily response cache |
| Amazon CloudWatch | Logs + metrics + alarms |
| AWS CDK | Infrastructure as Code |

---

## Out of Scope (Explicitly Excluded)

- Real payment processing or billing
- Multi-tenant / multi-company support
- Mobile application
- Version control / diff of generated documents
- Real-time collaboration on documents
- Email delivery of generated documents
- Integration with CRM (Salesforce, HubSpot)
- Fine-tuning or model training
- Support for languages other than English

---

## Application Structure

```
genese-proposal-ai/                    ← Application root
├── services/
│   ├── api/                           ← FastAPI application (ECS task)
│   │   ├── src/
│   │   │   ├── routers/               ← auth, documents, generate, search, jobs
│   │   │   ├── models/                ← Pydantic models + SQLAlchemy ORM
│   │   │   ├── services/              ← business logic (thin layer over workers)
│   │   │   └── core/                  ← config, db, auth middleware
│   │   ├── Dockerfile
│   │   └── requirements.txt
│   └── worker/                        ← LangChain RAG + generation worker (ECS task)
│       ├── src/
│       │   ├── chains/                ← LangChain: retrieval, validation, generation chains
│       │   ├── ingestion/             ← Document chunking + embedding pipeline
│       │   ├── generation/            ← python-docx template + branded output
│       │   └── core/                  ← config, db, SQS consumer
│       ├── Dockerfile
│       └── requirements.txt
├── frontend/                          ← React SPA
│   ├── src/
│   │   ├── pages/                     ← Generate, Search, Documents, History
│   │   ├── components/                ← shadcn/ui + custom components
│   │   ├── contexts/                  ← AuthContext, JobContext
│   │   └── lib/                       ← API client
│   └── package.json
├── infrastructure/                    ← CDK (Python)
│   ├── app.py
│   └── stacks/
│       └── genese_stack.py
├── scripts/
│   ├── seed_data.py                   ← Generates + ingests synthetic documents
│   └── seed_documents/                ← 10 synthetic .txt proposal/SoW/case study files
├── templates/
│   └── genese_proposal_template.docx  ← Base branded .docx template
└── README.md
```
