# X.md — Architecture & Auth Deep-Dive
## Genese Proposal AI: What It Is, How It Works, How to Extend It

---

## Part 1: What Architecture Type Is This?

### Current State: Modular Monolith (not microservices, not plain monolith)

The application is best described as a **modular monolith with async worker separation**.

Here is what that means precisely:

```
genese-proposal-ai/
├── services/api/       ← Module 1: HTTP layer (FastAPI)
├── services/worker/    ← Module 2: Async worker (LangChain)
└── services/shared/    ← Shared models, schemas, constants
```

**Two containers, one codebase.** Both containers share code from `services/shared/`. They are NOT independent deployable services with their own repos and contracts. They are two faces of the same system.

### Why Not a Microservice?

True microservices have:
- Independent deployable units with their own data stores
- Communication via APIs or events with versioned contracts
- Independent scaling decisions per service
- Teams that own entire services end-to-end

This app has:
- Two containers that share a schema, a DB, and code
- The "worker" is not a service — it is a background processor for one specific system
- No versioned API contract between API and Worker (they share Python models directly)

### Why Not a Plain Monolith?

A plain monolith puts everything in one process. Here:
- The API (sync HTTP) and Worker (async LLM jobs) run in separate processes and containers
- They communicate via SQS (message queue) — so a slow LLM job never blocks an HTTP request
- They can scale independently — add 3 workers, keep 1 API
- The separation is the right call: LLM jobs take 30-90 seconds and would time out HTTP if inline

### The Honest Label

> **Modular Monolith with Async Worker Separation**

Or more practically: a **well-structured backend split along sync/async lines**, deployed as two ECS Fargate containers communicating through SQS.

---

## Part 2: Is It Plug-and-Play? Can Features Be Added/Removed Cleanly?

### Current State: Mostly Yes, With a Few Tight Couplings

**What is well-isolated (easy to change):**

| Component | Isolation | Change effort |
|---|---|---|
| LLM (Claude) | `generation_chain.py` — one file, one function | Swap to GPT-4, Gemini, etc. in ~1 hour |
| Embeddings (Titan) | `ingestion.py` — one call | Swap to Cohere, OpenAI etc. in <1 hour |
| Vector DB (pgvector) | `rag_retriever.py` — one file | Swap to Pinecone, Weaviate in 2-3 hours |
| Web search (Tavily) | `orchestrator.py` — one block | Swap to Bing, SerpAPI, remove entirely |
| Diagram library | `architecture_generator.py` | Swap to draw.io XML, Mermaid, etc. |
| Frontend pages | Each page is a standalone component | Add/remove pages in minutes |
| API routes | Each router is a separate file | Add new route without touching others |

**What has coupling (harder to change):**

| Coupling | Where | Effort to fix |
|---|---|---|
| SQS message schema is implicit | `orchestrator.py` reads dict fields by name — no versioned contract | Medium — add a Pydantic schema for messages |
| Job pipeline is one long function | `orchestrator.py` `run_generation_pipeline()` — sequential steps in one function | Medium — refactor to a step registry |
| DB schema is hand-managed | ALTER TABLE run manually, not via migration tool | Medium — add Alembic |
| Auth is Cognito-only | No abstraction layer — if you want to swap auth providers, touches 3 files | Medium — add an auth interface |

---

## Part 3: How to Make It Properly Plug-and-Play (Future Architecture)

### Step 1: Add Alembic for DB migrations

Right now you run `ALTER TABLE` manually via one-off ECS tasks. This is fragile.

```bash
pip install alembic
alembic init migrations
# alembic/env.py → point to your SQLAlchemy models
# alembic revision --autogenerate -m "add tags column"
# alembic upgrade head
```

Every schema change becomes a versioned migration file. No manual SQL. Deploy runs `alembic upgrade head` automatically.

### Step 2: Pipeline Step Registry (replaces long orchestrator function)

Instead of a 200-line sequential function, define steps as a registry:

```python
PIPELINE_STEPS = [
    RetrieveContextStep(),
    ValidateSourcesStep(),
    DraftDocumentStep(),
    GenerateDiagramStep(),
    AwaitReviewStep(),       # pauses pipeline
    FormatOutputStep(),
]

async def run_pipeline(job, db):
    for step in PIPELINE_STEPS:
        if await step.should_run(job):
            await step.execute(job, db)
```

Adding a new step (e.g., "competitive analysis via Tavily") = add one class, register it. No other code changes.

### Step 3: LLM Provider Interface

```python
class LLMProvider(Protocol):
    async def generate(self, prompt: str, **kwargs) -> GenerationResult: ...
    async def embed(self, text: str) -> list[float]: ...

class BedrockClaudeProvider(LLMProvider): ...
class OpenAIProvider(LLMProvider): ...   # future
class GeminiProvider(LLMProvider): ...   # future
```

