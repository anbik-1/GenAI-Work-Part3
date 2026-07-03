# July3.md — Issues Faced & Fixes Applied (July 3, from ~9 AM onward)

---

## Issue 1: Document Pricing Showed $0 on Knowledge Base Page

**Symptom:** All documents on the Documents page showed `$0.000000` for embedding cost and `0` tokens.

**Root cause:** Two sub-causes:
1. The `embedding_tokens` column was added via `ALTER TABLE` after documents were indexed — existing documents had `NULL`/`0` in that column (no backfill)
2. The `DocumentsPage` frontend only fetched `/documents/{id}/status` for `pending`/`processing` docs, never for `complete` docs — so it never loaded the token data even when available

**Fix applied:**
1. **DB backfill** — ran a one-off script via ECS that estimated token counts from actual chunk word counts (`words × 1.3 ≈ tokens`) and updated all documents with `chunk_count > 0` and `embedding_tokens = 0`
2. **Frontend fix** — updated polling logic to also fetch status for `complete` docs that have `embedding_tokens = 0`, so token/cost data loads on page open

---

## Issue 2: Generation Stuck in "Drafting Document" — Bedrock Timeout

**Symptom:** PG Group job stuck at `drafting_document` for 5+ minutes then failed with `Read timeout on endpoint URL: bedrock-runtime.us-east-1.amazonaws.com`

**Root cause:** The default Bedrock HTTP client has a 60-second read timeout. Large/complex proposals take 60–90 seconds for Claude to generate — occasionally exceeding the limit.

**Fix applied:**
- Updated `bedrock.py` to create a custom boto3 client with `read_timeout=120` (2 minutes) and `retries={"max_attempts": 2}` using `botocore.config.Config`
- Worker redeployed with new timeout (TD:15)

---

## Issue 3: Old Failed Job Suddenly Completed — Confused User

**Symptom:** PG Group job was `failed`, then suddenly flipped to `complete` without user resubmitting.

**Root cause:** This is expected SQS behavior — NOT a bug. When a message fails processing (Bedrock timeout), it becomes visible again in SQS after the visibility timeout (600s). The new worker (with 120s timeout) picked it up and completed it successfully.

**Fix applied:** None required — system worked correctly. Added explanation to the user. This behavior is actually desirable (automatic retry).

---

## Issue 4: Download Button Not Working — All Jobs Return `None`

**Symptom:** Clicking Download on any completed job did nothing. API returned `null` for `status`, `download_url`, and all fields.

**Root cause (two parts):**
1. **Missing route decorator** — when the cancel endpoint was added to `generate.py`, the `@router.get("/{job_id}")` decorator was accidentally dropped from `get_job_status`. FastAPI was no longer registering it as an HTTP GET route, causing all poll/status requests to return empty.
2. **Async SQLAlchemy stale column cache** — even with the decorator restored, the async ORM session cached the column list from before `ALTER TABLE` migrations ran, so newly added columns (`output_s3_key`, `llm_model`, `input_tokens`, `output_tokens`) returned `None`.

**Fix applied:**
1. Restored `@router.get("/{job_id}")` decorator
2. Replaced ORM-based query with raw SQL (`text("""SELECT ... FROM generation_jobs WHERE id = :job_id""")`) — bypasses SQLAlchemy's column metadata cache entirely, always reads all columns directly from Aurora

---

## Issue 5: Template Upload — Full Original Document Carried Over

**Symptom:** After uploading a branded `.docx` template, the generated document contained the entire original template content PLUS Claude's new content appended below it — user wanted the theme/layout only, not the text.

**Root cause:** `_fill_custom_template()` opened the template and called `doc.add_paragraph()` etc. to append sections — leaving all original paragraphs and tables intact.

**Fix applied:**
- Rewrote `_fill_custom_template()` to:
  1. Open the template `.docx`
  2. **Clear all body paragraphs and tables** using `lxml` (`body.remove(child)` for each `<w:p>` and `<w:tbl>` element) — preserving only the document styles, page setup (`sectPr`), headers, and footers
  3. Write a fresh title block (doc type, client name, engagement type, date) using Genese brand colors
  4. Fill in Claude's generated sections in the same document style

**Result:** Template now contributes only its visual theme (fonts, margins, header/footer, color scheme) — the body is entirely replaced with AI-generated content.

---

## Issue 6: Cancel Button Added — UX Improvements

**New features added (not bug fixes, but UX improvements made today):**

1. **Cancel button** — appears on Generate page when job is in `queued` status (before processing starts). Marks job as `failed` with reason "Cancelled by user". Cannot cancel jobs already being drafted by Claude.

2. **Friendly error messages** — Generate page now shows human-readable failure reasons:
   - Timeout → "AI took too long. Please try again."
   - Rate limited → "Too many requests. Wait a moment."
   - Cancelled → "You cancelled this generation."
   - Other → first 150 chars of raw error

3. **"↩ Try Again" button** — shown on failure, clears current job state so user can resubmit without refreshing

4. **"~1–2 min remaining" estimate** — shown in progress bar during generation

5. **History page error reasons** — failed jobs in History now show why they failed inline in red text

---

## Summary of Deployments Made (July 3)

| Time | Component | What Changed |
|------|-----------|-------------|
| ~04:00 | Worker (TD:15) | Bedrock 120s read timeout |
| ~04:15 | API (TD:15) | Cancel endpoint + UX fixes |
| ~04:15 | Frontend | Cancel button, error reasons, retry button |
| ~04:20 | API (TD:16) | Fixed missing `@router.get` + raw SQL for job status |
| ~04:40 | Worker (TD:16) | Template fix — clear body, keep styles only |
| ~04:40 | Frontend | Documents page polling fix for token data |
