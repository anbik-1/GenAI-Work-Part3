/** Represents an item in a user's shopping cart */
export interface CartItem {
  userId: string;
  bookId: string;
  quantity: number;
  /** Denormalized book data for display without extra lookups */
  title: string;
  price: number;
  coverImageUrl: string;
}

/** Cart summary with computed total */
export interface Cart {
  items: CartItem[];
  totalPrice: number;
  itemCount: number;
}
