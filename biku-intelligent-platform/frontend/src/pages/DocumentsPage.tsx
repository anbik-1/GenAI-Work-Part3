import { useEffect, useState, useRef } from 'react';
import { Upload, Trash2, BookOpen, Loader2, FileText, CheckCircle2, Clock, AlertTriangle, Cpu, Coins } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Badge, Skeleton } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { useToast } from '@/components/ui/use-toast';

interface Doc {
  id: string;
  filename: string;
  document_type: string;
  engagement_type?: string;
  client_name?: string;
  chunk_count: number;
  ingestion_status?: string;
  embedding_model?: string;
  embedding_tokens?: number;
  created_at: string;
}

interface DocStatus {
  ingestion_status: string;
  phase_label: string;
  phase_description: string;
  phases: Array<{ key: string; label: string; description: string; state: 'done' | 'active' | 'pending' }>;
  chunk_count: number;
  embedding_model: string;
  embedding_tokens: number;
  embedding_cost_usd: number;
}

const DOC_TYPES = ['proposal', 'sow', 'case_study', 'other'];

const ACTIVE_STATUSES = ['processing', 'loading', 'chunking', 'embedding', 'storing'];

function isActiveStatus(status?: string) {
  return !!status && ACTIVE_STATUSES.includes(status);
}

/** Small status icon shown on the grid card */
function StatusIcon({ status }: { status?: string }) {
  if (!status || status === 'pending') return <Clock className="h-3.5 w-3.5 text-muted-foreground" />;
  if (isActiveStatus(status)) return <Loader2 className="h-3.5 w-3.5 text-blue-500 animate-spin" />;
  if (status === 'complete') return <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />;
  if (status === 'failed') return <AlertTriangle className="h-3.5 w-3.5 text-destructive" />;
  return <Clock className="h-3.5 w-3.5 text-muted-foreground" />;
}

/** Tooltip content string for a document card */
function buildTooltip(doc: Doc, liveStatus?: DocStatus): string {
  const tokens = liveStatus?.embedding_tokens || doc.embedding_tokens || 0;
  const costUsd = liveStatus?.embedding_cost_usd || 0;
  const model = liveStatus?.embedding_model || doc.embedding_model;
  const parts: string[] = [];
  if (doc.filename) parts.push(doc.filename);
  if (tokens > 0) parts.push(`${tokens.toLocaleString()} tokens`);
  if (costUsd > 0) parts.push(`$${costUsd.toFixed(5)}`);
  if (model) parts.push(model.split('/').pop() || model);
  return parts.join(' · ');
}

/** Active phase label during indexing */
function activePhaseLabel(liveStatus?: DocStatus): string | null {
  if (!liveStatus?.phases) return null;
  const active = liveStatus.phases.find(p => p.state === 'active');
  return active ? active.label : null;
}

function modelShort(id?: string) {
  if (!id) return 'Titan Text v2';
  if (id.includes('titan-embed-text-v2')) return 'Titan Text v2';
  return id.split('/').pop() || id;
}

// ─── Compact Grid Card ───────────────────────────────────────────────────────

interface DocCardProps {
  doc: Doc;
  liveStatus?: DocStatus;
  onDelete: (id: string, filename: string) => void;
}

