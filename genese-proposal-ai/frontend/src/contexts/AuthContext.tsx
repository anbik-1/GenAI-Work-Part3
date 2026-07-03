import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { api, setLogoutCallback } from '@/lib/api';

interface User { email: string; sub: string; }
interface AuthCtx {
  user: User | null;
  isAuthenticated: boolean;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}
const AuthContext = createContext<AuthCtx | undefined>(undefined);

const TOKEN_KEY   = 'genese-id-token';
const REFRESH_KEY = 'genese-refresh-token';
const USER_KEY    = 'genese-user';

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  // Restore session from localStorage on mount
  useEffect(() => {
    const stored = localStorage.getItem(USER_KEY);
    const token  = localStorage.getItem(TOKEN_KEY);
    if (stored && token) {
      try {
        setUser(JSON.parse(stored));
      } catch {
        localStorage.removeItem(USER_KEY);
      }
    }
    setLoading(false);
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem(USER_KEY);
    setUser(null);
    // Redirect to login page after clearing state
    window.location.href = '/login';
  }, []);

  // Register the logout function with the api client so it can trigger
  // a forced logout when the refresh token is also expired.
  useEffect(() => {
    setLogoutCallback(logout);
  }, [logout]);

  const login = useCallback(async (email: string, password: string) => {
    const data = await api.post<{
      idToken: string;
      accessToken: string;
      refreshToken?: string;
    }>('/auth/login', { email, password });

    localStorage.setItem(TOKEN_KEY, data.idToken);

    if (data.refreshToken) {
      localStorage.setItem(REFRESH_KEY, data.refreshToken);
    }

    const userData: User = { email, sub: email };
    localStorage.setItem(USER_KEY, JSON.stringify(userData));
    setUser(userData);
  }, []);

  return (
    <AuthContext.Provider value={{ user, isAuthenticated: !!user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be inside AuthProvider');
  return ctx;
};
