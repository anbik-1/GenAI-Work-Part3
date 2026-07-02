import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ThemeProvider } from '@/components/layout/theme-provider';
import { Layout } from '@/components/layout/layout';
import { Toaster } from '@/components/ui/toaster';
import { AuthProvider, useAuth } from '@/contexts/AuthContext';
import { JobProvider } from '@/contexts/JobContext';
import { GeneratePage } from '@/pages/GeneratePage';
import { SearchPage } from '@/pages/SearchPage';
import { DocumentsPage } from '@/pages/DocumentsPage';
import { HistoryPage } from '@/pages/HistoryPage';
import { LoginPage } from '@/pages/LoginPage';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, loading } = useAuth();
  if (loading) return <div className="flex items-center justify-center min-h-screen"><div className="animate-spin h-8 w-8 rounded-full border-4 border-primary border-t-transparent" /></div>;
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <ThemeProvider defaultTheme="system">
      <BrowserRouter>
        <AuthProvider>
          <JobProvider>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route element={<ProtectedRoute><Layout /></ProtectedRoute>}>
                <Route index element={<Navigate to="/generate" replace />} />
                <Route path="/generate" element={<GeneratePage />} />
                <Route path="/search" element={<SearchPage />} />
                <Route path="/documents" element={<DocumentsPage />} />
                <Route path="/history" element={<HistoryPage />} />
              </Route>
            </Routes>
            <Toaster />
          </JobProvider>
        </AuthProvider>
      </BrowserRouter>
    </ThemeProvider>
  );
}
