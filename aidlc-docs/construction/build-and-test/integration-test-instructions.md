# Integration Test Instructions — AnyCompanyRead

## Purpose

Test the full request flow from API Gateway through Lambda handlers to DynamoDB, verifying that deployed services work together correctly.

## Prerequisites

- Application deployed via `cdk deploy`
- Database seeded via `npx ts-node scripts/seed-data.ts`
- API Gateway URL available (from CDK outputs)

## Setup

### 1. Set Environment Variables

```bash
export API_URL="https://<api-gateway-id>.execute-api.<region>.amazonaws.com/prod"
```

### 2. Install Test Tool

Use `curl`, `httpie`, or a REST client. Examples below use `curl`.

## Integration Test Scenarios

### Scenario 1: User Registration and Login Flow

```bash
# 1. Register a new user
curl -X POST "$API_URL/auth/signup" \
  -H "Content-Type: application/json" \
  -d '{"email":"testuser@example.com","password":"TestPass123","name":"Test User"}'
# Expected: 201 {"message": "User registered successfully"}

# 2. Login with the registered user
curl -X POST "$API_URL/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"testuser@example.com","password":"TestPass123"}'
# Expected: 200 {"idToken":"...","accessToken":"...","refreshToken":"..."}

# Save the idToken for authenticated requests
export TOKEN="<idToken from response>"
```

### Scenario 2: Browse Books

```bash
# 1. List all books (public, no auth required)
curl "$API_URL/books"
# Expected: 200 {"books":[...],"totalCount":20,"nextToken":null}

# 2. Search by title
curl "$API_URL/books?search=hobbit"
# Expected: 200 with books matching "hobbit"

# 3. Filter by genre
curl "$API_URL/books?genre=Science%20Fiction"
# Expected: 200 with only Science Fiction books

# 4. Get book detail
export BOOK_ID="<bookId from list response>"
curl "$API_URL/books/$BOOK_ID"
# Expected: 200 {"book":{...full book details...}}
```

### Scenario 3: Shopping Cart Flow

```bash
# 1. Add item to cart (requires auth)
curl -X POST "$API_URL/cart" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"bookId\":\"$BOOK_ID\",\"quantity\":2}"
# Expected: 201 {"item":{...cart item with denormalized book data...}}

# 2. Get cart
curl "$API_URL/cart" -H "Authorization: Bearer $TOKEN"
# Expected: 200 {"items":[...],"totalPrice":...,"itemCount":2}

# 3. Update quantity
curl -X PUT "$API_URL/cart/$BOOK_ID" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"quantity":3}'
# Expected: 200 {"item":{...updated item...}}

# 4. Remove item
curl -X DELETE "$API_URL/cart/$BOOK_ID" \
  -H "Authorization: Bearer $TOKEN"
# Expected: 200 {"message":"Item removed from cart"}
```

### Scenario 4: Checkout and Orders Flow

```bash
# 1. Add items to cart first
curl -X POST "$API_URL/cart" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"bookId\":\"$BOOK_ID\",\"quantity\":1}"

# 2. Checkout
curl -X POST "$API_URL/checkout" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN"
# Expected: 201 {"order":{"orderId":"...","status":"CONFIRMED","items":[...]}}

# 3. Verify cart is cleared
curl "$API_URL/cart" -H "Authorization: Bearer $TOKEN"
# Expected: 200 {"items":[],"totalPrice":0,"itemCount":0}

# 4. List orders
curl "$API_URL/orders" -H "Authorization: Bearer $TOKEN"
# Expected: 200 {"orders":[{...order with CONFIRMED status...}]}

# 5. Get order detail
export ORDER_ID="<orderId from checkout response>"
curl "$API_URL/orders/$ORDER_ID" -H "Authorization: Bearer $TOKEN"
# Expected: 200 {"order":{...order with items...}}
```

### Scenario 5: Error Handling

```bash
# 1. Unauthenticated access to protected route
curl "$API_URL/cart"
# Expected: 401 Unauthorized

# 2. Non-existent book
curl "$API_URL/books/nonexistent-id"
# Expected: 404 {"error":"NOT_FOUND","message":"Book with id 'nonexistent-id' not found"}

# 3. Checkout with empty cart
curl -X POST "$API_URL/checkout" \
  -H "Authorization: Bearer $TOKEN"
# Expected: 400 {"error":"BAD_REQUEST","message":"Cart is empty..."}

# 4. Invalid login credentials
curl -X POST "$API_URL/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"wrong@example.com","password":"WrongPass123"}'
# Expected: 401 {"error":"UNAUTHORIZED","message":"Invalid credentials"}
```

## Verification Checklist

- [ ] User can register and login
- [ ] Books are listed from seeded data
- [ ] Book search and genre filter work
- [ ] Cart operations (add, get, update, remove) work
- [ ] Checkout creates order and clears cart
- [ ] Orders are listed and detail is accessible
- [ ] Protected routes reject unauthenticated requests
- [ ] Error responses have correct status codes and format

## Cleanup

```bash
# Remove test user (optional)
aws cognito-idp admin-delete-user \
  --user-pool-id <UserPoolId> \
  --username testuser@example.com
```
