/** Order status */
export type OrderStatus = 'CONFIRMED' | 'PROCESSING' | 'SHIPPED' | 'DELIVERED';

/** Represents an order */
export interface Order {
  userId: string;
  orderId: string;
  totalPrice: number;
  status: OrderStatus;
  itemCount: number;
  createdAt: string;
}

/** Represents a single item within an order */
export interface OrderItem {
  orderId: string;
  bookId: string;
  quantity: number;
  price: number;
  title: string;
}

/** Order with its items (for detail view) */
export interface OrderDetail extends Order {
  items: OrderItem[];
}
