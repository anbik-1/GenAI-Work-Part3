/** DynamoDB table names — set via environment variables in Lambda */
export const TABLE_NAMES = {
  BOOKS: process.env.BOOKS_TABLE_NAME || 'AnyCompanyRead-Books',
  CARTS: process.env.CARTS_TABLE_NAME || 'AnyCompanyRead-Carts',
  ORDERS: process.env.ORDERS_TABLE_NAME || 'AnyCompanyRead-Orders',
  ORDER_ITEMS: process.env.ORDER_ITEMS_TABLE_NAME || 'AnyCompanyRead-OrderItems',
} as const;

/** API path constants */
export const API_PATHS = {
  AUTH: {
    SIGNUP: '/auth/signup',
    LOGIN: '/auth/login',
    FORGOT_PASSWORD: '/auth/forgot-password',
    CONFIRM_FORGOT_PASSWORD: '/auth/confirm-forgot-password',
  },
  BOOKS: {
    LIST: '/books',
    DETAIL: '/books/:bookId',
  },
  CART: {
    GET: '/cart',
    ADD: '/cart',
    UPDATE: '/cart/:bookId',
    REMOVE: '/cart/:bookId',
  },
  ORDERS: {
    CHECKOUT: '/checkout',
    LIST: '/orders',
    DETAIL: '/orders/:orderId',
  },
} as const;

/** Available book genres */
export const GENRES = [
  'Fiction',
  'Non-Fiction',
  'Science Fiction',
  'Fantasy',
  'Mystery',
  'Thriller',
  'Romance',
  'Biography',
  'History',
  'Science',
  'Technology',
  'Self-Help',
] as const;

export type Genre = (typeof GENRES)[number];
