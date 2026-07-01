# biku.md — Solution Architect Knowledge Reference

> A personal learning reference exploring infrastructure/architecture decisions.
> Based on the AnyCompanyRead project's inception-phase choices, but written to
> generalize so you can reuse the reasoning on future projects.
>
> **How to read this**: Each section takes ONE decision, lists the realistic
> options, shows what happens when you combine them, what's missing/weak in each,
> the best default, and *when* to deviate. Use it as a checklist when whiteboarding.

---

## 0. The Mental Model First

Before picking any tool, a Solution Architect answers these in order:

1. **What are the non-functional requirements (NFRs)?** — scale, latency, cost ceiling, team size, compliance, time-to-market. **These decide the tools, not the other way around.**
2. **What is the traffic shape?** — spiky/unpredictable vs steady/predictable. This single factor drives serverless-vs-servers more than anything else.
3. **What is the team's operational maturity?** — Can they run Kubernetes at 2am? If not, managed services win.
4. **What is the blast radius of a wrong choice?** — Reversible (app code) → decide fast. Irreversible (data store, auth model) → decide carefully.

> Rule of thumb: **Optimize for change, not for the current requirement.** The requirement will change; the architecture's ability to absorb change is the real deliverable.

AnyCompanyRead's driving NFRs were: *demo/learning app, low cost, low ops, fast to build, spiky (near-zero) traffic.* Almost every choice below flows from that. If those NFRs were different (e.g., "10k steady RPS, 20-person team, strict p99 latency"), most choices would flip.

---

## 1. Compute — Lambda vs Containers vs VMs

### The Options
| Option | What it is | Ops burden | Scale model | Cost model |
|--------|-----------|-----------|-------------|-----------|
| **AWS Lambda** | Function-as-a-Service | Lowest | Automatic, per-request | Pay per invocation + duration |
| **ECS Fargate** | Serverless containers | Low-medium | Task count (auto-scalable) | Pay per running task/hour |
| **ECS/EKS on EC2** | Containers on your VMs | High | Node + pod scaling | Pay for EC2 24/7 |
| **Raw EC2 / ASG** | Virtual machines | Highest | Instance scaling | Pay for EC2 24/7 |
| **App Runner / Elastic Beanstalk** | PaaS wrappers | Low | Automatic | Pay for underlying compute |

### What happens with each combination
- **Lambda + API Gateway + DynamoDB** (what AnyCompanyRead uses): fully serverless, scales to zero, near-$0 idle cost. *Best for spiky/unpredictable/low traffic and small teams.*
- **Fargate + ALB + RDS**: containers stay warm (no cold start), easy to run any language/framework, but you pay for at least 1 task 24/7. *Best when you need steady low-latency, long-running processes, or WebSocket/streaming.*
- **EKS + everything self-managed**: maximum control and portability, huge ops cost. *Only justified at large scale or strict multi-cloud/portability needs.*

### What's missing / weak
- **Lambda weaknesses**: cold starts (100ms–several seconds), 15-min max execution, 250MB deployment limit, awkward for long-lived connections (WebSockets need API Gateway WS or AppSync), harder local debugging, per-request pricing gets *expensive at high steady volume*.
- **Fargate weaknesses**: no scale-to-zero (min cost), slower scale-up than Lambda, you manage the container image and its patching.
- **EC2 weaknesses**: you own patching, scaling, AMIs, capacity planning — highest toil.

### Best default & when to deviate
- **Default for new/uncertain projects**: Lambda. It defers the scaling problem to AWS and costs nothing when idle.
- **Deviate to Fargate** when: sustained high throughput (Lambda cost crosses over ~ a few million steady requests/day), you need long-running or stateful processes, cold starts violate your p99, or you have a large existing container.
- **Deviate to EKS/EC2** when: you need Kubernetes-specific ecosystem, multi-cloud portability, GPU workloads, or you already have a platform team.

### The cost crossover (key SA insight)
Lambda is cheapest at low/spiky volume and *most expensive* at high steady volume. Fargate/EC2 are the opposite. Plot expected requests × duration; where the lines cross is your decision boundary. For a demo → Lambda wins by a mile.

---

## 2. Data Store — DynamoDB vs RDS vs Aurora vs others

