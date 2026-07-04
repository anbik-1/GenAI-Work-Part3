import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/misc';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

const TOKEN_KEY   = 'genese-id-token';
const REFRESH_KEY = 'genese-refresh-token';
const USER_KEY    = 'genese-user';

interface GoogleCallbackResponse {
  idToken: string;
  refreshToken: string;
  user: unknown;
}

export function AuthCallbackPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const code = searchParams.get('code');

    if (!code) {
      setError('No authorisation code was returned by the identity provider.');
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(`${API_BASE}/auth/google-callback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code }),
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({ detail: 'Authentication failed' }));
          throw new Error(body.detail || `HTTP ${res.status}`);
        }

        const data: GoogleCallbackResponse = await res.json();

        if (!cancelled) {
          localStorage.setItem(TOKEN_KEY, data.idToken);
          localStorage.setItem(REFRESH_KEY, data.refreshToken);
          localStorage.setItem(USER_KEY, JSON.stringify(data.user));
          navigate('/generate', { replace: true });
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Authentication failed. Please try again.');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [navigate, searchParams]);

  // ── Error state ──────────────────────────────────────────────────────────
  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <div className="w-full max-w-sm space-y-4 text-center">
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
          <Button variant="outline" onClick={() => navigate('/login', { replace: true })}>
            Back to Login
          </Button>
        </div>
      </div>
    );
  }

  // ── Loading state (default) ──────────────────────────────────────────────
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4">
      <Loader2 className="h-10 w-10 animate-spin text-primary" />
      <p className="text-sm text-muted-foreground">Completing sign-in…</p>
    </div>
  );
}
