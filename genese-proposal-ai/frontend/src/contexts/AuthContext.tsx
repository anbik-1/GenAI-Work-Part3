import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { api, setLogoutCallback } from '@/lib/api';

export interface User {
  email: string;
  sub: string;
  name?: string;
  role: 'admin' | 'member';
  id?: string;
}

interface AuthCtx {
  user: User | null;
  isAuthenticated: boolean;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  refreshMe: () => Promise<void>;
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
    window.location.href = '/login';
  }, []);

  // Register the logout function with the api client so it can trigger
  // a forced logout when the refresh token is also expired.
  useEffect(() => {
    setLogoutCallback(logout);
  }, [logout]);

  /** Fetch current user profile from /auth/me and update state + storage. */
  const refreshMe = useCallback(async () => {
    try {
      const me = await api.get<{ id: string; email: string; name: string; role: 'admin' | 'member'; created_at: string }>('/auth/me');
      const updated: User = {
        email: me.email,
        sub: me.email,
        name: me.name,
        role: me.role,
        id: me.id,
      };
      localStorage.setItem(USER_KEY, JSON.stringify(updated));
      setUser(updated);
    } catch {
      // If /auth/me fails (e.g. network error), keep the existing user state
    }
  }, []);

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

    // Set a temporary user object so authenticated calls can proceed
    const tempUser: User = { email, sub: email, role: 'member' };
    localStorage.setItem(USER_KEY, JSON.stringify(tempUser));
    setUser(tempUser);

    // Fetch full profile (including role) from /auth/me
    await refreshMe();
  }, [refreshMe]);

  return (
    <AuthContext.Provider value={{ user, isAuthenticated: !!user, loading, login, logout, refreshMe }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be inside AuthProvider');
  return ctx;
};
