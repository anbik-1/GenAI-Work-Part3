# AnyCompanyRead - Code Generation Plan

## Unit Context
- **Unit**: AnyCompanyRead (single unit — full application)
- **Code Location**: `/home/ec2-user/environment/anycompanyread`
- **Project Type**: Greenfield, TypeScript monorepo (npm workspaces)
- **Tech Stack**: React + shadcn/ui + Tailwind | AWS Lambda (TypeScript) | DynamoDB | CDK

## Target Project Structure

```
anycompanyread/
├── package.json                  # Root workspace config
├── tsconfig.base.json            # Shared TS config
├── packages/
│   ├── shared/                   # Shared types & utilities
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── types/            # Book, CartItem, Order, OrderItem
│   │       ├── constants.ts      # Table names, API paths
│   │       └── index.ts
│   ├── backend/                  # Lambda handlers
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── handlers/
│   │       │   ├── auth/         # signup, login, forgotPassword, confirmForgotPassword
│   │       │   ├── books/        # listBooks, getBook
│   │       │   ├── cart/         # getCart, addToCart, updateCartItem, removeFromCart
│   │       │   └── orders/       # checkout, listOrders, getOrder
│   │       └── utils/            # Response helpers, DynamoDB client, error handling
│   ├── frontend/                 # React SPA (Vite)
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── vite.config.ts
│   │   ├── tailwind.config.ts
│   │   ├── postcss.config.js
│   │   ├── index.html
│   │   └── src/
│   │       ├── main.tsx
│   │       ├── App.tsx
│   │       ├── components/       # shadcn/ui components + custom components
│   │       │   ├── ui/           # shadcn/ui base components
│   │       │   ├── layout/       # Navbar, Footer, ThemeProvider
│   │       │   └── books/        # BookCard, BookGrid, BookDetail
│   │       ├── pages/            # Home, Books, BookDetail, Login, Signup, Cart, Orders
│   │       ├── contexts/         # AuthContext, CartContext
│   │       ├── lib/              # API client, utils
│   │       └── styles/
│   │           └── globals.css
│   └── infrastructure/           # AWS CDK
│       ├── package.json
│       ├── tsconfig.json
│       ├── cdk.json
│       ├── bin/
│       │   └── app.ts
│       └── lib/
│           ├── anycompanyread-stack.ts   # Main stack
│           └── constructs/              # Reusable constructs
├── scripts/
│   └── seed-data.ts              # DynamoDB seed script
└── README.md
```

## Dependencies on Prior Stages
- **Requirements**: requirements.md (FR-1 through FR-4, NFR-1 through NFR-6)
- **Application Design**: components.md, component-methods.md, services.md, component-dependency.md

---

## Code Generation Steps

### Step 1: Project Structure Setup
- [ ] Create root `anycompanyread/` directory
- [ ] Create root `package.json` with npm workspaces configuration
- [ ] Create `tsconfig.base.json` with shared TypeScript config
- [ ] Create all package directories and their `package.json` files
- [ ] Create `.gitignore`

### Step 2: Shared Package — Types & Utilities
- [ ] Create `packages/shared/src/types/book.ts` — Book interface
- [ ] Create `packages/shared/src/types/cart.ts` — CartItem interface
- [ ] Create `packages/shared/src/types/order.ts` — Order, OrderItem interfaces
- [ ] Create `packages/shared/src/types/auth.ts` — Auth-related types
- [ ] Create `packages/shared/src/types/api.ts` — API request/response types
- [ ] Create `packages/shared/src/constants.ts` — Table names, API paths
- [ ] Create `packages/shared/src/index.ts` — Barrel export

### Step 3: Backend — Utility Layer
- [ ] Create `packages/backend/src/utils/dynamodb.ts` — DynamoDB client setup
- [ ] Create `packages/backend/src/utils/response.ts` — Lambda response helpers (status codes, CORS headers)
- [ ] Create `packages/backend/src/utils/auth.ts` — JWT token extraction helper
- [ ] Create `packages/backend/src/utils/error.ts` — Error handling utilities

