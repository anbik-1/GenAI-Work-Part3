import { useEffect, useState, useCallback, useRef } from 'react';
import {
  Download, FileText, RefreshCw, ThumbsUp, Eye, Plus, X, Tag, Loader2, AlertCircle,
  GitBranch, ChevronDown, ChevronUp,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge, Skeleton } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { useToast } from '@/components/ui/use-toast';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

// ─── Types ────────────────────────────────────────────────────────────────────

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
  context_notes?: string;
}

interface JobDetail extends Job {
  download_url?: string;
  token_usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
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

function formatDate(iso?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// ─── Tag Chip ─────────────────────────────────────────────────────────────────

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

// ─── Tag Manager (per card) ───────────────────────────────────────────────────

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

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
      <div
        className="relative bg-background rounded-xl shadow-2xl w-full max-w-4xl mx-4 max-h-[90vh] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
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

// ─── Overview Modal ───────────────────────────────────────────────────────────

interface OverviewModalProps {
  job: Job;
  detail: JobDetail | null;
  loading: boolean;
  onClose: () => void;
  onDownload: (jobId: string) => void;
}

function OverviewModal({ job, detail, loading, onClose, onDownload }: OverviewModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  const tokenUsage = detail?.token_usage;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
      aria-modal="true"
      role="dialog"
    >
      <div
        className="relative bg-background rounded-xl shadow-2xl w-full max-w-2xl mx-4 max-h-[90vh] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b shrink-0">
          <div>
            <h2 className="text-lg font-semibold">Document Overview</h2>
            <p className="text-sm text-muted-foreground">{job.client_name}</p>
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
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" />
              <span className="ml-3 text-muted-foreground">Loading details…</span>
            </div>
          ) : (
            <>
              {/* Status */}
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide w-32 shrink-0">Status</span>
                <Badge
                  variant={statusVariant(job.status)}
                  className={`capitalize ${statusBadgeClass(job.status)}`}
                >
                  {statusLabel(job.status)}
                </Badge>
              </div>

              {/* Fields */}
              {(
                [
                  ['Document Type', job.document_type.replace(/_/g, ' ')],
                  ['Engagement Type', job.engagement_type ? job.engagement_type.replace(/_/g, ' ') : '—'],
                  ['Created', formatDate(job.created_at)],
                  ['Completed', formatDate(job.completed_at)],
                ] as [string, string][]
              ).map(([label, value]) => (
                <div key={label} className="flex items-start gap-2">
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide w-32 shrink-0 pt-0.5">{label}</span>
                  <span className="text-sm">{value}</span>
                </div>
              ))}

              {/* Token usage */}
              {tokenUsage && (
                <div className="flex items-start gap-2">
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide w-32 shrink-0 pt-0.5">Tokens</span>
                  <span className="text-sm">
                    {tokenUsage.total_tokens != null
                      ? `${tokenUsage.total_tokens.toLocaleString()} total`
                      : '—'}
                    {tokenUsage.input_tokens != null && tokenUsage.output_tokens != null
                      ? ` (↑${tokenUsage.input_tokens.toLocaleString()} in / ↓${tokenUsage.output_tokens.toLocaleString()} out)`
                      : ''}
                  </span>
                </div>
              )}

              {/* Key requirements */}
              {job.key_requirements && (
                <div className="space-y-1.5">
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide block">Key Requirements</span>
                  <div className="rounded-md border bg-muted/30 px-4 py-3 text-sm whitespace-pre-wrap leading-relaxed max-h-56 overflow-y-auto">
                    {job.key_requirements}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {!loading && job.status === 'complete' && (
          <div className="px-6 py-4 border-t shrink-0 bg-background">
            <Button
              className="w-full"
              onClick={() => { onDownload(job.job_id); onClose(); }}
            >
              <Download className="mr-2 h-4 w-4" />
              Download .docx
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Iterate Modal ────────────────────────────────────────────────────────────

interface IterateModalProps {
  job: Job;
  onClose: () => void;
  onQueued: () => void;
}

function IterateModal({ job, onClose, onQueued }: IterateModalProps) {
  const { toast } = useToast();
  const [iterationNotes, setIterationNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  const handleGenerate = async () => {
    if (!iterationNotes.trim()) return;
    setSubmitting(true);
    try {
      const combinedNotes = job.context_notes
        ? `${job.context_notes}\n\n--- Iteration Notes ---\n${iterationNotes.trim()}`
        : `--- Iteration Notes ---\n${iterationNotes.trim()}`;

      await api.post('/generate', {
        client_name: job.client_name,
        document_type: job.document_type,
        engagement_type: job.engagement_type,
        key_requirements: job.key_requirements ?? '',
        context_notes: combinedNotes,
      });

      toast({ title: 'New version queued!', description: `A new version for ${job.client_name} is being generated.`, variant: 'success' });
      onQueued();
      onClose();
    } catch (err) {
      toast({
        title: 'Failed to queue new version',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
      aria-modal="true"
      role="dialog"
    >
      <div
        className="relative bg-background rounded-xl shadow-2xl w-full max-w-2xl mx-4 max-h-[90vh] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b shrink-0">
          <div>
            <h2 className="text-lg font-semibold">Iterate Document</h2>
            <p className="text-sm text-muted-foreground">{job.client_name} — new version</p>
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
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
          {/* Original requirements read-only */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide block">
              Original Requirements (read-only)
            </label>
            <div className="rounded-md border bg-muted/30 px-4 py-3 text-sm whitespace-pre-wrap leading-relaxed max-h-40 overflow-y-auto text-muted-foreground">
              {job.key_requirements || '(none)'}
            </div>
          </div>

          {/* Iteration notes */}
          <div className="space-y-1.5">
            <label
              htmlFor="iteration-notes"
              className="text-xs font-medium uppercase tracking-wide block"
            >
              What to change in the next version? <span className="text-red-500">*</span>
            </label>
            <textarea
              id="iteration-notes"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm min-h-[100px] resize-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              placeholder="e.g. Add a section on data migration strategy, expand the pricing section, use a more formal tone…"
              value={iterationNotes}
              onChange={e => setIterationNotes(e.target.value)}
              autoFocus
            />
            <p className="text-xs text-muted-foreground">
              These notes will be appended to the context and a new document generation will be queued.
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t shrink-0 bg-background flex gap-3">
          <Button variant="outline" className="flex-1" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            className="flex-1"
            onClick={handleGenerate}
            disabled={!iterationNotes.trim() || submitting}
          >
            {submitting ? (
              <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Queuing…</>
            ) : (
              <><GitBranch className="mr-2 h-4 w-4" />Generate New Version</>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Job Card ─────────────────────────────────────────────────────────────────

interface JobCardProps {
  job: Job;
  versionLabel: string;
  onDownload: (jobId: string) => void;
  onRetry: (jobId: string, clientName: string) => void;
  onOpenLightbox: (jobId: string) => void;
  onOpenOverview: (job: Job) => void;
  onOpenIterate: (job: Job) => void;
}

function JobCard({ job, versionLabel, onDownload, onRetry, onOpenLightbox, onOpenOverview, onOpenIterate }: JobCardProps) {
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
        {/* Client name + version label + status badge */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <div
              className="group relative cursor-default min-w-0"
              title={summary ?? undefined}
            >
              <h2 className="text-xl font-bold leading-tight truncate max-w-[220px]">
                {job.client_name}
              </h2>
              {summary && (
                <div className="absolute left-0 top-full mt-1 z-30 hidden group-hover:block w-64 rounded-md bg-popover border text-popover-foreground text-xs p-2 shadow-lg pointer-events-none">
                  {summary}
                </div>
              )}
            </div>
            {/* Version badge */}
            <span className="shrink-0 inline-flex items-center rounded-full bg-primary/10 text-primary text-xs font-semibold px-2 py-0.5">
              {versionLabel}
            </span>
          </div>
          <Badge
            variant={statusVariant(job.status)}
            className={`shrink-0 capitalize ${statusBadgeClass(job.status)}`}
          >
            {statusLabel(job.status)}
          </Badge>
        </div>

        {/* Subtitle */}
        <p className="text-sm text-muted-foreground mt-0.5">
          {job.document_type.replace(/_/g, ' ')}
          {job.engagement_type ? ` · ${job.engagement_type.replace(/_/g, ' ')}` : ''}
        </p>

        {/* Date */}
        <p className="text-xs text-muted-foreground mt-1">
          {formatDate(job.created_at)}
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
              <Button size="sm" variant="outline" onClick={() => onOpenOverview(job)}>
                <FileText className="h-4 w-4 mr-1.5" />
                Overview
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

          {/* Iterate button for complete + failed */}
          {(job.status === 'complete' || job.status === 'failed') && (
            <Button
              size="sm"
              variant="outline"
              className="border-primary/40 text-primary hover:bg-primary/10"
              onClick={() => onOpenIterate(job)}
            >
              <GitBranch className="h-4 w-4 mr-1.5" />
              Iterate
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

// ─── Client Group ─────────────────────────────────────────────────────────────

interface ClientGroupProps {
  clientName: string;
  jobs: Job[];
  onDownload: (jobId: string) => void;
  onRetry: (jobId: string, clientName: string) => void;
  onOpenLightbox: (jobId: string) => void;
  onOpenOverview: (job: Job) => void;
  onOpenIterate: (job: Job) => void;
}

function ClientGroup({
  clientName,
  jobs,
  onDownload,
  onRetry,
  onOpenLightbox,
  onOpenOverview,
  onOpenIterate,
}: ClientGroupProps) {
  const [collapsed, setCollapsed] = useState(false);

  // Sort jobs oldest-first so v1 is the first document generated
  const sorted = [...jobs].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );

  return (
    <div className="space-y-3">
      {/* Group header */}
      <button
        className="flex items-center gap-2 w-full text-left group"
        onClick={() => setCollapsed(c => !c)}
        aria-expanded={!collapsed}
      >
        <h3 className="text-base font-semibold text-foreground group-hover:text-primary transition-colors">
          {clientName}
        </h3>
        <span className="text-xs text-muted-foreground rounded-full bg-muted px-2 py-0.5">
          {jobs.length} {jobs.length === 1 ? 'version' : 'versions'}
        </span>
        {collapsed
          ? <ChevronDown className="h-4 w-4 text-muted-foreground ml-auto" />
          : <ChevronUp className="h-4 w-4 text-muted-foreground ml-auto" />
        }
      </button>

      {/* Cards grid */}
      {!collapsed && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {sorted.map((job, idx) => (
            <JobCard
              key={job.job_id}
              job={job}
              versionLabel={`v${idx + 1}`}
              onDownload={onDownload}
              onRetry={onRetry}
              onOpenLightbox={onOpenLightbox}
              onOpenOverview={onOpenOverview}
              onOpenIterate={onOpenIterate}
            />
          ))}
        </div>
      )}
    </div>
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

  // Overview modal state
  const [overviewJob, setOverviewJob] = useState<Job | null>(null);
  const [overviewDetail, setOverviewDetail] = useState<JobDetail | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);

  // Iterate modal state
  const [iterateJob, setIterateJob] = useState<Job | null>(null);

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

  // ── Open Overview ───────────────────────────────────────────────────────────
  const openOverview = async (job: Job) => {
    setOverviewJob(job);
    setOverviewDetail(null);
    setOverviewLoading(true);
    try {
      const data = await api.get<JobDetail>(`/generate/${job.job_id}`);
      setOverviewDetail(data);
    } catch {
      // Non-fatal — show modal without extra details
    } finally {
      setOverviewLoading(false);
    }
  };

  const closeOverview = () => {
    setOverviewJob(null);
    setOverviewDetail(null);
  };

  // ── Open Lightbox ───────────────────────────────────────────────────────────
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

  // ── Group jobs by client_name ───────────────────────────────────────────────
  const clientGroups = jobs.reduce<Record<string, Job[]>>((acc, job) => {
    const key = job.client_name || 'Unknown Client';
    if (!acc[key]) acc[key] = [];
    acc[key].push(job);
    return acc;
  }, {});

  // Sort groups by the most recent job in each group (newest group first)
  const sortedClientNames = Object.keys(clientGroups).sort((a, b) => {
    const latestA = Math.max(...clientGroups[a].map(j => new Date(j.created_at).getTime()));
    const latestB = Math.max(...clientGroups[b].map(j => new Date(j.created_at).getTime()));
    return latestB - latestA;
  });

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

        {/* Client groups */}
        {!loading && sortedClientNames.length > 0 && (
          <div className="space-y-8">
            {sortedClientNames.map(clientName => (
              <ClientGroup
                key={clientName}
                clientName={clientName}
                jobs={clientGroups[clientName]}
                onDownload={handleDownload}
                onRetry={handleRetry}
                onOpenLightbox={openLightbox}
                onOpenOverview={openOverview}
                onOpenIterate={setIterateJob}
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

      {/* Overview Modal */}
      {overviewJob && (
        <OverviewModal
          job={overviewJob}
          detail={overviewDetail}
          loading={overviewLoading}
          onClose={closeOverview}
          onDownload={handleDownload}
        />
      )}

      {/* Iterate Modal */}
      {iterateJob && (
        <IterateModal
          job={iterateJob}
          onClose={() => setIterateJob(null)}
          onQueued={() => setTimeout(fetchJobs, 2000)}
        />
      )}
    </>
  );
}




