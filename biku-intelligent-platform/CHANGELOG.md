# Changelog — Genese Proposal AI
## What Was Built, Fixed, and Changed

> This file captures every meaningful change made during the development session.
> Most recent changes are at the top.

---

## 2026-07-04 (Today)

### Biku Intelligent Platform — Second Instance Deployed
- Copied the entire project to `/biku-intelligent-platform/` as a separate named deployment
- Renamed all identifiers (stack name, cluster, ECR repos, S3 buckets, secrets, log groups)
- CDK stack parameterised with `app_name` so any name can be used
- **Discovered and fixed a missing CDK IAM permission** — `cognito-idp:AdminInitiateAuth` was not in the task role. Login failed on fresh deploys. Fixed in both CDK stacks (Genese + Biku).
- Biku is live at: `https://dbf12eqaa717l.cloudfront.net`
- Credentials: `admin@bikuplatform.com / BikuAdmin2024!`

### RAG Documentation (`Architecture/07-rag-implementation.md`)
1,022-line document covering:
- What RAG is and why this app needs it
- Every technology choice with rationale (Aurora+pgvector, Titan Text v2, 1024 dims, cosine similarity, ivfflat, 512-char chunks)
- Complete ingestion flow + retrieval flow with diagrams
- Concrete before/after examples (generic vs RAG-grounded proposal)
- Current metrics: 28 docs, 1,346 vector chunks
- 10 prioritised improvements: reranking, hybrid search, HyDE, HNSW index, metadata filtering, query expansion, parent-child chunking

### Auth & Authorization Documentation (`Architecture/08-auth-and-authorization.md`)
486-line document covering:
- Authentication vs authorization — what each means
- Full Cognito token flow with ASCII diagrams (login, API call, token refresh)
- Why AdminInitiateAuth must be server-side (cannot be called from browser)
- JWT claims breakdown, JWKS validation
- Role access matrix: admin vs member across every endpoint
- Current gaps and improvement roadmap (MFA, Google OAuth, httpOnly cookies)

### Authorization Fix — Job Ownership Enforcement
- `GET /generate/{job_id}` now verifies the job belongs to the requesting user
- Members get HTTP 403 if they try to access another user's job by UUID
- Admins can see all jobs
- Admin responses include `owner_email` and `owner_name`
- Documents were already correctly scoped (member → own only, admin → all)

### SME Review — Fixed Pipeline Hang
- **Root cause:** `apply_sme_changes()` was missing from `orchestrator.py` — the function `main.py` was trying to call
- Added `apply_sme_changes(db, job, apply: bool)` — applies improvements if apply=True, then enqueues format job
- Added `_enqueue_format(job_id)` helper that publishes `{"job_type":"format"}` SQS message
- **Pipeline now completes correctly:** sme_reviewing → user clicks Apply/Skip → formatting_output → complete

### SME Review — 2025 AWS Technical Context
- SME prompt now includes engagement-type-specific 2025 AWS best practices
- Flags deprecated services: CloudEndure → MGN, SMS → MGN, SSO → IAM Identity Center
- 11 engagement types covered: aws_migration, data_platform, security_audit, devops_transformation, cloud_native_development, finops_optimization, disaster_recovery, managed_services, ai_ml_platform, cloud_adoption, cloud_optimization
- SME review now produces genuinely useful findings (not generic observations)

### Generation Pipeline UI Fixes
- Completed steps now show green ✓ checkmark (was ugly strikethrough)
- Active step shows pulsing dot + `status_detail` text from API
- Future steps shown as dimmed gray
- `validating_sources` label changed to "Checking AWS docs..."

### deploy.sh Portability Fix
- Consolidated migration now creates ALL tables and ALL columns in one pass (v1+v2+v3+v4 combined)
- Was previously missing 8 columns: `sections_content`, `drawio_s3_key`, `pdf_s3_key`, `proposal_score`, `sme_report`, `outcome`, `template_name`, `plain_text_instructions`, `role` on users, `arch_references` table
- CDK stack hardcoded account ID `654654306837` in ECR URI outputs → fixed to `self.account`
- LoginPage Google OAuth URLs now use env vars (`VITE_COGNITO_DOMAIN`) + dynamic `window.location.origin`