### Step 4: Backend — Auth Handler
- [ ] Create `packages/backend/src/handlers/auth/index.ts` — Router for auth endpoints
- [ ] Create `packages/backend/src/handlers/auth/signup.ts` — Cognito signup
- [ ] Create `packages/backend/src/handlers/auth/login.ts` — Cognito login (adminInitiateAuth)
- [ ] Create `packages/backend/src/handlers/auth/forgot-password.ts` — Initiate reset
- [ ] Create `packages/backend/src/handlers/auth/confirm-forgot-password.ts` — Confirm reset

### Step 5: Backend — Books Handler
- [ ] Create `packages/backend/src/handlers/books/index.ts` — Router for books endpoints
- [ ] Create `packages/backend/src/handlers/books/list-books.ts` — Scan/query with search, genre filter, pagination
- [ ] Create `packages/backend/src/handlers/books/get-book.ts` — Get by bookId

### Step 6: Backend — Cart Handler
- [ ] Create `packages/backend/src/handlers/cart/index.ts` — Router for cart endpoints
- [ ] Create `packages/backend/src/handlers/cart/get-cart.ts` — Query cart items by userId
- [ ] Create `packages/backend/src/handlers/cart/add-to-cart.ts` — Put item in Carts table
- [ ] Create `packages/backend/src/handlers/cart/update-cart-item.ts` — Update quantity
- [ ] Create `packages/backend/src/handlers/cart/remove-from-cart.ts` — Delete item

### Step 7: Backend — Orders Handler
- [ ] Create `packages/backend/src/handlers/orders/index.ts` — Router for orders endpoints
- [ ] Create `packages/backend/src/handlers/orders/checkout.ts` — Read cart, create order + items, clear cart
- [ ] Create `packages/backend/src/handlers/orders/list-orders.ts` — Query orders by userId
- [ ] Create `packages/backend/src/handlers/orders/get-order.ts` — Get order with items

### Step 8: Frontend — Project Setup & Configuration
- [ ] Create `packages/frontend/package.json` with React, Vite, Tailwind, shadcn/ui deps
- [ ] Create `packages/frontend/vite.config.ts`
- [ ] Create `packages/frontend/tsconfig.json`
- [ ] Create `packages/frontend/tailwind.config.ts` — with shadcn/ui preset and dark mode
- [ ] Create `packages/frontend/postcss.config.js`
- [ ] Create `packages/frontend/index.html`
- [ ] Create `packages/frontend/src/styles/globals.css` — Tailwind directives + shadcn/ui theme variables
- [ ] Create `packages/frontend/components.json` — shadcn/ui configuration

### Step 9: Frontend — shadcn/ui Base Components
- [ ] Create `packages/frontend/src/components/ui/button.tsx`
- [ ] Create `packages/frontend/src/components/ui/card.tsx`
- [ ] Create `packages/frontend/src/components/ui/input.tsx`
- [ ] Create `packages/frontend/src/components/ui/label.tsx`
- [ ] Create `packages/frontend/src/components/ui/select.tsx`
- [ ] Create `packages/frontend/src/components/ui/table.tsx`
- [ ] Create `packages/frontend/src/components/ui/dialog.tsx`
- [ ] Create `packages/frontend/src/components/ui/alert-dialog.tsx`
- [ ] Create `packages/frontend/src/components/ui/toast.tsx` and `toaster.tsx`
- [ ] Create `packages/frontend/src/components/ui/skeleton.tsx`
- [ ] Create `packages/frontend/src/components/ui/alert.tsx`
- [ ] Create `packages/frontend/src/components/ui/dropdown-menu.tsx`
- [ ] Create `packages/frontend/src/components/ui/badge.tsx`
- [ ] Create `packages/frontend/src/components/ui/separator.tsx`
- [ ] Create `packages/frontend/src/lib/utils.ts` — cn() utility function

### Step 10: Frontend — Layout Components
- [ ] Create `packages/frontend/src/components/layout/theme-provider.tsx` — Dark/light mode context
- [ ] Create `packages/frontend/src/components/layout/navbar.tsx` — Navigation bar with logo, search, cart badge, user menu
- [ ] Create `packages/frontend/src/components/layout/footer.tsx`
- [ ] Create `packages/frontend/src/components/layout/layout.tsx` — Main layout wrapper