### The Options
| Option | Type | Best at | Weak at |
|--------|------|---------|---------|
| **DynamoDB** | Managed NoSQL (key-value/document) | Predictable single-key access, massive scale, serverless, per-request billing | Ad-hoc queries, joins, aggregations, analytics |
| **RDS (Postgres/MySQL)** | Managed relational | Joins, transactions, ad-hoc SQL, reporting | Scaling writes horizontally, always-on cost |
| **Aurora Serverless v2** | Auto-scaling relational | SQL + elastic scale, scales down (not to zero on v2) | Cost floor, more moving parts |
| **DocumentDB / MongoDB** | Document DB | Flexible schemas, document queries | Cost, operational nuance |
| **OpenSearch** | Search engine | Full-text search, filters, facets | Not a primary datastore, cost |

### What happens with each combination
- **Lambda + DynamoDB** (AnyCompanyRead): matches the serverless story perfectly — scales to zero, pay-per-request, no connection-pool problem. *The natural pairing for serverless.*
- **Lambda + RDS**: **classic footgun** — Lambda can open thousands of concurrent connections and exhaust the DB's connection limit. You *must* add **RDS Proxy** to pool connections. So the honest combo is *Lambda + RDS Proxy + RDS*.
- **Lambda + Aurora Serverless v2 + RDS Proxy**: good when you need SQL flexibility with elastic scale.

### What's missing / weak
- **DynamoDB's big gap**: you must design access patterns *up front*. Search ("books by title contains X"), filtering by non-key attributes, and sorting require either a **GSI (Global Secondary Index)**, a `Scan` (expensive, avoid), or offloading search to **OpenSearch**. AnyCompanyRead does client-side search filtering *because it's a demo with ~20 books* — that does **not** scale. In production you'd add a GSI or OpenSearch.
- **RDS's big gap**: doesn't fit serverless connection model without RDS Proxy; always-on cost; vertical scaling ceiling for writes.

### Best default & when to deviate
- **Default with serverless + simple/known access patterns**: DynamoDB.
- **Deviate to RDS/Aurora** when: you need joins, complex reporting, ad-hoc analyst queries, strong relational integrity across many entities, or your team thinks in SQL and speed-to-market matters more than scale.
- **Add OpenSearch** when: search/filter/facet is a first-class feature (an actual bookstore would).
- **The pragmatic hybrid**: DynamoDB as system-of-record + stream to OpenSearch for search + optional analytics pipeline to a warehouse (Redshift/Athena).