### Architecture Documentation Updates
- `03-architecture-blueprint.md` — added Changelog table at top, updated TD revisions
- `05-deployment-master.md` — added Bedrock model access as ⚠️ CRITICAL prerequisite, full DB schema, portability note, Quick Start summary table

---

## 2026-07-03

### Features Added

#### Smart Import (CRM / Email)
- "Smart Import" collapsible section on Generate page
- Paste any client email, RFP text, or meeting notes
- Claude extracts client name, requirements, context, engagement type and auto-fills the form
- Backend: `POST /generate/extract-requirements` using Claude Sonnet 4.6

#### Win/Loss Tracking
- [Won] [Lost] [Pending] chips on each job card in History
- Stored in `generation_jobs.outcome` column (VARCHAR 20)
- Trophy icon on won proposals
- API: `POST /generate/{id}/outcome`

#### Client Portal (Shareable Link)
- "Share Link" button on complete jobs copies `https://domain/portal/{job_id}`
- New public page `/portal/:jobId` — no login required
- Shows proposal details, score, download buttons
- API: `GET /portal/{job_id}` (no auth)

#### Proposal Score
- After every generation Claude scores on 5 dimensions (1-10 each): completeness, clarity, technical_depth, client_alignment, value_proposition
- Stored in `generation_jobs.proposal_score` JSONB
- Displayed in History Overview modal with colored progress bars

#### PDF Export
- Worker generates `.pdf` alongside `.docx` using ReportLab
- Stored in `generation_jobs.pdf_s3_key`
- PDF download button in History and client portal

#### Architecture References Page
- New "Arch Refs" tab in navbar
- Upload PNG/JPG/PDF sample AWS architectures as style references
- Grid layout with lightbox preview
- Stored in new `arch_references` table

#### draw.io / Mermaid Export
- Architecture diagrams now export as `.drawio` XML (mxGraph format with real AWS4 shapes)
- Can be opened directly in draw.io, Lucidchart, VS Code extension, Confluence
- Also generates Mermaid syntax as alternative
- Stored in `generation_jobs.drawio_s3_key`

#### SME Review (Interactive)
- Optional toggle in architecture review panel
- Claude acts as domain expert (11 engagement type personas)
- Returns structured report: overall score, findings with severity, discrepancies, proposed improvements
- User sees before/after diff, chooses Apply or Skip
- Pipeline pauses at `sme_reviewing` status until user decides

#### Plain Text Template
- Third template option: Default (Genese branded), Plain Text (no styling), Uploaded .docx
- Plain Text shows a custom instructions textarea when selected
- Instructions guide tone, formatting, structure
- Stored in `generation_jobs.plain_text_instructions`

#### Model Selector
- Collapsible model selector on Generate page
- 4 options: Claude Sonnet 4.6, Sonnet 4.5, Haiku 3.5, Nova Pro
- Per-user preference stored in localStorage
- Sent as `model_id` in generation request
- Backend validates against whitelist (security)
- Environment variable `BEDROCK_LLM_MODEL_ID` overrides the default for all users

#### Role-Based User Management
- Two roles: `admin` and `member`
- Public `/auth/signup` removed (was a security risk)
- Admin-only: `POST /auth/admin/create-user`, `GET /auth/users`, `DELETE /auth/users/{id}`
- `GET /auth/me` returns profile + role
- Users page in navbar (admin only) — invite, manage, delete users
- Members see only their own jobs and documents

#### Document Iteration
- "Iterate" button on History cards for complete/failed jobs
- Pre-fills original requirements, add notes for what to change
- Creates a new job as version v2, v3, etc.
- Jobs grouped by client name in History with version labels

