# Genese Proposal AI — Operations Runbook

> **Audience**: Operators, SREs, and developers managing the live system after deployment.
> **Last updated**: 2026-07-03
> **Region**: us-east-1 | **Account**: 654654306837

---

## Quick Reference

| Resource | Value |
|---|---|
| Frontend URL | https://d3gmhvny3loneb.cloudfront.net |
| API (internal ALB) | http://Genese-ApiLB-XYr1qAvXxyX7-1479126617.us-east-1.elb.amazonaws.com |
| ECS Cluster | genese-proposal-ai |
| API Service | genese-api-service (TD:27, 0.5vCPU / 1GB) |
| Worker Service | genese-worker-service (TD:28, 1vCPU / 2GB) |
| Aurora Cluster | geneseproposalaistack-auroracluster23d869c0-u3dywplmcdan |
| SQS Queue | genese-generation-jobs |
| SQS DLQ | genese-generation-jobs-dlq |
| S3 Docs Bucket | genese-proposal-ai-docs-654654306837-us-east-1 |
| S3 Frontend Bucket | genese-proposal-ai-frontend-654654306837-us-east-1 |
| CloudFront Dist | E31C3VQPMUFTQZ |
| Cognito User Pool | us-east-1_ThM2KRVkt |
| Log Group (API) | /ecs/genese-api |
| Log Group (Worker) | /ecs/genese-worker |

### Default Admin Credentials

| Email | Password | Role |
|---|---|---|
| admin@genesesolution.com | GeneseAdmin2024! | admin |
| demo@genesesolution.com | GeneseDemo2024! | admin |

> **Warning**: Change these passwords before exposing the system to production traffic.

---

## Table of Contents