### DynamoDB modeling note (SA depth)
- **On-demand capacity** (AnyCompanyRead's choice): pay-per-request, zero capacity planning — ideal for spiky/unknown traffic and demos.
- **Provisioned capacity + auto-scaling**: cheaper at predictable steady volume.
- **Single-table design** vs **multi-table**: single-table is the "advanced" DynamoDB pattern (fewer round trips, but steep learning curve). AnyCompanyRead uses **multi-table** (Books/Carts/Orders/OrderItems) for *clarity/learning* — the right call for a teaching demo, arguably not for a high-scale prod system.

---

## 3. Authentication — Cognito vs self-managed vs 3rd-party

### The Options
| Option | What it is | Strength | Weakness |
|--------|-----------|----------|----------|
| **Amazon Cognito** | Managed user pools + JWT | Native AWS integration, API Gateway authorizer, MFA, hosted UI | Clunky DX, hard to migrate off, limited customization |
| **Auth0 / Okta** | Managed identity SaaS | Best-in-class DX, social logins, enterprise SSO | Cost at scale, third-party dependency |
| **Firebase Auth** | Google's managed auth | Great DX, easy social login | Ties you to Google ecosystem |
| **Self-managed (bcrypt + JWT)** | Roll your own | Full control, no vendor | You own security, resets, breaches — **high risk** |

### What happens with each combination
- **Cognito + API Gateway** (AnyCompanyRead): API Gateway has a *native Cognito authorizer* — it validates the JWT before your Lambda even runs. Least code, tight integration. *This is why Cognito is the default in an AWS-serverless stack.*
- **Auth0 + API Gateway**: use a **Lambda authorizer** (custom) to validate Auth0 JWTs. More setup but far nicer login/social/enterprise features.
- **Self-managed**: you write signup/login/reset/refresh, store password hashes, handle token revocation. Almost never worth it — **auth is a place to buy, not build.**

### What's missing / weak
- **Cognito gaps**: developer experience is rough, error messages are cryptic, customizing flows (e.g., passwordless, custom attributes) is fiddly, and **migrating users out later is painful** (vendor lock-in on the identity layer is real).
- AnyCompanyRead auto-confirms users (skips email verification) *for demo simplicity* — in production you'd enable email/SMS verification and likely MFA.

### Best default & when to deviate
- **Default in AWS-native serverless**: Cognito (integration wins).
- **Deviate to Auth0/Okta** when: you need excellent login UX, many social providers, enterprise SSO/SAML, or you're multi-cloud.
- **Never** self-manage unless you have a specific compliance reason and a security team.

---

## 4. API Layer — REST (API Gateway) vs HTTP API vs AppSync (GraphQL) vs ALB

### The Options
| Option | Protocol | Best at | Weak at |
|--------|----------|---------|---------|
| **API Gateway REST** | REST | Rich features: authorizers, request validation, usage plans, API keys, WAF | Higher cost, more config |
| **API Gateway HTTP API** | REST (lighter) | ~70% cheaper, lower latency, simpler | Fewer features (no request validation, usage plans) |
| **AppSync** | GraphQL | Flexible client queries, real-time subscriptions, mobile | GraphQL learning curve, resolver complexity |
| **ALB → Lambda/Fargate** | HTTP | Simple, cheap at high volume, good for containers | No API-management features |

### What happens with each combination
- **REST API Gateway + Cognito + Lambda** (AnyCompanyRead): full-featured, native Cognito authorizer, CORS handling, per-route integration. *Safe default for REST + serverless.*
- **HTTP API + Lambda**: same idea, cheaper and faster, but you lose request validation and usage plans. *Best when you don't need those and want to cut cost/latency.*
- **AppSync + DynamoDB direct resolvers**: you can skip Lambda entirely for CRUD (VTL/JS resolvers hit DynamoDB directly), plus free real-time subscriptions. *Best for mobile apps and apps that benefit from client-shaped queries.*

### What's missing / weak
- **REST API Gateway**: pricier than HTTP API; lots of config for full features.
- **HTTP API**: no request/response validation, no API keys/usage plans, fewer integrations.
- **AppSync**: GraphQL schema + resolver mental model is a real learning investment; over-kill for a simple REST CRUD demo.

### Best default & when to deviate
- **Default for a learning REST app**: REST API Gateway (as AnyCompanyRead did) — you *see* all the pieces, which is good for learning.
- **Deviate to HTTP API** when: cost/latency matters and you don't need the advanced features (most production REST APIs actually fit here).
- **Deviate to AppSync** when: mobile/SPA with varied data needs, real-time (chat, live updates), or you want to avoid N+1 REST round-trips.

---

## 5. Frontend Hosting — S3+CloudFront vs Amplify vs Vercel/Netlify vs server-rendered

### The Options
| Option | What it is | Strength | Weakness |
|--------|-----------|----------|----------|
| **S3 + CloudFront** | Static hosting + CDN | Cheap, scalable, full control | You wire up CI/CD, cache invalidation, SPA fallback yourself |
| **AWS Amplify Hosting** | Managed frontend CI/CD | Git-based deploys, preview envs, easy | Less control, AWS-specific |
| **Vercel / Netlify** | Frontend PaaS | Best DX, instant previews, edge functions | Third-party, cost at scale |
| **Next.js SSR (Lambda@Edge/OpenNext)** | Server-rendered React | SEO, dynamic content, streaming | More complex infra |

### What happens with each combination
- **S3 + CloudFront + SPA fallback** (AnyCompanyRead): classic static SPA hosting. CloudFront serves `index.html` for 403/404 so client-side routing works (React Router). Cheap, fast globally. *Correct default for a Vite SPA.*
- **Amplify Hosting**: same result with managed Git CI/CD and PR preview environments — less to wire, slightly less control.
- **Vercel/Netlify**: unbeatable DX for frontend, but splits your stack across two providers.

### What's missing / weak
- **S3+CloudFront gap**: no built-in CI/CD (AnyCompanyRead deploys via `aws s3 sync` manually — fine for demo, but production wants a pipeline). Cache invalidation on deploy is a manual/scripted step. **No SSR** — pure client-side render means weaker SEO (irrelevant for an authed app, relevant for a public catalog).
- If SEO on the public book catalog mattered, a **Next.js SSR** approach would be better than a pure SPA.

### Best default & when to deviate
- **Default for an internal/authed SPA demo**: S3 + CloudFront.
- **Deviate to Amplify** when: you want managed Git deploys + preview envs with minimal setup.
- **Deviate to SSR (Next.js)** when: public SEO, social share previews, or dynamic first-paint matter.

---

## 6. Infrastructure as Code — CDK vs Terraform vs SAM vs CloudFormation vs Pulumi

### The Options
| Option | Language | Strength | Weakness |
|--------|----------|----------|----------|
| **AWS CDK** | TypeScript/Python/etc. | Real programming language, high-level constructs, great for AWS | AWS-centric, synth step, versioning churn |
| **Terraform** | HCL | Multi-cloud, huge ecosystem, mature state mgmt | HCL is limited, module boilerplate |
| **AWS SAM** | YAML | Purpose-built for serverless, local testing (`sam local`) | Serverless-only, YAML verbosity |
| **CloudFormation** | YAML/JSON | Native, no extra tooling | Verbose, no logic/loops |
| **Pulumi** | Real languages | Like CDK but multi-cloud | Smaller community, state service |

### What happens with each combination
- **CDK + TypeScript** (AnyCompanyRead): same language as the app (monorepo consistency), high-level constructs (`new cognito.UserPool(...)` does a lot in one line), and it *synthesizes* to CloudFormation. *Best when you're all-in on AWS and want app-language IaC.*
- **Terraform**: pick this when multi-cloud or when your org already standardizes on it. Doesn't share language with a TS app, but the ecosystem is enormous.
- **SAM**: lighter than CDK for pure-serverless; great `sam local` for local Lambda testing.

### What's missing / weak
- **CDK gaps**: AWS lock-in, the synth step adds indirection, construct/library version upgrades can be churny, and "magic" high-level constructs can hide what's actually deployed (learn to read the synthesized CloudFormation).
- AnyCompanyRead sets `removalPolicy: DESTROY` and `autoDeleteObjects: true` on buckets — great for a **demo** (clean teardown), **dangerous in production** (you can delete data). Know the difference.

### Best default & when to deviate
- **Default for AWS-only + app in TS/Python**: CDK.
- **Deviate to Terraform** when: multi-cloud, org standard, or you want the largest module ecosystem.
- **Deviate to SAM** when: pure serverless and you value local emulation over high-level constructs.

---

## 7. Repository Strategy — Monorepo vs Polyrepo

### The Options
- **Monorepo (npm workspaces)** — AnyCompanyRead's choice.
- **Polyrepo** — one repo per service/package.

### What happens
- **Monorepo + npm workspaces**: shared types (`@anycompanyread/shared`) are imported directly by frontend, backend, and infra — **one source of truth for types**, atomic cross-cutting changes, single `npm install`. *Ideal for small teams and tightly-coupled full-stack apps.*
- **Polyrepo**: independent versioning/deploys per service, clear ownership boundaries, but you version-publish shared packages and coordinate changes across repos.

### What's missing / weak
- **Monorepo gaps**: build ordering matters (AnyCompanyRead hit exactly this — `shared` must build before `backend`; fixed with a sequential build script), CI can get slow without caching (Nx/Turborepo help), and access control is all-or-nothing.
- **Polyrepo gaps**: dependency hell across repos, harder atomic changes, more CI/CD to maintain.

### Best default & when to deviate
- **Default for small team / full-stack app with shared types**: monorepo.
- **Deviate to polyrepo** when: many teams with independent release cadences, strict service ownership, or org-scale where a monorepo's tooling cost is justified only with Nx/Bazel/Turborepo.

---

## 8. State Management (Frontend) — Context vs Redux vs Zustand vs React Query

### The Options
| Option | Best at | Weak at |
|--------|---------|---------|
| **React Context** (AnyCompanyRead) | Simple global state (auth, cart), no deps | Re-render performance at scale, no caching |
| **Redux Toolkit** | Large, complex, predictable state | Boilerplate, overkill for small apps |
| **Zustand / Jotai** | Lightweight global state | Smaller ecosystem |
| **React Query / TanStack Query** | *Server* state: caching, refetch, sync | Not for pure client state |

### Key SA insight
- AnyCompanyRead uses **Context for auth + cart** — perfect for a demo's small, simple global state.
- **What's missing**: it manually manages server data (fetch + setState in each page). A production app would use **React Query** for server state (caching, background refetch, dedupe) and keep Context/Zustand only for pure client state. Mixing these two responsibilities is the most common frontend-architecture mistake.

### Best default & when to deviate
- **Default (small app)**: Context (client state) — add React Query when server-data caching/sync becomes painful.
- **Deviate to Redux** when: complex state machines, time-travel debugging, large team needing strict conventions.

---

## 9. Putting It Together — Scenario Iterations

Same product, different NFRs → different stack. This is the core SA skill: **the requirement dictates the architecture.**

### Scenario A: Demo / Learning app (AnyCompanyRead's actual case)
- **NFRs**: near-zero traffic, min cost, min ops, fast build, clarity.
- **Stack**: Lambda + REST API Gateway + Cognito + DynamoDB (multi-table, on-demand) + S3/CloudFront + CDK + monorepo + Context.
- **Why it wins**: scales to zero, ~$0 idle, everything managed, all pieces visible for learning.
- **What's knowingly sacrificed**: search doesn't scale (client-side filter), no CI/CD pipeline, auto-confirm users, `DESTROY` removal policies.

### Scenario B: Real startup MVP heading to production
- **NFRs**: moderate growing traffic, SEO on catalog, real search, must not lose data.
- **Changes**: keep Lambda + DynamoDB, **add GSIs or OpenSearch** for search, **Next.js SSR** for catalog SEO, **RETAIN** removal policies + PITR backups on DynamoDB, enable **Cognito email verification + MFA**, add a **CI/CD pipeline** (CodePipeline/GitHub Actions), switch REST → **HTTP API** to cut cost.

### Scenario C: High steady traffic, latency-sensitive, 20-person team
- **NFRs**: 10k steady RPS, strict p99, multiple teams.
- **Changes**: compute likely moves to **Fargate** (no cold starts, cheaper than Lambda at steady high volume) behind an **ALB**; data may stay DynamoDB but consider **Aurora + RDS Proxy** if relational/reporting needs grow; **polyrepo or Nx monorepo** for team scaling; **React Query** for frontend server-state.

### Scenario D: Mobile-first with real-time features
- **NFRs**: mobile clients, live order tracking, offline sync.
- **Changes**: **AppSync (GraphQL)** replaces REST API Gateway (subscriptions + client-shaped queries + offline via Amplify DataStore); DynamoDB direct resolvers reduce Lambda usage; Amplify for the client SDK.

### Scenario E: Enterprise / regulated
- **NFRs**: SSO, audit, compliance, VPC isolation.
- **Changes**: **Okta/Auth0 or Cognito + SAML**, Lambdas in **VPC** with private subnets, **RDS in private subnet + RDS Proxy**, WAF on API Gateway, CloudTrail + Config for audit, KMS-encrypted everything, Terraform (often the enterprise IaC standard).

---

## 10. The SA Decision Checklist (use this on every project)

1. **Write the NFRs down first.** Traffic shape, cost ceiling, latency target, team maturity, compliance, time-to-market.
2. **Traffic shape → compute.** Spiky/low → Lambda. Steady/high → Fargate/EC2. Compute the cost crossover.
3. **Access patterns → data store.** Known/simple keys → DynamoDB. Joins/reporting → RDS/Aurora (+ RDS Proxy if serverless). Search → OpenSearch or GSI.
4. **Buy auth, don't build.** Cognito (AWS-native) or Auth0/Okta (better DX/enterprise).
5. **API: match features to need.** REST GW (features), HTTP API (cheap), AppSync (GraphQL/real-time).
6. **Frontend: SPA (S3/CF) vs SSR (Next.js) — decided by SEO/dynamic needs.**
7. **IaC: CDK (AWS+app language), Terraform (multi-cloud/org standard), SAM (pure serverless).**
8. **Repo: monorepo (small/coupled) vs polyrepo (many teams).**
9. **Name the tradeoffs you're accepting.** Every choice sacrifices something — write down what and why (like the "demo sacrifices" above). This is what separates an architect from a tool-picker.
10. **Design for the *next* requirement, not just this one.** Is this choice reversible? If not, spend more time.

---

## 11. Quick Reference — "If I choose X, watch out for Y"

| If you choose... | Watch out for... | Mitigation |
|------------------|------------------|-----------|
| Lambda | Cold starts, 15-min limit, cost at high steady volume | Provisioned concurrency; move to Fargate at scale |
| Lambda + RDS | Connection exhaustion | **RDS Proxy** (mandatory) |
| DynamoDB | No ad-hoc queries/search | Design access patterns; GSIs; OpenSearch for search |
| DynamoDB Scan | Cost + latency explosion | Never Scan in hot paths; use Query on keys/GSIs |
| Cognito | Poor DX, migration lock-in | Accept for AWS-native; Auth0 if DX/SSO matters |
| REST API Gateway | Cost vs HTTP API | Use HTTP API unless you need validation/usage plans |
| S3+CloudFront SPA | No SSR/SEO, manual invalidation | Next.js SSR if SEO matters; scripted CF invalidation |
| CDK | AWS lock-in, hidden complexity | Read synthesized CFN; Terraform if multi-cloud |
| Monorepo | Build ordering, CI speed | Sequential/parallel build tooling (Nx/Turborepo) |
| Context for server state | Manual caching, refetch bugs | React Query for server state |
| `removalPolicy: DESTROY` | Data loss in prod | `RETAIN` + backups in production |

---

*End of biku.md — extend this as you encounter new decisions. The goal isn't to memorize tools; it's to internalize the reasoning: **NFRs → traffic/access patterns → tool → named tradeoffs → reversibility check.***