function DocCard({ doc, liveStatus, onDelete }: DocCardProps) {
  const status = liveStatus?.ingestion_status || doc.ingestion_status || 'pending';
  const chunks = liveStatus?.chunk_count || doc.chunk_count || 0;
  const tokens = liveStatus?.embedding_tokens || doc.embedding_tokens || 0;
  const costUsd = liveStatus?.embedding_cost_usd || 0;
  const indexing = isActiveStatus(status);
  const phaseLabel = indexing ? activePhaseLabel(liveStatus) : null;
  const tooltip = buildTooltip(doc, liveStatus);

  // Strip file extension for display
  const displayName = doc.filename.replace(/\.[^/.]+$/, '');

  return (
    <div
      title={tooltip}
      className={[
        'group relative flex flex-col gap-2 rounded-lg border bg-card p-3',
        'transition-all duration-150',
        'hover:shadow-md hover:-translate-y-0.5',
        indexing ? 'border-blue-200 dark:border-blue-800' : 'border-border',
      ].join(' ')}
    >
      {/* Delete button — top-right, visible on hover */}
      <button
        onClick={() => onDelete(doc.id, doc.filename)}
        aria-label={`Delete ${doc.filename}`}
        className={[
          'absolute top-2 right-2 rounded p-1',
          'text-muted-foreground opacity-0 group-hover:opacity-100',
          'hover:text-destructive hover:bg-destructive/10',
          'transition-opacity duration-100',
        ].join(' ')}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>

      {/* File icon + status icon */}
      <div className="flex items-center justify-between pr-6">
        <FileText className="h-6 w-6 text-primary shrink-0" />
        <StatusIcon status={status} />
      </div>

      {/* Filename */}
      <p className="text-sm font-medium leading-tight line-clamp-2 min-h-[2.5rem]" title={doc.filename}>
        {displayName}
      </p>

      {/* Doc type badge + client */}
      <div className="flex flex-wrap items-center gap-1">
        <Badge variant="outline" className="text-[10px] px-1.5 py-0 leading-4">
          {doc.document_type.replace('_', ' ')}
        </Badge>
        {doc.client_name && (
          <span className="text-[10px] text-muted-foreground truncate max-w-[80px]" title={doc.client_name}>
            {doc.client_name}
          </span>
        )}
      </div>

      {/* Chunks + date */}
      <div className="flex items-center justify-between text-[10px] text-muted-foreground mt-auto">
        {chunks > 0 ? (
          <span>{chunks} chunks</span>
        ) : (
          <span>—</span>
        )}
        <span>{new Date(doc.created_at).toLocaleDateString()}</span>
      </div>

      {/* Token info — visible on hover via group-hover (shown in tooltip too) */}
      {tokens > 0 && (
        <div
          className={[
            'overflow-hidden transition-all duration-200',
            'max-h-0 opacity-0 group-hover:max-h-10 group-hover:opacity-100',
          ].join(' ')}
        >
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground border-t pt-1.5 mt-0.5">
            <Cpu className="h-3 w-3 shrink-0" />
            <span className="truncate">{modelShort(liveStatus?.embedding_model || doc.embedding_model)}</span>
            <span className="shrink-0">{tokens.toLocaleString()} tok</span>
            {costUsd > 0 && (
              <span className="flex items-center gap-0.5 text-primary font-medium shrink-0">
                <Coins className="h-3 w-3" />${costUsd.toFixed(5)}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Indexing progress indicator */}
      {indexing && (
        <div className="mt-1">
          {/* Animated progress bar */}
          <div className="h-1 rounded-full bg-blue-100 dark:bg-blue-950 overflow-hidden">
            <div className="h-full bg-blue-500 rounded-full animate-pulse w-2/3" />
          </div>
          {phaseLabel && (
            <p className="text-[10px] text-blue-500 mt-0.5 truncate">{phaseLabel}…</p>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export function DocumentsPage() {
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [docStatuses, setDocStatuses] = useState<Record<string, DocStatus>>({});
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [docType, setDocType] = useState('proposal');
  const [clientName, setClientName] = useState('');
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchDocs = async () => {
    try {
      const data = await api.get<{ documents: Doc[] }>('/documents');
      setDocs(data.documents);
    } catch {
      toast({ title: 'Failed to load documents', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  // Poll status for pending/processing docs AND fetch token data for complete docs missing it
  const pollPendingStatuses = async (currentDocs: Doc[]) => {
    const needsStatus = currentDocs.filter(d => {
      const status = d.ingestion_status;
      const missingTokens = !d.embedding_tokens || d.embedding_tokens === 0;
      return !status || status === 'pending' || isActiveStatus(status) || (status === 'complete' && missingTokens);
    });
    if (needsStatus.length === 0) return false;

    const updates: Record<string, DocStatus> = {};
    await Promise.all(
      needsStatus.map(async (doc) => {
        try {
          const status = await api.get<DocStatus>(`/documents/${doc.id}/status`);
          updates[doc.id] = status;
        } catch { /* ignore */ }
      })
    );
    setDocStatuses(prev => ({ ...prev, ...updates }));

    const anyComplete = Object.values(updates).some(s => s.ingestion_status === 'complete');
    if (anyComplete) fetchDocs();

    return needsStatus.length > 0;
  };

  useEffect(() => {
    fetchDocs();
  }, []);

  useEffect(() => {
    if (pollingRef.current) clearInterval(pollingRef.current);
    pollPendingStatuses(docs);
    const hasActive = docs.some(d => {
      const s = d.ingestion_status;
      return !s || s === 'pending' || isActiveStatus(s);
    });
    if (hasActive) {
      pollingRef.current = setInterval(() => pollPendingStatuses(docs), 4000);
    }
    return () => { if (pollingRef.current) clearInterval(pollingRef.current); };
  }, [docs.length]);

  const handleUpload = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setUploading(true);
    const formData = new FormData();
    formData.append('file', file);
    formData.append('document_type', docType);
    if (clientName) formData.append('client_name', clientName);
    try {
      await api.post<{ document_id: string }>('/documents/upload', formData);
      toast({ title: 'Upload queued!', description: 'Document will be indexed in a moment.', variant: 'success' });
      if (fileRef.current) fileRef.current.value = '';
      setClientName('');
      setTimeout(fetchDocs, 1000);
    } catch (err) {
      toast({ title: 'Upload failed', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' });
    } finally { setUploading(false); }
  };

  const handleDelete = async (id: string, filename: string) => {
    if (!confirm(`Delete "${filename}" and all its chunks?`)) return;
    try {
      await api.delete(`/documents/${id}`);
      setDocs(prev => prev.filter(d => d.id !== id));
      setDocStatuses(prev => { const n = { ...prev }; delete n[id]; return n; });
      toast({ title: 'Document deleted' });
    } catch { toast({ title: 'Delete failed', variant: 'destructive' }); }
  };

  const totalChunks = docs.reduce((s, d) => s + (d.chunk_count || 0), 0);
  const totalTokens = Object.values(docStatuses).reduce((s, st) => s + (st.embedding_tokens || 0), 0);
  const totalCost   = Object.values(docStatuses).reduce((s, st) => s + (st.embedding_cost_usd || 0), 0);

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      {/* ── Header ── */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Knowledge Base</h1>
          <p className="text-muted-foreground mt-1">
            {docs.length} document{docs.length !== 1 ? 's' : ''} · {totalChunks.toLocaleString()} chunks indexed
          </p>
        </div>
        {totalTokens > 0 && (
          <div className="text-right text-xs text-muted-foreground space-y-1">
            <div className="flex items-center justify-end space-x-1">
              <Cpu className="h-3 w-3" /><span>Titan Text v2</span>
            </div>
            <div className="flex items-center justify-end space-x-1">
              <Coins className="h-3 w-3" />
              <span>{totalTokens.toLocaleString()} tokens · ${totalCost.toFixed(5)}</span>
            </div>
          </div>
        )}
      </div>

      {/* ── Upload Card (unchanged) ── */}
      <Card>
        <CardHeader>
          <CardTitle>Upload Document</CardTitle>
          <CardDescription>PDF, DOCX or TXT — max 50MB</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid sm:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label>Document Type</Label>
              <Select value={docType} onValueChange={setDocType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {DOC_TYPES.map(t => <SelectItem key={t} value={t}>{t.replace('_', ' ')}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Client Name (optional)</Label>
              <Input placeholder="e.g. Acme Corp" value={clientName} onChange={e => setClientName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>File</Label>
              <input
                ref={fileRef}
                type="file"
                accept=".pdf,.docx,.txt"
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </div>
          </div>
          <Button onClick={handleUpload} disabled={uploading}>
            {uploading
              ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Uploading...</>
              : <><Upload className="mr-2 h-4 w-4" />Upload & Index</>}
          </Button>
        </CardContent>
      </Card>

      {/* ── Document Grid ── */}
      {loading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
          {Array.from({ length: 10 }).map((_, i) => (
            <Skeleton key={i} className="h-40 w-full rounded-lg" />
          ))}
        </div>
      ) : docs.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center py-12 text-center">
            <BookOpen className="h-12 w-12 text-muted-foreground mb-4" />
            <p className="font-medium">No documents yet</p>
            <p className="text-sm text-muted-foreground">Upload your first document to build the knowledge base.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
          {docs.map(doc => (
            <DocCard
              key={doc.id}
              doc={doc}
              liveStatus={docStatuses[doc.id]}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}
