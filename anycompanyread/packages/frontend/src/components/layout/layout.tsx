import { Outlet } from 'react-router-dom';
import { Navbar } from './navbar';
import { Footer } from './footer';

/**
 * Main layout wrapper — provides consistent navbar, content area, and footer.
 */
export function Layout() {
  return (
    <div className="flex min-h-screen flex-col">
      <Navbar />
      <main className="flex-1">
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}
