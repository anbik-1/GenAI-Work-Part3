import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Download, Loader2, AlertCircle, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/misc';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ProposalScore {
  overall_score?: number;
  completeness?: number;
  clarity?: number;
  technical_depth?: number;
  client_alignment?: number;
  value_proposition?: number;
  summary?: string;
}

interface PortalJob {
  job_id: string;
  status: string;
  document_type: string;
  client_name: string;
  engagement_type: string;
  download_url?: string;
  pdf_url?: string;
  created_at?: string;
  completed_at?: string;
  proposal_score?: ProposalScore | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function formatDate(iso?: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function labelFromSlug(slug: string): string {
  return slug.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function scoreColor(val?: number): string {
  if (val === undefined || val === null) return 'bg-muted';
  if (val > 7) return 'bg-green-500';
  if (val >= 5) return 'bg-yellow-400';
  return 'bg-red-500';
}

function scoreTextColor(val?: number): string {
  if (val === undefined || val === null) return 'text-muted-foreground';
  if (val > 7) return 'text-green-600';
  if (val >= 5) return 'text-yellow-600';
  return 'text-red-600';
}

// ── Component ─────────────────────────────────────────────────────────────────

export function PortalPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const [job, setJob] = useState<PortalJob | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!jobId) { setNotFound(true); setLoading(false); return; }
    fetch(`${API_BASE}/portal/${jobId}`)
      .then(res => {
        if (!res.ok) { setNotFound(true); return null; }
        return res.json();
      })
      .then(data => { if (data) setJob(data); })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [jobId]);

  const score = job?.proposal_score;

  const scoreDimensions: { key: keyof ProposalScore; label: string }[] = [
    { key: 'completeness',      label: 'Completeness'      },
    { key: 'clarity',           label: 'Clarity'           },
    { key: 'technical_depth',   label: 'Technical Depth'   },
    { key: 'client_alignment',  label: 'Client Alignment'  },
    { key: 'value_proposition', label: 'Value Proposition' },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-900 dark:to-slate-800 flex flex-col">
      {/* Branding header */}
      <header className="bg-white dark:bg-slate-900 border-b shadow-sm py-4 px-6 flex items-center gap-3">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
            <FileText className="h-4 w-4 text-primary-foreground" />
          </div>
          <span className="text-lg font-bold tracking-tight">Genese Solution</span>
        </div>
        <span className="text-muted-foreground text-sm hidden sm:block">· Proposal Portal</span>
      </header>

      {/* Main content */}
      <main className="flex-1 flex items-start justify-center px-4 py-10">
        <div className="w-full max-w-2xl space-y-6">

          {loading && (
            <div className="flex items-center justify-center py-24">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <span className="ml-3 text-muted-foreground">Loading proposal…</span>
            </div>
          )}

          {!loading && notFound && (
            <Card>
              <CardContent className="flex flex-col items-center py-16 text-center gap-3">
                <AlertCircle className="h-10 w-10 text-muted-foreground" />
                <p className="text-lg font-semibold">Proposal not available</p>
                <p className="text-sm text-muted-foreground">
                  This proposal is not available or has not been completed yet.
                </p>
              </CardContent>
            </Card>
          )}

          {!loading && job && (
            <>
              {/* Header card */}
              <Card>
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1">
                      <CardTitle className="text-2xl">{job.client_name}</CardTitle>
                      <p className="text-sm text-muted-foreground">
                        {labelFromSlug(job.document_type)}
                        {job.engagement_type ? ` · ${labelFromSlug(job.engagement_type)}` : ''}
                      </p>
                    </div>
                    <Badge className="shrink-0 bg-green-500 text-white border-transparent capitalize">
                      {job.status.replace(/_/g, ' ')}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-2 text-sm text-muted-foreground">
                  <div className="flex gap-8">
                    <div>
                      <span className="text-xs uppercase tracking-wide font-medium text-muted-foreground block">Created</span>
                      <span className="text-foreground">{formatDate(job.created_at)}</span>
                    </div>
                    <div>
                      <span className="text-xs uppercase tracking-wide font-medium text-muted-foreground block">Completed</span>
                      <span className="text-foreground">{formatDate(job.completed_at)}</span>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Proposal Score card */}
              {score && (
                <Card>
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-base">Proposal Quality Score</CardTitle>
                      {score.overall_score !== undefined && score.overall_score !== null && (
                        <span className={`text-3xl font-bold ${scoreTextColor(score.overall_score)}`}>
                          {score.overall_score.toFixed(1)}
                          <span className="text-base font-normal text-muted-foreground">/10</span>
                        </span>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {scoreDimensions.map(({ key, label }) => {
                      const val = score[key] as number | undefined;
                      const pct = val !== undefined && val !== null ? (val / 10) * 100 : 0;
                      return (
                        <div key={key} className="flex items-center gap-3">
                          <span className="text-xs text-muted-foreground w-36 shrink-0">{label}</span>
                          <div className="flex-1 h-2.5 bg-secondary rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all ${scoreColor(val)}`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <span className={`text-xs font-semibold w-8 text-right ${scoreTextColor(val)}`}>
                            {val !== undefined && val !== null ? val.toFixed(1) : '—'}
                          </span>
                        </div>
                      );
                    })}
                    {score.summary && (
                      <p className="text-xs text-muted-foreground italic border-t pt-3">{score.summary}</p>
                    )}
                  </CardContent>
                </Card>
              )}

              {/* Downloads card */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Downloads</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  {job.download_url ? (
                    <Button asChild className="w-full">
                      <a href={job.download_url} download>
                        <Download className="mr-2 h-4 w-4" />
                        Download Proposal (.docx)
                      </a>
                    </Button>
                  ) : (
                    <p className="text-sm text-muted-foreground">Document download not available.</p>
                  )}
                  {job.pdf_url && (
                    <Button asChild variant="outline" className="w-full">
                      <a href={job.pdf_url} target="_blank" rel="noopener noreferrer">
                        <Download className="mr-2 h-4 w-4" />
                        Download PDF
                      </a>
                    </Button>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </div>
      </main>

      {/* Footer */}
      <footer className="py-4 text-center text-xs text-muted-foreground border-t bg-white/50 dark:bg-slate-900/50">
        Generated by <span className="font-semibold">Genese Proposal AI</span>
      </footer>
    </div>
  );
}
