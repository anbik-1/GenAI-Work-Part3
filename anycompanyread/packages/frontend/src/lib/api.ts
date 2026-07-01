/**
 * API client — wraps fetch with base URL, auth token injection, and error handling.
 */

const API_BASE_URL = import.meta.env.VITE_API_URL || '/api';

/** Get the stored auth token */
function getToken(): string | null {
  const tokens = localStorage.getItem('anycompanyread-tokens');
  if (!tokens) return null;
  try {
    return JSON.parse(tokens).idToken;
  } catch {
    return null;
  }
}

/** Generic fetch wrapper */
async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({ message: 'Request failed' }));
    throw new Error(errorBody.message || `HTTP ${response.status}`);
  }

  return response.json();
}

/** API methods */
export const api = {
  get: <T>(path: string) => request<T>(path, { method: 'GET' }),

  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),

  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: body ? JSON.stringify(body) : undefined }),

  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};