Swap providers by changing one config value.

### Step 4: Feature Flags

```python
FEATURES = {
    "tavily_validation": True,
    "architecture_diagram": True,
    "arch_review_pause": True,   # set False to auto-approve
    "streaming_generation": False,
}
```

Disable/enable features without code changes. Store in SSM Parameter Store for runtime toggles.

### Step 5: Event-Driven Extensibility

Right now the pipeline is closed — nothing can hook into it from outside. Make it open:

```python
# After each step completes, publish an event
await event_bus.publish("job.step.completed", {
    "job_id": job.id, "step": "drafting_document", "result": ...
})
```

External systems (analytics, notifications, CRM sync) subscribe to events without touching the pipeline.

---

## Part 4: Auth Deep-Dive — How Login Works Today

### The Full Login Flow (Step by Step)

```
1. User enters email + password on LoginPage.tsx

2. Frontend calls:
   POST /api/auth/login   { email, password }
   (goes through CloudFront /api/* → ALB → ECS API task)

3. FastAPI auth.py receives the request
   cognito.admin_initiate_auth(
     AuthFlow="ADMIN_USER_PASSWORD_AUTH",
     AuthParameters={"USERNAME": email, "PASSWORD": password}
   )
   WHY admin_initiate_auth: this is a server-side call using AWS credentials
   (the ECS task role has Cognito permissions). Cannot be called from the browser.

4. Cognito validates credentials against its user pool
   Returns: { IdToken, AccessToken, RefreshToken }
   
   IdToken  — JWT, contains user claims (email, sub, name), valid 1 HOUR
   AccessToken — JWT, used for Cognito API calls, valid 1 HOUR  
   RefreshToken — opaque token, used to get new tokens, valid 30 DAYS

5. FastAPI returns all three tokens to the frontend

6. Frontend stores:
   localStorage['genese-id-token']     = IdToken
   localStorage['genese-refresh-token'] = RefreshToken
   localStorage['genese-user']          = { email, sub }
   (AccessToken is NOT stored — not needed for our API)

7. Every subsequent API call:
   Authorization: Bearer {IdToken}

8. FastAPI validates the JWT:
   auth.py → get_current_user_sub() → decode JWT
   Verifies: signature (Cognito public key), expiry, issuer
   Returns: user's Cognito sub (unique ID)

9. API uses sub to look up or create User record in Aurora DB
   (Cognito sub is stored in users.cognito_sub column)
```

### What Is a JWT (IdToken)?

The IdToken is a Base64-encoded JSON Web Token with three parts:

```
header.payload.signature

Payload (decoded):
{
  "sub": "abc123-...",         ← unique Cognito user ID
  "email": "user@company.com",
  "name": "John",
  "iss": "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_ThM2KRVkt",
  "aud": "19ufsosadrbr5fqlhleargbrbi",  ← your app client ID
  "exp": 1719999999,           ← expires 1 hour from issue
  "iat": 1719996399            ← issued at
}
```

The API verifies the signature using Cognito's public JWKS endpoint — this means only Cognito can produce valid tokens. Your API trusts them without calling Cognito on every request (stateless validation).

### How Cognito User Maps to DB User

```
Cognito: user identified by "sub" (UUID — never changes even if email changes)
DB users table: cognito_sub column stores this sub

On first API call after login:
  SELECT * FROM users WHERE cognito_sub = 'abc123-...'
  → if not found: INSERT new user record with cognito_sub + email
  → if found: use existing record

All jobs, documents etc. have user_id = users.id (our internal UUID)
```

