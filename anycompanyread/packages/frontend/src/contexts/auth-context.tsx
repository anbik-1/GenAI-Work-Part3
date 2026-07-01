import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { LoginRequest, SignupRequest, LoginResponse, MessageResponse } from '@anycompanyread/shared';
import { api } from '@/lib/api';

interface User {
  email: string;
  name: string;
}

interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  loading: boolean;
  login: (data: LoginRequest) => Promise<void>;
  signup: (data: SignupRequest) => Promise<void>;
  logout: () => void;
  forgotPassword: (email: string) => Promise<void>;
  confirmForgotPassword: (email: string, code: string, newPassword: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const STORAGE_KEY = 'anycompanyread-tokens';
const USER_KEY = 'anycompanyread-user';

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  // Restore session on mount
  useEffect(() => {
    const storedUser = localStorage.getItem(USER_KEY);
    const storedTokens = localStorage.getItem(STORAGE_KEY);
    if (storedUser && storedTokens) {
      try {
        setUser(JSON.parse(storedUser));
      } catch {
        localStorage.removeItem(USER_KEY);
        localStorage.removeItem(STORAGE_KEY);
      }
    }
    setLoading(false);
  }, []);

  const login = useCallback(async (data: LoginRequest) => {
    const response = await api.post<LoginResponse>('/auth/login', data);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(response));
    const userData: User = { email: data.email, name: data.email.split('@')[0] };
    localStorage.setItem(USER_KEY, JSON.stringify(userData));
    setUser(userData);
  }, []);

  const signup = useCallback(async (data: SignupRequest) => {
    await api.post<MessageResponse>('/auth/signup', data);
    // Auto-login after signup
    await login({ email: data.email, password: data.password });
  }, [login]);

  const logout = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(USER_KEY);
    setUser(null);
  }, []);

  const forgotPassword = useCallback(async (email: string) => {
    await api.post<MessageResponse>('/auth/forgot-password', { email });
  }, []);

  const confirmForgotPassword = useCallback(async (email: string, code: string, newPassword: string) => {
    await api.post<MessageResponse>('/auth/confirm-forgot-password', { email, code, newPassword });
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated: !!user,
        loading,
        login,
        signup,
        logout,
        forgotPassword,
        confirmForgotPassword,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) throw new Error('useAuth must be used within an AuthProvider');
  return context;
}
