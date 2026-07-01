# Unit Test Instructions — AnyCompanyRead

## Test Framework Setup

This project is a demo application. Unit tests are recommended but not generated during code generation to keep the scope manageable.

**Recommended test stack:**
- **Test Runner**: Vitest (for both frontend and backend — fast, TypeScript-native, Vite-compatible)
- **Mocking**: Vitest built-in mocking (`vi.mock`)
- **Frontend Testing**: React Testing Library + jsdom
- **Coverage**: Vitest built-in coverage (c8/istanbul)

## Setting Up Tests

### 1. Install Test Dependencies

```bash
# From root
npm install -D vitest @testing-library/react @testing-library/jest-dom jsdom @types/jest --workspace=packages/frontend
npm install -D vitest --workspace=packages/backend
```

### 2. Add Vitest Config

Create `packages/backend/vitest.config.ts`:
```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
  },
});
```

Create `packages/frontend/vitest.config.ts`:
```typescript
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
  },
});
```

### 3. Add Test Scripts

In root `package.json`:
```json
"scripts": {
  "test": "npm run test --workspaces",
  "test:backend": "npm run test -w packages/backend",
  "test:frontend": "npm run test -w packages/frontend"
}
```

## Recommended Test Cases

### Backend — Auth Handler
| Test Case | Description |
|-----------|-------------|
| signup - success | Valid email/password creates user |
| signup - missing fields | Returns 400 for missing email/password/name |
| signup - duplicate email | Returns 409 for existing user |
| login - success | Valid credentials return JWT tokens |
| login - invalid credentials | Returns 401 |
| login - missing fields | Returns 400 |

### Backend — Books Handler
| Test Case | Description |
|-----------|-------------|
| listBooks - returns books | Returns array of books |
| listBooks - genre filter | Filters by genre correctly |
| listBooks - pagination | Returns nextToken when more results exist |
| getBook - found | Returns book for valid bookId |
| getBook - not found | Returns 404 for invalid bookId |

### Backend — Cart Handler
| Test Case | Description |
|-----------|-------------|
| getCart - empty | Returns empty cart for new user |
| getCart - with items | Returns items with totals |
| addToCart - new item | Adds item with book denormalization |
| addToCart - existing item | Increases quantity |
| addToCart - invalid book | Returns 404 |
| updateCartItem - valid | Updates quantity |
| updateCartItem - invalid quantity | Returns 400 for quantity < 1 |
| removeFromCart - success | Removes item |

### Backend — Orders Handler
| Test Case | Description |
|-----------|-------------|
| checkout - success | Creates order, clears cart |
| checkout - empty cart | Returns 400 |
| listOrders - returns orders | Returns user's orders |
| getOrder - found | Returns order with items |
| getOrder - not found | Returns 404 |

### Frontend — Components
| Test Case | Description |
|-----------|-------------|
| BookCard - renders | Displays title, author, price, rating |
| Navbar - unauthenticated | Shows login/signup buttons |
| Navbar - authenticated | Shows cart icon, user menu |
| LoginPage - validation | Shows error on empty submit |
| CartPage - empty state | Shows empty cart message |

## Running Tests

```bash
# Run all tests
npm test

# Run with coverage
npx vitest run --coverage

# Run in watch mode
npx vitest
```

## Expected Results

For a demo application, aim for:
- **Backend handler coverage**: 70-80% (focus on business logic)
- **Frontend component coverage**: 50-60% (focus on key interactions)
- **All tests passing**: 0 failures
