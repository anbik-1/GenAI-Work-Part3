# AnyCompanyRead - Requirements Document

## Intent Analysis

- **User Request**: Implement the AnyCompanyRead online book e-commerce platform as a demo/learning application with a polished, visually appealing frontend
- **Request Type**: New Project (Greenfield)
- **Scope Estimate**: Moderate — 3 core feature areas (Auth + Book Catalog + Cart & Checkout) with focus on frontend quality
- **Complexity Estimate**: Moderate — AWS serverless architecture with modern frontend stack
- **Priority**: Visual polish and frontend quality over feature breadth; simplicity and clarity for demo purposes
- **Purpose**: Learning/training tool for developers with an impressive demo frontend

## Technology Decisions

- **Architecture**: AWS Serverless (API Gateway + Lambda + DynamoDB)
- **Language**: TypeScript (frontend and backend)
- **Frontend**: React with TypeScript, shadcn/ui component library (built on Radix UI primitives), Tailwind CSS for styling
- **Backend**: AWS Lambda functions in TypeScript
- **Database**: Amazon DynamoDB (all data)
- **Authentication**: Amazon Cognito (email/password signup and login)
- **Infrastructure**: AWS CDK in TypeScript
- **Repository Structure**: Monorepo
- **Deployment**: Real AWS services via CDK

### Frontend Stack Details

| Library | Purpose |
|---------|---------|
| React 18+ | UI framework |
| TypeScript | Type safety |
| shadcn/ui | Pre-built, beautiful UI components (buttons, cards, dialogs, forms, tables, navigation) |
| Radix UI | Accessible headless primitives (underlying shadcn/ui) |
| Tailwind CSS | Utility-first styling, theming, dark mode |
| Lucide React | Modern icon set (pairs with shadcn/ui) |
| React Router | Client-side routing |

### Why shadcn/ui?
- Modern, clean design out of the box — looks polished with zero custom CSS
- Copy-paste model: components live in your codebase, fully customizable
- Built on Radix UI primitives (excellent accessibility, WAI-ARIA compliant)
- Tailwind CSS integration for consistent theming and dark mode support
- Free and open source
- Large ecosystem of pre-built components (cards, tables, forms, dialogs, navigation, etc.)

## Functional Requirements

### FR-1: User Authentication & Identity Management

**FR-1.1**: Users can register with email and password via Amazon Cognito user pool. Registration form uses shadcn/ui form components with inline validation.

**FR-1.2**: Users can log in with email and password and receive JWT tokens. Login page features a clean, centered card layout.

**FR-1.3**: Users can log out, invalidating their session.

**FR-1.4**: Authenticated API endpoints validate Cognito JWT tokens via API Gateway authorizer.

**FR-1.5**: User profile stores basic information (name, email) in Cognito user attributes.

### FR-2: Book Catalog & Product Discovery

**FR-2.1**: The system maintains a book catalog in DynamoDB with fields: bookId, title, author, ISBN, genre, description, price, coverImageUrl, rating, pageCount, publishedYear, createdAt.

**FR-2.2**: Users can browse the catalog with a responsive grid layout using shadcn/ui Card components. Cards display cover image, title, author, price, and rating.

**FR-2.3**: Users can search books by title or author using a prominent search bar with shadcn/ui Input component.

**FR-2.4**: Users can filter books by genre using shadcn/ui Select/DropdownMenu components.

**FR-2.5**: Users can view a book detail page with full metadata displayed in a polished layout with cover image, description, and book details in a structured card.

**FR-2.6**: The system provides a seed data mechanism to populate the catalog with sample books (including realistic cover image URLs) for demo purposes.

**FR-2.7**: Book cover images are stored in S3 and served via CloudFront.

### FR-3: Shopping Cart & Checkout

**FR-3.1**: Authenticated users can add books to their shopping cart. Add-to-cart button on book cards and detail page with toast confirmation.

**FR-3.2**: Users can view their cart with item details and total price, displayed using shadcn/ui Table and Card components.

**FR-3.3**: Users can update item quantities in the cart using shadcn/ui number input controls.

**FR-3.4**: Users can remove items from the cart with confirmation dialog (shadcn/ui AlertDialog).

**FR-3.5**: Cart data is persisted in DynamoDB (associated with userId).

**FR-3.6**: Users can proceed to checkout, which creates an order from the cart contents.

**FR-3.7**: Checkout simulates order placement (no real payment processing) — order is created with status "CONFIRMED" immediately.

