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

// Ingestion status badge styling
function StatusBadge({ status }: { status?: string }) {
  if (!status || status === 'pending') return (
    <span className="flex items-center space-x-1 text-xs text-muted-foreground">
      <Clock className="h-3 w-3" /><span>Pending</span>
    </span>
  );
  if (['processing', 'loading', 'chunking', 'embedding', 'storing'].includes(status)) return (
    <span className="flex items-center space-x-1 text-xs text-blue-600">
      <Loader2 className="h-3 w-3 animate-spin" />
      <span>{status === 'loading' ? 'Loading...' :
             status === 'chunking' ? 'Chunking...' :
             status === 'embedding' ? 'Embedding...' :
             status === 'storing' ? 'Storing...' : 'Indexing...'}</span>
    </span>
  );
  if (status === 'complete') return (
    <span className="flex items-center space-x-1 text-xs text-green-600">
      <CheckCircle2 className="h-3 w-3" /><span>Indexed</span>
    </span>
  );
  if (status === 'failed') return (
    <span className="flex items-center space-x-1 text-xs text-destructive">
      <AlertTriangle className="h-3 w-3" /><span>Failed</span>
    </span>
  );
  return <span className="text-xs text-muted-foreground">{status}</span>;
}

function modelShort(id?: string) {
  if (!id) return 'Titan Text v2';
  if (id.includes('titan-embed-text-v2')) return 'Titan Text v2';
  return id.split('/').pop() || id;
}

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
    // Fetch status for: pending/processing docs (for live progress) AND
    // complete docs that have 0 tokens (to show cost data)
    const needsStatus = currentDocs.filter(d => {
      const status = d.ingestion_status;
      const missingTokens = !d.embedding_tokens || d.embedding_tokens === 0;
      return !status || status === 'pending' || ['loading','chunking','embedding','storing'].includes(status) || (status === 'complete' && missingTokens);
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

    // Re-fetch full doc list when something completes to update chunk_count
    const anyComplete = Object.values(updates).some(s => s.ingestion_status === 'complete');
    if (anyComplete) fetchDocs();

    return needsStatus.length > 0;
  };

  useEffect(() => {
    fetchDocs();
  }, []);

  // Start polling when docs change
  useEffect(() => {
    if (pollingRef.current) clearInterval(pollingRef.current);
    // Initial fetch of all statuses (including complete ones missing tokens)
    pollPendingStatuses(docs);
    // Keep polling only if there are active docs
    const hasActive = docs.some(d => {
      const s = d.ingestion_status;
      return !s || s === 'pending' || ['loading','chunking','embedding','storing'].includes(s);
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
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Knowledge Base</h1>
          <p className="text-muted-foreground mt-1">
            {docs.length} document{docs.length !== 1 ? 's' : ''} · {totalChunks.toLocaleString()} chunks indexed
          </p>
        </div>
        {/* KB-wide token summary */}
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

      {/* Upload Card */}
      <Card>
        <CardHeader><CardTitle>Upload Document</CardTitle><CardDescription>PDF, DOCX or TXT — max 50MB</CardDescription></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid sm:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label>Document Type</Label>
              <Select value={docType} onValueChange={setDocType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{DOC_TYPES.map(t => <SelectItem key={t} value={t}>{t.replace('_', ' ')}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Client Name (optional)</Label>
              <Input placeholder="e.g. Acme Corp" value={clientName} onChange={e => setClientName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>File</Label>
              <input ref={fileRef} type="file" accept=".pdf,.docx,.txt"
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
            </div>
          </div>
          <Button onClick={handleUpload} disabled={uploading}>
            {uploading ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Uploading...</> : <><Upload className="mr-2 h-4 w-4" />Upload & Index</>}
          </Button>
        </CardContent>
      </Card>

      {/* Document list */}
      <div className="space-y-3">
        {loading ? (
          Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-24 w-full" />)
        ) : docs.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center py-12 text-center">
              <BookOpen className="h-12 w-12 text-muted-foreground mb-4" />
              <p className="font-medium">No documents yet</p>
              <p className="text-sm text-muted-foreground">Upload your first document to build the knowledge base.</p>
            </CardContent>
          </Card>
        ) : (
          docs.map(doc => {
            const liveStatus = docStatuses[doc.id];
            const status   = liveStatus?.ingestion_status || doc.ingestion_status || 'pending';
            const chunks   = liveStatus?.chunk_count      || doc.chunk_count       || 0;
            const tokens   = liveStatus?.embedding_tokens  || doc.embedding_tokens  || 0;
            const costUsd  = liveStatus?.embedding_cost_usd || 0;
            const model    = liveStatus?.embedding_model   || doc.embedding_model;

            return (
              <Card key={doc.id} className={status === 'processing' ? 'border-blue-200 dark:border-blue-800' : ''}>
                <CardContent className="flex items-start justify-between py-4 px-6">
                  <div className="flex items-start space-x-4 flex-1 min-w-0">
                    <FileText className="h-8 w-8 text-primary shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center space-x-2 flex-wrap gap-y-1">
                        <p className="font-medium truncate">{doc.filename}</p>
                        <StatusBadge status={status} />
                      </div>

                      {/* Metadata row */}
                      <div className="flex items-center flex-wrap gap-x-3 gap-y-1 mt-1">
                        <Badge variant="outline" className="text-xs">{doc.document_type}</Badge>
                        {doc.client_name && <span className="text-xs text-muted-foreground">{doc.client_name}</span>}
                        {chunks > 0 && (
                          <span className="text-xs text-muted-foreground">{chunks} chunks</span>
                        )}
                        <span className="text-xs text-muted-foreground">
                          {new Date(doc.created_at).toLocaleDateString()}
                        </span>
                      </div>

                      {/* Token + cost row — shows after indexing completes */}
                      {tokens > 0 && (
                        <div className="flex items-center space-x-3 mt-2 text-xs">
                          <span className="flex items-center space-x-1 text-muted-foreground">
                            <Cpu className="h-3 w-3" />
                            <span>{modelShort(model)}</span>
                          </span>
                          <span className="text-muted-foreground">
                            {tokens.toLocaleString()} tokens
                          </span>
                          <span className="flex items-center space-x-1 text-primary font-medium">
                            <Coins className="h-3 w-3" />
                            <span>${costUsd.toFixed(5)}</span>
                          </span>
                        </div>
                      )}

                      {/* Phases breakdown — visible during processing */}
                      {(status === 'processing' || status === 'loading' || status === 'chunking' ||
                        status === 'embedding' || status === 'storing') && liveStatus?.phases && (
                        <div className="mt-2 space-y-1">
                          {liveStatus.phases.map(phase => (
                            <div key={phase.key} className="flex items-center space-x-2 text-xs">
                              <div className={`w-3 h-3 rounded-full flex-shrink-0 flex items-center justify-center
                                ${phase.state === 'done' ? 'bg-green-500' :
                                  phase.state === 'active' ? 'bg-blue-500' : 'bg-muted'}`}>
                                {phase.state === 'active' && <Loader2 className="h-2 w-2 text-white animate-spin" />}
                                {phase.state === 'done' && <span className="text-white text-[8px]">✓</span>}
                              </div>
                              <span className={
                                phase.state === 'active' ? 'text-blue-600 font-medium' :
                                phase.state === 'done' ? 'text-muted-foreground line-through' :
                                'text-muted-foreground'
                              }>
                                {phase.state === 'active' ? phase.description : phase.label}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  <Button
                    variant="ghost" size="icon"
                    className="text-destructive hover:text-destructive shrink-0 ml-2"
                    onClick={() => handleDelete(doc.id, doc.filename)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </CardContent>
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}
