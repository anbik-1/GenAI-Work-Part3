# AnyCompanyRead

An online book e-commerce platform built with React, shadcn/ui, and AWS Serverless.

## Architecture

```
Frontend (React + shadcn/ui + Tailwind CSS)
    │
    │  HTTPS
    ▼
CloudFront (CDN)
    │
    ├── Static files → S3 (frontend bucket)
    ├── /images/* → S3 (images bucket)
    └── /api/* → API Gateway
                    │
                    ├── /auth/* → Auth Lambda → Cognito
                    ├── /books/* → Books Lambda → DynamoDB
                    ├── /cart/* → Cart Lambda → DynamoDB
                    └── /orders/* → Orders Lambda → DynamoDB
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, TypeScript, Vite, Tailwind CSS, shadcn/ui |
| Backend | AWS Lambda (Node.js 20, TypeScript) |
| Database | Amazon DynamoDB (4 tables) |
| Auth | Amazon Cognito |
| API | Amazon API Gateway (REST) |
| Hosting | S3 + CloudFront |
| IaC | AWS CDK (TypeScript) |
| Monorepo | npm workspaces |

## Project Structure

```
anycompanyread/
├── packages/
│   ├── shared/          # Shared types & constants
│   ├── backend/         # Lambda handlers (auth, books, cart, orders)
│   ├── frontend/        # React SPA (Vite + shadcn/ui)
│   └── infrastructure/  # AWS CDK stack
├── scripts/
│   └── seed-data.ts     # Database seed script
├── package.json         # Root workspace config
└── tsconfig.base.json   # Shared TypeScript config
```

## Prerequisites

- Node.js >= 18
- AWS CLI configured with credentials
- AWS CDK CLI (`npm install -g aws-cdk`)

## Getting Started

### 1. Install dependencies

```bash
cd anycompanyread
npm install
```

### 2. Build all packages

```bash
npm run build:shared
npm run build:backend
npm run build:frontend
```

### 3. Deploy infrastructure

```bash
cd packages/infrastructure
npx cdk bootstrap   # First time only
npx cdk deploy
```

### 4. Configure frontend

After deployment, copy the API Gateway URL from the CDK outputs:

```bash
# Create .env file in packages/frontend/
echo "VITE_API_URL=https://your-api-id.execute-api.region.amazonaws.com/prod" > packages/frontend/.env
```

### 5. Seed the database

```bash
npx ts-node scripts/seed-data.ts
```

### 6. Local development

```bash
npm run dev:frontend
```

The frontend dev server runs at `http://localhost:3000`.

## Features

- **Book Catalog** — Browse, search, and filter books by genre
- **Book Details** — Full book information with cover image and rating
- **User Authentication** — Sign up, log in, password reset via Cognito
- **Shopping Cart** — Add/remove/update items with real-time totals
- **Checkout** — Simulated order placement (no real payment)
- **Order History** — View past orders and order details
- **Dark Mode** — Toggle between light and dark themes
- **Responsive** — Works on mobile, tablet, and desktop

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /auth/signup | No | Register user |
| POST | /auth/login | No | User login |
| POST | /auth/forgot-password | No | Initiate password reset |
| POST | /auth/confirm-forgot-password | No | Confirm password reset |
| GET | /books | No | List/search books |
| GET | /books/{bookId} | No | Get book details |
| GET | /cart | Yes | Get user's cart |
| POST | /cart | Yes | Add item to cart |
| PUT | /cart/{bookId} | Yes | Update cart item |
| DELETE | /cart/{bookId} | Yes | Remove from cart |
| POST | /checkout | Yes | Place order |
| GET | /orders | Yes | List orders |
| GET | /orders/{orderId} | Yes | Get order details |

## DynamoDB Tables

| Table | PK | SK | Purpose |
|-------|----|----|---------|
| AnyCompanyRead-Books | bookId | — | Book catalog |
| AnyCompanyRead-Carts | userId | bookId | Cart items |
| AnyCompanyRead-Orders | userId | orderId | Orders |
| AnyCompanyRead-OrderItems | orderId | bookId | Order line items |

## Cleanup

```bash
cd packages/infrastructure
npx cdk destroy
```

## License

This is a demo/learning application. Not intended for production use.
