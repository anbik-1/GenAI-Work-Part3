# Component Dependencies

## Dependency Matrix

| Component | Depends On | Depended On By |
|-----------|-----------|----------------|
| Frontend | Shared (types), API Gateway (REST) | — |
| AuthHandler | Shared (types, utils), Cognito | Frontend (via API) |
| BooksHandler | Shared (types, utils), DynamoDB | Frontend (via API) |
| CartHandler | Shared (types, utils), DynamoDB | Frontend (via API) |
| OrdersHandler | Shared (types, utils), DynamoDB | Frontend (via API) |
| Infrastructure | All Lambdas (bundled), S3 (frontend build) | All components (provides AWS resources) |
| Shared | — | All Lambdas, Frontend |

## Data Flow

```
+------------------+
|     Frontend     |
| (React/shadcn)   |
+------------------+
        |
        | HTTPS REST
        v
+------------------+
|   API Gateway    |
|  + Cognito Auth  |
+------------------+
   |    |    |    |
   v    v    v    v
+----+ +----+ +----+ +------+
|Auth| |Book| |Cart| |Orders|
+----+ +----+ +----+ +------+
   |    |    |    |
   v    v    v    v
+------+ +------------------+
|Cognito| |    DynamoDB      |
+------+ | Books,Carts,     |
          | Orders,OrderItems|
          +------------------+
```

## Package Dependencies (npm)

```
packages/shared          --> (no internal deps)
packages/backend         --> packages/shared
packages/frontend        --> packages/shared
packages/infrastructure  --> packages/backend, packages/frontend (build artifacts)
```

## Build Order

1. **packages/shared** — build first (no dependencies)
2. **packages/backend** — depends on shared types
3. **packages/frontend** — depends on shared types
4. **packages/infrastructure** — bundles Lambda code, references frontend build output

## Communication Patterns

- **Frontend → Backend**: REST API calls over HTTPS via API Gateway
- **Backend → DynamoDB**: AWS SDK v3 direct calls
- **Backend → Cognito**: AWS SDK v3 direct calls (auth handler only)
- **No inter-Lambda communication**: Each Lambda is independent, no service-to-service calls