### Step 11: Frontend — Context Providers
- [ ] Create `packages/frontend/src/contexts/auth-context.tsx` — AuthContext with login, signup, logout, forgotPassword
- [ ] Create `packages/frontend/src/contexts/cart-context.tsx` — CartContext with addToCart, updateQuantity, removeItem, clearCart, checkout
- [ ] Create `packages/frontend/src/lib/api.ts` — API client (fetch wrapper with auth token injection)

### Step 12: Frontend — Pages
- [ ] Create `packages/frontend/src/pages/home.tsx` — Hero section + featured books
- [ ] Create `packages/frontend/src/pages/books.tsx` — Book catalog with search, filter, grid
- [ ] Create `packages/frontend/src/pages/book-detail.tsx` — Full book info + add to cart
- [ ] Create `packages/frontend/src/pages/login.tsx` — Login form card
- [ ] Create `packages/frontend/src/pages/signup.tsx` — Signup form card
- [ ] Create `packages/frontend/src/pages/cart.tsx` — Cart items table + checkout
- [ ] Create `packages/frontend/src/pages/orders.tsx` — Order history + order detail view

### Step 13: Frontend — App Shell & Routing
- [ ] Create `packages/frontend/src/App.tsx` — Routes, providers, Toaster
- [ ] Create `packages/frontend/src/main.tsx` — Entry point (render App)
- [ ] Create `packages/frontend/src/components/books/book-card.tsx` — Book card component
- [ ] Create `packages/frontend/src/components/books/book-grid.tsx` — Responsive grid

### Step 14: Infrastructure — CDK Stack
- [ ] Create `packages/infrastructure/package.json` with CDK deps
- [ ] Create `packages/infrastructure/tsconfig.json`
- [ ] Create `packages/infrastructure/cdk.json`
- [ ] Create `packages/infrastructure/bin/app.ts` — CDK app entry point
- [ ] Create `packages/infrastructure/lib/anycompanyread-stack.ts` — Main stack (Cognito, API GW, Lambda, DynamoDB, S3, CloudFront)

### Step 15: Seed Data & Documentation
- [ ] Create `scripts/seed-data.ts` — Populate DynamoDB Books table with 20+ sample books
- [ ] Create `README.md` — Setup instructions, architecture overview, project structure

### Step 16: Code Summary Documentation
- [ ] Create `aidlc-docs/construction/anycompanyread/code/code-generation-summary.md` — Summary of all generated files

---

## Story Traceability

| Step | Requirements Covered |
|------|---------------------|
| Steps 1-2 | Foundation for all FRs |
| Step 3 | Foundation for FR-1 through FR-3 |
| Step 4 | FR-1.1, FR-1.2, FR-1.3, FR-1.4, FR-1.5 |
| Step 5 | FR-2.1, FR-2.2, FR-2.3, FR-2.4, FR-2.5 |
| Step 6 | FR-3.1, FR-3.2, FR-3.3, FR-3.4, FR-3.5 |
| Step 7 | FR-3.6, FR-3.7, FR-3.8, FR-3.9, FR-3.10 |
| Steps 8-9 | FR-4 (foundation), NFR-3 |
| Step 10 | FR-4.1, FR-4.2, FR-4.4 |
| Step 11 | FR-1.3, FR-3.1, FR-3.5 |
| Step 12 | FR-2.2 through FR-2.5, FR-3.2 through FR-3.10, FR-4.3, FR-4.5, FR-4.6, FR-4.7 |
| Step 13 | FR-4.1, FR-4.4 |
| Step 14 | NFR-2, NFR-5, NFR-6 |
| Step 15 | FR-2.6, NFR-2 |
| Step 16 | Documentation |

---

## Key Technical Decisions

1. **Vite** for frontend bundling (fast, modern, TypeScript-native)
2. **shadcn/ui components** copied into project (not installed as dependency) — per shadcn/ui copy-paste model
3. **AWS SDK v3** for all Lambda AWS service calls (modular imports)
4. **Single Lambda per resource group** with internal routing (4 functions total)
5. **DynamoDB on-demand** capacity for cost optimization
6. **CloudFront + S3** for frontend hosting and book cover images
7. **React Context API** for state management (no Redux — demo simplicity)
8. **npm workspaces** for monorepo dependency management

## Estimated Scope
- **Total Steps**: 16
- **Total Files**: ~70-80 files
- **Languages**: TypeScript (100%)
- **Packages**: 4 (shared, backend, frontend, infrastructure)
