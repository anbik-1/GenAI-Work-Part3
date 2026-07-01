import { Book } from './book';
import { Order } from './order';

/** Paginated list response for books */
export interface ListBooksResponse {
  books: Book[];
  totalCount: number;
  nextToken?: string;
}

/** Query parameters for listing books */
export interface ListBooksParams {
  search?: string;
  genre?: string;
  page?: number;
  limit?: number;
}

/** Add to cart request */
export interface AddToCartRequest {
  bookId: string;
  quantity: number;
}

/** Update cart item request */
export interface UpdateCartItemRequest {
  quantity: number;
}

/** List orders response */
export interface ListOrdersResponse {
  orders: Order[];
}

/** Standard API error response */
export interface ApiErrorResponse {
  error: string;
  message: string;
}
