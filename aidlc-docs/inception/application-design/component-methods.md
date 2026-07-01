# Component Methods

## AuthHandler

| Method | Input | Output | Purpose |
|--------|-------|--------|---------|
| signup | { email, password, name } | { message } | Register user in Cognito |
| login | { email, password } | { idToken, accessToken, refreshToken } | Authenticate and return tokens |
| forgotPassword | { email } | { message } | Initiate password reset flow |
| confirmForgotPassword | { email, code, newPassword } | { message } | Complete password reset |

## BooksHandler

| Method | Input | Output | Purpose |
|--------|-------|--------|---------|
| listBooks | queryParams: { search?, genre?, page?, limit? } | { books[], totalCount, nextToken? } | List/search/filter books |
| getBook | pathParam: bookId | { book } | Get single book details |

## CartHandler

| Method | Input | Output | Purpose |
|--------|-------|--------|---------|
| getCart | userId (from JWT) | { items[], totalPrice } | Get user's cart |
| addToCart | userId, { bookId, quantity } | { item } | Add book to cart |
| updateCartItem | userId, bookId, { quantity } | { item } | Update item quantity |
| removeFromCart | userId, bookId | { message } | Remove item from cart |

## OrdersHandler

| Method | Input | Output | Purpose |
|--------|-------|--------|---------|
| checkout | userId (from JWT) | { order } | Create order from cart, clear cart |
| listOrders | userId (from JWT) | { orders[] } | List user's order history |
| getOrder | userId, orderId | { order, items[] } | Get order details |

## Frontend — React Context Providers

| Context | State | Methods | Purpose |
|---------|-------|---------|---------|
| AuthContext | user, isAuthenticated, loading | login, signup, logout, forgotPassword | Auth state management |
| CartContext | items, totalPrice, itemCount | addToCart, updateQuantity, removeItem, clearCart, checkout | Cart state management |

## Frontend — Pages

| Page | Route | Auth Required | Key Components |
|------|-------|---------------|----------------|
| Home | / | No | Hero section, featured books grid |
| Books | /books | No | Search bar, genre filter, book card grid |
| Book Detail | /books/:bookId | No | Book info card, add-to-cart button |
| Login | /login | No | Login form card |
| Signup | /signup | No | Signup form card |
| Cart | /cart | Yes | Cart items table, checkout button |
| Orders | /orders | Yes | Orders list table |

## Shared — Types

| Type | Fields | Used By |
|------|--------|---------|
| Book | bookId, title, author, isbn, genre, description, price, coverImageUrl, rating, pageCount, publishedYear | BooksHandler, Frontend |
| CartItem | userId, bookId, quantity, book (denormalized title, price, coverImageUrl) | CartHandler, Frontend |
| Order | userId, orderId, totalPrice, status, createdAt | OrdersHandler, Frontend |
| OrderItem | orderId, bookId, quantity, price, title | OrdersHandler, Frontend |
