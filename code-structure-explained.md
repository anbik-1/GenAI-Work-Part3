# code-structure-explained.md

A personal reference explaining how the AnyCompanyRead codebase is structured,
why each piece lives where it does, and how a request flows from browser to database.

---

## 1. Was ECS / Fargate Ever the Plan?

No. **Lambda was the choice from day one**, locked in during the Requirements Analysis
phase. The requirement document states explicitly:

> `Architecture: AWS Serverless (API Gateway + Lambda + DynamoDB)`

ECS/Fargate was never considered for this project. The reasoning (from `biku.md`):
- Demo app with near-zero / spiky traffic → Lambda scales to zero, costs nothing idle
- Small team, fast build → no container images to manage
- Simplicity NFR → fewest moving parts wins

ECS would make sense if traffic were steady and high-volume, or if we needed long-running
processes or WebSocket connections. Neither applied here.

---

## 2. The Monorepo — One Repo, Four Packages

```
anycompanyread/               ← root (npm workspaces)
├── packages/shared/          ← shared types & constants
├── packages/backend/         ← all Lambda handlers (the API)
├── packages/frontend/        ← React SPA (the UI)
└── packages/infrastructure/  ← AWS CDK stack (the AWS wiring)
```

Each package has **one job** and imports only what it needs.
Build order is fixed: `shared` → `backend` → `frontend` → `infrastructure`
(each depends on the one before it).

---

## 3. packages/shared — The Contract

```
packages/shared/src/
├── types/
│   ├── book.ts      ← Book, BookSummary
│   ├── cart.ts      ← CartItem, Cart
│   ├── order.ts     ← Order, OrderItem, OrderDetail
│   ├── auth.ts      ← LoginRequest, SignupRequest, LoginResponse, etc.
│   └── api.ts       ← ListBooksResponse, AddToCartRequest, etc.
├── constants.ts     ← TABLE_NAMES, API_PATHS, GENRES
└── index.ts         ← barrel export (re-exports everything above)
```

**Why it exists:** Both the backend (Lambda) and the frontend (React) import from here.
If you rename a field on the `Book` type, TypeScript breaks in *both* places at compile
time. This is the single source of truth for all data shapes — it prevents backend and
frontend from drifting out of sync silently.

```typescript
// Backend (Lambda) uses it
import { Book, TABLE_NAMES } from '@anycompanyread/shared';

// Frontend (React) uses the same types
import { Book, CartItem } from '@anycompanyread/shared';
```

---

## 4. packages/backend — One Folder Per Resource

The backend is **4 Lambda functions**, each responsible for one resource domain.
Inside each function, there is one file per operation.

```
packages/backend/src/
│
├── handlers/
│   │
│   ├── auth/                          ← FR-1: Authentication (talks to Cognito)
│   │   ├── index.ts                   ← Lambda entry point + router
│   │   ├── signup.ts                  ← POST /auth/signup
│   │   ├── login.ts                   ← POST /auth/login
│   │   ├── forgot-password.ts         ← POST /auth/forgot-password
│   │   └── confirm-forgot-password.ts ← POST /auth/confirm-forgot-password
│   │
│   ├── books/                         ← FR-2: Book Catalog (reads DynamoDB Books)
│   │   ├── index.ts                   ← Lambda entry point + router
│   │   ├── list-books.ts              ← GET /books (search, genre filter, pagination)
│   │   └── get-book.ts                ← GET /books/{bookId}
│   │
│   ├── cart/                          ← FR-3a: Shopping Cart (reads/writes DynamoDB Carts)
│   │   ├── index.ts                   ← Lambda entry point + router
│   │   ├── get-cart.ts                ← GET /cart
│   │   ├── add-to-cart.ts             ← POST /cart
│   │   ├── update-cart-item.ts        ← PUT /cart/{bookId}
│   │   └── remove-from-cart.ts        ← DELETE /cart/{bookId}
│   │
│   └── orders/                        ← FR-3b: Checkout & Orders (reads/writes Orders)
│       ├── index.ts                   ← Lambda entry point + router
│       ├── checkout.ts                ← POST /checkout
│       ├── list-orders.ts             ← GET /orders
│       └── get-order.ts               ← GET /orders/{orderId}
│
└── utils/                             ← Shared utilities (zero business logic)
    ├── dynamodb.ts    ← Single shared DynamoDB Document Client instance
    ├── response.ts    ← success(), error(), badRequest(), notFound(), unauthorized()
    ├── auth.ts        ← getUserId() — extracts userId from Cognito JWT claims
    └── error.ts       ← handleError() — maps AWS SDK errors to HTTP status codes
```

