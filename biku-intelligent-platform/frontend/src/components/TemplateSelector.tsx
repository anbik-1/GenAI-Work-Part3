/**
 * TemplateSelector — lets the user pick a template before generating.
 * Fetches existing templates from /templates, shows them as selectable cards.
 * Also allows inline upload of a new template.
 */
import { useEffect, useState, useRef } from 'react';
import { Upload, CheckCircle2, FileText, Loader2, ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';
import { useToast } from '@/components/ui/use-toast';

interface Template {
  template_type: string;
  exists: boolean;
  size_kb: number | null;
  last_modified: string | null;
}

interface Props {
  docType: string;
  onChange: (templateName: string | null, plainTextInstructions?: string) => void;
}

export function TemplateSelector({ docType, onChange }: Props) {
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);

  const [templates, setTemplates] = useState<Template[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [collapsed, setCollapsed] = useState(true);
  const [plainTextInstructions, setPlainTextInstructions] = useState('');

  const fetchTemplates = async () => {
    try {
      const data = await api.get<{ templates: Template[] }>('/templates');
      setTemplates(data.templates);
    } catch { /* silent */ }
  };

  useEffect(() => { fetchTemplates(); }, []);

  // When docType changes, reset selection if it no longer matches
  useEffect(() => {
    if (selected && selected !== 'default' && selected !== 'plain_text' && selected !== docType) {
      setSelected(null);
      onChange(null);
    }
  }, [docType]);

  // When plainTextInstructions changes and plain_text is selected, notify parent
  useEffect(() => {
    if (selected === 'plain_text') {
      onChange('plain_text', plainTextInstructions);
    }
  }, [plainTextInstructions]);

  const handleSelect = (value: string | null) => {
    setSelected(value);
    if (value === 'plain_text') {
      onChange('plain_text', plainTextInstructions);
    } else {
      onChange(value === 'default' || value === null ? null : value, undefined);
    }
  };

  const handleUpload = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    if (!file.name.endsWith('.docx')) {
      toast({ title: 'Only .docx files are allowed', variant: 'destructive' });
      return;
    }
    setUploading(true);
    const formData = new FormData();
    formData.append('file', file);
    formData.append('template_type', docType);
    try {
      await api.post('/templates/upload', formData);
      toast({ title: 'Template uploaded!', description: `Template for ${docType} saved.`, variant: 'success' });
      if (fileRef.current) fileRef.current.value = '';
      setShowUpload(false);
      await fetchTemplates();
      // Auto-select the just-uploaded template
      handleSelect(docType);
    } catch (err) {
      toast({ title: 'Upload failed', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' });
    } finally {
      setUploading(false);
    }
  };

  // Templates that match the current docType or exist for any type
  const relevantTemplates = templates.filter(t => t.exists);
  const matchingTemplate = templates.find(t => t.template_type === docType && t.exists);

  const hasAny = relevantTemplates.length > 0;
  const selectionLabel = selected === null || selected === 'default'
    ? 'Default (built-in)'
    : selected === 'plain_text'
    ? 'Plain Text'
    : `Custom: ${selected}`;

  return (
    <div className="space-y-2">
      {/* Collapsible header */}
      <button
        type="button"
        className="flex items-center justify-between w-full text-left"
        onClick={() => setCollapsed(c => !c)}
      >
        <Label className="cursor-pointer flex items-center space-x-2">
          {collapsed ? <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
          <span>Document Template</span>
          {selected && selected !== 'default' && (
            <span className="ml-2 text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full font-normal">
              {selectionLabel}
            </span>
          )}
        </Label>
        <span className="text-xs text-muted-foreground">optional</span>
      </button>

      {!collapsed && (
        <div className="space-y-3 pl-5 border-l-2 border-muted ml-1.5">
          {/* Template cards */}
          <div className="grid grid-cols-3 gap-2">
            {/* Default option */}
            <button
              type="button"
              onClick={() => handleSelect('default')}
              className={`relative flex flex-col items-start p-3 rounded-lg border text-left transition-all text-sm
                ${!selected || selected === 'default'
                  ? 'border-primary bg-primary/5 ring-1 ring-primary'
                  : 'border-border hover:border-primary/40 hover:bg-muted/50'}`}
            >
              <div className="flex items-center justify-between w-full mb-1">
                <FileText className="h-4 w-4 text-muted-foreground" />
                {(!selected || selected === 'default') && (
                  <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
                )}
              </div>
              <span className="font-medium">Default</span>
              <span className="text-xs text-muted-foreground">Built-in Genese template</span>
            </button>

            {/* Plain Text option */}
            <button
              type="button"
              onClick={() => handleSelect('plain_text')}
              className={`relative flex flex-col items-start p-3 rounded-lg border text-left transition-all text-sm
                ${selected === 'plain_text'
                  ? 'border-primary bg-primary/5 ring-1 ring-primary'
                  : 'border-border hover:border-primary/40 hover:bg-muted/50'}`}
            >
              <div className="flex items-center justify-between w-full mb-1">
                <FileText className="h-4 w-4 text-muted-foreground" />
                {selected === 'plain_text' && (
                  <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
                )}
              </div>
              <span className="font-medium">Plain Text</span>
              <span className="text-xs text-muted-foreground">Simple text format, no styling</span>
            </button>

            {/* Uploaded templates matching docType */}
            {matchingTemplate && (
              <button
                type="button"
                onClick={() => handleSelect(matchingTemplate.template_type)}
                className={`relative flex flex-col items-start p-3 rounded-lg border text-left transition-all text-sm
                  ${selected === matchingTemplate.template_type
                    ? 'border-primary bg-primary/5 ring-1 ring-primary'
                    : 'border-border hover:border-primary/40 hover:bg-muted/50'}`}
              >
                <div className="flex items-center justify-between w-full mb-1">
                  <FileText className="h-4 w-4 text-primary" />
                  {selected === matchingTemplate.template_type && (
                    <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
                  )}
                </div>
                <span className="font-medium capitalize">{matchingTemplate.template_type.replace(/_/g, ' ')}</span>
                <span className="text-xs text-muted-foreground">
                  {matchingTemplate.size_kb ? `${matchingTemplate.size_kb} KB` : 'Custom'} · uploaded
                </span>
              </button>
            )}
          </div>

          {/* Plain Text instructions — shown when plain_text is selected */}
          {selected === 'plain_text' && (
            <div className="space-y-2 mt-1">
              <Label className="text-xs text-muted-foreground">Plain Text Instructions (optional)</Label>
              <textarea
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm min-h-[80px] resize-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                placeholder="e.g. Use formal tone. Include a table of contents. Format pricing in NPR. Add page numbers. Keep each section under 2 paragraphs."
                value={plainTextInstructions}
                onChange={e => setPlainTextInstructions(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">These instructions guide how the plain text document is structured and formatted.</p>
            </div>
          )}

          {/* Upload new template toggle */}
          <div>
            <button
              type="button"
              className="text-xs text-primary hover:underline flex items-center space-x-1"
              onClick={() => setShowUpload(v => !v)}
            >
              <Upload className="h-3 w-3" />
              <span>{matchingTemplate ? 'Replace template' : 'Upload template for this type'}</span>
            </button>

            {showUpload && (
              <div className="mt-2 flex items-center space-x-2">
                <input
                  ref={fileRef}
                  type="file"
                  accept=".docx"
                  className="flex-1 h-9 rounded-md border border-input bg-background px-3 py-1 text-xs"
                />
                <Button
                  type="button"
                  size="sm"
                  onClick={handleUpload}
                  disabled={uploading}
                  className="h-9 shrink-0"
                >
                  {uploading
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <Upload className="h-3.5 w-3.5" />}
                </Button>
              </div>
            )}
          </div>

          {!hasAny && !showUpload && (
            <p className="text-xs text-muted-foreground">
              No custom templates uploaded yet. Using default Genese template.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
