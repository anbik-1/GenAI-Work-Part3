# 08 — Authentication & Authorization

> **Scope**: Everything about identity, tokens, roles, and access control in Genese Proposal AI.

---

## Table of Contents

1. [Authentication vs Authorization](#1-authentication-vs-authorization)
2. [Auth Stack Overview](#2-auth-stack-overview)
3. [Amazon Cognito — Why and What](#3-amazon-cognito--why-and-what)
4. [Full Token Flow](#4-full-token-flow)
5. [Token Storage and Lifecycle](#5-token-storage-and-lifecycle)
6. [JWT Validation on the Backend](#6-jwt-validation-on-the-backend)
7. [Role-Based Access Control](#7-role-based-access-control)
8. [User Management](#8-user-management)
9. [Current Authorization Gaps](#9-current-authorization-gaps)
10. [How to Improve](#10-how-to-improve)
11. [Quick Reference](#11-quick-reference)

---

## 1. Authentication vs Authorization

These are two distinct concerns that work together.

**Authentication** — "Who are you?"
Verifies the user's identity. In this app, it means checking the email and password against Amazon Cognito and receiving a signed JWT (JSON Web Token) that proves who the user is.

**Authorization** — "What are you allowed to do?"
Checks what the authenticated user can access. In this app, authorization is role-based: `admin` or `member`. The role is stored in the application database, not in Cognito.

A user who is authenticated (has a valid JWT) but not authorized (wrong role or doesn't own the resource) will receive a `403 Forbidden` response.

---

## 2. Auth Stack Overview

| Component | Technology | Detail |
|---|---|---|
| Identity provider | Amazon Cognito | User Pool `us-east-1_ThM2KRVkt` |
| App client | Cognito App Client | ID `19ufsosadrbr5fqlhleargbrbi`, no secret (public client) |
| Auth flow | `ADMIN_USER_PASSWORD_AUTH` | Server-side only — requires AWS IAM credentials |
| Token format | JWT (RS256) | Signed by Cognito's RSA private key |
| Token validation | JWKS public key | Fetched from Cognito's `.well-known/jwks.json` endpoint |
| Role storage | PostgreSQL `users.role` | Values: `admin` or `member` — NOT Cognito groups |
| Frontend token storage | `localStorage` | Keys: `genese-id-token`, `genese-refresh-token`, `genese-user` |

---

## 3. Amazon Cognito — Why and What

### Why Cognito instead of rolling your own auth

Building authentication from scratch means solving a set of hard, security-critical problems. Cognito solves all of them:

- **JWT signing key management** — Cognito generates and rotates RSA key pairs. You never touch private keys.
- **Password hashing** — bcrypt with high work factor, handled entirely by Cognito.
- **Brute force protection** — automatic account lockout after repeated failed attempts.
- **Built-in flows** — token refresh, password reset, forgot password all work without any backend code.
- **MFA ready** — TOTP and SMS MFA can be enabled in minutes with no code changes.
- **OAuth2/OIDC compliant** — Google, Apple, or any enterprise SSO can be added without changing the token validation logic.
- **Compliance** — SOC 2, HIPAA, PCI-DSS certified. Relevant if Genese handles sensitive client data.
- **Cost** — Free up to 50,000 monthly active users (MAU).

### Why not a JWT-only backend

An alternative is to skip Cognito entirely, store hashed passwords in the database, and sign JWTs yourself. This is valid for toy projects but has real costs in production:

- You own key rotation (if the signing key leaks, all tokens are valid forever unless you rotate and invalidate).
- You own password hashing correctness (easy to get wrong, hard to audit).
- You own brute force protection (rate limiting, lockout logic).
- You own MFA if you ever need it.
- Any OAuth2/SSO integration requires significant extra code.

The Cognito approach trades a small amount of AWS vendor lock-in for a major reduction in security surface area.

### Why `ADMIN_USER_PASSWORD_AUTH` instead of client-side auth

Cognito supports two authentication flows relevant here:

| Flow | Where it runs | Requires |
|---|---|---|
| `USER_PASSWORD_AUTH` | Browser (or server) | Only the app client ID |
| `ADMIN_USER_PASSWORD_AUTH` | Server only | AWS IAM credentials with Cognito permissions |

`ADMIN_USER_PASSWORD_AUTH` cannot be called from a browser because it requires AWS IAM credentials — exposing those in the browser would be a critical security vulnerability. The backend acts as a secure proxy: the browser sends email+password to FastAPI, FastAPI calls Cognito using its ECS task IAM role, and returns only the JWT tokens to the browser.

`USER_PASSWORD_AUTH` can be called from the browser (the app client ID is public), but it is considered less secure because it is more susceptible to certain pre-auth lambda trigger limitations and doesn't benefit from server-side request validation.

**Decision**: always use `ADMIN_USER_PASSWORD_AUTH` via backend proxy for maximum security.

---

## 4. Full Token Flow

### Login sequence

```
Browser                    FastAPI (ECS)              Amazon Cognito
  |                             |                           |
  |  POST /api/auth/login       |                           |
  |  { email, password }        |                           |
  |---------------------------->|                           |
  |                             |  admin_initiate_auth()    |
  |                             |  ADMIN_USER_PASSWORD_AUTH |
  |                             |-------------------------->|
  |                             |                           | validates credentials
  |                             |                           | generates RSA-signed JWTs
  |                             |  { IdToken,               |
  |                             |    AccessToken,           |
  |                             |    RefreshToken }         |
  |                             |<--------------------------|
  |  200 OK                     |                           |
  |  { id_token,                |                           |
  |    refresh_token,           |                           |
  |    user: { email, role } }  |                           |
  |<----------------------------|                           |
  |                             |                           |
  | stores in localStorage:     |                           |
  |   genese-id-token           |                           |
  |   genese-refresh-token      |                           |
  |   genese-user               |                           |
```

### Authenticated API call sequence

```
Browser                    FastAPI (ECS)              PostgreSQL (Aurora)
  |                             |                           |
  |  GET /api/jobs              |                           |
  |  Authorization: Bearer      |                           |
  |  {IdToken}                  |                           |
  |---------------------------->|                           |
  |                             | 1. decode JWT header      |
  |                             | 2. fetch JWKS public key  |
  |                             |    (cached after first    |
  |                             |     fetch)                |
  |                             | 3. verify RS256 signature |
  |                             | 4. check expiry           |
  |                             | 5. extract 'sub' claim    |
  |                             |                           |
  |                             |  SELECT id, role FROM     |
  |                             |  users WHERE              |
  |                             |  cognito_sub = :sub       |
  |                             |-------------------------->|
  |                             |  { id, role }             |
  |                             |<--------------------------|
  |                             |                           |
  |                             | apply role-based filter   |
  |  200 OK { jobs: [...] }     |                           |
  |<----------------------------|                           |
```

### Token refresh sequence (automatic, silent)

```
Browser (api.ts)            FastAPI (ECS)              Amazon Cognito
  |                             |                           |
  | any API call → 401          |                           |
  |  (IdToken expired)          |                           |
  |                             |                           |
  | POST /api/auth/refresh      |                           |
  | { refresh_token }           |                           |
  |---------------------------->|                           |
  |                             |  REFRESH_TOKEN_AUTH       |
  |                             |  { refresh_token }        |
  |                             |-------------------------->|
  |                             |  { IdToken,               |
  |                             |    AccessToken }          |
  |                             |  (new tokens — same       |
  |                             |   refresh token)          |
  |                             |<--------------------------|
  |  { id_token }               |                           |
  |<----------------------------|                           |
  |                             |                           |
  | update localStorage:        |                           |
  |   genese-id-token = new     |                           |
  |                             |                           |
  | retry original request      |                           |
  |---------------------------->|                           |
```

The refresh flow is fully transparent to the user — they never see a 401 error from a simple token expiry. If the refresh token itself has expired (after 30 days of inactivity), the user is logged out and redirected to the login page.

---

## 5. Token Storage and Lifecycle

### Tokens issued

| Token | Duration | What it's used for |
|---|---|---|
| `IdToken` | 1 hour | Sent as `Authorization: Bearer` header on every API call. Contains user identity claims (email, sub, cognito:username). |
| `AccessToken` | 1 hour | Not currently used by the app (reserved for Cognito API calls like change password). |
| `RefreshToken` | 30 days | Used to obtain new IdToken + AccessToken when they expire. |

### Where tokens are stored

All three values are stored in `localStorage`:

| Key | Contents |
|---|---|
| `genese-id-token` | The raw JWT IdToken string |
| `genese-refresh-token` | The raw RefreshToken string |
| `genese-user` | JSON object `{ email, role, sub }` |

**Note on localStorage vs cookies**: Storing tokens in localStorage is convenient but means JavaScript can read them (XSS risk). The alternative is `httpOnly` cookies set by the server, which JavaScript cannot read. This is a known trade-off in this app — see [Section 10](#10-how-to-improve) for the upgrade path.

### Token claims (IdToken payload)

```json
{
  "sub": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",  // unique Cognito user ID
  "email": "user@genese.com",
  "cognito:username": "user@genese.com",
  "aud": "19ufsosadrbr5fqlhleargbrbi",             // app client ID
  "iss": "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_ThM2KRVkt",
  "token_use": "id",
  "exp": 1720000000,
  "iat": 1719996400
}
```

The `sub` claim is the stable, unique identifier used to link the Cognito identity to the application's `users` table via the `cognito_sub` column.

---

## 6. JWT Validation on the Backend

Every protected endpoint calls `get_current_user_sub()` (from `services/api/src/core/auth.py`) which:

1. Extracts the `Authorization: Bearer <token>` header.
2. Decodes the JWT header (without verification) to get the `kid` (key ID).
3. Fetches the Cognito JWKS endpoint to get the public key matching that `kid`:
   ```
   https://cognito-idp.us-east-1.amazonaws.com/us-east-1_ThM2KRVkt/.well-known/jwks.json
   ```
4. Verifies the RS256 signature using that public key.
5. Checks the token hasn't expired (`exp` claim).
6. Checks `token_use == "id"` and `aud == app_client_id` to prevent AccessTokens being used as IdTokens.
7. Returns the `sub` claim as `user_sub`.

If any check fails, a `401 Unauthorized` is returned immediately — no database query happens.

The JWKS keys are cached in memory (they rotate infrequently). A cache miss triggers a fresh fetch from AWS.

### Role lookup (after JWT validation)

For endpoints that need role information, a second step queries the database:

```python
user_row = await db.execute(
    text("SELECT id, role FROM users WHERE cognito_sub = :sub"),
    {"sub": user_sub}
)
user = user_row.mappings().one_or_none()
```

Roles are **not** stored in the JWT. This is intentional: it means role changes take effect immediately on the next request without waiting for a token to expire or be reissued.

---

## 7. Role-Based Access Control

### Roles

| Role | Description |
|---|---|
| `admin` | Full access. Can see all users' jobs and documents, create and delete users. |
| `member` | Scoped access. Can only see and manage their own jobs and documents. |

Roles are stored in the `users.role` column in PostgreSQL. Cognito groups are not used.

### Access matrix

| Resource | `member` | `admin` |
|---|---|---|
| `POST /generate` | Own jobs only | Own jobs only |
| `GET /jobs` | Own jobs | Own jobs (add `?all=true` for all) |
| `GET /generate/{job_id}` | Own job only (403 on others) | Any job + owner info |
| `POST /documents/upload` | Own documents | Any user's documents |
| `GET /documents` | Own uploaded documents | All documents |
| `DELETE /documents/{id}` | Own documents only | Any document |
| `POST /auth/admin/create-user` | 403 | Allowed |
| `DELETE /auth/admin/users/{id}` | 403 | Allowed |
| `GET /auth/admin/users` | 403 | Allowed |

### How role is enforced (pattern used consistently)

```python
# 1. JWT validates the request is authenticated
user_sub: str = Depends(get_current_user_sub)

# 2. DB lookup resolves role
user_row = await db.execute(
    text("SELECT id, role FROM users WHERE cognito_sub = :sub"),
    {"sub": user_sub}
)
user = user_row.mappings().one_or_none()
if not user:
    raise HTTPException(status_code=401, detail="User not found")

is_admin = user["role"] == "admin"

# 3. Apply role-based filter
if is_admin:
    # no ownership filter
else:
    # WHERE uploaded_by = :user_id  /  WHERE user_id = :user_id
```

---

## 8. User Management

### Self-signup is disabled

The Cognito User Pool has `self_sign_up_enabled = False`. Users cannot create accounts themselves. This is a deliberate decision — Genese Proposal AI is an internal tool for Genese employees, not a public SaaS.

### How users are created

Only admins can create users via:

```
POST /auth/admin/create-user
Authorization: Bearer {admin_IdToken}

{
  "email": "newuser@genese.com",
  "name": "Jane Smith",
  "role": "member",        // or "admin"
  "temporary_password": "TempPass123!"
}
```

This endpoint:
1. Calls `cognito.admin_create_user()` to create the identity in Cognito.
2. Calls `cognito.admin_set_user_password()` with `permanent=True` to skip the forced-change-on-first-login flow.
3. Creates a corresponding row in the `users` table with `cognito_sub`, `email`, `name`, and `role`.

### Deleting users

```
DELETE /auth/admin/users/{user_id}
Authorization: Bearer {admin_IdToken}
```

Deletes from both Cognito and the application database.

---

## 9. Current Authorization Gaps

These are known gaps as of the initial implementation, ordered by risk.

### Gap 1: Document ownership — FIXED

**Was**: `GET /documents` returned all documents to all authenticated users regardless of role.

**Fixed**: Members now see only documents they uploaded (`uploaded_by = user.id`). Admins see all. The fix is in `services/api/src/routers/documents.py`.

### Gap 2: Job status by ID — FIXED

**Was**: `GET /generate/{job_id}` returned job details to any authenticated user who knew the UUID. A member could enumerate or guess job IDs and read another user's proposal content.

**Fixed**: After fetching the job row, the backend checks if the requesting user owns the job. Non-admins get `403 Forbidden` if `row['user_id'] != user.id`. Admins see all jobs and additionally get `owner_email` and `owner_name` in the response.

### Gap 3: Document status endpoint

**Current**: `GET /documents/{document_id}/status` requires only authentication (`_: str = Depends(get_current_user_sub)`). Any authenticated user can check the ingestion status of any document if they know the ID.

**Risk**: Low — status information is not sensitive (just phase progress and token counts). No proposal content is exposed.

**Recommendation**: Apply the same ownership check pattern if document IDs ever become guessable or if status responses are extended to include content.

### Gap 4: Token storage in localStorage

**Current**: `genese-id-token` and `genese-refresh-token` are stored in `localStorage`, which is accessible to JavaScript. An XSS attack on the frontend could steal tokens.

**Risk**: Medium — requires a successful XSS exploit first. The React app does not use `dangerouslySetInnerHTML` and input is not rendered as raw HTML, but third-party dependencies could introduce a vector.

**Recommendation**: Migrate to `httpOnly` session cookies set by the FastAPI backend. See [Section 10](#10-how-to-improve).

---

## 10. How to Improve

### MFA (Time-based OTP)

Cognito supports TOTP MFA natively. To enable for all users:

1. Update the Cognito User Pool in `infra/cognito.tf`:
   ```hcl
   mfa_configuration = "ON"
   software_token_mfa_configuration {
     enabled = true
   }
   ```
2. The auth flow (`ADMIN_USER_PASSWORD_AUTH`) will return a `ChallengeName: SOFTWARE_TOKEN_MFA` response instead of tokens when MFA is required.
3. Add a second API endpoint `POST /auth/mfa-verify` that calls `respond_to_auth_challenge` with the TOTP code.
4. The login page needs a second step to collect the OTP code.

No changes to JWT validation or role logic are needed — MFA is entirely handled by Cognito before tokens are issued.

### Google OAuth / Social Login

Cognito supports federated identity with Google, Apple, or any OIDC provider.

1. Add a Google identity provider to the Cognito User Pool.
2. Enable the hosted UI or handle the OAuth2 authorization code flow in the backend.
3. JWT validation, role lookup, and all downstream authorization logic works identically — the `sub` claim is still the stable identifier.

The only application-level change needed is the login page UI and a `POST /auth/social-callback` endpoint to exchange the authorization code for Cognito tokens.

### Granular permissions

The current model has two roles. For more fine-grained control, consider:

- **Resource-level permissions**: store a `permissions` JSON column on the user row `{ "can_generate": true, "max_jobs_per_day": 10 }`.
- **Scoped admin**: an `org_admin` role that can manage users within their organization but not globally.
- **Cognito groups**: if permissions need to be embedded in the JWT itself (to avoid the DB lookup), Cognito groups can be used. Group membership is included in the `cognito:groups` claim. Note: JWT-embedded permissions have a lag — they don't update until the next token refresh.

### Document ownership model

Currently `documents.uploaded_by` tracks the uploader. A fuller ownership model would:

1. Add an `organization_id` to both `users` and `documents`.
2. Allow `org_admin` to see all documents within their org.
3. Allow shared document libraries (documents owned by the org, visible to all members).

### httpOnly cookie token storage

To eliminate the XSS-based token theft risk:

1. On login success, FastAPI sets two `httpOnly; Secure; SameSite=Strict` cookies:
   - `session_token` — the IdToken (or a reference to a server-side session)
   - No refresh token in a cookie (or a separate `__refresh` cookie with a longer max-age)
2. The React frontend no longer stores tokens in localStorage.
3. Every API request automatically sends the cookie — no `Authorization` header needed.
4. CSRF protection is needed (use `SameSite=Strict` + a CSRF token for state-changing requests).

This is a moderately invasive change to `api.ts` and the FastAPI auth router but significantly improves the token security posture.

---

## 11. Quick Reference

### Key identifiers

| Item | Value |
|---|---|
| Cognito User Pool ID | `us-east-1_ThM2KRVkt` |
| Cognito App Client ID | `19ufsosadrbr5fqlhleargbrbi` |
| AWS Region | `us-east-1` |
| JWKS endpoint | `https://cognito-idp.us-east-1.amazonaws.com/us-east-1_ThM2KRVkt/.well-known/jwks.json` |
| Token issuer (`iss`) | `https://cognito-idp.us-east-1.amazonaws.com/us-east-1_ThM2KRVkt` |

### Token durations

| Token | Duration |
|---|---|
| IdToken | 1 hour |
| AccessToken | 1 hour |
| RefreshToken | 30 days |

### localStorage keys

| Key | Contents |
|---|---|
| `genese-id-token` | Raw JWT IdToken |
| `genese-refresh-token` | Raw RefreshToken |
| `genese-user` | `{ email, role, sub }` JSON |

### Relevant source files

| File | Purpose |
|---|---|
| `services/api/src/core/auth.py` | JWT validation, `get_current_user_sub()` dependency |
| `services/api/src/routers/auth.py` | Login, refresh, admin user management endpoints |
| `services/api/src/routers/jobs.py` | Job list with role-based scoping |
| `services/api/src/routers/generate.py` | Job submission, status polling with ownership check |
| `services/api/src/routers/documents.py` | Document upload, list, delete with ownership enforcement |
| `services/frontend/src/api.ts` | Token storage, refresh interceptor |
| `services/frontend/src/pages/LoginPage.tsx` | Login form, calls `POST /api/auth/login` |
| `infra/cognito.tf` | Cognito User Pool Terraform definition |
