import { useEffect, useState, useCallback, useRef } from 'react';
import {
  Download, FileText, RefreshCw, ThumbsUp, Eye, Plus, X, Tag, Loader2, AlertCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge, Skeleton } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { useToast } from '@/components/ui/use-toast';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

// ─── Types ───────────────────────────────────────────────────────────────────

interface Job {
  job_id: string;
  document_type: string;
  client_name: string;
  engagement_type: string;
  status: string;
  created_at: string;
  completed_at?: string;
  error_message?: string;
  key_requirements?: string;
}

interface ArchData {
  preview_url?: string;
  arch_json?: unknown;
  arch_iteration?: number;
}

// ─── Tag Storage (localStorage) ──────────────────────────────────────────────

const TAGS_STORAGE_KEY = 'genese-job-tags';

const PRESET_TAGS = [
  'Nepal Client', 'US Client', 'UK Client', 'AU Client',
  'Priority', 'Banking', 'Healthcare', 'Retail', 'Government',
  'Startup', 'Enterprise', 'Urgent', 'Long-term',
];

function loadAllTags(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(TAGS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveAllTags(allTags: Record<string, string[]>) {
  localStorage.setItem(TAGS_STORAGE_KEY, JSON.stringify(allTags));
}

function getTagsForJob(jobId: string): string[] {
  return loadAllTags()[jobId] ?? [];
}

function setTagsForJob(jobId: string, tags: string[]) {
  const allTags = loadAllTags();
  allTags[jobId] = tags;
  saveAllTags(allTags);
}

// ─── Status helpers ───────────────────────────────────────────────────────────

type StatusVariant = 'default' | 'secondary' | 'destructive' | 'outline';

function statusVariant(status: string): StatusVariant {
  switch (status) {
    case 'complete': return 'default';
    case 'failed': return 'destructive';
    case 'queued': return 'outline';
    case 'processing': return 'secondary';
    case 'awaiting_review': return 'secondary';
    default: return 'secondary';
  }
}

/** Tailwind class overrides for badge color by status */
function statusBadgeClass(status: string): string {
  switch (status) {
    case 'complete':
      return 'bg-green-500 text-white border-transparent';
    case 'failed':
      return 'bg-red-500 text-white border-transparent';
    case 'awaiting_review':
      return 'bg-amber-500 text-white border-transparent';
    case 'queued':
    case 'processing':
      return 'bg-blue-500 text-white border-transparent';
    default:
      return '';
  }
}

function statusLabel(status: string): string {
  return status.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function formatError(msg?: string): string {
  if (!msg) return '⚠ Failed — unknown error';
  if (msg === 'Cancelled by user') return '✕ Cancelled by user';
  if (/timeout/i.test(msg)) return '⏱ Timed out — AI took too long. Try again.';
  if (/ThrottlingException/i.test(msg)) return '⚠ Rate limited — try again in a moment';
  return `⚠ ${msg.slice(0, 120)}`;
}

// ─── Tag Chip ────────────────────────────────────────────────────────────────

function TagChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-secondary text-secondary-foreground text-xs px-2 py-0.5 font-medium">
      {label}
      <button
        onClick={onRemove}
        className="ml-0.5 rounded-full hover:bg-muted-foreground/20 focus:outline-none"
        aria-label={`Remove tag ${label}`}
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

// ─── Tag Manager (per card) ──────────────────────────────────────────────────

function TagManager({ jobId }: { jobId: string }) {
  const [tags, setTags] = useState<string[]>(() => getTagsForJob(jobId));
  const [showPicker, setShowPicker] = useState(false);
  const [customInput, setCustomInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const persistAndSet = (newTags: string[]) => {
    setTags(newTags);
    setTagsForJob(jobId, newTags);
  };

  const addTag = (tag: string) => {
    const trimmed = tag.trim();
    if (!trimmed || tags.includes(trimmed)) return;
    persistAndSet([...tags, trimmed]);
  };

  const removeTag = (tag: string) => {
    persistAndSet(tags.filter(t => t !== tag));
  };

  const handlePresetSelect = (value: string) => {
    addTag(value);
    setShowPicker(false);
  };

  const handleCustomKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      addTag(customInput);
      setCustomInput('');
      setShowPicker(false);
    }
    if (e.key === 'Escape') {
      setShowPicker(false);
      setCustomInput('');
    }
  };

  const availablePresets = PRESET_TAGS.filter(t => !tags.includes(t));

  return (
    <div className="flex flex-wrap items-center gap-1.5 mt-2">
      <Tag className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      {tags.map(tag => (
        <TagChip key={tag} label={tag} onRemove={() => removeTag(tag)} />
      ))}

      {showPicker ? (
        <div className="flex items-center gap-1">
          {availablePresets.length > 0 && (
            <Select onValueChange={handlePresetSelect}>
              <SelectTrigger className="h-6 text-xs px-2 w-36">
                <SelectValue placeholder="Pick a tag…" />
              </SelectTrigger>
              <SelectContent className="bg-background border shadow-lg z-50">
                {availablePresets.map(t => (
                  <SelectItem key={t} value={t} className="text-xs">{t}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <input
            ref={inputRef}
            value={customInput}
            onChange={e => setCustomInput(e.target.value)}
            onKeyDown={handleCustomKeyDown}
            placeholder="Custom tag…"
            className="h-6 text-xs border border-input rounded-md px-2 w-28 bg-background focus:outline-none focus:ring-1 focus:ring-ring"
            autoFocus
          />
          <button
            onClick={() => { addTag(customInput); setCustomInput(''); setShowPicker(false); }}
            className="h-6 w-6 flex items-center justify-center rounded-md bg-primary text-primary-foreground hover:opacity-90"
            aria-label="Add tag"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => { setShowPicker(false); setCustomInput(''); }}
            className="h-6 w-6 flex items-center justify-center rounded-md hover:bg-muted"
            aria-label="Cancel"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : (
        <button
          onClick={() => setShowPicker(true)}
          className="inline-flex items-center gap-0.5 rounded-full border border-dashed border-muted-foreground/40 text-muted-foreground text-xs px-2 py-0.5 hover:border-primary/60 hover:text-primary transition-colors"
          aria-label="Add tag"
        >
          <Plus className="h-3 w-3" />
          <span>Add tag</span>
        </button>
      )}
    </div>
  );
}

// ─── Architecture Lightbox ────────────────────────────────────────────────────

interface LightboxProps {
  archData: ArchData;
  loading: boolean;
  onClose: () => void;
  onApprove: () => void;
  onRevise: (feedback: string) => void;
}

function ArchLightbox({ archData, loading, onClose, onApprove, onRevise }: LightboxProps) {
  const [feedback, setFeedback] = useState('');

  // Close on Escape key
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Prevent body scroll while open
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  const handleRevise = () => {
    if (!feedback.trim()) return;
    onRevise(feedback);
    setFeedback('');
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
      aria-modal="true"
      role="dialog"
    >
      {/* Lightbox panel — stop propagation so clicking inside doesn't close */}
      <div
        className="relative bg-background rounded-xl shadow-2xl w-full max-w-4xl mx-4 max-h-[90vh] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b shrink-0">
          <div>
            <h2 className="text-lg font-semibold">Architecture Review</h2>
            <p className="text-sm text-muted-foreground">
              Iteration {archData.arch_iteration ?? 1}
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 hover:bg-muted transition-colors"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              <span className="ml-3 text-muted-foreground">Loading architecture…</span>
            </div>
          ) : archData.preview_url ? (
            <div className="border rounded-lg overflow-hidden bg-white flex items-center justify-center">
              <img
                src={archData.preview_url}
                alt="Architecture Diagram"
                className="w-full h-auto max-h-[55vh] object-contain"
              />
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <FileText className="h-10 w-10 mb-2" />
              <p>No architecture preview available.</p>
            </div>
          )}

          {/* Feedback textarea */}
          {!loading && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">Request changes (optional):</p>
              <textarea
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm min-h-[72px] resize-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                placeholder="e.g. Add WAF, use Lambda instead of ECS, include RDS Multi-AZ…"
                value={feedback}
                onChange={e => setFeedback(e.target.value)}
              />
            </div>
          )}
        </div>

        {/* Footer actions */}
        {!loading && (
          <div className="flex items-center gap-3 px-6 py-4 border-t shrink-0 bg-background">
            <Button
              className="flex-1 bg-green-600 hover:bg-green-700 text-white"
              onClick={onApprove}
            >
              <ThumbsUp className="mr-2 h-4 w-4" />
              Approve & Generate Document
            </Button>
            <Button
              variant="outline"
              className="flex-1"
              onClick={handleRevise}
              disabled={!feedback.trim()}
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Revise Architecture
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Job Card ─────────────────────────────────────────────────────────────────

interface JobCardProps {
  job: Job;
  onDownload: (jobId: string) => void;
  onRetry: (jobId: string, clientName: string) => void;
  onOpenLightbox: (jobId: string) => void;
}

function JobCard({ job, onDownload, onRetry, onOpenLightbox }: JobCardProps) {
  const isActive = job.status === 'queued' || job.status === 'processing';
  const summary = job.key_requirements
    ? job.key_requirements.slice(0, 100) + (job.key_requirements.length > 100 ? '…' : '')
    : null;

  return (
    <Card
      className={`flex flex-col hover:shadow-md transition-shadow ${
        job.status === 'failed' ? 'border-red-300 dark:border-red-800' : ''
      }`}
    >
      <CardHeader className="pb-2 pt-5 px-5">
        {/* Client name + status badge */}
        <div className="flex items-start justify-between gap-2">
          <div
            className="group relative cursor-default"
            title={summary ?? undefined}
          >
            <h2 className="text-xl font-bold leading-tight truncate max-w-[260px]">
              {job.client_name}
            </h2>
            {/* Tooltip on hover for key_requirements */}
            {summary && (
              <div className="absolute left-0 top-full mt-1 z-30 hidden group-hover:block w-64 rounded-md bg-popover border text-popover-foreground text-xs p-2 shadow-lg pointer-events-none">
                {summary}
              </div>
            )}
          </div>
          <Badge
            variant={statusVariant(job.status)}
            className={`shrink-0 capitalize ${statusBadgeClass(job.status)}`}
          >
            {statusLabel(job.status)}
          </Badge>
        </div>

        {/* Subtitle: doc type + engagement type */}
        <p className="text-sm text-muted-foreground mt-0.5">
          {job.document_type.replace(/_/g, ' ')}
          {job.engagement_type ? ` · ${job.engagement_type.replace(/_/g, ' ')}` : ''}
        </p>

        {/* Date */}
        <p className="text-xs text-muted-foreground mt-1">
          {new Date(job.created_at).toLocaleString(undefined, {
            year: 'numeric', month: 'short', day: 'numeric',
            hour: '2-digit', minute: '2-digit',
          })}
        </p>
      </CardHeader>

      <CardContent className="flex-1 flex flex-col justify-between px-5 pb-5 space-y-3">
        {/* Tags */}
        <TagManager jobId={job.job_id} />

        {/* Error message */}
        {job.status === 'failed' && (
          <div className="flex items-start gap-1.5 text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 rounded-md px-2.5 py-2">
            <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>{formatError(job.error_message)}</span>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2 flex-wrap">
          {job.status === 'complete' && (
            <>
              <Button size="sm" variant="outline" onClick={() => onDownload(job.job_id)}>
                <Download className="h-4 w-4 mr-1.5" />
                Download
              </Button>
              <Button size="sm" variant="outline" onClick={() => onOpenLightbox(job.job_id)}>
                <Eye className="h-4 w-4 mr-1.5" />
                View Architecture
              </Button>
            </>
          )}

          {job.status === 'awaiting_review' && (
            <Button
              size="sm"
              className="bg-amber-500 hover:bg-amber-600 text-white"
              onClick={() => onOpenLightbox(job.job_id)}
            >
              <Eye className="h-4 w-4 mr-1.5" />
              Review Architecture
            </Button>
          )}

          {job.status === 'failed' && (
            <Button
              size="sm"
              variant="outline"
              className="border-primary/40 text-primary hover:bg-primary/10"
              onClick={() => onRetry(job.job_id, job.client_name)}
            >
              <RefreshCw className="h-4 w-4 mr-1.5" />
              Retry
            </Button>
          )}

          {isActive && (
            <div className="flex items-center gap-2 text-sm text-blue-600 dark:text-blue-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="capitalize">{statusLabel(job.status)}…</span>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function HistoryPage() {
  const { toast } = useToast();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);

  // Lightbox state
  const [lightboxJobId, setLightboxJobId] = useState<string | null>(null);
  const [archData, setArchData] = useState<ArchData | null>(null);
  const [archLoading, setArchLoading] = useState(false);

  // ── Fetch jobs ──────────────────────────────────────────────────────────────
  const fetchJobs = useCallback(async () => {
    try {
      const data = await api.get<Job[]>('/jobs');
      setJobs(data);
    } catch {
      toast({ title: 'Failed to load history', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { fetchJobs(); }, [fetchJobs]);

  // ── Download ────────────────────────────────────────────────────────────────
  const handleDownload = async (jobId: string) => {
    try {
      const result = await api.get<{ download_url: string }>(`/generate/${jobId}`);
      if (result.download_url) window.open(result.download_url, '_blank');
    } catch {
      toast({ title: 'Download failed', variant: 'destructive' });
    }
  };

  // ── Open lightbox ───────────────────────────────────────────────────────────
  const openLightbox = async (jobId: string) => {
    setLightboxJobId(jobId);
    setArchData(null);
    setArchLoading(true);
    try {
      const data = await api.get<ArchData>(`/generate/${jobId}/architecture`);
      setArchData(data);
    } catch {
      toast({ title: 'Failed to load architecture', variant: 'destructive' });
      setLightboxJobId(null);
    } finally {
      setArchLoading(false);
    }
  };

  const closeLightbox = () => {
    setLightboxJobId(null);
    setArchData(null);
  };

  // ── Approve architecture ────────────────────────────────────────────────────
  const handleApprove = async () => {
    if (!lightboxJobId) return;
    setArchLoading(true);
    try {
      await api.post(`/generate/${lightboxJobId}/approve`);
      toast({ title: 'Approved!', description: 'Generating your final document…', variant: 'success' });
      closeLightbox();
      setTimeout(fetchJobs, 3000);
    } catch (err) {
      toast({
        title: 'Approval failed',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setArchLoading(false);
    }
  };

  // ── Revise architecture ─────────────────────────────────────────────────────
  const handleRevise = async (feedback: string) => {
    if (!lightboxJobId || !feedback.trim()) return;
    setArchLoading(true);
    try {
      await api.post(`/generate/${lightboxJobId}/iterate-architecture`, { feedback });
      toast({ title: 'Feedback sent!', description: 'Revising architecture…', variant: 'success' });
      // Re-fetch after a short delay so the PNG regenerates
      setTimeout(() => openLightbox(lightboxJobId), 5000);
    } catch (err) {
      toast({
        title: 'Revision failed',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
      setArchLoading(false);
    }
  };

  // ── Retry ───────────────────────────────────────────────────────────────────
  const handleRetry = async (jobId: string, clientName: string) => {
    try {
      await api.post(`/generate/${jobId}/retry`);
      toast({
        title: 'Job re-queued!',
        description: `${clientName} will be regenerated. Check back in 1–2 minutes.`,
        variant: 'success',
      });
      setTimeout(fetchJobs, 2000);
    } catch (err) {
      toast({
        title: 'Retry failed',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <>
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Page header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">History</h1>
            <p className="text-muted-foreground mt-1">Your past generation requests</p>
          </div>
          <Button variant="outline" size="sm" onClick={fetchJobs} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>

        {/* Loading skeletons */}
        {loading && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-44 w-full rounded-xl" />
            ))}
          </div>
        )}

        {/* Empty state */}
        {!loading && jobs.length === 0 && (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center py-16 text-center">
              <FileText className="h-12 w-12 text-muted-foreground mb-4" />
              <p className="font-semibold text-lg">No documents generated yet</p>
              <p className="text-sm text-muted-foreground mt-1">
                Go to Generate to create your first proposal.
              </p>
            </CardContent>
          </Card>
        )}

        {/* Job cards grid */}
        {!loading && jobs.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {jobs.map(job => (
              <JobCard
                key={job.job_id}
                job={job}
                onDownload={handleDownload}
                onRetry={handleRetry}
                onOpenLightbox={openLightbox}
              />
            ))}
          </div>
        )}
      </div>

      {/* Architecture Lightbox */}
      {lightboxJobId && (
        <ArchLightbox
          archData={archData ?? {}}
          loading={archLoading}
          onClose={closeLightbox}
          onApprove={handleApprove}
          onRevise={handleRevise}
        />
      )}
    </>
  );
}