### The Pattern Inside Every Handler Folder

**`index.ts` is always the router:**
```typescript
// cart/index.ts — Lambda entry point
export async function handler(event) {
  const userId = getUserId(event);        // extract from JWT
  if (!userId) return unauthorized();

  switch (event.httpMethod) {
    case 'GET':    return await getCart(userId);
    case 'POST':   return await addToCart(event, userId);
    case 'PUT':    return await updateCartItem(event, userId, bookId);
    case 'DELETE': return await removeFromCart(userId, bookId);
  }
}
```

**Each operation file does exactly one thing:**
```typescript
// cart/add-to-cart.ts — one file, one responsibility
export async function addToCart(event, userId) {
  // 1. Parse and validate input
  // 2. Look up the book (for denormalized data)
  // 3. Write to DynamoDB Carts table
  // 4. Return 201 with the cart item
}
```

**Why one file per operation?**
- "I need to fix checkout" → open `orders/checkout.ts` — done, no searching
- Each file is understandable in isolation, no scrolling through 500 lines
- Easy to test each operation independently
- New team member can read one file and understand one feature completely

---

## 5. packages/frontend — Mirrors the Backend Domains

```
packages/frontend/src/
│
├── pages/                   ← One file per route (one page = one user goal)
│   ├── home.tsx             ← /            (hero + featured books)
│   ├── books.tsx            ← /books       (catalog with search + genre filter)
│   ├── book-detail.tsx      ← /books/:id   (full book info + add to cart)
│   ├── login.tsx            ← /login       (login form)
│   ├── signup.tsx           ← /signup      (signup form)
│   ├── cart.tsx             ← /cart        (cart table + checkout)
│   └── orders.tsx           ← /orders      (order history + detail dialog)
│
├── contexts/                ← Global state — shared across all pages
│   ├── auth-context.tsx     ← isAuthenticated, user, login(), signup(), logout()
│   └── cart-context.tsx     ← items, totalPrice, itemCount, addToCart(), checkout()
│
├── components/
│   ├── ui/                  ← shadcn/ui base components (button, card, input, etc.)
│   │                           These are copied into the project — fully owned/customizable
│   ├── layout/              ← Navbar, Footer, Layout wrapper, ThemeProvider (dark mode)
│   └── books/               ← BookCard, BookGrid — reusable book-display components
│
├── lib/
│   ├── api.ts               ← HTTP client (fetch + auto auth token injection)
│   └── utils.ts             ← cn() — merges Tailwind classes safely
│
├── App.tsx                  ← All routes defined + all providers wrapped
├── main.tsx                 ← Entry point (renders <App />)
└── styles/globals.css       ← Tailwind directives + shadcn/ui CSS variable theme
```

### How State Is Managed

**Two React Contexts, two responsibilities:**

| Context | Owns | Used by |
|---------|------|---------|
| `AuthContext` | Login state, JWT token, user email | Navbar (show login/logout), any page needing auth |
| `CartContext` | Cart items, total price, item count | Navbar (badge), Cart page, Book Detail (add button) |

Data from the API (books list, order history) is **local state** inside each page
component — it doesn't need to be global because only one page uses it at a time.

### The Provider Hierarchy in App.tsx

```
ThemeProvider          ← dark/light mode (outermost — affects everything)
  BrowserRouter        ← client-side routing
    AuthProvider       ← auth state
      CartProvider     ← cart state (needs auth to know when to fetch)
        Layout         ← Navbar + Footer wrapper
          Routes       ← individual pages rendered here
        Toaster        ← toast notifications (global overlay)
```

Order matters: `CartProvider` is inside `AuthProvider` because the cart context
checks `isAuthenticated` to decide when to fetch cart data.

---

## 6. packages/infrastructure — The AWS Wiring

```
packages/infrastructure/
├── bin/app.ts                    ← CDK entry point (creates the stack)
└── lib/anycompanyread-stack.ts   ← ALL AWS resources defined here
```

