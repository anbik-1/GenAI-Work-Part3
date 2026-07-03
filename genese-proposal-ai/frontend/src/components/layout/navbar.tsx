import { Link, useNavigate, useLocation } from 'react-router-dom';
import { FileText, Search, BookOpen, History, Sun, Moon, LogOut, Network } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTheme } from './theme-provider';
import { useAuth } from '@/contexts/AuthContext';

const NAV_ITEMS = [
  { to: '/generate', label: 'Generate', icon: FileText },
  { to: '/search', label: 'Search', icon: Search },
  { to: '/documents', label: 'Documents', icon: BookOpen },
  { to: '/history', label: 'History', icon: History },
  { to: '/arch-references', label: 'Arch Refs', icon: Network },
];

export function Navbar() {
  const { theme, setTheme } = useTheme();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

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
          {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
            <Button key={to} variant={location.pathname.startsWith(to) ? 'secondary' : 'ghost'} size="sm" onClick={() => navigate(to)}>
              <Icon className="h-4 w-4 mr-1.5" />{label}
            </Button>
          ))}
        </nav>

        {/* Right actions */}
        <div className="flex items-center space-x-2">
          <Button variant="ghost" size="icon" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label="Toggle theme">
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
