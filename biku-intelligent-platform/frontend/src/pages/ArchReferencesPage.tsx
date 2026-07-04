import { useEffect, useState, useRef } from 'react';
import { Trash2, Upload, X, Loader2, Image as ImageIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/misc';
import { useToast } from '@/components/ui/use-toast';
import { api } from '@/lib/api';

// ─── Constants ────────────────────────────────────────────────────────────────

const ENGAGEMENT_TYPES = [
  { value: 'general', label: 'General' },
  { value: 'aws_migration', label: 'AWS Migration' },
  { value: 'data_platform', label: 'Data Platform' },
  { value: 'managed_services', label: 'Managed Services' },
  { value: 'security_audit', label: 'Security Audit' },
  { value: 'devops_transformation', label: 'DevOps Transformation' },
  { value: 'ai_ml_platform', label: 'AI/ML Platform' },
  { value: 'cloud_native_development', label: 'Cloud Native Development' },
  { value: 'finops_optimization', label: 'FinOps Optimization' },
  { value: 'cloud_adoption', label: 'Cloud Adoption' },
  { value: 'disaster_recovery', label: 'Disaster Recovery' },
  { value: 'cloud_optimization', label: 'Cloud Optimization' },
  { value: 'other', label: 'Other' },
];

// ─── Types ────────────────────────────────────────────────────────────────────

interface ArchReference {
  id: string;
  name: string;
  description: string | null;
  engagement_type: string;
  preview_url: string | null;
  created_at: string | null;
}

// ─── Simple Lightbox ──────────────────────────────────────────────────────────

interface LightboxProps {
  ref_item: ArchReference;
  onClose: () => void;
}

function RefLightbox({ ref_item, onClose }: LightboxProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm"
      onClick={onClose}
      aria-modal="true"
      role="dialog"
      aria-label={ref_item.name}
    >
      <div
        className="relative bg-background rounded-xl shadow-2xl w-full max-w-5xl mx-4 max-h-[90vh] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b shrink-0">
          <div>
            <h2 className="text-lg font-semibold">{ref_item.name}</h2>
            {ref_item.description && (
              <p className="text-sm text-muted-foreground mt-0.5">{ref_item.description}</p>
            )}
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 hover:bg-muted transition-colors"
            aria-label="Close lightbox"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Image */}
        <div className="flex-1 overflow-auto p-4 flex items-center justify-center bg-white dark:bg-zinc-900">
          {ref_item.preview_url ? (
            <img
              src={ref_item.preview_url}
              alt={ref_item.name}
              className="max-w-full max-h-[70vh] object-contain rounded"
            />
          ) : (
            <div className="flex flex-col items-center gap-2 text-muted-foreground py-20">
              <ImageIcon className="h-12 w-12" />
              <p>No preview available.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Reference Card ───────────────────────────────────────────────────────────

interface RefCardProps {
  item: ArchReference;
  onDelete: (id: string) => void;
  onOpen: (item: ArchReference) => void;
  deleting: boolean;
}

function RefCard({ item, onDelete, onOpen, deleting }: RefCardProps) {
  const [hovered, setHovered] = useState(false);
  const engLabel = ENGAGEMENT_TYPES.find(e => e.value === item.engagement_type)?.label ?? item.engagement_type;

  return (
    <Card
      className="relative overflow-hidden group cursor-pointer hover:shadow-md transition-shadow"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Thumbnail */}
      <div
        className="relative bg-muted flex items-center justify-center overflow-hidden"
        style={{ aspectRatio: '4/3' }}
        onClick={() => item.preview_url && onOpen(item)}
        aria-label={`View ${item.name}`}
        role="button"
        tabIndex={0}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); item.preview_url && onOpen(item); } }}
      >
        {item.preview_url ? (
          <img
            src={item.preview_url}
            alt={item.name}
            className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-105"
          />
        ) : (
          <div className="flex flex-col items-center gap-1 text-muted-foreground py-4">
            <ImageIcon className="h-8 w-8" />
            <span className="text-xs">PDF — no preview</span>
          </div>
        )}

        {/* Delete button on hover */}
        {hovered && (
          <button
            className="absolute top-2 right-2 rounded-md bg-destructive text-destructive-foreground p-1.5 shadow hover:opacity-90 transition-opacity"
            onClick={e => { e.stopPropagation(); onDelete(item.id); }}
            aria-label={`Delete ${item.name}`}
            disabled={deleting}
          >
            {deleting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
          </button>
        )}
      </div>

      {/* Card body */}
      <CardContent className="px-3 py-2.5 space-y-1">
        <p className="text-sm font-medium leading-tight truncate" title={item.name}>
          {item.name}
        </p>
        <Badge variant="secondary" className="text-xs px-1.5 py-0">
          {engLabel}
        </Badge>
        {item.description && (
          <p className="text-xs text-muted-foreground line-clamp-2">{item.description}</p>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function ArchReferencesPage() {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Data state
  const [references, setReferences] = useState<ArchReference[]>([]);
  const [loadingList, setLoadingList] = useState(true);

  // Upload form state
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [engagementType, setEngagementType] = useState('general');
  const [uploading, setUploading] = useState(false);

  // Delete state: tracks which id is being deleted
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Lightbox state
  const [lightboxItem, setLightboxItem] = useState<ArchReference | null>(null);

  // ── Fetch ──────────────────────────────────────────────────────────────────
  const fetchReferences = async () => {
    try {
      const data = await api.get<{ references: ArchReference[] }>('/arch-references');
      setReferences(data.references);
    } catch {
      toast({ title: 'Failed to load references', variant: 'destructive' });
    } finally {
      setLoadingList(false);
    }
  };

  useEffect(() => { fetchReferences(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Upload ──────────────────────────────────────────────────────────────────
  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file || !name.trim()) return;

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('name', name.trim());
      formData.append('description', description.trim());
      formData.append('engagement_type', engagementType);

      await api.post('/arch-references', formData);

      toast({ title: 'Reference uploaded!', description: `"${name.trim()}" added successfully.`, variant: 'success' });

      // Reset form
      setFile(null);
      setName('');
      setDescription('');
      setEngagementType('general');
      if (fileInputRef.current) fileInputRef.current.value = '';

      // Refresh list
      await fetchReferences();
    } catch (err) {
      toast({
        title: 'Upload failed',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setUploading(false);
    }
  };

  // ── Delete ──────────────────────────────────────────────────────────────────
  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await api.delete(`/arch-references/${id}`);
      setReferences(prev => prev.filter(r => r.id !== id));
      toast({ title: 'Reference deleted', variant: 'success' });
    } catch (err) {
      toast({
        title: 'Delete failed',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setDeletingId(null);
    }
  };

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <>
      <div className="max-w-6xl mx-auto space-y-8">
        {/* Page header */}
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Architecture References</h1>
          <p className="text-muted-foreground mt-1">
            Upload sample AWS architecture diagrams. These are used as style and structure references when generating new architecture diagrams.
          </p>
        </div>

        {/* Upload form */}
        <Card>
          <CardContent className="pt-6">
            <form onSubmit={handleUpload} className="space-y-4">
              <h2 className="text-base font-semibold">Upload New Reference</h2>

              {/* File picker */}
              <div className="space-y-1.5">
                <Label htmlFor="ref-file">
                  Diagram File <span className="text-destructive">*</span>
                  <span className="text-muted-foreground font-normal ml-1">(PNG, JPG, or PDF · max 20 MB)</span>
                </Label>
                <Input
                  id="ref-file"
                  ref={fileInputRef}
                  type="file"
                  accept=".png,.jpg,.jpeg,.pdf"
                  onChange={e => setFile(e.target.files?.[0] ?? null)}
                  disabled={uploading}
                  className="cursor-pointer"
                />
                {file && (
                  <p className="text-xs text-muted-foreground">
                    Selected: <span className="font-medium">{file.name}</span> ({(file.size / 1024).toFixed(0)} KB)
                  </p>
                )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Name */}
                <div className="space-y-1.5">
                  <Label htmlFor="ref-name">
                    Name <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="ref-name"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    placeholder="e.g. Three-tier web app with RDS"
                    disabled={uploading}
                    required
                  />
                </div>

                {/* Engagement type */}
                <div className="space-y-1.5">
                  <Label htmlFor="ref-engagement">Engagement Type</Label>
                  <Select value={engagementType} onValueChange={setEngagementType} disabled={uploading}>
                    <SelectTrigger id="ref-engagement">
                      <SelectValue placeholder="Select type" />
                    </SelectTrigger>
                    <SelectContent>
                      {ENGAGEMENT_TYPES.map(et => (
                        <SelectItem key={et.value} value={et.value}>{et.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Description */}
              <div className="space-y-1.5">
                <Label htmlFor="ref-description">Description <span className="text-muted-foreground font-normal">(optional)</span></Label>
                <Textarea
                  id="ref-description"
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  placeholder="Briefly describe what makes this diagram a good style reference…"
                  rows={2}
                  disabled={uploading}
                  className="resize-none"
                />
              </div>

              <Button type="submit" disabled={uploading || !file || !name.trim()}>
                {uploading ? (
                  <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Uploading…</>
                ) : (
                  <><Upload className="mr-2 h-4 w-4" />Upload Reference</>
                )}
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* Reference grid */}
        <div>
          <h2 className="text-base font-semibold mb-4">
            Saved References
            {!loadingList && references.length > 0 && (
              <span className="ml-2 text-sm font-normal text-muted-foreground">({references.length})</span>
            )}
          </h2>

          {/* Loading skeleton */}
          {loadingList && (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="rounded-xl bg-muted animate-pulse" style={{ aspectRatio: '4/3' }} />
              ))}
            </div>
          )}

          {/* Empty state */}
          {!loadingList && references.length === 0 && (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center py-16 text-center">
                <ImageIcon className="h-12 w-12 text-muted-foreground mb-4" />
                <p className="font-semibold text-lg">No reference architectures yet.</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Upload your first one to guide the AI.
                </p>
              </CardContent>
            </Card>
          )}

          {/* Cards grid */}
          {!loadingList && references.length > 0 && (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
              {references.map(item => (
                <RefCard
                  key={item.id}
                  item={item}
                  onDelete={handleDelete}
                  onOpen={setLightboxItem}
                  deleting={deletingId === item.id}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Lightbox */}
      {lightboxItem && (
        <RefLightbox
          ref_item={lightboxItem}
          onClose={() => setLightboxItem(null)}
        />
      )}
    </>
  );
}
