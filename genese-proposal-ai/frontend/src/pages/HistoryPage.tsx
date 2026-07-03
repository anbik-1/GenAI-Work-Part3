import { useEffect, useState } from 'react';
import { Download, FileText, RefreshCw, ThumbsUp, Eye } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge, Skeleton } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { useToast } from '@/components/ui/use-toast';

interface Job { job_id: string; document_type: string; client_name: string; engagement_type: string; status: string; created_at: string; completed_at?: string; error_message?: string; }

const STATUS_COLORS: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  complete: 'default', failed: 'destructive', queued: 'outline', processing: 'secondary',
};

export function HistoryPage() {
  const { toast } = useToast();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [reviewJobId, setReviewJobId] = useState<string | null>(null);
  const [archData, setArchData] = useState<{ preview_url?: string; arch_json?: any; arch_iteration?: number } | null>(null);
  const [archFeedback, setArchFeedback] = useState('');
  const [archLoading, setArchLoading] = useState(false);

  const fetchJobs = async () => {
    try {
      const data = await api.get<Job[]>('/jobs');
      setJobs(data);
    } catch { toast({ title: 'Failed to load history', variant: 'destructive' }); }
    finally { setLoading(false); }
  };

  useEffect(() => { fetchJobs(); }, []);

  const handleDownload = async (jobId: string) => {
    try {
      const result = await api.get<{ download_url: string }>(`/generate/${jobId}`);
      if (result.download_url) window.open(result.download_url, '_blank');
    } catch { toast({ title: 'Download failed', variant: 'destructive' }); }
  };

  const openArchReview = async (jobId: string) => {
    setArchLoading(true);
    setReviewJobId(jobId);
    try {
      const data = await api.get<any>(`/generate/${jobId}/architecture`);
      setArchData(data);
    } catch { toast({ title: 'Failed to load architecture', variant: 'destructive' }); }
    finally { setArchLoading(false); }
  };

  const handleApprove = async () => {
    if (!reviewJobId) return;
    setArchLoading(true);
    try {
      await api.post(`/generate/${reviewJobId}/approve`);
      toast({ title: 'Approved!', description: 'Generating your final document...', variant: 'success' });
      setReviewJobId(null); setArchData(null);
      setTimeout(fetchJobs, 3000);
    } catch (err) {
      toast({ title: 'Error', description: err instanceof Error ? err.message : 'Failed', variant: 'destructive' });
    } finally { setArchLoading(false); }
  };

  const handleIterate = async () => {
    if (!reviewJobId || !archFeedback.trim()) return;
    setArchLoading(true);
    try {
      await api.post(`/generate/${reviewJobId}/iterate-architecture`, { feedback: archFeedback });
      toast({ title: 'Feedback sent!', description: 'Revising architecture...', variant: 'success' });
      setArchFeedback('');
      // Re-fetch arch after delay
      setTimeout(() => openArchReview(reviewJobId), 5000);
    } catch (err) {
      toast({ title: 'Error', description: err instanceof Error ? err.message : 'Failed', variant: 'destructive' });
      setArchLoading(false);
    }
  };

  const handleRetry = async (jobId: string, clientName: string) => {
    try {
      await api.post(`/generate/${jobId}/retry`);
      toast({ title: 'Job re-queued!', description: `${clientName} will be regenerated. Check back in 1–2 minutes.`, variant: 'success' });
      setTimeout(fetchJobs, 2000);
    } catch (err) {
      toast({ title: 'Retry failed', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' });
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">History</h1>
        <p className="text-muted-foreground mt-1">Your past generation requests</p>
      </div>

      {loading ? (
        Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20 w-full" />)
      ) : jobs.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center py-12 text-center">
            <FileText className="h-12 w-12 text-muted-foreground mb-4" />
            <p className="font-medium">No documents generated yet</p>
            <p className="text-sm text-muted-foreground">Go to Generate to create your first proposal.</p>
          </CardContent>
        </Card>
      ) : (
        jobs.map(job => (
          <Card key={job.job_id} className={`hover:shadow-md transition-shadow ${job.status === 'failed' ? 'border-destructive/30' : ''}`}>
            <CardContent className="flex items-center justify-between py-4 px-6">
              <div className="space-y-1 flex-1 min-w-0">
                <p className="font-medium">{job.client_name}</p>
                <div className="flex items-center space-x-2">
                  <Badge variant={STATUS_COLORS[job.status] || 'secondary'} className="text-xs">{job.status}</Badge>
                  <span className="text-xs text-muted-foreground">{job.document_type.replace('_', ' ')}</span>
                  <span className="text-xs text-muted-foreground">{job.engagement_type.replace(/_/g, ' ')}</span>
                </div>
                {/* Show failure reason for failed jobs */}
                {job.status === 'failed' && (
                  <p className="text-xs text-destructive mt-1">
                    {job.error_message === 'Cancelled by user'
                      ? '✕ Cancelled by user'
                      : job.error_message?.includes('timeout') || job.error_message?.includes('Timeout')
                      ? '⏱ Timed out — AI took too long. Try again.'
                      : job.error_message?.includes('ThrottlingException')
                      ? '⚠ Rate limited — try again in a moment'
                      : job.error_message
                      ? `⚠ ${job.error_message.slice(0, 100)}`
                      : '⚠ Failed — unknown error'}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">{new Date(job.created_at).toLocaleString()}</p>
              </div>
              {job.status === 'complete' && (
                <Button size="sm" variant="outline" onClick={() => handleDownload(job.job_id)}>
                  <Download className="h-4 w-4 mr-1.5" />Download
                </Button>
              )}
              {job.status === 'awaiting_review' && (
                <Button size="sm" className="bg-primary text-primary-foreground"
                  onClick={() => reviewJobId === job.job_id ? setReviewJobId(null) : openArchReview(job.job_id)}>
                  <Eye className="h-4 w-4 mr-1.5" />
                  {reviewJobId === job.job_id ? 'Close Review' : 'Review Architecture'}
                </Button>
              )}
              {job.status === 'failed' && (
                <Button size="sm" variant="outline" className="border-primary/40 text-primary hover:bg-primary/10"
                  onClick={() => handleRetry(job.job_id, job.client_name)}>
                  <RefreshCw className="h-4 w-4 mr-1.5" />Retry
                </Button>
              )}
            </CardContent>
            {/* Architecture review panel — expands inline */}
            {reviewJobId === job.job_id && (
              <CardContent className="pt-0 border-t">
                {archLoading ? (
                  <div className="py-4 text-center text-sm text-muted-foreground">Loading architecture...</div>
                ) : archData ? (
                  <div className="space-y-3 py-2">
                    <p className="text-sm font-medium">Architecture Review — Iteration {archData.arch_iteration || 1}</p>
                    {archData.preview_url && (
                      <div className="border rounded overflow-hidden bg-white">
                        <img src={archData.preview_url} alt="Architecture Diagram" className="w-full h-auto max-h-80 object-contain" />
                      </div>
                    )}
                    <Button className="w-full" onClick={handleApprove} disabled={archLoading}>
                      <ThumbsUp className="mr-2 h-4 w-4" />Approve & Generate Document
                    </Button>
                    <div className="space-y-2">
                      <p className="text-xs text-muted-foreground font-medium">Or request changes:</p>
                      <textarea
                        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm min-h-[60px] resize-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        placeholder="e.g. Add WAF, use Lambda instead of ECS..."
                        value={archFeedback}
                        onChange={e => setArchFeedback(e.target.value)}
                      />
                      <Button variant="outline" className="w-full" onClick={handleIterate}
                        disabled={archLoading || !archFeedback.trim()}>
                        <RefreshCw className="mr-2 h-4 w-4" />Revise Architecture
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="py-4 text-center text-sm text-muted-foreground">No architecture data available.</div>
                )}
              </CardContent>
            )}
          </Card>
        ))
      )}
    </div>
  );
}
