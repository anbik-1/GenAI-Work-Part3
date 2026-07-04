import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/misc';
import { useAuth } from '@/contexts/AuthContext';

const COGNITO_DOMAIN = import.meta.env.VITE_COGNITO_DOMAIN || 'https://genese-proposal.auth.us-east-1.amazoncognito.com';
const CLIENT_ID = import.meta.env.VITE_COGNITO_CLIENT_ID || '19ufsosadrbr5fqlhleargbrbi';
const REDIRECT_URI = `${window.location.origin}/auth/callback`;

function handleGoogleLogin() {
  const url =
    `${COGNITO_DOMAIN}/oauth2/authorize` +
    `?response_type=code` +
    `&client_id=${CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&identity_provider=Google` +
    `&scope=email+openid+profile`;
  window.location.href = url;
}

// Google "G" logo SVG — official brand colours
function GoogleLogo() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 48 48"
      width="18"
      height="18"
      aria-hidden="true"
    >
      <path
        fill="#EA4335"
        d="M24 9.5c3.14 0 5.95 1.08 8.17 2.85l6.09-6.09C34.46 2.99 29.5 1 24 1 14.82 1 7.07 6.48 3.64 14.18l7.08 5.5C12.43 13.61 17.73 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.52 24.5c0-1.64-.15-3.22-.42-4.74H24v8.98h12.67c-.55 2.94-2.2 5.43-4.68 7.1l7.18 5.57C43.3 37.64 46.52 31.54 46.52 24.5z"
      />
      <path
        fill="#FBBC05"
        d="M10.73 28.32A14.6 14.6 0 0 1 9.5 24c0-1.5.26-2.95.72-4.32l-7.08-5.5A23.94 23.94 0 0 0 0 24c0 3.87.93 7.52 2.57 10.74l8.16-6.42z"
      />
      <path
        fill="#34A853"
        d="M24 47c5.5 0 10.12-1.82 13.48-4.95l-7.18-5.57C28.56 38.4 26.4 39.5 24 39.5c-6.27 0-11.57-4.11-13.27-9.68l-8.16 6.42C6.07 44.52 14.42 47 24 47z"
      />
    </svg>
  );
}

export function LoginPage() {
  const navigate = useNavigate();
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login(email, password);
      navigate('/generate');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-[calc(100vh-8rem)] items-center justify-center">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 h-12 w-12 rounded-lg bg-primary flex items-center justify-center">
            <span className="text-primary-foreground text-xl font-bold">G</span>
          </div>
          <CardTitle className="text-2xl">Biku Intelligent Platform</CardTitle>
          <CardDescription>Internal tool — Genese Solution staff only</CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {/* ── Google SSO ── */}
          <button
            type="button"
            onClick={handleGoogleLogin}
            className="flex w-full items-center justify-center gap-3 rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2"
          >
            <GoogleLogo />
            Continue with Google
          </button>

          <p className="text-center text-xs text-muted-foreground">
            (Requires Google OAuth setup in Cognito — see X.md)
          </p>

          {/* ── Divider ── */}
          <div className="relative flex items-center">
            <div className="flex-grow border-t border-border" />
            <span className="mx-3 shrink-0 text-xs font-medium uppercase text-muted-foreground">
              OR
            </span>
            <div className="flex-grow border-t border-border" />
          </div>

          {/* ── Email / password form ── */}
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="you@genesesolution.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Signing in...
                </>
              ) : (
                'Sign in'
              )}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
