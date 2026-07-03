import { useEffect, useState, useRef } from 'react';
import { Upload, Download, Trash2, FileCheck, FileX, Loader2, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/misc';
import { Badge } from '@/components/ui/misc';
import { useToast } from '@/components/ui/use-toast';
import { api } from '@/lib/api';

interface Template {
  template_type: string;
  exists: boolean;
  size_kb: number | null;
  last_modified: string | null;
  s3_key: string;
}

const TYPE_LABELS: Record<string, string> = {
  proposal: 'Proposal',
  sow: 'Statement of Work',
  case_study: 'Case Study',
};

export function TemplatesPage() {
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [selectedType, setSelectedType] = useState('proposal');

  const fetchTemplates = async () => {
    try {
      const data = await api.get<{ templates: Template[] }>('/templates');
      setTemplates(data.templates);
    } catch {
      toast({ title: 'Failed to load templates', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchTemplates(); }, []);

  const handleUpload = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    if (!file.name.endsWith('.docx')) {
      toast({ title: 'Invalid file type', description: 'Please upload a .docx file', variant: 'destructive' });
      return;
    }

    setUploading(true);
    const formData = new FormData();
    formData.append('file', file);
    formData.append('template_type', selectedType);

    try {
      await api.post('/templates/upload', formData);
      toast({
        title: 'Template uploaded!',
        description: `Your ${TYPE_LABELS[selectedType]} template is now active. New generations will use it.`,
        variant: 'success',
      });
      if (fileRef.current) fileRef.current.value = '';
      fetchTemplates();
    } catch (err) {
      toast({ title: 'Upload failed', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' });
    } finally {
      setUploading(false); }
  };

  const handleDownload = async (templateType: string) => {
    try {
      const data = await api.get<{ download_url: string }>(`/templates/${templateType}/download`);
      window.open(data.download_url, '_blank');
    } catch {
      toast({ title: 'Download failed', variant: 'destructive' });
    }
  };

  const handleDelete = async (templateType: string) => {
    if (!confirm(`Remove the ${TYPE_LABELS[templateType]} template? The system will use the default Genese template instead.`)) return;
    try {
      await api.delete(`/templates/${templateType}`);
      toast({ title: 'Template removed' });
      fetchTemplates();
    } catch {
      toast({ title: 'Delete failed', variant: 'destructive' });
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Proposal Templates</h1>
        <p className="text-muted-foreground mt-1">
          Upload your branded .docx templates. Claude's generated content will be filled into your template's structure.
        </p>
      </div>

      {/* How it works */}
      <Alert>
        <Info className="h-4 w-4" />
        <AlertDescription>
          <strong>How it works:</strong> Upload a .docx file with your preferred layout, branding, and section headings.
          When you generate a proposal, the system uses your template as the base and fills in Claude's AI-generated content.
          If no template is uploaded, the default Genese branded template is used.
        </AlertDescription>
      </Alert>

      {/* Upload */}
      <Card>
        <CardHeader>
          <CardTitle>Upload Template</CardTitle>
          <CardDescription>
            Upload a .docx file with your preferred branding and structure (max 20MB)
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Document Type</Label>
              <Select value={selectedType} onValueChange={setSelectedType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(TYPE_LABELS).map(([val, label]) => (
                    <SelectItem key={val} value={val}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Template File (.docx)</Label>
              <input
                ref={fileRef}
                type="file"
                accept=".docx"
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </div>
          </div>
          <Button onClick={handleUpload} disabled={uploading}>
            {uploading
              ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Uploading...</>
              : <><Upload className="mr-2 h-4 w-4" />Upload Template</>}
          </Button>
        </CardContent>
      </Card>

      {/* Current templates */}
      <div className="space-y-3">
        <h2 className="text-lg font-semibold">Current Templates</h2>
        {loading ? (
          <div className="text-sm text-muted-foreground">Loading...</div>
        ) : (
          templates.map((tmpl) => (
            <Card key={tmpl.template_type}>
              <CardContent className="flex items-center justify-between py-4 px-6">
                <div className="flex items-center space-x-4">
                  {tmpl.exists
                    ? <FileCheck className="h-8 w-8 text-green-600 shrink-0" />
                    : <FileX className="h-8 w-8 text-muted-foreground shrink-0" />}
                  <div>
                    <div className="flex items-center space-x-2">
                      <p className="font-medium">{TYPE_LABELS[tmpl.template_type]}</p>
                      <Badge variant={tmpl.exists ? 'default' : 'secondary'} className="text-xs">
                        {tmpl.exists ? 'Custom template active' : 'Using default template'}
                      </Badge>
                    </div>
                    {tmpl.exists ? (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {tmpl.size_kb}KB · Last updated: {tmpl.last_modified ? new Date(tmpl.last_modified).toLocaleDateString() : '—'}
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        No custom template — upload one above to use your own branding
                      </p>
                    )}
                  </div>
                </div>

                {tmpl.exists && (
                  <div className="flex items-center space-x-2">
                    <Button variant="outline" size="sm" onClick={() => handleDownload(tmpl.template_type)}>
                      <Download className="h-4 w-4 mr-1.5" />Download
                    </Button>
                    <Button
                      variant="ghost" size="icon"
                      className="text-destructive hover:text-destructive"
                      onClick={() => handleDelete(tmpl.template_type)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
