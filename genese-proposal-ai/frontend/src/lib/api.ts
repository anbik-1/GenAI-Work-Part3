/** Authenticated API client for Genese Proposal AI backend.
 *
 * Token refresh flow:
 *   1. Every request attaches the stored idToken as a Bearer header.
 *   2. On a 401 response the client attempts a silent refresh via POST /auth/refresh.
 *   3. If the refresh succeeds the new idToken is persisted and the original
 *      request is retried exactly once.
 *   4. If the refresh fails (refresh token also expired / revoked) the registered
 *      logout callback is invoked and the user is redirected to /login.
 */

const API_BASE = import.meta.env.VITE_API_URL || '/api';

const TOKEN_KEY    = 'genese-id-token';
const REFRESH_KEY  = 'genese-refresh-token';

// ---------------------------------------------------------------------------
// Logout callback — registered by AuthContext on mount
// ---------------------------------------------------------------------------

type LogoutFn = () => void;
let _logoutCallback: LogoutFn | null = null;

export function setLogoutCallback(fn: LogoutFn): void {
  _logoutCallback = fn;
}

function performLogout(): void {
  if (_logoutCallback) {
    _logoutCallback();
  } else {
    // Fallback: clear storage and hard-redirect even without a callback
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem('genese-user');
    window.location.href = '/login';
  }
}

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_KEY);
}

function saveToken(idToken: string): void {
  localStorage.setItem(TOKEN_KEY, idToken);
}

// ---------------------------------------------------------------------------
// Silent token refresh
// ---------------------------------------------------------------------------

interface RefreshResponse {
  idToken: string;
  accessToken: string;
}

/**
 * Attempts to obtain a new idToken using the stored refreshToken.
 * Returns the new idToken on success, or null if the refresh fails.
 */
async function refreshTokens(): Promise<string | null> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return null;

  try {
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });

    if (!res.ok) return null;

    const data: RefreshResponse = await res.json();
    saveToken(data.idToken);
    return data.idToken;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Core request function
// ---------------------------------------------------------------------------

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();

  const buildHeaders = (tok: string | null): Record<string, string> => {
    const h: Record<string, string> = {
      ...(options.headers as Record<string, string>),
    };
    if (!(options.body instanceof FormData)) {
      h['Content-Type'] = 'application/json';
    }
    if (tok) h['Authorization'] = `Bearer ${tok}`;
    return h;
  };

  // First attempt
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: buildHeaders(token),
  });

  // Happy path
  if (res.ok) {
    if (res.status === 204) return undefined as T;
    return res.json();
  }

  // Token expired — attempt a silent refresh then retry once
  if (res.status === 401) {
    const newToken = await refreshTokens();

    if (newToken) {
      // Retry original request with the fresh token
      const retryRes = await fetch(`${API_BASE}${path}`, {
        ...options,
        headers: buildHeaders(newToken),
      });

      if (retryRes.ok) {
        if (retryRes.status === 204) return undefined as T;
        return retryRes.json();
      }

      // Retry also failed — treat as auth failure
      if (retryRes.status === 401) {
        performLogout();
        throw new Error('Session expired. Please log in again.');
      }

      // Non-auth error on retry
      const retryErr = await retryRes.json().catch(() => ({ detail: 'Request failed' }));
      throw new Error(retryErr.detail || `HTTP ${retryRes.status}`);
    }

    // Refresh failed — session is fully expired
    performLogout();
    throw new Error('Session expired. Please log in again.');
  }

  // Non-401 error
  const err = await res.json().catch(() => ({ detail: 'Request failed' }));
  throw new Error(err.detail || `HTTP ${res.status}`);
}

// ---------------------------------------------------------------------------
// Public API surface
// ---------------------------------------------------------------------------

export const api = {
  get:    <T>(path: string) =>
    request<T>(path),

  post:   <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'POST',
      body: body instanceof FormData ? body : JSON.stringify(body),
    }),

  delete: <T>(path: string) =>
    request<T>(path, { method: 'DELETE' }),
};
