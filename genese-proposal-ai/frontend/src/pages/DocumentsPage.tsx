import { useEffect, useState, useRef } from 'react';
import { Upload, Trash2, BookOpen, Loader2, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Badge, Skeleton } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { useToast } from '@/components/ui/use-toast';

interface Doc { id: string; filename: string; document_type: string; engagement_type?: string; client_name?: string; chunk_count: number; created_at: string; }

const DOC_TYPES = ['proposal', 'sow', 'case_study', 'other'];

export function DocumentsPage() {
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [docType, setDocType] = useState('proposal');
  const [clientName, setClientName] = useState('');

  const fetchDocs = async () => {
    try {
      const data = await api.get<{ documents: Doc[] }>('/documents');
      setDocs(data.documents);
    } catch { toast({ title: 'Failed to load documents', variant: 'destructive' }); }
    finally { setLoading(false); }
  };

  useEffect(() => { fetchDocs(); }, []);

  const handleUpload = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setUploading(true);
    const formData = new FormData();
    formData.append('file', file);
    formData.append('document_type', docType);
    if (clientName) formData.append('client_name', clientName);
    try {
      await api.post('/documents/upload', formData);
      toast({ title: 'Document uploaded!', description: 'Ingestion started — chunks will be available shortly.', variant: 'success' });
      if (fileRef.current) fileRef.current.value = '';
      setClientName('');
      setTimeout(fetchDocs, 3000); // re-fetch after ingestion starts
    } catch (err) {
      toast({ title: 'Upload failed', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' });
    } finally { setUploading(false); }
  };

  const handleDelete = async (id: string, filename: string) => {
    if (!confirm(`Delete "${filename}" and all its chunks?`)) return;
    try {
      await api.delete(`/documents/${id}`);
      setDocs(prev => prev.filter(d => d.id !== id));
      toast({ title: 'Document deleted' });
    } catch { toast({ title: 'Delete failed', variant: 'destructive' }); }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Knowledge Base</h1>
        <p className="text-muted-foreground mt-1">{docs.length} document{docs.length !== 1 ? 's' : ''} · {docs.reduce((s, d) => s + d.chunk_count, 0)} chunks indexed</p>
      </div>

      {/* Upload Card */}
      <Card>
        <CardHeader><CardTitle>Upload Document</CardTitle><CardDescription>PDF, DOCX, or TXT — max 50MB</CardDescription></CardHeader>
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
              <input ref={fileRef} type="file" accept=".pdf,.docx,.txt" className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
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
          Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-20 w-full" />)
        ) : docs.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center py-12 text-center">
              <BookOpen className="h-12 w-12 text-muted-foreground mb-4" />
              <p className="font-medium">No documents yet</p>
              <p className="text-sm text-muted-foreground">Upload your first proposal or SoW to build the knowledge base.</p>
            </CardContent>
          </Card>
        ) : (
          docs.map(doc => (
            <Card key={doc.id}>
              <CardContent className="flex items-center justify-between py-4 px-6">
                <div className="flex items-center space-x-4">
                  <FileText className="h-8 w-8 text-primary shrink-0" />
                  <div>
                    <p className="font-medium">{doc.filename}</p>
                    <div className="flex items-center space-x-2 mt-1">
                      <Badge variant="outline" className="text-xs">{doc.document_type}</Badge>
                      {doc.client_name && <span className="text-xs text-muted-foreground">{doc.client_name}</span>}
                      <span className="text-xs text-muted-foreground">{doc.chunk_count} chunks</span>
                      <span className="text-xs text-muted-foreground">{new Date(doc.created_at).toLocaleDateString()}</span>
                    </div>
                  </div>
                </div>
                <Button variant="ghost" size="icon" className="text-destructive hover:text-destructive" onClick={() => handleDelete(doc.id, doc.filename)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
