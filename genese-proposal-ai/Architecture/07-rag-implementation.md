# RAG Implementation — Genese Proposal AI

> **Document purpose**: Complete reference for how Retrieval-Augmented Generation (RAG) works in this application — what it is, how it is configured, why each choice was made, and how to improve it.

---

## Table of Contents

1. [What is RAG?](#1-what-is-rag)
2. [How RAG is Set Up in This Application](#2-how-rag-is-set-up-in-this-application)
3. [How It Works — Step by Step](#3-how-it-works--step-by-step)
4. [What RAG Does for Us — Concrete Examples](#4-what-rag-does-for-us--concrete-examples)
5. [Current Metrics](#5-current-metrics)
6. [How to Improve It](#6-how-to-improve-it)
7. [Troubleshooting RAG](#7-troubleshooting-rag)

---

## 1. What is RAG?

### The Problem RAG Solves

Large language models like Claude have impressive general knowledge, but they have a hard cutoff — they only know what was in their training data. They have never read your proposals. They do not know your client history, your methodology, your pricing patterns, or your past engagement outcomes.

If you ask Claude to write a proposal for a fintech data platform, it will produce something competent but generic. It will not reference how Genese approached a similar engagement for NepPay. It will not reflect your specific way of structuring a discovery phase. It will not reuse the exact language from a proposal that already won.

**Retrieval-Augmented Generation (RAG)** fixes this by adding a retrieval step before generation. Instead of sending just the user's request to the LLM, you first search your own knowledge base for relevant content, then hand that content to the LLM as context.

```
Without RAG:
  User request → LLM → Generic response

With RAG:
  User request → Retrieve relevant documents → User request + retrieved context → LLM → Specific, grounded response
```

### Why We Need RAG in This Application

Genese Proposal AI generates business proposals. Quality proposals are:

- **Grounded in past work** — referencing comparable engagements builds credibility
- **Consistent in methodology** — Genese has a defined way of doing things; proposals should reflect it
- **Specific, not generic** — a proposal that mentions the client's domain, names relevant past clients, and reuses proven language wins more than a generic document

Without RAG, every proposal starts from zero. With RAG, every proposal starts from the best of what Genese has already written.

---

## 2. How RAG is Set Up in This Application

### Tech Stack Overview

| Component | Choice | Notes |
|-----------|--------|-------|
| Embedding model | Amazon Titan Text v2 (Bedrock) | 1024-dimensional output |
| Vector database | Aurora PostgreSQL 16.4 + pgvector | Same DB as the rest of the app |
| Vector index | ivfflat, cosine ops, lists=10 | Approximate nearest-neighbor |
| Chunking | RecursiveCharacterTextSplitter | 512 chars, 50 overlap |
| Top-K retrieval | 5 chunks per query | Per generation request |
| Generation LLM | Claude Sonnet 4.6 (`us.anthropic.claude-sonnet-4-6`) | Via Bedrock |

---

### Why Aurora + pgvector (not OpenSearch or Pinecone)

We use Aurora PostgreSQL with the `pgvector` extension rather than a dedicated vector database. The reasons are practical:

**Operational simplicity**: The application already runs on Aurora. Adding pgvector means zero new infrastructure — no separate cluster to manage, no additional IAM policies, no extra cost center, no new failure point.

**Transactional consistency**: Document metadata (status, chunk count, client name) and the actual chunk embeddings live in the same database. A single transaction can update both atomically. With a separate vector store, you would need to keep two systems in sync.

**SQL joins**: We can join `document_chunks` with `documents` in a single query to filter by client, engagement type, or document status. With Pinecone or OpenSearch you would need a two-step lookup.

**Cost**: pgvector is free. Pinecone at production scale costs hundreds of dollars per month. For the current scale (28 documents, 1346 chunks), pgvector handles the load trivially.

**When to reconsider**: If the document library grows to millions of chunks, or if sub-10ms similarity search becomes a hard requirement, a dedicated vector database becomes worth the operational cost. At current scale, Aurora + pgvector is the right choice.

---

### Why Amazon Titan Text v2 for Embeddings

We use `amazon.titan-embed-text-v2:0` via Amazon Bedrock, not OpenAI `text-embedding-ada-002` or Cohere Embed.

**AWS-native**: The entire stack runs on AWS. Using Bedrock for embeddings means no outbound API calls to third-party endpoints, no API keys to manage outside IAM, and billing on the same AWS account.

**No data leaves AWS**: For a consulting firm handling client proposal data, keeping all data within the AWS boundary simplifies compliance and data governance.

**Titan v2 quality**: Titan Text v2 produces high-quality semantic embeddings competitive with OpenAI's ada-002 for English business text, which is the dominant content type in our document library.

**Cost**: Bedrock pricing for Titan embeddings is very competitive compared to OpenAI's embedding API.

---

### Why 1024 Dimensions (Not 1536)

**This is a critical detail.** Amazon Titan Text v2 outputs **1024-dimensional** vectors. This is not a configuration choice — it is the model's fixed output size.

OpenAI `text-embedding-ada-002` outputs 1536 dimensions. If you see `vector(1536)` anywhere in this codebase, it is a bug.

The database schema is correctly defined:

```sql
-- document_chunks table
embedding vector(1024)   -- 1024 dims, matching Titan v2 output exactly
```

Every embedding stored in the database and every query vector used for similarity search must be 1024-dimensional. Dimension mismatch causes pgvector to raise an error at query time.

---

### Why Cosine Similarity (Not Dot Product or Euclidean)

pgvector supports three distance operators:

| Operator | Metric | Use when |
|----------|--------|----------|
| `<=>` | Cosine distance | Vectors may vary in magnitude; care about direction |
| `<#>` | Negative dot product | Vectors are normalized; want raw similarity score |
| `<->` | Euclidean (L2) distance | Vectors represent spatial positions |

We use `<=>` (cosine) for two reasons:

1. **Text embeddings encode meaning as direction, not magnitude.** A short chunk and a long chunk covering the same topic should have similar cosine similarity even though their raw vector magnitudes differ.

2. **Titan v2 embeddings are not guaranteed to be unit-normalized**, so dot product similarity would be unfairly biased toward longer or more "confident" embeddings. Cosine normalizes this away.

Euclidean distance is inappropriate for high-dimensional text embeddings — the curse of dimensionality makes L2 distances unreliable in 1024-dimensional space.

---

### Why ivfflat Index (Not HNSW or Flat Scan)

Three indexing options exist in pgvector:

**Flat scan** (no index): Exact nearest-neighbor. Scans every row. Accurate but O(n) per query — unacceptably slow at scale.

**ivfflat** (Inverted File with Flat compression): Approximate nearest-neighbor. Divides vectors into `lists` clusters at build time; at query time, searches only the most promising clusters. We use `lists=10`.

**HNSW** (Hierarchical Navigable Small World): Better approximate nearest-neighbor. Higher accuracy than ivfflat, faster queries, but higher memory usage and longer index build time. Available in pgvector 0.5.0+, supported in PostgreSQL 16.

We chose ivfflat because:
- At 1346 chunks, the performance difference vs HNSW is negligible
- ivfflat has a smaller memory footprint
- It was the safer, more established choice at the time of implementation

The `lists=10` parameter means the index partitions vectors into 10 clusters. The pgvector recommendation is `lists = sqrt(row_count)` for up to 1 million rows. At 1346 chunks, `sqrt(1346) ≈ 37` would technically be more appropriate — upgrading `lists` or switching to HNSW is a low-effort improvement.

```sql
-- Current index definition
CREATE INDEX idx_chunks_embedding
ON document_chunks
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 10);
```

---

### Why 512 Characters for Chunking

Chunking splits documents into pieces small enough to embed meaningfully and large enough to contain useful context.

**Too small** (e.g., 50 chars): Each chunk is a sentence fragment. The embedding has no semantic context. Retrieval returns noise.

**Too large** (e.g., 2000 chars): Each chunk covers too many topics. The embedding is diluted. A query about pricing might retrieve a chunk that is 80% about methodology and 20% about pricing — the relevant content is buried.

**512 characters** is approximately 80–120 words, which is 3–6 sentences. This is large enough to carry a coherent idea (a pricing model description, a methodology step, a client outcome statement) and small enough to be semantically focused.

The 50-character overlap between consecutive chunks prevents a key idea from being split across chunk boundaries and lost.

**Minimum chunk filter**: Chunks shorter than 50 characters are discarded. These are typically headers, page numbers, or formatting artifacts that add noise without content.

---

### Why Top-5 Retrieval

At generation time, we retrieve the 5 most similar chunks and inject them all into the Claude prompt as context.

- **Too few (1–2)**: Risk missing a relevant angle. If the top result is about methodology but the query also needs pricing context, we lose that.
- **Too many (10+)**: The context window fills up with marginally relevant content. Claude's attention gets diluted. Token cost increases.
- **5** is the balance point: enough breadth to cover multiple relevant aspects, few enough to stay focused.

Each chunk is approximately 512 characters (~130 tokens). Five chunks add ~650 tokens of context to the prompt — a small fraction of Claude's 200K context window, with high signal density.


---

## 3. How It Works — Step by Step

### 3.1 Ingestion Pipeline

This is what happens when someone uploads a document through the UI.

```
User uploads file
       |
       v
[S3] File stored at raw/{doc_id}/{filename}
       |
       v
[SQS] Message published: { job_type: "ingestion", document_id: "..." }
       |
       v
[Worker] Picks up SQS message
       |
       +---> Phase 1: LOADING
       |         - Download file from S3
       |         - Detect file type (PDF / DOCX / TXT)
       |         - Extract raw text:
       |             PDF  → pypdf
       |             DOCX → python-docx
       |             TXT  → plain file read
       |         - Status: pending → loading
       |
       +---> Phase 2: CHUNKING
       |         - Split text with RecursiveCharacterTextSplitter
       |             chunk_size=512, chunk_overlap=50
       |         - Filter out chunks shorter than 50 chars
       |         - Status: loading → chunking
       |
       +---> Phase 3: EMBEDDING
       |         - Call Bedrock: amazon.titan-embed-text-v2:0
       |         - Batch embed all chunks
       |         - Each chunk → float[1024] vector
       |         - Status: chunking → embedding
       |
       +---> Phase 4: STORING
                 - INSERT INTO document_chunks for each chunk:
                     content TEXT
                     embedding vector(1024)
                     metadata JSONB (filename, doc_type, engagement_type, client)
                 - UPDATE documents SET chunk_count=N, ingestion_status='complete'
                 - Status: embedding → storing → complete
```

**Database state after ingestion:**

```sql
-- documents table row (example)
INSERT INTO documents VALUES (
  'doc-uuid-1234',
  'NepPay-Platform-Proposal-2024.pdf',
  'proposal',          -- document_type
  'data_platform',     -- engagement_type
  'NepPay',            -- client_name
  'raw/doc-uuid-1234/NepPay-Platform-Proposal-2024.pdf',
  47,                  -- chunk_count
  'complete',          -- ingestion_status
  'amazon.titan-embed-text-v2:0',
  18432                -- embedding_tokens used
);

-- document_chunks table rows (one per chunk, 47 total for this doc)
INSERT INTO document_chunks VALUES (
  'chunk-uuid-0001',
  'doc-uuid-1234',     -- document_id FK
  0,                   -- chunk_index
  'Genese will deliver a fully managed data lakehouse on AWS, combining S3-based cold storage with Redshift Serverless for interactive analytics. The engagement is structured in three phases...',
  '[0.012, -0.087, 0.234, ...]'::vector(1024),   -- 1024 floats
  '{"filename": "NepPay-Platform-Proposal-2024.pdf", "document_type": "proposal", "engagement_type": "data_platform", "client_name": "NepPay", "chunk_index": 0}'
);
```

---

### 3.2 Retrieval Pipeline

This is what happens at proposal generation time.

```
User submits proposal request
  (document_type="proposal", engagement_type="data_platform", requirements=["real-time ingestion", "BI dashboards"])
       |
       v
Step 1: BUILD QUERY STRING
  query = "proposal data_platform real-time ingestion BI dashboards"
       |
       v
Step 2: EMBED QUERY
  Call Bedrock: amazon.titan-embed-text-v2:0
  query_vector = float[1024]
       |
       v
Step 3: COSINE SIMILARITY SEARCH
  SELECT
    dc.content,
    dc.metadata,
    d.filename,
    d.client_name,
    1 - (dc.embedding <=> query_vector::vector) AS similarity
  FROM document_chunks dc
  JOIN documents d ON d.id = dc.document_id
  ORDER BY dc.embedding <=> query_vector::vector
  LIMIT 5;
       |
       v
Step 4: FORMAT CONTEXT
  [Source 1: NepPay-Platform-Proposal-2024.pdf | Client: NepPay]
  Genese will deliver a fully managed data lakehouse on AWS...

  [Source 2: DataMesh-Engagement-Outcomes.pdf | Client: Himalayan Bank]
  Phase 2 of the engagement delivered real-time Kafka pipelines...

  ... (3 more chunks)
       |
       v
Step 5: INJECT INTO CLAUDE PROMPT
  SYSTEM: You are a proposal writer for Genese...
  
  PAST WORK CONTEXT:
  [Source 1: NepPay-Platform-Proposal-2024.pdf | Client: NepPay]
  Genese will deliver a fully managed data lakehouse...
  
  [Source 2: ...]
  ...
  
  USER REQUEST: Write a proposal for [client] for a data platform engagement.
       |
       v
Step 6: CLAUDE GENERATES PROPOSAL
  Grounded in the retrieved Genese-specific context
```

**The actual SQL query executed:**

```sql
SELECT
    dc.id,
    dc.content,
    dc.chunk_index,
    dc.metadata,
    d.filename,
    d.client_name,
    d.document_type,
    d.engagement_type,
    1 - (dc.embedding <=> $1::vector) AS similarity
FROM document_chunks dc
JOIN documents d ON d.id = dc.document_id
WHERE d.ingestion_status = 'complete'
ORDER BY dc.embedding <=> $1::vector
LIMIT 5;

-- $1 is the 1024-dimensional query vector as a string like '[0.012, -0.087, ...]'
```

---

## 4. What RAG Does for Us — Concrete Examples

### 4.1 Without RAG vs With RAG

**Scenario**: User requests a proposal for a fintech company needing a cloud data platform.

**Without RAG** — Claude generates a generic response:

> "We propose building a modern cloud data platform leveraging industry best practices. Our approach includes a data ingestion layer, a storage tier, and an analytics interface. We will use agile methodology with two-week sprints..."

This is correct but valueless. It could have been written by any consulting firm.

**With RAG** — Claude has retrieved 5 chunks from Genese's actual past proposals:

> "Drawing on our experience delivering Genese's data lakehouse for NepPay, where we achieved sub-3-second query latency on 500GB daily transaction volumes using Redshift Serverless, we propose a similar architecture for [Client]. Our proven three-phase delivery model — Discovery & Architecture (2 weeks), Platform Build (6 weeks), Handover & Enablement (2 weeks) — has been validated across our fintech engagements. The NepPay engagement saw 40% reduction in reporting cycle time within 60 days of go-live..."

This is specific, credible, and directly references Genese's track record.

---

### 4.2 How Similarity Scores Work

The cosine similarity score ranges from 0.0 to 1.0. pgvector returns cosine **distance** (`<=>` operator), which we convert to similarity as `1 - distance`.

| Score Range | Meaning | Action |
|-------------|---------|--------|
| 0.85 – 1.00 | Highly relevant. Same topic, same engagement type. | Always use |
| 0.70 – 0.84 | Relevant. Related domain or methodology. | Use |
| 0.50 – 0.69 | Marginally relevant. Tangentially related. | Use with caution |
| 0.30 – 0.49 | Probably not relevant. Similar surface language, different meaning. | Avoid |
| 0.00 – 0.29 | Not relevant. Different domain entirely. | Discard |

**Practical example:**

Query: `"proposal data_platform real-time ingestion BI dashboards"`

```
Rank 1: similarity=0.87  NepPay-Platform-Proposal-2024.pdf  chunk_index=3
         "Genese will deliver real-time data ingestion pipelines using
          Kafka on MSK, feeding into a Redshift Serverless warehouse
          with Power BI dashboards for business users..."
         → HIGHLY RELEVANT: same engagement type, exact keyword overlap

Rank 2: similarity=0.79  DataMesh-Outcomes-HimalBank.pdf  chunk_index=12
         "The Phase 2 delivery included streaming analytics via Kinesis
          with downstream BI reporting, reducing report generation
          from 4 hours to 15 minutes..."
         → RELEVANT: same domain, proven outcome reference

Rank 3: similarity=0.71  Genese-Methodology-2024.pdf  chunk_index=8
         "Our Data Platform practice follows a standardized three-phase
          delivery: Discovery, Build, and Enablement. Each phase has
          defined exit criteria and client sign-off gates..."
         → RELEVANT: methodology context, useful for proposal structure

Rank 4: similarity=0.63  Cloud-Migration-Proposal-RetailCo.pdf  chunk_index=5
         "The cloud architecture leverages AWS managed services to
          minimize operational overhead, with RDS for transactional
          data and S3 for analytical workloads..."
         → MARGINAL: cloud/AWS overlap but different engagement type

Rank 5: similarity=0.58  Genese-Company-Overview.pdf  chunk_index=2
         "Genese Technology has delivered over 50 cloud engagements
          since 2018, with a focus on AWS-native architectures for
          financial services clients..."
         → MARGINAL: company credibility, usable as background context
```

All 5 are included in the context passed to Claude. Claude synthesizes them into a coherent proposal narrative.

---

## 5. Current Metrics

| Metric | Value |
|--------|-------|
| Documents indexed | 28 |
| Total chunks | 1,346 |
| Average chunks per document | ~48 |
| Embedding dimensions | 1,024 |
| Chunks retrieved per query | 5 |
| Approximate context tokens added per generation | ~650 |
| Vector index type | ivfflat, lists=10 |
| Similarity metric | Cosine |

**Storage estimate:**
- Each embedding: 1024 floats × 4 bytes = 4,096 bytes per chunk
- 1,346 chunks × 4,096 bytes ≈ 5.5 MB for raw embedding data
- With pgvector overhead and metadata JSONB: ~15–20 MB total

At this scale, Aurora handles all queries in well under 100ms. The ivfflat index has essentially no performance advantage over a flat scan at 1,346 rows — but it is there for when the library grows.


---

## 6. How to Improve It

The current implementation is correct and functional. The improvements below are ordered roughly by effort-to-impact ratio — highest bang for the buck first.

---

### 6a. Upload Quality Matters Most

**Effort**: 0 hours of engineering  
**Impact**: Highest possible

No algorithmic improvement can compensate for poor source documents. The RAG system is only as good as what has been uploaded.

**What to upload:**
- Real Genese proposals that won engagements (not drafts)
- Real engagement outcome summaries with specific metrics
- The Genese methodology playbook(s)
- Any capability statements or company overview documents

**What to avoid:**
- Synthetic seed data or AI-generated placeholder proposals
- Template files with unfilled placeholders (`[CLIENT NAME]`, `[DATE]`)
- Duplicate versions of the same document

A library of 10 high-quality, real Genese proposals will outperform 100 synthetic ones.

---

### 6b. Similarity Threshold Filtering

**Effort**: 30 minutes  
**Impact**: Medium — removes low-quality noise from context

Currently, we always return exactly 5 chunks regardless of their similarity score. If the library has nothing relevant to a particular query, we still return the 5 least-irrelevant chunks, which add noise to the prompt.

Add a minimum similarity threshold:

```python
MIN_SIMILARITY = 0.5

def retrieve_context(query_vector, top_k=5):
    results = db.execute("""
        SELECT
            dc.content,
            dc.metadata,
            d.filename,
            d.client_name,
            1 - (dc.embedding <=> $1::vector) AS similarity
        FROM document_chunks dc
        JOIN documents d ON d.id = dc.document_id
        WHERE d.ingestion_status = 'complete'
          AND (1 - (dc.embedding <=> $1::vector)) >= $2   -- threshold filter
        ORDER BY dc.embedding <=> $1::vector
        LIMIT $3
    """, [query_vector, MIN_SIMILARITY, top_k])
    
    return results  # May return fewer than 5 if library lacks relevant content
```

If fewer than 2 chunks pass the threshold, log a warning: the library may lack content for this engagement type.

---

### 6c. Metadata-Aware Retrieval

**Effort**: 1 hour  
**Impact**: Medium-high — improves precision when library grows

Currently, all 1,346 chunks compete equally in every similarity search. A query for a `data_platform` proposal can return chunks from a `mobile_app` proposal because the surface language overlaps.

Add a pre-filter by `engagement_type` before the vector search:

```python
def retrieve_context(query_vector, engagement_type=None, top_k=5):
    base_query = """
        SELECT
            dc.content,
            dc.metadata,
            d.filename,
            d.client_name,
            1 - (dc.embedding <=> $1::vector) AS similarity
        FROM document_chunks dc
        JOIN documents d ON d.id = dc.document_id
        WHERE d.ingestion_status = 'complete'
    """
    
    params = [query_vector]
    
    if engagement_type:
        base_query += " AND d.engagement_type = $2"
        params.append(engagement_type)
        limit_param = "$3"
    else:
        limit_param = "$2"
    
    base_query += f" ORDER BY dc.embedding <=> $1::vector LIMIT {limit_param}"
    params.append(top_k)
    
    results = db.execute(base_query, params)
    
    # Fallback: if filtered results are too few, run without filter
    if len(results) < 2 and engagement_type:
        return retrieve_context(query_vector, engagement_type=None, top_k=top_k)
    
    return results
```

---

### 6d. Reranking with a Cross-Encoder

**Effort**: 2 hours  
**Impact**: High — significantly improves the quality of the top results

The current vector similarity search is fast but imprecise. It finds chunks that are semantically similar to the query, but "similar" in embedding space does not always mean "most useful for answering this query."

A **cross-encoder reranker** takes each (query, chunk) pair and scores them together — it reads both at once, which is much more accurate than comparing two independently created embeddings.

**Approach**: Retrieve top-20 candidates via vector search, then rerank with a cross-encoder, keep top-5.

```python
# Option 1: Cohere Rerank API (managed, no GPU needed)
import cohere

co = cohere.Client(api_key=os.environ["COHERE_API_KEY"])

def retrieve_and_rerank(query_text, query_vector, top_k=5):
    # Step 1: Over-fetch candidates from pgvector
    candidates = vector_search(query_vector, limit=20)
    
    # Step 2: Rerank with Cohere
    docs = [c["content"] for c in candidates]
    rerank_results = co.rerank(
        query=query_text,
        documents=docs,
        top_n=top_k,
        model="rerank-english-v3.0"
    )
    
    # Step 3: Return reranked top-K
    return [candidates[r.index] for r in rerank_results.results]


# Option 2: Local cross-encoder (no external API)
from sentence_transformers import CrossEncoder

reranker = CrossEncoder("cross-encoder/ms-marco-MiniLM-L-6-v2")

def retrieve_and_rerank_local(query_text, query_vector, top_k=5):
    candidates = vector_search(query_vector, limit=20)
    pairs = [(query_text, c["content"]) for c in candidates]
    scores = reranker.predict(pairs)
    ranked = sorted(zip(scores, candidates), key=lambda x: x[0], reverse=True)
    return [c for _, c in ranked[:top_k]]
```

---

### 6e. Hybrid Search (BM25 + Vector)

**Effort**: 3–4 hours  
**Impact**: High — much better recall for exact-term queries

Vector similarity is great for semantic ("what does this mean?") matching but poor for exact-term matching. If a user mentions a specific technology ("ClickHouse", "dbt", "Airbyte"), vector search may miss chunks that contain exactly that term if the embedding space doesn't cluster it with the query.

BM25 (keyword search) excels at exact-term recall. Combining both is called **hybrid search**.

```sql
-- Enable pg_trgm for text search (or use tsvector for full BM25)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Add a tsvector column for full-text search
ALTER TABLE document_chunks ADD COLUMN content_tsv tsvector;
UPDATE document_chunks SET content_tsv = to_tsvector('english', content);
CREATE INDEX idx_chunks_fts ON document_chunks USING gin(content_tsv);
```

```python
def hybrid_search(query_text, query_vector, top_k=5, alpha=0.7):
    """
    alpha=0.7 means 70% weight on vector similarity, 30% on keyword score.
    Adjust alpha based on whether exact-term recall matters more.
    """
    
    # Vector results (semantic)
    vector_results = db.execute("""
        SELECT id, content, metadata,
               1 - (embedding <=> $1::vector) AS vec_score
        FROM document_chunks
        ORDER BY embedding <=> $1::vector
        LIMIT $2
    """, [query_vector, top_k * 4])
    
    # BM25/FTS results (keyword)
    fts_results = db.execute("""
        SELECT id, content, metadata,
               ts_rank(content_tsv, plainto_tsquery('english', $1)) AS fts_score
        FROM document_chunks
        WHERE content_tsv @@ plainto_tsquery('english', $1)
        ORDER BY fts_score DESC
        LIMIT $2
    """, [query_text, top_k * 4])
    
    # Reciprocal Rank Fusion (RRF) to merge ranked lists
    scores = {}
    k = 60  # RRF constant
    
    for rank, row in enumerate(vector_results):
        scores[row["id"]] = scores.get(row["id"], 0) + alpha * (1 / (k + rank + 1))
    
    for rank, row in enumerate(fts_results):
        scores[row["id"]] = scores.get(row["id"], 0) + (1 - alpha) * (1 / (k + rank + 1))
    
    # Sort by combined score, return top-K
    all_ids = sorted(scores.keys(), key=lambda x: scores[x], reverse=True)[:top_k]
    return fetch_chunks_by_ids(all_ids)
```

---

### 6f. HyDE — Hypothetical Document Embeddings

**Effort**: 1 hour  
**Impact**: Medium — helps when query is very short or abstract

HyDE addresses a fundamental problem: the user's short query and the relevant document chunks live in different regions of embedding space. A query like `"data platform fintech"` is 3 words; the relevant chunk is 512 characters. Their embeddings will not be as close as two 512-character passages on the same topic.

**HyDE fix**: Use the LLM to generate a hypothetical chunk that would answer the query, then embed that hypothetical chunk instead of the original query.

```python
def hyde_embed(query_text: str, document_type: str, engagement_type: str) -> list[float]:
    """Generate a hypothetical document chunk, embed it instead of the raw query."""
    
    hypothetical_prompt = f"""Write a short excerpt (3-4 sentences) from a {document_type} 
    for a {engagement_type} engagement. This excerpt should naturally contain the answer to: 
    "{query_text}"
    
    Write only the excerpt, no preamble."""
    
    hypothetical_doc = claude.invoke(hypothetical_prompt)
    
    # Embed the hypothetical document instead of the raw query
    return titan_embed(hypothetical_doc)


# Usage in retrieval
def retrieve_context_with_hyde(query_text, document_type, engagement_type):
    query_vector = hyde_embed(query_text, document_type, engagement_type)
    return vector_search(query_vector, limit=5)
```

HyDE adds one extra LLM call per retrieval, which adds latency and cost. Use it for short or abstract queries, not for long, detailed queries that are already close to the document space.

---

### 6g. Query Expansion

**Effort**: 1 hour  
**Impact**: Medium — improves recall by covering query variations

Different proposals use different words for the same concept. "Data lakehouse", "data platform", and "analytical data store" all refer to similar things but may not cluster tightly in embedding space.

Query expansion generates 2–3 rephrasings of the query, embeds each, and merges the result sets:

```python
def expand_query(query_text: str) -> list[str]:
    """Generate query variations using Claude."""
    
    prompt = f"""Given this search query for a proposal knowledge base:
    "{query_text}"
    
    Generate 2 alternative phrasings that mean the same thing but use different words.
    Return only the alternatives, one per line, no numbering."""
    
    response = claude.invoke(prompt)
    alternatives = [q.strip() for q in response.strip().split("\n") if q.strip()]
    return [query_text] + alternatives[:2]  # original + 2 alternatives


def retrieve_with_expansion(query_text, top_k=5):
    queries = expand_query(query_text)
    
    all_results = {}
    for q in queries:
        vec = titan_embed(q)
        results = vector_search(vec, limit=top_k)
        for r in results:
            if r["id"] not in all_results:
                all_results[r["id"]] = r
    
    # Return unique results, re-sort by original query similarity
    original_vec = titan_embed(query_text)
    return rerank_by_similarity(list(all_results.values()), original_vec, top_k)
```

---

### 6h. Parent-Child Chunking

**Effort**: 4–6 hours (schema change required)  
**Impact**: High — best of both worlds: precise retrieval, rich context

Current approach: embed 512-char chunks, retrieve 512-char chunks. The chunk size is a compromise — large enough to embed meaningfully, small enough to be focused.

Parent-child chunking stores two granularities:
- **Child chunks** (~128 chars): Small, semantically tight. Used for embedding and retrieval.
- **Parent chunks** (~512–1024 chars): The surrounding context. Returned to Claude.

```
                     Parent Chunk (1024 chars)
          ┌──────────────────────────────────────────────┐
          │  ...broader context about the engagement...  │
          │  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
          │  │  Child 1 │  │  Child 2 │  │  Child 3 │   │
          │  │ (128chr) │  │ (128chr) │  │ (128chr) │   │
          │  └──────────┘  └──────────┘  └──────────┘   │
          └──────────────────────────────────────────────┘

Vector search finds Child 2 as most similar to query.
Claude receives the full Parent Chunk for richer context.
```

Schema change required:

```sql
ALTER TABLE document_chunks ADD COLUMN parent_chunk_id UUID REFERENCES document_chunks(id);
ALTER TABLE document_chunks ADD COLUMN chunk_level VARCHAR(10) DEFAULT 'single'; -- 'parent', 'child', 'single'
```

This is the highest-effort improvement but produces measurably better outputs for proposals that reference specific engagements.

---

### 6i. HNSW Index Instead of ivfflat

**Effort**: 15 minutes  
**Impact**: Medium — better accuracy, especially as corpus grows

HNSW (Hierarchical Navigable Small World) provides better approximate nearest-neighbor accuracy than ivfflat, with faster query times at scale. PostgreSQL 16 + pgvector 0.5.0+ support HNSW natively.

```sql
-- Drop the old ivfflat index
DROP INDEX IF EXISTS idx_chunks_embedding;

-- Create HNSW index
-- m=16: connections per node (higher = more accurate, more memory)
-- ef_construction=64: build-time accuracy (higher = more accurate, slower to build)
CREATE INDEX idx_chunks_embedding
ON document_chunks
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- At query time, optionally increase ef (search-time accuracy)
SET hnsw.ef_search = 100;
```

At 1,346 chunks the difference is imperceptible. Run this migration before the corpus exceeds ~50,000 chunks.

---

### 6j. Contextual Chunking

**Effort**: 2–3 hours  
**Impact**: Medium — improves embedding quality for chunks that lack self-contained context

Some chunks are meaningless without context. A chunk like `"Phase 2 delivered the following outcomes:"` followed by a list is incomplete on its own — the chunk that got embedded is just that header sentence.

Contextual chunking prepends a document-level summary to each chunk before embedding:

```python
def create_contextual_chunks(document_text, document_metadata, chunks):
    """Add document context to each chunk before embedding."""
    
    # Generate a brief document summary using Claude
    summary_prompt = f"""Summarize this document in 2 sentences for context.
    Document type: {document_metadata['document_type']}
    Client: {document_metadata['client_name']}
    
    Document:
    {document_text[:3000]}  # First 3000 chars for summary
    """
    
    doc_summary = claude.invoke(summary_prompt)
    
    # Prepend summary to each chunk before embedding
    contextual_chunks = []
    for chunk in chunks:
        contextual_content = f"Document context: {doc_summary}\n\nChunk content: {chunk}"
        contextual_chunks.append({
            "original_content": chunk,       # Store original for display
            "embed_content": contextual_content  # Use this for embedding
        })
    
    return contextual_chunks
```

Store the original chunk content in `document_chunks.content` (shown to Claude), but generate the embedding from `contextual_content`. This improves the embedding quality of context-dependent chunks without bloating the context injected into the proposal generation prompt.

---

### Improvement Priority Matrix

| Improvement | Effort | Impact | Recommended Priority |
|------------|--------|--------|---------------------|
| Upload real proposals | 0 hrs | Highest | **Do first** |
| Similarity threshold filter | 30 min | Medium | **Do now** |
| HNSW index | 15 min | Medium | **Do now** |
| Metadata-aware retrieval | 1 hr | Medium-high | Next sprint |
| Reranking (Cohere/cross-encoder) | 2 hrs | High | Next sprint |
| Query expansion | 1 hr | Medium | Next sprint |
| HyDE | 1 hr | Medium | Next sprint |
| Hybrid search (BM25 + vector) | 3–4 hrs | High | Future |
| Contextual chunking | 2–3 hrs | Medium | Future |
| Parent-child chunking | 4–6 hrs | High | Future |

---

## 7. Troubleshooting RAG

### Problem: Proposals are generic, don't reference past work

**Diagnosis steps:**

1. **Check if documents are indexed:**
```sql
SELECT ingestion_status, COUNT(*)
FROM documents
GROUP BY ingestion_status;
-- Expected: all rows show 'complete'
-- If 'pending' or 'failed': worker is not processing
```

2. **Check chunk count:**
```sql
SELECT id, filename, chunk_count, ingestion_status
FROM documents
ORDER BY created_at DESC;
-- chunk_count should be > 0 for completed documents
-- If chunk_count = 0: chunking phase failed silently
```

3. **Run a manual similarity search:**
```sql
-- First, get any embedding from the table to test with
SELECT embedding FROM document_chunks LIMIT 1;

-- Then search using that embedding as query (self-similarity should be ~1.0)
SELECT
    d.filename,
    dc.chunk_index,
    1 - (dc.embedding <=> (SELECT embedding FROM document_chunks LIMIT 1)::vector) AS similarity,
    LEFT(dc.content, 100) AS preview
FROM document_chunks dc
JOIN documents d ON d.id = dc.document_id
ORDER BY dc.embedding <=> (SELECT embedding FROM document_chunks LIMIT 1)::vector
LIMIT 5;
```

4. **Check what query string is being built:**
Add logging to the retrieval function:
```python
logger.info(f"RAG query string: '{query_string}'")
logger.info(f"RAG retrieved {len(results)} chunks")
for i, r in enumerate(results):
    logger.info(f"  Chunk {i+1}: similarity={r['similarity']:.3f} | {r['filename']} | {r['content'][:80]}")
```

---

### Problem: Ingestion stuck in non-complete status

**Check SQS queue:**
```bash
aws sqs get-queue-attributes \
  --queue-url $SQS_QUEUE_URL \
  --attribute-names ApproximateNumberOfMessages,ApproximateNumberOfMessagesNotVisible
```

**Check worker logs for error:**
```bash
# If running on ECS
aws logs tail /ecs/proposal-worker --follow

# If running locally
docker logs proposal-worker --tail 50
```

**Check for Bedrock embedding errors:**
```sql
SELECT id, filename, ingestion_status, error_message
FROM documents
WHERE ingestion_status NOT IN ('complete', 'pending')
ORDER BY updated_at DESC;
```

---

### Problem: Similarity scores are all low (< 0.5)

**Possible causes:**

1. **Wrong embedding model used for query vs documents**: The query was embedded with a different model than the stored chunks. Check that both use `amazon.titan-embed-text-v2:0`.

2. **Wrong number of dimensions**: If stored chunks are `vector(1024)` but query vector is a different size, pgvector will raise an error. If there is no error but scores are low, check that the query embedding has exactly 1024 dimensions.

3. **Poor query string construction**: Log the query string. If it is too short or too generic (e.g., just `"proposal"`), similarity will be diffuse.

4. **Library lacks relevant documents**: If all uploaded documents are in a different domain than the query, scores will legitimately be low. Add more relevant documents.

```python
# Debug: print query embedding stats
query_vector = titan_embed(query_text)
print(f"Query vector length: {len(query_vector)}")
print(f"Query vector sample (first 5): {query_vector[:5]}")
print(f"Query vector norm: {sum(x**2 for x in query_vector) ** 0.5:.4f}")
# Titan v2 vectors are roughly unit-normalized; norm should be close to 1.0
```

---

### Problem: ivfflat index not being used (slow queries)

```sql
-- Check query plan
EXPLAIN (ANALYZE, BUFFERS)
SELECT dc.content, 1 - (dc.embedding <=> '[...]'::vector) AS similarity
FROM document_chunks dc
ORDER BY dc.embedding <=> '[...]'::vector
LIMIT 5;

-- If plan shows "Seq Scan" instead of "Index Scan":
-- ivfflat requires at least 'lists' rows before it activates
-- At < 1000 rows, PostgreSQL may prefer a sequential scan anyway
-- This is correct behavior at small scale
```

---

### Problem: Embeddings are not being stored (chunk_count stays 0)

**Check for Bedrock throttling:**
```python
# Titan v2 embedding has rate limits
# If batch is too large, break into smaller batches
BATCH_SIZE = 25  # Embed 25 chunks at a time, not all at once

for i in range(0, len(chunks), BATCH_SIZE):
    batch = chunks[i:i + BATCH_SIZE]
    embeddings = [titan_embed(chunk) for chunk in batch]
    # Insert batch into database
    time.sleep(0.1)  # Small delay to avoid throttling
```

**Check Aurora connection pool exhaustion:**
```sql
SELECT count(*), state
FROM pg_stat_activity
WHERE datname = current_database()
GROUP BY state;
-- If many 'idle in transaction' connections, the worker is leaking connections
```

---

### Quick Diagnostic Checklist

When RAG quality is poor, run through this list in order:

- [ ] Are there documents with `ingestion_status = 'complete'`?
- [ ] Do those documents have `chunk_count > 0`?
- [ ] Is the worker currently running and consuming from SQS?
- [ ] Is the query string non-empty and descriptive?
- [ ] Is the embedding model the same for ingestion and retrieval (`amazon.titan-embed-text-v2:0`)?
- [ ] Are returned chunk similarity scores above 0.5?
- [ ] Is the retrieved context actually appearing in the Claude prompt (check logs)?
- [ ] Are the uploaded documents real, high-quality proposals (not synthetic)?

---

*Last updated: 2026-07-04*  
*Maintainer: Genese Engineering Team*