This means:
- Cognito owns authentication (who you are)
- Our DB owns authorisation data (what you've done, what you own)
- You can query "all jobs by this user" via users.id

### Token Refresh (Now Implemented)

```
After 1 hour, IdToken expires.
api.ts detects 401 response → calls POST /auth/refresh { refreshToken }
FastAPI calls cognito.initiate_auth(REFRESH_TOKEN_AUTH, refreshToken)
Cognito returns new IdToken + AccessToken (NOT new RefreshToken)
api.ts saves new IdToken → retries original request
User never sees a login prompt
After 30 days, RefreshToken expires → user must log in again
```

---

## Part 5: Google OAuth — Is It Possible? How?

### Yes, It Is Possible. Cognito Supports It Natively.

Cognito has a "Federated Identities" feature that supports Google, Facebook, Apple, SAML, and any OIDC provider. You add Google as an "identity provider" in Cognito. Users can then log in with either email/password OR Google.

### What Needs to Change

**1. Google Cloud Console (5 minutes)**
- Create a project at console.cloud.google.com
- Enable Google Identity API
- Create OAuth 2.0 Client ID (Web Application type)
- Authorized redirect URI: `https://your-cognito-domain.auth.us-east-1.amazoncognito.com/oauth2/idpresponse`
- Copy: `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`

**2. Cognito User Pool (CDK change)**

```python
# In genese_stack.py, update user_pool:
user_pool = cognito.UserPool(self, "UserPool",
    ...existing config...
)

# Add Cognito domain for hosted UI
user_pool.add_domain("Domain",
    cognito_domain=cognito.CognitoDomainOptions(
        domain_prefix="genese-proposal"
    )
)

# Add Google as identity provider
google_provider = cognito.UserPoolIdentityProviderGoogle(self, "Google",
    user_pool=user_pool,
    client_id="YOUR_GOOGLE_CLIENT_ID",
    client_secret_value=SecretValue.unsafe_plain_text("YOUR_GOOGLE_CLIENT_SECRET"),
    scopes=["profile", "email", "openid"],
    attribute_mapping=cognito.AttributeMapping(
        email=cognito.ProviderAttribute.GOOGLE_EMAIL,
        given_name=cognito.ProviderAttribute.GOOGLE_GIVEN_NAME,
        fullname=cognito.ProviderAttribute.GOOGLE_NAME,
    )
)

# Update app client to allow Google
app_client = user_pool.add_client("AppClient",
    ...existing config...
    supported_identity_providers=[
        cognito.UserPoolClientIdentityProvider.COGNITO,
        cognito.UserPoolClientIdentityProvider.GOOGLE,
    ],
    o_auth=cognito.OAuthSettings(
        flows=cognito.OAuthFlows(authorization_code_grant=True),
        scopes=[cognito.OAuthScope.EMAIL, cognito.OAuthScope.OPENID, cognito.OAuthScope.PROFILE],
        callback_urls=["https://d3gmhvny3loneb.cloudfront.net/auth/callback"],
        logout_urls=["https://d3gmhvny3loneb.cloudfront.net/login"],
    )
)
```

**3. Frontend changes**

Add a "Sign in with Google" button that redirects to Cognito's hosted UI:

```typescript
const COGNITO_DOMAIN = "https://genese-proposal.auth.us-east-1.amazoncognito.com";
const CLIENT_ID = "19ufsosadrbr5fqlhleargbrbi";
const REDIRECT_URI = "https://d3gmhvny3loneb.cloudfront.net/auth/callback";

function loginWithGoogle() {
  window.location.href = 
    `${COGNITO_DOMAIN}/oauth2/authorize?` +
    `response_type=code&client_id=${CLIENT_ID}` +
    `&redirect_uri=${REDIRECT_URI}` +
    `&identity_provider=Google` +
    `&scope=email+openid+profile`;
}
```

Add a `/auth/callback` route in React that:
1. Reads the `?code=` query param
2. Calls `POST /auth/google-callback { code }` on your API
3. Backend exchanges code for tokens via Cognito's token endpoint
4. Returns IdToken + RefreshToken to frontend
5. Frontend stores them — same flow as password login from this point on

**4. Backend: add /auth/google-callback**

```python
@router.post("/google-callback")
async def google_callback(req: GoogleCallbackRequest):
    """Exchange OAuth2 code for Cognito tokens."""
    import httpx
    token_url = f"https://cognito-domain.auth.us-east-1.amazoncognito.com/oauth2/token"
    response = httpx.post(token_url, data={
        "grant_type": "authorization_code",
        "client_id": settings.cognito_client_id,
        "code": req.code,
        "redirect_uri": settings.callback_url,
    })
    tokens = response.json()
    return {
        "idToken": tokens["id_token"],
        "accessToken": tokens["access_token"],
        "refreshToken": tokens.get("refresh_token"),
    }
```

### Effort Estimate

| Task | Time |
|---|---|
| Google Cloud Console setup | 15 min |
| CDK changes + deploy | 30 min |
| Frontend callback route | 1 hour |
| Backend callback endpoint | 30 min |
| Testing end-to-end | 1 hour |
| **Total** | **~3 hours** |

### One Important Note

Google OAuth users get a Cognito `sub` like any other user. Your existing `cognito_sub` → `users` mapping works identically. No DB changes needed. Google login and password login produce the same JWT shape. The rest of the app is completely unaffected.

---

## Summary Table

| Topic | Current State | What to Do |
|---|---|---|
| Architecture type | Modular Monolith + Async Worker | Fine for current scale |
| Feature isolation | Good for LLM/embed/search, tight in pipeline | Add step registry for pipeline |
| DB migrations | Manual ALTER TABLE | Add Alembic |
| Auth flow | Email/password via Cognito AdminInitiateAuth | Working well |
| Token refresh | Implemented (1hr idToken, 30d refreshToken) | Done |
| Google OAuth | Not yet | ~3 hours to add, straightforward |
| Extensibility | Can swap LLM/embed/search | Add event bus for full extensibility |
