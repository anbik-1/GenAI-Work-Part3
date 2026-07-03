import { Link, useNavigate, useLocation } from 'react-router-dom';
import { FileText, Search, BookOpen, History, Sun, Moon, LogOut, Network, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTheme } from './theme-provider';
import { useAuth } from '@/contexts/AuthContext';

const BASE_NAV_ITEMS = [
  { to: '/generate', label: 'Generate', icon: FileText },
  { to: '/search', label: 'Search', icon: Search },
  { to: '/documents', label: 'Documents', icon: BookOpen },
  { to: '/history', label: 'History', icon: History },
  { to: '/arch-references', label: 'Arch Refs', icon: Network },
];

const ADMIN_NAV_ITEMS = [
  { to: '/users', label: 'Users', icon: Users },
];

export function Navbar() {
  const { theme, setTheme } = useTheme();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const isAdmin = user?.role === 'admin';
  const navItems = isAdmin ? [...BASE_NAV_ITEMS, ...ADMIN_NAV_ITEMS] : BASE_NAV_ITEMS;

  return (
    <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur">
      <div className="container flex h-16 items-center justify-between">
        {/* Brand */}
        <Link to="/generate" className="flex items-center space-x-2">
          <div className="h-8 w-8 rounded bg-primary flex items-center justify-center">
            <span className="text-primary-foreground text-xs font-bold">G</span>
          </div>
          <span className="font-bold text-lg hidden sm:block">Genese Proposal AI</span>
        </Link>

        {/* Nav links */}
        <nav className="flex items-center space-x-1">
          {navItems.map(({ to, label, icon: Icon }) => (
            <Button
              key={to}
              variant={location.pathname.startsWith(to) ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => navigate(to)}
            >
              <Icon className="h-4 w-4 mr-1.5" />{label}
            </Button>
          ))}
        </nav>

        {/* Right actions */}
        <div className="flex items-center space-x-2">
          {/* Role badge for admins */}
          {isAdmin && (
            <span className="hidden sm:inline-flex items-center rounded-full bg-purple-100 dark:bg-purple-900/40 px-2 py-0.5 text-[10px] font-medium text-purple-700 dark:text-purple-300">
              Admin
            </span>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            aria-label="Toggle theme"
          >
            <Sun className="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
            <Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
          </Button>
          {user && (
            <Button variant="ghost" size="sm" onClick={() => { logout(); navigate('/login'); }}>
              <LogOut className="h-4 w-4 mr-1.5" />Sign out
            </Button>
          )}
        </div>
      </div>
    </header>
  );
}
