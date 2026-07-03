import { useEffect, useState } from 'react';
import { Download, FileText } from 'lucide-react';
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

  useEffect(() => {
    api.get<Job[]>('/jobs')
      .then(setJobs)
      .catch(() => toast({ title: 'Failed to load history', variant: 'destructive' }))
      .finally(() => setLoading(false));
  }, []);

  const handleDownload = async (jobId: string) => {
    try {
      const result = await api.get<{ download_url: string }>(`/generate/${jobId}`);
      if (result.download_url) window.open(result.download_url, '_blank');
    } catch { toast({ title: 'Download failed', variant: 'destructive' }); }
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
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
