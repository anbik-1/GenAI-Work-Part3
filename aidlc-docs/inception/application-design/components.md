# Application Components

## Component Overview

| Component | Package | Type | Purpose |
|-----------|---------|------|---------|
| Frontend | packages/frontend | React SPA | User interface with shadcn/ui |
| AuthHandler | packages/backend | Lambda | User authentication via Cognito |
| BooksHandler | packages/backend | Lambda | Book catalog CRUD |
| CartHandler | packages/backend | Lambda | Shopping cart management |
| OrdersHandler | packages/backend | Lambda | Checkout and order history |
| Infrastructure | packages/infrastructure | CDK | AWS resource provisioning |
| Shared | packages/shared | Library | Shared types and utilities |

---

## Frontend

- **Package**: packages/frontend
- **Type**: React SPA (Vite + TypeScript)
- **Responsibilities**:
  - Render all UI pages using shadcn/ui components and Tailwind CSS
  - Manage client-side routing (React Router)
  - Manage auth state and cart state via React Context
  - Communicate with backend via REST API (fetch)
  - Support light/dark mode theming
- **Pages**: Home, Books, Book Detail, Login, Signup, Cart, Orders

## AuthHandler

- **Package**: packages/backend/handlers/auth
- **Type**: AWS Lambda (TypeScript)
- **Responsibilities**:
  - Handle signup, login, forgot-password, confirm-forgot-password
  - Interact with Amazon Cognito User Pool
  - Return JWT tokens on successful authentication

## BooksHandler

- **Package**: packages/backend/handlers/books
- **Type**: AWS Lambda (TypeScript)
- **Responsibilities**:
  - List books with pagination, search, and genre filter
  - Get book details by bookId
  - Query DynamoDB Books table

## CartHandler

- **Package**: packages/backend/handlers/cart
- **Type**: AWS Lambda (TypeScript)
- **Responsibilities**:
  - Get cart items for authenticated user
  - Add item to cart
  - Update item quantity
  - Remove item from cart
  - Query/update DynamoDB Carts table

## OrdersHandler

- **Package**: packages/backend/handlers/orders
- **Type**: AWS Lambda (TypeScript)
- **Responsibilities**:
  - Create order from cart (checkout) — simulated, no payment
  - List orders for authenticated user
  - Get order details
  - Query/update DynamoDB Orders and OrderItems tables
  - Clear cart after successful checkout

## Infrastructure

- **Package**: packages/infrastructure
- **Type**: AWS CDK (TypeScript)
- **Responsibilities**:
  - Define all AWS resources (Cognito, API Gateway, Lambda, DynamoDB, S3, CloudFront)
  - Configure API Gateway routes and Cognito authorizer
  - Set up S3 bucket for frontend hosting and book cover images
  - Configure CloudFront distribution

## Shared

- **Package**: packages/shared
- **Type**: TypeScript library
- **Responsibilities**:
  - Define shared TypeScript types/interfaces (Book, CartItem, Order, etc.)
  - Shared constants (API paths, DynamoDB table names)
  - Shared utility functions (response helpers, validation)