#### History Page Overhaul
- Two-column card grid
- Tags/labels per job stored in localStorage (Nepal Client, US Client, Banking, etc. + custom)
- Architecture lightbox with approve/revise (view-only for complete jobs)
- Overview modal with full job details + inline document reader (collapsible sections)
- Win/loss outcome chips
- Version grouping (v1, v2, v3...) by client name

#### Generate Page Improvements
- Single-column wider layout (max-w-3xl, no cramped two-column split)
- Bigger form fields, larger Generate button
- TemplateSelector component with inline upload
- Generation Constraints section with quick-add chips (AWS Best Practices, Serverless First, etc.)

#### Documents Grid Layout
- Changed from vertical rows to responsive grid (2-5 cards per row)
- Compact cards with hover-reveal token info and delete button
- Indexing phase progress shown during upload

### Bugs Fixed

| Bug | Root Cause | Fix |
|---|---|---|
| Iterate document "Failed to queue" | `key_requirements` and `context_notes` not in jobs list response | Added to SQL SELECT and return dict in `jobs.py` |
| Architecture iterate "not awaiting review" | Lightbox showed Approve/Revise for complete jobs | Added `jobStatus` prop to ArchLightbox — hides actions for non-awaiting_review |
| Smart import not working | Wrong model ID (`claude-sonnet-4-5` instead of `4-6`) + `text` variable shadowed `sqlalchemy.text` | Fixed model ID, renamed variable |
| Architecture references "failed to load" | `arch_references` table not created in migration | Added `CREATE TABLE arch_references` to consolidated migration |
| Token expiry causing "Failed to load" | No token refresh on 401 | `api.ts` now silently refreshes token and retries on 401 |
| redis_cache import crash | `redis_cache.py` was deleted but `validation_chain.py` still imported it | Replaced with simple in-memory dict cache |
| Dead `REDIS_URL` env var | Redis removed from stack, stale env var remained | Removed from `WorkerSettings` |

### Architecture & Documentation

#### Architecture folder created (`Architecture/`)
All 8 files below are the definitive project reference:

| File | Lines | Contents |
|---|---|---|
| `01-system-overview.md` | 909 | What the app does, all components, all flows |
| `02-deployment-guide.md` | 1,216 | CDK vs CLI concepts, all deployment steps |
| `03-architecture-blueprint.md` | 1,434 | Every AWS resource ID, DB schema, debug commands |
| `04-architecture-decisions.md` | 387 | 10 ADRs — why every major decision was made |
| `05-deployment-master.md` | 1,400 | Master deployment guide, complete schema |
| `06-operations-runbook.md` | 1,575 | Daily ops, troubleshooting, monitoring |
| `07-rag-implementation.md` | 1,022 | RAG setup, flows, improvements |
| `08-auth-and-authorization.md` | 486 | Full auth/authz documentation |

#### DB migrations (all idempotent)
- `db_migration_v2.py` — adds `outcome`, `proposal_score`, `pdf_s3_key`, `sme_report`, `role` on users
- `db_migration_v3.py` — adds `template_name`
- `db_migration_v4.py` — adds `plain_text_instructions`
- `deploy.sh` — consolidated migration creates everything in one pass for fresh installs

### Credentials

| User | Password | Role | App |
|---|---|---|---|
| `demo@genesesolution.com` | `GeneseDemo2024!` | admin | Genese Proposal AI |
| `admin@genesesolution.com` | `GeneseAdmin2024!` | admin | Genese Proposal AI |
| `admin@bikuplatform.com` | `BikuAdmin2024!` | admin | Biku Intelligent Platform |

### Live Deployments

| App | URL | Stack | API TD | Worker TD |
|---|---|---|---|---|
| Genese Proposal AI | https://d3gmhvny3loneb.cloudfront.net | GeneseProposalAIStack | :28 | :29 |
| Biku Intelligent Platform | https://dbf12eqaa717l.cloudfront.net | BikuIntelligentPlatformStack | :2 | :1 |

---
*Last updated: 2026-07-04*