The stack file defines every resource in this order:
1. **Cognito** — User Pool + Client
2. **DynamoDB** — 4 tables (Books, Carts, Orders, OrderItems)
3. **S3** — 2 buckets (frontend hosting + images)
4. **CloudFront** — CDN distribution pointing at S3 buckets
5. **Lambda** — 4 NodejsFunction (esbuild bundles each handler automatically)
6. **IAM grants** — gives each Lambda only the permissions it needs
7. **API Gateway** — REST API with 13 routes wired to the correct Lambda
8. **Cognito authorizer** — attached to authenticated routes
9. **CloudFormation Outputs** — prints the URLs and IDs after deploy

CDK handles all the wiring automatically. When you write:
```typescript
booksTable.grantReadData(booksFunction);
```
CDK creates the exact IAM policy that allows *only* the Books Lambda to read *only*
the Books table — least-privilege by default, zero manual IAM work.

---

## 7. End-to-End Request Flow — "Add Book to Cart"

This traces a single user action from browser click to database write and back.

```
Step 1: User clicks "Add to Cart" on BookDetail page (book-detail.tsx)

Step 2: CartContext.addToCart(bookId) is called
        → api.ts sends: POST https://<api-gateway>/prod/cart
          Headers: { Authorization: "Bearer <idToken>" }
          Body:    { bookId: "abc-123", quantity: 1 }

Step 3: API Gateway receives the request
        → Cognito Authorizer validates the JWT token
        → Extracts userId (sub claim) from the token
        → Passes userId in the request context to Lambda

Step 4: AnyCompanyRead-Cart Lambda wakes up (cold start ~200ms, warm ~5ms)
        cart/index.ts runs:
        → getUserId(event) → "3418d418-..."
        → method = POST → calls addToCart(event, userId)

Step 5: cart/add-to-cart.ts runs:
        a. Parse body: { bookId: "abc-123", quantity: 1 }
        b. Validate: bookId present, quantity >= 1
        c. GetCommand → Books table → fetch book (title, price, coverImageUrl)
        d. GetCommand → Carts table → check if item already exists
        e. PutCommand → Carts table → write:
           { userId, bookId, quantity, title, price, coverImageUrl }
        f. Return HTTP 201: { item: { ...cartItem } }

Step 6: API Gateway returns the 201 response to the browser

Step 7: CartContext refreshes:
        → GET /cart → fetches updated items + new totalPrice + itemCount

Step 8: Navbar badge updates (shows new item count)
        Toast notification appears: "Added to cart!"
```

The same pattern applies to every feature:
- "List books" → Books Lambda → Scan DynamoDB Books table
- "Checkout" → Orders Lambda → read cart → write order → write order items → clear cart
- "Login" → Auth Lambda → Cognito AdminInitiateAuth → return JWT tokens

---

## 8. Naming Conventions Used Throughout

| Convention | Example | Why |
|------------|---------|-----|
| kebab-case files | `add-to-cart.ts` | Standard Node.js / React convention |
| camelCase functions | `addToCart()` | TypeScript standard |
| PascalCase components | `BookCard`, `CartPage` | React component convention |
| PascalCase types | `Book`, `CartItem`, `Order` | TypeScript type convention |
| SCREAMING_SNAKE constants | `TABLE_NAMES.BOOKS` | Distinguishes constants from variables |
| `index.ts` as entry point | `handlers/cart/index.ts` | Clean imports: `from './cart'` not `from './cart/index'` |

---

## 9. Design Principles Applied

**1. One responsibility per file**
Each file does one thing. `checkout.ts` only handles checkout. `get-cart.ts` only fetches
the cart. No file does two unrelated things.

**2. Shared code in dedicated packages**
Types → `shared/`. DynamoDB client → `utils/dynamodb.ts`. Response helpers →
`utils/response.ts`. Nothing is duplicated across handlers.

**3. No hardcoded values**
Table names → environment variables (set by CDK at deploy time).
API URL → `.env` file (set before build).
No `us-east-1` or account IDs in source code.

**4. Layers are kept separate**
- `shared/` knows nothing about AWS
- `backend/` knows nothing about React
- `frontend/` knows nothing about DynamoDB
- `infrastructure/` knows nothing about business logic — it only wires services together

**5. Denormalization for read efficiency**
When a book is added to the cart, the cart item stores `title`, `price`, and
`coverImageUrl` directly (copied from the Books table). This means the Cart page
never needs to join across two tables — it reads one DynamoDB table and has
everything it needs to display. This is the DynamoDB way: optimize for reads by
duplicating data at write time.

---

*Last updated: 2026-07-01 | Project: AnyCompanyRead*
