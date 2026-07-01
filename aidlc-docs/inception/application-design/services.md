# Services

## Service Architecture

The application uses a simple service pattern where each Lambda handler acts as a service for its resource domain. No separate service orchestration layer is needed given the demo scope.

```
Frontend (React SPA)
    |
    | HTTPS (REST)
    v
API Gateway
    |
    |--- /auth/*       --> AuthHandler Lambda --> Cognito
    |--- /books/*      --> BooksHandler Lambda --> DynamoDB (Books)
    |--- /cart/*       --> CartHandler Lambda --> DynamoDB (Carts)
    |--- /checkout     --> OrdersHandler Lambda --> DynamoDB (Orders, OrderItems, Carts)
    |--- /orders/*     --> OrdersHandler Lambda --> DynamoDB (Orders, OrderItems)
```

## API Gateway Configuration

- **Type**: REST API
- **Auth**: Cognito User Pool Authorizer on protected routes
- **CORS**: Enabled for frontend origin
- **Routes**: 14 endpoints mapped to 4 Lambda functions

## Service Definitions

### AuthService (AuthHandler Lambda)
- **Upstream**: API Gateway (public routes)
- **Downstream**: Amazon Cognito User Pool
- **Pattern**: Request/Response — stateless auth operations

### BookService (BooksHandler Lambda)
- **Upstream**: API Gateway (public routes)
- **Downstream**: DynamoDB Books table
- **Pattern**: Request/Response — read-only catalog queries

### CartService (CartHandler Lambda)
- **Upstream**: API Gateway (authenticated routes)
- **Downstream**: DynamoDB Carts table
- **Pattern**: Request/Response — CRUD on user's cart items

### OrderService (OrdersHandler Lambda)
- **Upstream**: API Gateway (authenticated routes)
- **Downstream**: DynamoDB Orders table, OrderItems table, Carts table
- **Pattern**: Request/Response — checkout creates order + clears cart in sequence
- **Note**: Checkout reads cart, creates order + order items, then deletes cart items. No transaction needed for demo (eventual consistency acceptable).

## Infrastructure Services (CDK)

| AWS Service | Resource | Purpose |
|-------------|----------|---------|
| Cognito | User Pool + Client | User authentication |
| API Gateway | REST API | Route requests to Lambdas |
| Lambda | 4 functions | Business logic |
| DynamoDB | 4 tables | Data storage |
| S3 | 2 buckets | Frontend hosting + book cover images |
| CloudFront | 1 distribution | CDN for frontend + images |
