import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { CartItem, Cart, OrderDetail } from '@anycompanyread/shared';
import { api } from '@/lib/api';
import { useAuth } from './auth-context';

interface CartContextType {
  items: CartItem[];
  totalPrice: number;
  itemCount: number;
  loading: boolean;
  addToCart: (bookId: string, quantity?: number) => Promise<void>;
  updateQuantity: (bookId: string, quantity: number) => Promise<void>;
  removeItem: (bookId: string) => Promise<void>;
  checkout: () => Promise<OrderDetail>;
  refreshCart: () => Promise<void>;
}

const CartContext = createContext<CartContextType | undefined>(undefined);

export function CartProvider({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuth();
  const [items, setItems] = useState<CartItem[]>([]);
  const [totalPrice, setTotalPrice] = useState(0);
  const [itemCount, setItemCount] = useState(0);
  const [loading, setLoading] = useState(false);

  const refreshCart = useCallback(async () => {
    if (!isAuthenticated) {
      setItems([]);
      setTotalPrice(0);
      setItemCount(0);
      return;
    }

    try {
      setLoading(true);
      const cart = await api.get<Cart>('/cart');
      setItems(cart.items);
      setTotalPrice(cart.totalPrice);
      setItemCount(cart.itemCount);
    } catch (err) {
      console.error('Failed to fetch cart:', err);
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated]);

  // Fetch cart when auth state changes
  useEffect(() => {
    refreshCart();
  }, [refreshCart]);

  const addToCart = useCallback(async (bookId: string, quantity = 1) => {
    await api.post('/cart', { bookId, quantity });
    await refreshCart();
  }, [refreshCart]);

  const updateQuantity = useCallback(async (bookId: string, quantity: number) => {
    await api.put(`/cart/${bookId}`, { quantity });
    await refreshCart();
  }, [refreshCart]);

  const removeItem = useCallback(async (bookId: string) => {
    await api.delete(`/cart/${bookId}`);
    await refreshCart();
  }, [refreshCart]);

  const checkout = useCallback(async (): Promise<OrderDetail> => {
    const result = await api.post<{ order: OrderDetail }>('/checkout');
    setItems([]);
    setTotalPrice(0);
    setItemCount(0);
    return result.order;
  }, []);

  return (
    <CartContext.Provider
      value={{
        items,
        totalPrice,
        itemCount,
        loading,
        addToCart,
        updateQuantity,
        removeItem,
        checkout,
        refreshCart,
      }}
    >
      {children}
    </CartContext.Provider>
  );
}

export function useCart() {
  const context = useContext(CartContext);
  if (context === undefined) throw new Error('useCart must be used within a CartProvider');
  return context;
}