1. [Daily Health Check](#1-daily-health-check)
2. [User Management](#2-user-management)
3. [Adding Documents to Knowledge Base](#3-adding-documents-to-knowledge-base)
4. [Generating a Proposal Document](#4-generating-a-proposal-document)
5. [Troubleshooting Guide](#5-troubleshooting-guide)
6. [Deploying Code Changes](#6-deploying-code-changes)
7. [Switching the LLM Model](#7-switching-the-llm-model)
8. [Monitoring](#8-monitoring)
9. [Backup and Recovery](#9-backup-and-recovery)
10. [Architecture Reference Images](#10-architecture-reference-images)

---

## 1. Daily Health Check

Run these checks every morning, or whenever you suspect an issue. All commands assume `AWS_DEFAULT_REGION=us-east-1` and a properly configured AWS CLI profile.

```bash
export AWS_DEFAULT_REGION=us-east-1
export CLUSTER=genese-proposal-ai
export ALB=http://Genese-ApiLB-XYr1qAvXxyX7-1479126617.us-east-1.elb.amazonaws.com
export SQS_URL=https://sqs.us-east-1.amazonaws.com/654654306837/genese-generation-jobs
export DLQ_URL=https://sqs.us-east-1.amazonaws.com/654654306837/genese-generation-jobs-dlq
```

### 1.1 ECS Running Task Counts

```bash
# API service — expect runningCount >= 1
aws ecs describe-services \
  --cluster $CLUSTER \
  --services genese-api-service \
  --query 'services[0].{desired:desiredCount,running:runningCount,pending:pendingCount,status:status}' \
  --output table

# Worker service — expect runningCount >= 1
aws ecs describe-services \
  --cluster $CLUSTER \
  --services genese-worker-service \
  --query 'services[0].{desired:desiredCount,running:runningCount,pending:pendingCount,status:status}' \
  --output table
```

**Healthy output**: `runningCount` equals `desiredCount`, `pendingCount` is 0.

### 1.2 API Health Endpoint

```bash
curl -sf $ALB/health | python3 -m json.tool
```

**Healthy output**:
```json
{ "status": "ok", "database": "connected" }
```

If the command returns a non-zero exit code or shows `"database": "error"`, go to [Troubleshooting §5.3](#53-alb-503-errors).

### 1.3 SQS Queue Depth

```bash
# Main queue — should be 0 or low (jobs in flight have visibility timeout of 600s)
aws sqs get-queue-attributes \
  --queue-url $SQS_URL \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible \
  --query 'Attributes' \
  --output table
```

`ApproximateNumberOfMessages` = visible (waiting to be picked up).
`ApproximateNumberOfMessagesNotVisible` = in-flight (being processed by worker).

A large `ApproximateNumberOfMessages` combined with `runningCount=0` means the worker is down.

### 1.4 DLQ Depth (Should Always Be 0)

```bash
aws sqs get-queue-attributes \
  --queue-url $DLQ_URL \
  --attribute-names ApproximateNumberOfMessages \
  --query 'Attributes.ApproximateNumberOfMessages' \
  --output text
```

**Any value > 0 requires immediate investigation.** See [§5.1](#51-job-stuck-in-queued) and [§5.2](#52-job-stuck-in-generating_diagram).

### 1.5 Recent Worker Logs

```bash
# Last 50 log events from the worker (last 10 minutes)
aws logs filter-log-events \
  --log-group-name /ecs/genese-worker \
  --start-time $(date -d '10 minutes ago' +%s000) \
  --filter-pattern '?ERROR ?WARN ?error ?warn' \
  --limit 50 \
  --query 'events[*].{time:timestamp,msg:message}' \
  --output table
```

```bash
# Last 50 log events from the API (last 10 minutes)
aws logs filter-log-events \
  --log-group-name /ecs/genese-api \
  --start-time $(date -d '10 minutes ago' +%s000) \
  --filter-pattern '?ERROR ?WARN ?error ?warn' \
  --limit 50 \
  --query 'events[*].{time:timestamp,msg:message}' \
  --output table
```

### 1.6 Full Health Check Script (copy-paste)

Save this as `health-check.sh` and run it daily:

```bash
#!/usr/bin/env bash
set -euo pipefail

export AWS_DEFAULT_REGION=us-east-1
CLUSTER=genese-proposal-ai
ALB=http://Genese-ApiLB-XYr1qAvXxyX7-1479126617.us-east-1.elb.amazonaws.com
SQS_URL=https://sqs.us-east-1.amazonaws.com/654654306837/genese-generation-jobs
DLQ_URL=https://sqs.us-east-1.amazonaws.com/654654306837/genese-generation-jobs-dlq

echo "=== ECS Services ==="
for svc in genese-api-service genese-worker-service; do
  aws ecs describe-services --cluster $CLUSTER --services $svc \
    --query "services[0].{Service:serviceName,Desired:desiredCount,Running:runningCount,Pending:pendingCount}" \
    --output table
done

echo ""
echo "=== API Health ==="
curl -sf $ALB/health | python3 -m json.tool || echo "HEALTH CHECK FAILED"

echo ""
echo "=== SQS Queue Depth ==="
aws sqs get-queue-attributes --queue-url $SQS_URL \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible \
  --query 'Attributes' --output table

echo ""
echo "=== DLQ Depth (should be 0) ==="
DLQ_COUNT=$(aws sqs get-queue-attributes --queue-url $DLQ_URL \
  --attribute-names ApproximateNumberOfMessages \
  --query 'Attributes.ApproximateNumberOfMessages' --output text)
echo "DLQ messages: $DLQ_COUNT"
[ "$DLQ_COUNT" != "0" ] && echo "*** WARNING: DLQ has messages — investigate immediately ***"

echo ""
echo "=== Recent Errors (last 10 min) ==="
aws logs filter-log-events \
  --log-group-name /ecs/genese-worker \
  --start-time $(date -d '10 minutes ago' +%s000) \
  --filter-pattern 'ERROR' \
  --limit 20 \
  --query 'events[*].message' \
  --output text

echo ""
echo "=== Health check complete ==="
```

---

## 2. User Management

All user management uses Amazon Cognito User Pool `us-east-1_ThM2KRVkt`. Some operations can also be performed via the API using an admin JWT token.

### 2.1 Get an Admin JWT Token

You need this token for all API-based user operations.

```bash
export COGNITO_POOL=us-east-1_ThM2KRVkt
export COGNITO_CLIENT_ID=$(aws cognito-idp list-user-pool-clients \
  --user-pool-id $COGNITO_POOL \
  --query 'UserPoolClients[0].ClientId' --output text)

# Get token for admin user
AUTH_RESULT=$(aws cognito-idp initiate-auth \
  --auth-flow USER_PASSWORD_AUTH \
  --client-id $COGNITO_CLIENT_ID \
  --auth-parameters USERNAME=admin@genesesolution.com,PASSWORD=GeneseAdmin2024! \
  --query 'AuthenticationResult.IdToken' \
  --output text)

export ADMIN_TOKEN=$AUTH_RESULT
export ALB=http://Genese-ApiLB-XYr1qAvXxyX7-1479126617.us-east-1.elb.amazonaws.com

echo "Token acquired: ${ADMIN_TOKEN:0:40}..."
```

### 2.2 List All Users

**Via AWS CLI (Cognito):**
```bash
aws cognito-idp list-users \
  --user-pool-id $COGNITO_POOL \
  --query 'Users[*].{Username:Username,Email:Attributes[?Name==`email`].Value|[0],Status:UserStatus,Enabled:Enabled}' \
  --output table
```

**Via API:**
```bash
curl -sf -H "Authorization: Bearer $ADMIN_TOKEN" \
  $ALB/admin/users | python3 -m json.tool
```

### 2.3 Create a New User

**Via AWS CLI (recommended — creates user and sends temp password):**
```bash
NEW_EMAIL="newuser@example.com"
TEMP_PASSWORD="TempPass2024!"

aws cognito-idp admin-create-user \
  --user-pool-id $COGNITO_POOL \
  --username "$NEW_EMAIL" \
  --user-attributes Name=email,Value="$NEW_EMAIL" Name=email_verified,Value=true \
  --temporary-password "$TEMP_PASSWORD" \
  --message-action SUPPRESS

# Set permanent password immediately (skip forced reset)
aws cognito-idp admin-set-user-password \
  --user-pool-id $COGNITO_POOL \
  --username "$NEW_EMAIL" \
  --password "$TEMP_PASSWORD" \
  --permanent
```

**Assign a role via API** (if the app stores roles in its own DB):
```bash
curl -sf -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"email":"newuser@example.com","role":"user"}' \
  $ALB/admin/users | python3 -m json.tool
```

### 2.4 Change a User's Password

**Via AWS CLI:**
```bash
TARGET_EMAIL="user@example.com"
NEW_PASSWORD="NewSecurePass2024!"

aws cognito-idp admin-set-user-password \
  --user-pool-id $COGNITO_POOL \
  --username "$TARGET_EMAIL" \
  --password "$NEW_PASSWORD" \
  --permanent
```

**Force a password reset (user must change on next login):**
```bash
aws cognito-idp admin-reset-user-password \
  --user-pool-id $COGNITO_POOL \
  --username "$TARGET_EMAIL"
```

### 2.5 Disable / Enable a User

```bash
TARGET_EMAIL="user@example.com"

# Disable (blocks login, does not delete)
aws cognito-idp admin-disable-user \
  --user-pool-id $COGNITO_POOL \
  --username "$TARGET_EMAIL"

# Re-enable
aws cognito-idp admin-enable-user \
  --user-pool-id $COGNITO_POOL \
  --username "$TARGET_EMAIL"
```

### 2.6 Delete a User

> **Warning**: This is permanent. The user's proposals in the database are NOT deleted — only their login access is revoked.

```bash
TARGET_EMAIL="user@example.com"

aws cognito-idp admin-delete-user \
  --user-pool-id $COGNITO_POOL \
  --username "$TARGET_EMAIL"
```

### 2.7 Look Up a Specific User

```bash
TARGET_EMAIL="user@example.com"

aws cognito-idp admin-get-user \
  --user-pool-id $COGNITO_POOL \
  --username "$TARGET_EMAIL" \
  --query '{Username:Username,Status:UserStatus,Enabled:Enabled,Attributes:UserAttributes}' \
  --output table
```


---

## 3. Adding Documents to Knowledge Base

The knowledge base feeds the RAG (Retrieval-Augmented Generation) pipeline. Higher-quality, relevant documents produce significantly better proposal output.

### 3.1 Upload via the UI

1. Open https://d3gmhvny3loneb.cloudfront.net and log in.
2. Click **Documents** in the left sidebar.
3. Click **Upload Document**.
4. Select one or more files. Supported formats: PDF, DOCX, TXT, MD.
5. Give each document a descriptive name and optional tags (e.g., `aws`, `networking`, `cloud-migration`).
6. Click **Upload**. The document enters `pending` status.
7. The worker picks it up from the queue and indexes it. Status changes to `indexed` within 1–3 minutes depending on file size.

### 3.2 Bulk Upload via API

```bash
export ADMIN_TOKEN=<your-admin-jwt-token>   # see §2.1
export ALB=http://Genese-ApiLB-XYr1qAvXxyX7-1479126617.us-east-1.elb.amazonaws.com

# Upload a single file
curl -sf -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -F "file=@/local/path/to/document.pdf" \
  -F "name=My Reference Document" \
  -F "tags=aws,migration" \
  $ALB/documents | python3 -m json.tool
```

**Bulk upload script** (upload all PDFs in a directory):
```bash
#!/usr/bin/env bash
DOC_DIR="./docs-to-upload"
ALB=http://Genese-ApiLB-XYr1qAvXxyX7-1479126617.us-east-1.elb.amazonaws.com

for f in "$DOC_DIR"/*.pdf "$DOC_DIR"/*.docx "$DOC_DIR"/*.txt; do
  [ -f "$f" ] || continue
  BASENAME=$(basename "$f")
  echo "Uploading: $BASENAME"
  curl -sf -X POST \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -F "file=@$f" \
    -F "name=$BASENAME" \
    $ALB/documents | python3 -m json.tool
  sleep 1  # avoid rate limiting
done
echo "Done."
```

### 3.3 Check Indexing Status

**List all documents and their status:**
```bash
curl -sf -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$ALB/documents?limit=50" | python3 -m json.tool
```

**Check a specific document by ID:**
```bash
DOC_ID="your-document-uuid"
curl -sf -H "Authorization: Bearer $ADMIN_TOKEN" \
  $ALB/documents/$DOC_ID | python3 -m json.tool
```

Possible status values:
- `pending` — uploaded, waiting for worker to pick up
- `processing` — worker is currently chunking and embedding
- `indexed` — ready for RAG retrieval
- `failed` — indexing error (check worker logs: `aws logs filter-log-events --log-group-name /ecs/genese-worker --filter-pattern "ingestion error"`)

**Check directly in S3** (raw uploaded files land here):
```bash
aws s3 ls s3://genese-proposal-ai-docs-654654306837-us-east-1/ --recursive --human-readable
```

### 3.4 Recommended Document Types and Formats

| Format | Quality | Notes |
|---|---|---|
| PDF (text-based) | Excellent | Best for technical whitepapers, case studies |
| DOCX | Excellent | Proposals, templates, SOWs |
| TXT / MD | Good | Clean text content, no formatting noise |
| Scanned PDF (image) | Poor | OCR not supported — convert to text first |
| XLSX / CSV | Not supported | Extract relevant content to TXT/MD |

**Best practices for document quality:**

- **Prefer clean, structured text.** PDFs with complex multi-column layouts may produce garbled chunks.
- **Include company-specific content.** Past proposals, case studies, and architecture patterns give Claude the most relevant context.
- **Tag documents consistently.** Tags are used to filter retrieval. Use lowercase, hyphenated tags: `aws`, `cloud-migration`, `security`, `cost-optimization`.
- **Remove boilerplate.** Legal disclaimers and headers/footers on every page create noise in embeddings.
- **Document size.** Files over 50 MB may slow indexing. Split large documents into logical sections.

### 3.5 Why Document Quality Matters for RAG Output

The generation pipeline uses RAG to ground Claude's responses in real company knowledge. Poor-quality documents cause:

- **Hallucinations**: Claude invents details not present in any document.
- **Generic proposals**: Output looks like a generic AWS template, not tailored to Genese's offerings.
- **Wrong architecture diagrams**: Diagram generation pulls service references from retrieved chunks; bad chunks produce irrelevant components.

Rule of thumb: **10 high-quality, relevant documents outperform 100 generic ones.**

---

## 4. Generating a Proposal Document

### 4.1 Complete Flow Walkthrough

#### Step 1 — Open the Generate Form

1. Navigate to https://d3gmhvny3loneb.cloudfront.net.
2. Log in with your credentials.
3. Click **Generate** in the left sidebar.

#### Step 2 — Fill the Form (or use Smart Import)

**Manual entry**: Fill in the required fields:
- **Client Name**: Name of the prospect (e.g., `Acme Corp`)
- **Project Title**: Short description (e.g., `Cloud Migration to AWS`)
- **Requirements**: Free-text description of what the client needs
- **Industry** (optional): Helps Claude pick relevant examples
- **Budget / Timeline** (optional): Adds constraints to the output

**Smart Import** (faster): Click the **Smart Import** button, then paste raw email or RFP text into the text area. Claude will parse the pasted text and auto-fill the form fields. Review the auto-filled values before proceeding — correct any misidentified fields.

#### Step 3 — Submit and Watch the Pipeline

Click **Generate Proposal**. The job enters the pipeline. You will see live status updates:

| Step | Description | Typical Duration |
|---|---|---|
| `queued` | Job submitted to SQS, waiting for worker | < 5 seconds |
| `retrieving_context` | Worker fetches relevant documents from knowledge base | 5–15 seconds |
| `generating_content` | Claude generates proposal sections | 30–90 seconds |
| `generating_diagram` | Claude generates architecture diagram via graphviz | 15–30 seconds |
| `sme_reviewing` | SME review enabled — waiting for SME input | Indefinite |
| `completed` | All steps done, document ready to download | — |
| `failed` | An error occurred — check job details for message | — |

Do not close the browser tab during generation. The job will continue server-side, but you will lose live progress updates.

#### Step 4 — Review the Architecture Diagram

Once `generating_diagram` completes, the diagram appears inline on the job status page. Review it for:

- Correct AWS service selection
- Logical data flows between components
- Missing services (e.g., expected a WAF but it is absent)

If the diagram looks wrong, you can re-generate just the diagram by clicking **Regenerate Diagram** (if available), or re-run the full job after adding better reference architecture images (see [§10](#10-architecture-reference-images)).

#### Step 5 — SME Review

If SME review is enabled for this job:

1. The job pauses at `sme_reviewing` status.
2. The assigned SME receives a notification (email/Slack depending on configuration).
3. The SME opens the review URL, reads the draft proposal, and submits feedback.
4. Click **Submit SME Review** to resume the pipeline.
5. Claude incorporates the feedback and finalises the document.

To **skip SME review** for a specific job, toggle the **SME Review** switch to OFF before submitting.

To check if an SME report has been submitted:
```bash
JOB_ID="your-job-uuid"
curl -sf -H "Authorization: Bearer $ADMIN_TOKEN" \
  $ALB/jobs/$JOB_ID/sme-report | python3 -m json.tool
```

#### Step 6 — Download the Document

When the job reaches `completed`:

1. Click **Download DOCX** for the editable Word document.
2. Click **Download PDF** for the final formatted PDF.

Both files are generated from the same content. Use DOCX when the client's team will further edit, and PDF for final delivery.

#### Step 7 — History and Win/Loss Tracking

1. Click **History** in the left sidebar to see all past proposals.
2. Click any proposal to open its detail view.
3. Use the **Mark as Won** / **Mark as Lost** buttons to record the outcome.
4. The win/loss data is visible in the dashboard summary for conversion rate tracking.

**Filter history by status:**
```bash
# Via API — get won proposals
curl -sf -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$ALB/jobs?status=won&limit=20" | python3 -m json.tool

# Get all proposals for a specific client
curl -sf -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$ALB/jobs?client_name=Acme+Corp" | python3 -m json.tool
```

---

## 5. Troubleshooting Guide

Set these exports before running any diagnostic command in this section:

```bash
export AWS_DEFAULT_REGION=us-east-1
export CLUSTER=genese-proposal-ai
export ALB=http://Genese-ApiLB-XYr1qAvXxyX7-1479126617.us-east-1.elb.amazonaws.com
export SQS_URL=https://sqs.us-east-1.amazonaws.com/654654306837/genese-generation-jobs
export DLQ_URL=https://sqs.us-east-1.amazonaws.com/654654306837/genese-generation-jobs-dlq
export COGNITO_POOL=us-east-1_ThM2KRVkt
```

---

### 5.1 Job Stuck in `queued`

**Symptom**: A job stays in `queued` for more than 2 minutes.

**Diagnostic:**
```bash
# 1. Is the worker running?
aws ecs describe-services \
  --cluster $CLUSTER \
  --services genese-worker-service \
  --query 'services[0].{running:runningCount,desired:desiredCount,pending:pendingCount}' \
  --output table

# 2. Are there messages sitting in the queue?
aws sqs get-queue-attributes \
  --queue-url $SQS_URL \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible \
  --query 'Attributes' --output table

# 3. Check worker logs for startup errors
aws logs filter-log-events \
  --log-group-name /ecs/genese-worker \
  --start-time $(date -d '15 minutes ago' +%s000) \
  --limit 50 \
  --query 'events[*].message' --output text
```

**Fix:**

If `runningCount = 0`:
```bash
# Force a new deployment to restart the worker
aws ecs update-service \
  --cluster $CLUSTER \
  --service genese-worker-service \
  --force-new-deployment

# Watch it come up
aws ecs wait services-stable --cluster $CLUSTER --services genese-worker-service
echo "Worker is stable"
```

If the worker is running but messages are stuck in the queue with `ApproximateNumberOfMessagesNotVisible > 0`, the visibility timeout (600s) may not have expired yet. Wait up to 10 minutes. If still stuck after 10 minutes, the worker is crashing silently — check the logs above.

---

### 5.2 Job Stuck in `generating_diagram`

**Symptom**: Job progresses past `generating_content` but hangs at `generating_diagram` for more than 5 minutes.

**Diagnostic:**
```bash
# Search worker logs for graphviz or Bedrock errors
aws logs filter-log-events \
  --log-group-name /ecs/genese-worker \
  --start-time $(date -d '30 minutes ago' +%s000) \
  --filter-pattern '?graphviz ?diagram ?Bedrock ?ThrottlingException' \
  --limit 50 \
  --query 'events[*].message' --output text
```

**Common causes and fixes:**

| Error in logs | Cause | Fix |
|---|---|---|
| `ThrottlingException` | Bedrock rate limit hit | Wait 1–2 minutes, job will retry automatically |
| `graphviz: command not found` | graphviz not in worker container | Redeploy worker (see §6.3) |
| `Invalid DOT syntax` | Claude generated malformed diagram code | Re-run job; add better reference arch images (§10) |
| `AccessDeniedException` | Worker IAM role lacks Bedrock permissions | Add `bedrock:InvokeModel` to worker task role |

**Verify Bedrock access from the worker task role:**
```bash
TASK_ROLE=$(aws ecs describe-task-definition \
  --task-definition genese-worker-service \
  --query 'taskDefinition.taskRoleArn' --output text)

echo "Task role: $TASK_ROLE"

# Simulate the Bedrock call (replace ROLE_ARN with the task role ARN)
aws bedrock-runtime invoke-model \
  --model-id us.anthropic.claude-haiku-3-5 \
  --body '{"anthropic_version":"bedrock-2023-05-31","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}' \
  --cli-binary-format raw-in-base64-out \
  /tmp/bedrock-test.json && echo "Bedrock OK" || echo "Bedrock FAILED"
```

---

### 5.3 ALB 503 Errors

**Symptom**: API calls return HTTP 503 or the health check script fails.

**Diagnostic:**
```bash
# Is the API service running?
aws ecs describe-services \
  --cluster $CLUSTER \
  --services genese-api-service \
  --query 'services[0].{running:runningCount,desired:desiredCount,events:events[0:3]}' \
  --output json

# Check recent API logs
aws logs filter-log-events \
  --log-group-name /ecs/genese-api \
  --start-time $(date -d '10 minutes ago' +%s000) \
  --filter-pattern '?ERROR ?error ?fatal ?crash' \
  --limit 30 \
  --query 'events[*].message' --output text
```

**Fix:**

If `runningCount = 0`:
```bash
aws ecs update-service \
  --cluster $CLUSTER \
  --service genese-api-service \
  --force-new-deployment

aws ecs wait services-stable --cluster $CLUSTER --services genese-api-service
echo "API service stable"

# Verify health
curl -sf $ALB/health | python3 -m json.tool
```

If the service keeps restarting, check for database connectivity:
```bash
# Look for DB connection errors
aws logs filter-log-events \
  --log-group-name /ecs/genese-api \
  --start-time $(date -d '10 minutes ago' +%s000) \
  --filter-pattern '?ECONNREFUSED ?database ?aurora ?postgres' \
  --limit 20 \
  --query 'events[*].message' --output text
```

If the Aurora cluster is paused (serverless v2 auto-pause after inactivity), the first connection attempt triggers a cold start (30–60 seconds). The API should reconnect automatically. If it does not, restart it with `force-new-deployment`.

---

### 5.4 Login Fails

**Symptom**: User cannot log in — gets "Incorrect username or password" or "User is disabled".

**Diagnostic:**
```bash
TARGET_EMAIL="user@example.com"

aws cognito-idp admin-get-user \
  --user-pool-id $COGNITO_POOL \
  --username "$TARGET_EMAIL" \
  --query '{Status:UserStatus,Enabled:Enabled,Attributes:UserAttributes}' \
  --output table
```

**Fix by case:**

| UserStatus | Enabled | Fix |
|---|---|---|
| `CONFIRMED` | `true` | Password is wrong — reset it (see §2.4) |
| `CONFIRMED` | `false` | Account disabled — re-enable (see §2.5) |
| `FORCE_CHANGE_PASSWORD` | `true` | User never set a permanent password — set one (see §2.4) |
| `UNCONFIRMED` | `true` | Email not verified — resend confirmation or verify manually |

**Manually verify a user's email (skip email verification):**
```bash
aws cognito-idp admin-update-user-attributes \
  --user-pool-id $COGNITO_POOL \
  --username "$TARGET_EMAIL" \
  --user-attributes Name=email_verified,Value=true
```

---

### 5.5 Document Stuck in `pending`

**Symptom**: An uploaded document stays in `pending` status for more than 5 minutes.

**Diagnostic:**
```bash
# Check worker logs for ingestion errors
aws logs filter-log-events \
  --log-group-name /ecs/genese-worker \
  --start-time $(date -d '30 minutes ago' +%s000) \
  --filter-pattern '?ingestion ?embedding ?document ?pending ?failed' \
  --limit 50 \
  --query 'events[*].message' --output text

# Verify the file made it to S3
aws s3 ls s3://genese-proposal-ai-docs-654654306837-us-east-1/ --recursive | grep -i "your-filename"
```

**Fix:**

If the file is in S3 but the worker is not processing it, force-restart the worker:
```bash
aws ecs update-service \
  --cluster $CLUSTER \
  --service genese-worker-service \
  --force-new-deployment
```

If the file is not in S3, the upload failed mid-transfer. Re-upload via the UI or API (§3.2).

If logs show an embedding error (Bedrock Titan Embeddings access denied):
```bash
# Test embeddings access
aws bedrock-runtime invoke-model \
  --model-id amazon.titan-embed-text-v1 \
  --body '{"inputText":"test"}' \
  --cli-binary-format raw-in-base64-out \
  /tmp/embed-test.json && echo "Embeddings OK" || echo "Embeddings FAILED"
```

---

### 5.6 Frontend Shows Old Version

**Symptom**: After a deployment, users still see the old UI.

**Fix — invalidate CloudFront cache:**
```bash
aws cloudfront create-invalidation \
  --distribution-id E31C3VQPMUFTQZ \
  --paths "/*"
```

Invalidation takes 1–3 minutes. Check progress:
```bash
INVAL_ID=$(aws cloudfront create-invalidation \
  --distribution-id E31C3VQPMUFTQZ \
  --paths "/*" \
  --query 'Invalidation.Id' --output text)

aws cloudfront wait invalidation-completed \
  --distribution-id E31C3VQPMUFTQZ \
  --id $INVAL_ID

echo "Invalidation complete — hard refresh your browser (Ctrl+Shift+R)"
```

---

### 5.7 SME Review Not Showing

**Symptom**: A job is in `sme_reviewing` status but the SME report section is empty or not appearing.

**Diagnostic:**
```bash
JOB_ID="your-job-uuid"

# Check job status
curl -sf -H "Authorization: Bearer $ADMIN_TOKEN" \
  $ALB/jobs/$JOB_ID | python3 -m json.tool

# Fetch the SME report directly
curl -sf -H "Authorization: Bearer $ADMIN_TOKEN" \
  $ALB/jobs/$JOB_ID/sme-report | python3 -m json.tool
```

If the job status is `sme_reviewing` but `/sme-report` returns 404, no review has been submitted yet — the job is correctly waiting. Notify the SME.

If the job is stuck in `sme_reviewing` and you want to bypass it:
```bash
# Submit an empty/approval SME review to unblock the job
curl -sf -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"feedback":"Approved — no changes needed","approved":true}' \
  $ALB/jobs/$JOB_ID/sme-report | python3 -m json.tool
```

---

### 5.8 Iterate Fails with Empty Requirements

**Symptom**: Clicking **Iterate** on a job returns an error about empty or missing requirements.

**Status**: This bug is fixed. The jobs list endpoint now includes `key_requirements` in each job object. If you see this error on an older deployment, redeploy the API service (§6.2) to pick up the fix.

**Verify the fix is deployed:**
```bash
curl -sf -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$ALB/jobs?limit=1" | python3 -c "
import sys, json
data = json.load(sys.stdin)
jobs = data.get('jobs', data) if isinstance(data, dict) else data
if jobs:
    job = jobs[0]
    print('key_requirements present:', 'key_requirements' in job)
    print('value:', job.get('key_requirements', 'MISSING'))
else:
    print('No jobs found to verify')
"
```

If `key_requirements` is missing, redeploy:
```bash
aws ecs update-service \
  --cluster $CLUSTER \
  --service genese-api-service \
  --force-new-deployment
```

---

## 6. Deploying Code Changes

All deployments assume you are in the repository root and Docker is running. Set common variables first:

```bash
export AWS_DEFAULT_REGION=us-east-1
export AWS_ACCOUNT=654654306837
export CLUSTER=genese-proposal-ai
export ECR_BASE=$AWS_ACCOUNT.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com

# Log in to ECR
aws ecr get-login-password --region $AWS_DEFAULT_REGION \
  | docker login --username AWS --password-stdin $ECR_BASE
```

---

### 6.1 Frontend Only (Fast — ~2 minutes, no downtime)

Use this when only files under `frontend/` changed.

```bash
# 1. Install dependencies and build
cd frontend
npm ci
npm run build
cd ..

# 2. Sync build output to S3
aws s3 sync frontend/dist/ \
  s3://genese-proposal-ai-frontend-654654306837-us-east-1/ \
  --delete \
  --cache-control "max-age=31536000,immutable" \
  --exclude "index.html"

# 3. Upload index.html with no-cache (always fetch fresh)
aws s3 cp frontend/dist/index.html \
  s3://genese-proposal-ai-frontend-654654306837-us-east-1/index.html \
  --cache-control "no-cache,no-store,must-revalidate"

# 4. Invalidate CloudFront
INVAL_ID=$(aws cloudfront create-invalidation \
  --distribution-id E31C3VQPMUFTQZ \
  --paths "/*" \
  --query 'Invalidation.Id' --output text)

echo "Waiting for invalidation $INVAL_ID ..."
aws cloudfront wait invalidation-completed \
  --distribution-id E31C3VQPMUFTQZ \
  --id $INVAL_ID

echo "Frontend deployed. Hard-refresh browser to verify."
```

---

### 6.2 API Service Only (Rolling — no downtime)

Use this when only backend API code changed (no worker changes).

```bash
API_REPO=$ECR_BASE/genese-api
IMAGE_TAG=$(git rev-parse --short HEAD)

# 1. Build and push Docker image
docker build -t $API_REPO:$IMAGE_TAG -f backend/Dockerfile.api backend/
docker push $API_REPO:$IMAGE_TAG
docker tag $API_REPO:$IMAGE_TAG $API_REPO:latest
docker push $API_REPO:latest

# 2. Get current task definition and update the image
CURR_TD=$(aws ecs describe-task-definition \
  --task-definition genese-api-service \
  --query 'taskDefinition' --output json)

NEW_TD=$(echo $CURR_TD | python3 -c "
import sys, json
td = json.load(sys.stdin)
# Update image tag in first container
td['containerDefinitions'][0]['image'] = td['containerDefinitions'][0]['image'].rsplit(':', 1)[0] + ':$IMAGE_TAG'
# Remove fields that cannot be in RegisterTaskDefinition
for k in ['taskDefinitionArn','revision','status','requiresAttributes',
          'compatibilities','registeredAt','registeredBy']:
    td.pop(k, None)
print(json.dumps(td))
")

# 3. Register new task definition revision
NEW_TD_ARN=$(echo $NEW_TD | aws ecs register-task-definition \
  --cli-input-json file:///dev/stdin \
  --query 'taskDefinition.taskDefinitionArn' --output text)

echo "Registered: $NEW_TD_ARN"

# 4. Update service to use new revision (rolling deploy)
aws ecs update-service \
  --cluster $CLUSTER \
  --service genese-api-service \
  --task-definition $NEW_TD_ARN

# 5. Wait for stability
aws ecs wait services-stable --cluster $CLUSTER --services genese-api-service
echo "API deployment complete."

# 6. Verify
curl -sf http://Genese-ApiLB-XYr1qAvXxyX7-1479126617.us-east-1.elb.amazonaws.com/health \
  | python3 -m json.tool
```

---

### 6.3 Worker Service Only (Rolling — no downtime)

```bash
WORKER_REPO=$ECR_BASE/genese-worker
IMAGE_TAG=$(git rev-parse --short HEAD)

# 1. Build and push
docker build -t $WORKER_REPO:$IMAGE_TAG -f backend/Dockerfile.worker backend/
docker push $WORKER_REPO:$IMAGE_TAG
docker tag $WORKER_REPO:$IMAGE_TAG $WORKER_REPO:latest
docker push $WORKER_REPO:latest

# 2. Get and update task definition
CURR_TD=$(aws ecs describe-task-definition \
  --task-definition genese-worker-service \
  --query 'taskDefinition' --output json)

NEW_TD=$(echo $CURR_TD | python3 -c "
import sys, json
td = json.load(sys.stdin)
td['containerDefinitions'][0]['image'] = td['containerDefinitions'][0]['image'].rsplit(':', 1)[0] + ':$IMAGE_TAG'
for k in ['taskDefinitionArn','revision','status','requiresAttributes',
          'compatibilities','registeredAt','registeredBy']:
    td.pop(k, None)
print(json.dumps(td))
")

NEW_TD_ARN=$(echo $NEW_TD | aws ecs register-task-definition \
  --cli-input-json file:///dev/stdin \
  --query 'taskDefinition.taskDefinitionArn' --output text)

echo "Registered: $NEW_TD_ARN"

# 3. Update service
aws ecs update-service \
  --cluster $CLUSTER \
  --service genese-worker-service \
  --task-definition $NEW_TD_ARN

aws ecs wait services-stable --cluster $CLUSTER --services genese-worker-service
echo "Worker deployment complete."
```

---

### 6.4 Both Services in Parallel

Run the build steps sequentially (Docker can only build one image at a time without buildx), then trigger both ECS updates simultaneously:

```bash
IMAGE_TAG=$(git rev-parse --short HEAD)

# Build and push API
docker build -t $ECR_BASE/genese-api:$IMAGE_TAG -f backend/Dockerfile.api backend/
docker push $ECR_BASE/genese-api:$IMAGE_TAG

# Build and push Worker
docker build -t $ECR_BASE/genese-worker:$IMAGE_TAG -f backend/Dockerfile.worker backend/
docker push $ECR_BASE/genese-worker:$IMAGE_TAG

# Register and update both services (run in background)
# API
(
  CURR=$(aws ecs describe-task-definition --task-definition genese-api-service --query 'taskDefinition' --output json)
  NEW_ARN=$(echo $CURR | python3 -c "
import sys,json; td=json.load(sys.stdin)
td['containerDefinitions'][0]['image']=td['containerDefinitions'][0]['image'].rsplit(':',1)[0]+':$IMAGE_TAG'
[td.pop(k,None) for k in ['taskDefinitionArn','revision','status','requiresAttributes','compatibilities','registeredAt','registeredBy']]
print(json.dumps(td))" | aws ecs register-task-definition --cli-input-json file:///dev/stdin --query 'taskDefinition.taskDefinitionArn' --output text)
  aws ecs update-service --cluster $CLUSTER --service genese-api-service --task-definition $NEW_ARN
  echo "API update triggered: $NEW_ARN"
) &

# Worker
(
  CURR=$(aws ecs describe-task-definition --task-definition genese-worker-service --query 'taskDefinition' --output json)
  NEW_ARN=$(echo $CURR | python3 -c "
import sys,json; td=json.load(sys.stdin)
td['containerDefinitions'][0]['image']=td['containerDefinitions'][0]['image'].rsplit(':',1)[0]+':$IMAGE_TAG'
[td.pop(k,None) for k in ['taskDefinitionArn','revision','status','requiresAttributes','compatibilities','registeredAt','registeredBy']]
print(json.dumps(td))" | aws ecs register-task-definition --cli-input-json file:///dev/stdin --query 'taskDefinition.taskDefinitionArn' --output text)
  aws ecs update-service --cluster $CLUSTER --service genese-worker-service --task-definition $NEW_ARN
  echo "Worker update triggered: $NEW_ARN"
) &

# Wait for both
wait
echo "Both deployments triggered. Waiting for stability..."

aws ecs wait services-stable --cluster $CLUSTER \
  --services genese-api-service genese-worker-service

echo "Both services stable."
curl -sf http://Genese-ApiLB-XYr1qAvXxyX7-1479126617.us-east-1.elb.amazonaws.com/health \
  | python3 -m json.tool
```

---

## 7. Switching the LLM Model

You can change the Bedrock model used for generation without any code changes — it is controlled by the `BEDROCK_LLM_MODEL_ID` environment variable in the worker task definition.

### Available Models

| Model ID | Speed | Quality | Cost |
|---|---|---|---|
| `us.anthropic.claude-sonnet-4-6` | Medium | Highest | Highest |
| `us.anthropic.claude-haiku-3-5` | Fastest | Good | Lowest |
| `amazon.nova-pro-v1:0` | Fast | High | Medium |

### Switch Model — Step by Step

```bash
export AWS_DEFAULT_REGION=us-east-1
export CLUSTER=genese-proposal-ai

# 1. Choose the new model
NEW_MODEL="us.anthropic.claude-haiku-3-5"
# Options:
#   us.anthropic.claude-sonnet-4-6   (default, highest quality)
#   us.anthropic.claude-haiku-3-5    (fastest, lowest cost)
#   amazon.nova-pro-v1:0             (alternative)

# 2. Get the current worker task definition
CURR_TD=$(aws ecs describe-task-definition \
  --task-definition genese-worker-service \
  --query 'taskDefinition' --output json)

# 3. Verify current model setting
echo $CURR_TD | python3 -c "
import sys, json
td = json.load(sys.stdin)
env = td['containerDefinitions'][0].get('environment', [])
for e in env:
    if e['name'] == 'BEDROCK_LLM_MODEL_ID':
        print('Current model:', e['value'])
        break
else:
    print('BEDROCK_LLM_MODEL_ID not set (using code default)')
"

# 4. Build new task definition with updated env var
NEW_TD=$(echo $CURR_TD | python3 -c "
import sys, json
td = json.load(sys.stdin)
env = td['containerDefinitions'][0].setdefault('environment', [])
# Remove existing entry if present
env[:] = [e for e in env if e['name'] != 'BEDROCK_LLM_MODEL_ID']
# Add new value
env.append({'name': 'BEDROCK_LLM_MODEL_ID', 'value': '$NEW_MODEL'})
# Strip read-only fields
for k in ['taskDefinitionArn','revision','status','requiresAttributes',
          'compatibilities','registeredAt','registeredBy']:
    td.pop(k, None)
print(json.dumps(td))
")

# 5. Register the new revision
NEW_TD_ARN=$(echo $NEW_TD | aws ecs register-task-definition \
  --cli-input-json file:///dev/stdin \
  --query 'taskDefinition.taskDefinitionArn' --output text)

echo "New task definition: $NEW_TD_ARN"

# 6. Update the worker service
aws ecs update-service \
  --cluster $CLUSTER \
  --service genese-worker-service \
  --task-definition $NEW_TD_ARN

# 7. Wait for rollout
aws ecs wait services-stable --cluster $CLUSTER --services genese-worker-service
echo "Worker restarted with model: $NEW_MODEL"
```

### Verify the Change

```bash
# The new task definition should show the updated env var
aws ecs describe-task-definition \
  --task-definition genese-worker-service \
  --query 'taskDefinition.containerDefinitions[0].environment' \
  --output table
```

### Rolling Back the Model

```bash
# List recent task definition revisions
aws ecs list-task-definitions \
  --family-prefix genese-worker-service \
  --sort DESC \
  --query 'taskDefinitionArns[:5]' \
  --output table

# Roll back to a specific revision (e.g., revision 28)
aws ecs update-service \
  --cluster $CLUSTER \
  --service genese-worker-service \
  --task-definition genese-worker-service:28

aws ecs wait services-stable --cluster $CLUSTER --services genese-worker-service
echo "Rolled back."
```

---

## 8. Monitoring

### 8.1 Tail Logs in Real Time

**API logs (live stream):**
```bash
# Get the latest log stream for the API
STREAM=$(aws logs describe-log-streams \
  --log-group-name /ecs/genese-api \
  --order-by LastEventTime \
  --descending \
  --limit 1 \
  --query 'logStreams[0].logStreamName' --output text)

aws logs tail /ecs/genese-api \
  --log-stream-names "$STREAM" \
  --follow
```

**Worker logs (live stream):**
```bash
STREAM=$(aws logs describe-log-streams \
  --log-group-name /ecs/genese-worker \
  --order-by LastEventTime \
  --descending \
  --limit 1 \
  --query 'logStreams[0].logStreamName' --output text)

aws logs tail /ecs/genese-worker \
  --log-stream-names "$STREAM" \
  --follow
```

**Both services simultaneously (requires two terminals or tmux):**
```bash
# Terminal 1
aws logs tail /ecs/genese-api --follow

# Terminal 2
aws logs tail /ecs/genese-worker --follow
```

**Filter for specific job ID:**
```bash
JOB_ID="your-job-uuid"
aws logs filter-log-events \
  --log-group-name /ecs/genese-worker \
  --start-time $(date -d '1 hour ago' +%s000) \
  --filter-pattern "\"$JOB_ID\"" \
  --query 'events[*].message' --output text
```

### 8.2 Key Log Patterns to Watch For

Use these filter patterns in CloudWatch or with `aws logs filter-log-events`:

| Pattern | Meaning | Action |
|---|---|---|
| `ERROR` | General error | Investigate immediately |
| `ThrottlingException` | Bedrock rate limit | Normal at bursts; alert if persistent |
| `AccessDeniedException` | IAM permission problem | Check task role policies |
| `ECONNREFUSED` | Cannot reach Aurora | Check Aurora cluster state |
| `SQS.*failed` | Message processing failure | Check DLQ count |
| `ingestion.*error` | Document embedding failed | Re-upload document |
| `graphviz` | Diagram generation issue | See §5.2 |
| `job.*completed` | Job finished successfully | Good signal for throughput |
| `token_count` | Token usage per job | Monitor for cost spikes |

**Search for errors in the last hour:**
```bash
for GROUP in /ecs/genese-api /ecs/genese-worker; do
  echo "=== $GROUP ==="
  aws logs filter-log-events \
    --log-group-name $GROUP \
    --start-time $(date -d '1 hour ago' +%s000) \
    --filter-pattern 'ERROR' \
    --limit 20 \
    --query 'events[*].message' --output text
done
```

### 8.3 SQS DLQ Monitoring

**Check DLQ depth:**
```bash
aws sqs get-queue-attributes \
  --queue-url https://sqs.us-east-1.amazonaws.com/654654306837/genese-generation-jobs-dlq \
  --attribute-names ApproximateNumberOfMessages \
  --query 'Attributes.ApproximateNumberOfMessages' --output text
```

**Read (but do not delete) a DLQ message to see why it failed:**
```bash
aws sqs receive-message \
  --queue-url https://sqs.us-east-1.amazonaws.com/654654306837/genese-generation-jobs-dlq \
  --max-number-of-messages 1 \
  --attribute-names All \
  --query 'Messages[0].{Body:Body,Attributes:Attributes}' \
  --output json | python3 -m json.tool
```

**Redrive DLQ messages back to the main queue** (after fixing the underlying issue):
```bash
# Set source queue's redrive allow policy, then use AWS Console
# Redrive: SQS Console > genese-generation-jobs-dlq > Start DLQ Redrive
# Or via CLI (requires setting up a redrive policy):
aws sqs start-message-move-task \
  --source-arn arn:aws:sqs:us-east-1:654654306837:genese-generation-jobs-dlq \
  --destination-arn arn:aws:sqs:us-east-1:654654306837:genese-generation-jobs
```

**Purge DLQ** (discard all failed messages — only do this if they are unrecoverable):
```bash
# WARNING: This permanently deletes all DLQ messages
aws sqs purge-queue \
  --queue-url https://sqs.us-east-1.amazonaws.com/654654306837/genese-generation-jobs-dlq
echo "DLQ purged."
```

### 8.4 Cost Tracking

Token usage is logged per job and visible in the UI on the job detail page under **Usage Stats**. To view token counts programmatically:

```bash
# Get token usage for recent jobs
curl -sf -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$ALB/jobs?limit=20" | python3 -c "
import sys, json
data = json.load(sys.stdin)
jobs = data.get('jobs', data) if isinstance(data, dict) else data
total = 0
for j in jobs:
    tokens = j.get('token_count', 0) or 0
    total += tokens
    print(f\"{j.get('id','?')[:8]}  {j.get('status','?'):20s}  {tokens:>8,} tokens\")
print(f\"{'Total':30s}  {total:>8,} tokens\")
"
```

**AWS Cost Explorer** — check Bedrock spend:
```bash
aws ce get-cost-and-usage \
  --time-period Start=$(date -d '7 days ago' +%Y-%m-%d),End=$(date +%Y-%m-%d) \
  --granularity DAILY \
  --filter '{"Dimensions":{"Key":"SERVICE","Values":["Amazon Bedrock"]}}' \
  --metrics BlendedCost \
  --query 'ResultsByTime[*].{Date:TimePeriod.Start,Cost:Total.BlendedCost.Amount}' \
  --output table
```

### 8.5 CloudWatch Alarms (Recommended Setup)

These alarms are not pre-created — set them up to get proactive alerts:

```bash
# Alarm: DLQ has messages
aws cloudwatch put-metric-alarm \
  --alarm-name "GenAI-DLQ-HasMessages" \
  --alarm-description "DLQ received a message — a job failed 3 times" \
  --namespace AWS/SQS \
  --metric-name ApproximateNumberOfMessagesVisible \
  --dimensions Name=QueueName,Value=genese-generation-jobs-dlq \
  --statistic Sum \
  --period 60 \
  --threshold 1 \
  --comparison-operator GreaterThanOrEqualToThreshold \
  --evaluation-periods 1 \
  --alarm-actions arn:aws:sns:us-east-1:654654306837:your-alert-topic

# Alarm: API service running count drops to 0
aws cloudwatch put-metric-alarm \
  --alarm-name "GenAI-API-NoRunningTasks" \
  --namespace AWS/ECS \
  --metric-name RunningTaskCount \
  --dimensions Name=ClusterName,Value=genese-proposal-ai Name=ServiceName,Value=genese-api-service \
  --statistic Minimum \
  --period 60 \
  --threshold 1 \
  --comparison-operator LessThanThreshold \
  --evaluation-periods 2 \
  --alarm-actions arn:aws:sns:us-east-1:654654306837:your-alert-topic
```

---

## 9. Backup and Recovery

### 9.1 Current Backup Status

| Resource | Backup Status | Risk |
|---|---|---|
| Aurora DB | No PITR enabled | **High** — enable PITR immediately in production |
| S3 Docs bucket | Versioning not enabled | Medium |
| S3 Frontend bucket | Versioning not needed (source of truth is git) | Low |
| Cognito User Pool | AWS-managed, highly durable | Low |
| SQS messages | In-flight only, not persistent | Low (jobs re-runnable) |

### 9.2 Take a Manual Aurora Snapshot

Run this before any risky operation (database migrations, major deployments):

```bash
CLUSTER_ID=geneseproposalaistack-auroracluster23d869c0-u3dywplmcdan
SNAP_ID="manual-snapshot-$(date +%Y%m%d-%H%M%S)"

aws rds create-db-cluster-snapshot \
  --db-cluster-identifier $CLUSTER_ID \
  --db-cluster-snapshot-identifier $SNAP_ID

echo "Snapshot $SNAP_ID creation started."

# Wait for it to complete
aws rds wait db-cluster-snapshot-available \
  --db-cluster-snapshot-identifier $SNAP_ID

echo "Snapshot ready: $SNAP_ID"
```

**List existing snapshots:**
```bash
aws rds describe-db-cluster-snapshots \
  --db-cluster-identifier $CLUSTER_ID \
  --query 'DBClusterSnapshots[*].{ID:DBClusterSnapshotIdentifier,Status:Status,Created:SnapshotCreateTime}' \
  --output table
```

### 9.3 Enable PITR (Point-in-Time Recovery) — Recommended

```bash
aws rds modify-db-cluster \
  --db-cluster-identifier $CLUSTER_ID \
  --backup-retention-period 7 \
  --apply-immediately

echo "PITR enabled with 7-day retention."
```

This enables automatic daily snapshots and transaction log retention for 7 days. You can restore to any second within the retention window.

### 9.4 Enable S3 Versioning (Recommended)

```bash
aws s3api put-bucket-versioning \
  --bucket genese-proposal-ai-docs-654654306837-us-east-1 \
  --versioning-configuration Status=Enabled

echo "Versioning enabled for docs bucket."
```

### 9.5 What to Do if Aurora Goes Down

Aurora Serverless v2 can take 30–60 seconds to resume from auto-pause. Most transient failures self-resolve.

**Step 1 — Check Aurora status:**
```bash
CLUSTER_ID=geneseproposalaistack-auroracluster23d869c0-u3dywplmcdan

aws rds describe-db-clusters \
  --db-cluster-identifier $CLUSTER_ID \
  --query 'DBClusters[0].{Status:Status,Capacity:ServerlessV2ScalingConfiguration,Endpoint:Endpoint}' \
  --output table
```

**Step 2 — If status is `stopped` or `paused`, trigger a connection to wake it:**
```bash
# Restarting the API service will trigger a DB connection and wake Aurora
aws ecs update-service \
  --cluster genese-proposal-ai \
  --service genese-api-service \
  --force-new-deployment

aws ecs wait services-stable --cluster genese-proposal-ai --services genese-api-service
curl -sf http://Genese-ApiLB-XYr1qAvXxyX7-1479126617.us-east-1.elb.amazonaws.com/health \
  | python3 -m json.tool
```

**Step 3 — If Aurora instance is in an error state, restore from snapshot:**
```bash
# List snapshots
aws rds describe-db-cluster-snapshots \
  --db-cluster-identifier $CLUSTER_ID \
  --query 'DBClusterSnapshots[*].{ID:DBClusterSnapshotIdentifier,Created:SnapshotCreateTime,Status:Status}' \
  --output table

# Restore (creates a NEW cluster — update connection strings after)
SNAP_ID="the-snapshot-id-to-restore"
aws rds restore-db-cluster-from-snapshot \
  --db-cluster-identifier genese-aurora-restored \
  --snapshot-identifier $SNAP_ID \
  --engine aurora-postgresql \
  --engine-version "16.4" \
  --serverless-v2-scaling-configuration MinCapacity=0.5,MaxCapacity=4

echo "Restore initiated. Update DB connection env vars in ECS task definitions after cluster is available."
```

### 9.6 What to Do if the Worker Gets Stuck

A stuck worker can block all pending jobs. The safe recovery is a force-new-deployment:

```bash
# Step 1: Check if the worker is actually stuck
aws ecs describe-services \
  --cluster genese-proposal-ai \
  --services genese-worker-service \
  --query 'services[0].{running:runningCount,deployments:deployments}' \
  --output json

# Step 2: Check SQS — are messages stuck in-flight (not visible)?
aws sqs get-queue-attributes \
  --queue-url https://sqs.us-east-1.amazonaws.com/654654306837/genese-generation-jobs \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible \
  --output table

# Step 3: Force restart the worker
aws ecs update-service \
  --cluster genese-proposal-ai \
  --service genese-worker-service \
  --force-new-deployment

aws ecs wait services-stable \
  --cluster genese-proposal-ai \
  --services genese-worker-service

echo "Worker restarted. In-flight SQS messages will become visible again after the 600s visibility timeout expires."
```

The SQS visibility timeout is 600 seconds (10 minutes). After the old worker task is killed, its in-flight messages will become visible again and the new worker will pick them up. If a message fails 3 times, it moves to the DLQ.

---

## 10. Architecture Reference Images

### What Are Reference Architecture Images?

Reference architectures are PNG or JPG images of AWS architecture diagrams that you upload to the system. When Claude generates a new architecture diagram for a proposal, it uses these images as visual examples to guide its design decisions — service selection, diagram style, component placement, and connectivity patterns.

**High-quality references produce better diagrams.** Generic prompts without references produce generic AWS diagrams. Company-specific references (past projects, preferred patterns) produce diagrams that match Genese's delivery style.

### How to Upload a Reference Architecture

1. Navigate to https://d3gmhvny3loneb.cloudfront.net.
2. Log in with an admin account.
3. Click **Settings** or **Reference Architectures** in the sidebar (location may vary by UI version).
4. Click **Upload Reference Architecture**.
5. Select a PNG or JPG file. Maximum recommended size: 5 MB.
6. Add a descriptive name: e.g., `3-Tier Web App on AWS`, `Serverless Data Pipeline`, `Multi-Region Failover`.
7. Add tags to help the system select relevant references: e.g., `serverless`, `multi-region`, `data-pipeline`, `microservices`.
8. Click **Save**.

**Via API:**
```bash
curl -sf -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -F "file=@/local/path/reference-arch.png" \
  -F "name=Three Tier Web Application" \
  -F "tags=web,three-tier,rds,alb" \
  $ALB/reference-architectures | python3 -m json.tool
```

### Best Practices for Reference Images

- **Use official AWS architecture diagrams** as a baseline (AWS Solutions Library: https://aws.amazon.com/solutions/).
- **Include Genese-specific past project architectures.** Real delivered architectures work better than theoretical ones.
- **Use clean, readable diagrams.** Avoid screenshots of slides with heavy text overlays — they confuse the vision model.
- **Organise by domain.** Upload separate images for: networking, data, serverless, migration, security, containers.
- **Keep images current.** Remove outdated architecture patterns that use deprecated services.

### Recommended Reference Architecture Set (Starter Kit)

| Architecture | Tags |
|---|---|
| VPC with public/private subnets, NAT, IGW | `networking`, `vpc`, `baseline` |
| Three-tier web app (ALB + ECS + RDS) | `web`, `three-tier`, `ecs` |
| Serverless API (API GW + Lambda + DynamoDB) | `serverless`, `lambda`, `api` |
| Data lake (S3 + Glue + Athena + QuickSight) | `data`, `analytics`, `lake` |
| CI/CD pipeline (CodePipeline + ECR + ECS) | `cicd`, `devops`, `ecs` |
| Multi-region active-passive DR | `multi-region`, `disaster-recovery` |
| Microservices on EKS with service mesh | `containers`, `kubernetes`, `microservices` |
| Event-driven pipeline (SQS + Lambda + SNS) | `event-driven`, `serverless`, `integration` |

### Verify Reference Images Are Being Used

After uploading, run a test proposal generation for a known domain (e.g., "serverless data pipeline for a retail client") and review the generated diagram. If the output matches the style and services in your reference image, the integration is working correctly.

---

*End of Genese Proposal AI Operations Runbook*

*For architecture details, see [01-system-overview.md](./01-system-overview.md), [02-deployment-guide.md](./02-deployment-guide.md), and [03-architecture-blueprint.md](./03-architecture-blueprint.md).*
