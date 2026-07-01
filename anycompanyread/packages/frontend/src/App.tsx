import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { ThemeProvider } from '@/components/layout/theme-provider';
import { Layout } from '@/components/layout/layout';
import { Toaster } from '@/components/ui/toaster';
import { AuthProvider } from '@/contexts/auth-context';
import { CartProvider } from '@/contexts/cart-context';
import { HomePage } from '@/pages/home';
import { BooksPage } from '@/pages/books';
import { BookDetailPage } from '@/pages/book-detail';
import { LoginPage } from '@/pages/login';
import { SignupPage } from '@/pages/signup';
import { CartPage } from '@/pages/cart';
import { OrdersPage } from '@/pages/orders';

export default function App() {
  return (
    <ThemeProvider defaultTheme="system">
      <BrowserRouter>
        <AuthProvider>
          <CartProvider>
            <Routes>
              <Route element={<Layout />}>
                <Route path="/" element={<HomePage />} />
                <Route path="/books" element={<BooksPage />} />
                <Route path="/books/:bookId" element={<BookDetailPage />} />
                <Route path="/login" element={<LoginPage />} />
                <Route path="/signup" element={<SignupPage />} />
                <Route path="/cart" element={<CartPage />} />
                <Route path="/orders" element={<OrdersPage />} />
              </Route>
            </Routes>
            <Toaster />
          </CartProvider>
        </AuthProvider>
      </BrowserRouter>
    </ThemeProvider>
  );
}
