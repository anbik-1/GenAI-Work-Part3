# Genese Proposal AI — Execution Plan

## Workflow Summary
- **Project Type**: Greenfield, Full Autonomy, Deploy Live
- **Total Stages**: 6 (Requirements ✓ → Application Design → Code Generation → Build & Test → Deploy)
- **Skipped Stages**: Reverse Engineering, User Stories, Units Generation, Functional Design (simple enough), NFR Requirements (captured in requirements)
- **Risk Level**: Medium (new AI/RAG architecture, but well-defined stack)
- **Single Unit**: Yes — one deployable system

## Execution Sequence

```
[x] Workspace Detection
[x] Requirements Analysis
[ ] Application Design        ← NEXT
[ ] Code Generation (Part 1: Plan)
[ ] Code Generation (Part 2: Generate)
[ ] Build & Test
[ ] Deploy to AWS
```

## Stage Details

### Application Design
- Define component interfaces and method signatures
- Define data models (PostgreSQL schema + pgvector table)
- Define API surface (FastAPI routes)
- Define LangChain chain architecture
- Define CDK stack resource plan

### Code Generation
One unit, built in this order (dependency order):
1. Infrastructure (CDK stack) — defines all AWS resources
2. Shared models/types (Pydantic + SQLAlchemy)
3. Worker service (RAG pipeline + generation chains)
4. API service (FastAPI routers + business logic)
5. Frontend (React UI)
6. Seed data + templates

### Build & Test
- Docker builds for API and Worker containers
- Frontend build (Vite)
- CDK synth validation
- Smoke tests against deployed endpoints

### Deploy
- CDK bootstrap + deploy
- ECR push (API + Worker images)
- DB migration (pgvector extension + schema)
- Seed data ingestion
- Frontend S3 sync + CloudFront
- End-to-end verification