**FR-3.8**: After successful checkout, the cart is cleared and a success toast is shown.

**FR-3.9**: Users can view their order history (list of past orders with status) using shadcn/ui Table component.

**FR-3.10**: Users can view order details (items, total, date, status) in a structured card layout.

### FR-4: Frontend Experience & Polish

**FR-4.1**: The application has a responsive navigation bar with logo, search, cart icon with item count badge, and user menu (login/signup or profile dropdown when authenticated).

**FR-4.2**: The application supports light and dark mode toggle using Tailwind CSS dark mode and shadcn/ui theming.

**FR-4.3**: The home page features a hero section with a featured books carousel or highlight area.

**FR-4.4**: All pages are fully responsive (mobile, tablet, desktop) using Tailwind CSS responsive utilities.

**FR-4.5**: Loading states use shadcn/ui Skeleton components for a polished loading experience.

**FR-4.6**: Error states display user-friendly messages using shadcn/ui Alert components.

**FR-4.7**: Toast notifications (shadcn/ui Sonner/Toast) for user actions (login success, add to cart, checkout, errors, etc.).

## Non-Functional Requirements

### NFR-1: Simplicity
- Code should be clear, well-commented, and easy to understand for learning purposes.
- Prefer straightforward implementations over optimized/complex patterns.
- Minimize the number of AWS services to what's essential.
- Reduced feature scope to keep codebase manageable.

### NFR-2: Developer Experience
- Single `cdk deploy` command to provision all infrastructure.
- Seed data script to populate the catalog for immediate demo use.
- Clear README with setup instructions, architecture overview, and learning notes.

### NFR-3: Frontend Quality
- Consistent visual design using shadcn/ui theming system.
- Dark mode support throughout the application.
- Responsive design that looks good on all screen sizes.
- Smooth transitions and loading states.
- Accessible components (Radix UI primitives ensure WAI-ARIA compliance).

### NFR-4: Performance (Demo-Grade)
- API response time: < 1 second (acceptable for demo).
- Page load: reasonable for demo purposes (no aggressive optimization).

### NFR-5: Security (Basic)
- Cognito-based authentication with JWT validation.
- API Gateway authorizer for protected endpoints.
- No sensitive data stored in code (use environment variables / CDK context).
- CORS configured for frontend-backend communication.

### NFR-6: Cost Optimization
- Use DynamoDB on-demand capacity (pay-per-request) to minimize costs.
- Lambda functions with minimal memory allocation.
- S3 for static assets with CloudFront.
- Designed to stay within or near AWS Free Tier where possible.

## Out of Scope (Explicitly Excluded)

- Order management / fulfillment workflows
- Payment processing (simulated only)
- E-book / audiobook digital content delivery
- Community features (reviews, book clubs, events)
- Subscription / loyalty programs
- Mobile applications
- Advanced search (OpenSearch)
- AI-powered recommendations (Personalize)
- Multi-region deployment
- CI/CD pipeline
- Monitoring / alerting setup

## AWS Services Summary

| Service | Purpose |
|---------|---------|
| Amazon Cognito | User authentication (email/password) |
| Amazon API Gateway | REST API endpoints |
| AWS Lambda | Backend business logic (TypeScript) |
| Amazon DynamoDB | All data storage (books, carts, orders) |
| Amazon S3 | Book cover images, React frontend hosting |
| Amazon CloudFront | CDN for frontend and images |
| AWS CDK | Infrastructure as Code |

## DynamoDB Table Design (High-Level)

| Table | Partition Key | Sort Key | Purpose |
|-------|--------------|----------|---------|
| Books | bookId | — | Book catalog |
| Carts | userId | bookId | Shopping cart items |
| Orders | userId | orderId | Order records |
| OrderItems | orderId | bookId | Items within an order |

## API Endpoints (High-Level)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /auth/signup | No | Register new user |
| POST | /auth/login | No | User login |
| POST | /auth/forgot-password | No | Initiate password reset |
| POST | /auth/confirm-forgot-password | No | Confirm password reset |
| GET | /books | No | List/search books |
| GET | /books/{bookId} | No | Get book details |
| GET | /cart | Yes | Get user's cart |
| POST | /cart | Yes | Add item to cart |
| PUT | /cart/{bookId} | Yes | Update cart item quantity |
| DELETE | /cart/{bookId} | Yes | Remove item from cart |
| POST | /checkout | Yes | Place order from cart |
| GET | /orders | Yes | List user's orders |
| GET | /orders/{orderId} | Yes | Get order details |
