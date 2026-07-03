# What Is the Operations Phase?

## Definition

Operations is the phase after code is built and tested. It covers everything needed to **deploy, run, observe, and maintain** the system in a real environment — and to recover when things go wrong.

In AIDLC terms, this phase is currently a placeholder (formally undefined). But the work it describes is real and critical. We did most of it during development — often under the label of "debugging" or "fixing." This folder documents it properly.

---

## What Operations Covers

### 1. Deployment

Getting the system running in an environment. Includes:
- Infrastructure provisioning (CDK, Terraform, CloudFormation)
- Container image builds and pushes
- Service creation and startup
- Database schema creation and migration
- Configuration and secrets injection
- First-run verification

**Our deliverable:** `deploy.sh` — one script, 13 steps, fully automated.

---

### 2. Monitoring and Observability

Knowing what the system is doing at all times. Includes:
- Structured application logs (CloudWatch, Datadog, etc.)
- Metrics (CPU, memory, request latency, error rate)
- Alerting (notify on failure before users notice)
- Distributed tracing (follow a request across services)
- Cost tracking (cloud spend visibility)

**What to watch in this system:**
- ECS task health (`runningCount` vs `desiredCount`)
- SQS DLQ depth (dead-letter queue — failed jobs)
- Aurora CPU and connection count
- Bedrock token usage and cost per job
- CloudFront error rate (4xx/5xx)

---

### 3. Incident Response

What to do when something breaks at 2am. Includes:
- Runbooks: step-by-step recovery procedures
- Root cause analysis (RCA): why did it break, what changed
- Post-mortems: document what happened, what was learned
- On-call procedures

**Signs of trouble in this system:**
- Job stuck in `queued` forever → worker not running or SQS not delivering
- Job stuck in `generating_diagram` → Bedrock timeout or diagrams library error
- ALB 503 → ECS API task not running
- Documents stuck in `pending` → worker not running or SQS race condition

---

### 4. Maintenance

Keeping the system healthy over time. Includes:
- Dependency updates (Python packages, Node packages, base Docker images)
- Security patches
- Database vacuuming / index maintenance
- Secret rotation
- Backup verification

**Periodic tasks for this system:**
- Rotate DB credentials in Secrets Manager
- Update `claude-sonnet-4-6` model ID if AWS deprecates it
- Rebuild Docker images for OS/package security patches
- Verify Aurora backups are running (enable PITR in production)

---

### 5. Production Hardening

Making the system safe for real users and real data. Includes:
- High availability (multiple tasks, multi-AZ)
- Data protection (backups, `RemovalPolicy.RETAIN`)
- Security (WAF, HTTPS everywhere, least-privilege IAM)
- Rate limiting and abuse prevention
- CORS locked to specific domain

**Not yet done for this system (intentional — dev/demo phase):**
- `desiredCount=2` on both ECS services
- `RemovalPolicy.RETAIN` on Aurora and S3
- Aurora PITR backups enabled
- WAF on CloudFront
- ACM certificate on ALB
- CORS locked from `*` to specific domain

---

### 6. Scaling

Handling more load. Includes:
- Horizontal scaling (more tasks)
- Auto-scaling policies
- Queue-based scaling (scale worker on SQS queue depth)
- Database read replicas or connection pooling

**For this system when needed:**
- API: increase `desiredCount` on `genese-api-service`
- Worker: increase `desiredCount` on `genese-worker-service` or add auto-scaling on SQS depth
- Aurora: auto-scales from 0.5 to 4 ACU by default — no action needed until 4 ACU is saturated

---

## How Operations Relates to the Rest of AIDLC

```
INCEPTION    → What to build and why
CONSTRUCTION → How to build it (design + code + test)
OPERATIONS   → How to run it, watch it, fix it, and keep it running
```

Operations never truly ends. Every deployment, every bug fix in production, every alert that fires — that is Operations. AIDLC formalises it as a phase so teams don't treat it as an afterthought.
