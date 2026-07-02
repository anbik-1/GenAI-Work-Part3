import { useState } from 'react';
import { FileText, Download, ExternalLink, CheckCircle, Loader2, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/misc';
import { Progress } from '@/components/ui/misc';
import { Alert, AlertDescription } from '@/components/ui/misc';
import { useToast } from '@/components/ui/use-toast';
import { api } from '@/lib/api';
import { useJob } from '@/contexts/JobContext';

const DOC_TYPES = [
  { value: 'proposal', label: 'Proposal' },
  { value: 'sow', label: 'Statement of Work' },
  { value: 'case_study', label: 'Case Study' },
];

const ENGAGEMENT_TYPES = [
  { value: 'aws_migration', label: 'AWS Migration' },
  { value: 'data_platform', label: 'Data Platform' },
  { value: 'managed_services', label: 'Managed Services' },
  { value: 'security_audit', label: 'Security Audit' },
  { value: 'devops_transformation', label: 'DevOps Transformation' },
  { value: 'ai_ml_platform', label: 'AI/ML Platform' },
  { value: 'cloud_native_development', label: 'Cloud Native Development' },
  { value: 'finops_optimization', label: 'FinOps Optimization' },
];

const STATUS_STEPS = [
  { key: 'queued', label: 'Queued', progress: 10 },
  { key: 'retrieving_context', label: 'Searching knowledge base...', progress: 30 },
  { key: 'validating_sources', label: 'Validating official documentation...', progress: 50 },
  { key: 'drafting_document', label: 'Drafting document with AI...', progress: 75 },
  { key: 'formatting_output', label: 'Formatting branded output...', progress: 90 },
  { key: 'complete', label: 'Complete — ready for download!', progress: 100 },
];

export function GeneratePage() {
  const { toast } = useToast();
  const { activeJob, startPolling, clearJob } = useJob();

  const [docType, setDocType] = useState('proposal');
  const [clientName, setClientName] = useState('');
  const [engagementType, setEngagementType] = useState('aws_migration');
  const [requirements, setRequirements] = useState('');
  const [contextNotes, setContextNotes] = useState('');
  const [loading, setLoading] = useState(false);

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!clientName.trim() || !requirements.trim()) {
      toast({ title: 'Missing fields', description: 'Please fill in client name and key requirements.', variant: 'destructive' });
      return;
    }
    clearJob();
    setLoading(true);
    try {
      const result = await api.post<{ job_id: string }>('/generate', {
        document_type: docType, client_name: clientName,
        engagement_type: engagementType, key_requirements: requirements,
        context_notes: contextNotes || undefined,
      });
      toast({ title: 'Generation started!', description: 'Your document is being drafted. This takes 1–3 minutes.', variant: 'success' });
      startPolling(result.job_id);
    } catch (err) {
      toast({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to start generation', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  const step = STATUS_STEPS.find(s => s.key === activeJob?.status) || STATUS_STEPS[0];
  const isBusy = activeJob && !['complete', 'failed'].includes(activeJob.status);

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Generate Document</h1>
        <p className="text-muted-foreground mt-1">AI-powered proposals, SoWs, and case studies — Genese-branded and ready to edit.</p>
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        {/* Form */}
        <Card>
          <CardHeader><CardTitle>Document Details</CardTitle><CardDescription>Fill in the engagement context</CardDescription></CardHeader>
          <CardContent>
            <form onSubmit={handleGenerate} className="space-y-4">
              <div className="space-y-2">
                <Label>Document Type</Label>
                <Select value={docType} onValueChange={setDocType}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{DOC_TYPES.map(t => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="client">Client Name *</Label>
                <Input id="client" placeholder="e.g. ABC Financial Services" value={clientName} onChange={e => setClientName(e.target.value)} required />
              </div>
              <div className="space-y-2">
                <Label>Engagement Type</Label>
                <Select value={engagementType} onValueChange={setEngagementType}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{ENGAGEMENT_TYPES.map(t => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="req">Key Requirements *</Label>
                <Textarea id="req" placeholder="Describe the client's main requirements, challenges, and goals. The more detail, the better the output." className="min-h-[120px]" value={requirements} onChange={e => setRequirements(e.target.value)} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ctx">Additional Context (optional)</Label>
                <Textarea id="ctx" placeholder="Any specific technologies, constraints, or preferences..." className="min-h-[80px]" value={contextNotes} onChange={e => setContextNotes(e.target.value)} />
              </div>
              <Button type="submit" className="w-full" disabled={loading || !!isBusy}>
                {loading ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Starting...</> : <><FileText className="mr-2 h-4 w-4" />Generate Document</>}
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* Job Status */}
        <div className="space-y-4">
          {activeJob ? (
            <Card>
              <CardHeader><CardTitle>Generation Status</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                {activeJob.status === 'failed' ? (
                  <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>{activeJob.error_message || 'Generation failed. Please try again.'}</AlertDescription>
                  </Alert>
                ) : (
                  <>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">{step.label}</span>
                        <span className="font-medium">{step.progress}%</span>
                      </div>
                      <Progress value={step.progress} />
                    </div>
                    {activeJob.status === 'complete' && (
                      <div className="space-y-3">
                        <div className="flex items-center text-green-600 space-x-2">
                          <CheckCircle className="h-5 w-5" />
                          <span className="font-medium">Document ready!</span>
                        </div>
                        {activeJob.download_url && (
                          <Button className="w-full" asChild>
                            <a href={activeJob.download_url} download>
                              <Download className="mr-2 h-4 w-4" />Download .docx
                            </a>
                          </Button>
                        )}
                      </div>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          ) : (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center justify-center py-12 text-center">
                <FileText className="h-12 w-12 text-muted-foreground mb-4" />
                <p className="text-muted-foreground">Fill in the form and click Generate to create your branded document.</p>
              </CardContent>
            </Card>
          )}

          {/* Sources panel */}
          {activeJob?.rag_context && activeJob.rag_context.length > 0 && (
            <Card>
              <CardHeader><CardTitle className="text-base">Knowledge Base Sources Used</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {activeJob.rag_context.slice(0, 3).map((ctx, i) => (
                  <div key={i} className="text-sm border rounded p-2 space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="font-medium truncate">{ctx.source_document}</span>
                      <Badge variant="secondary" className="ml-2 shrink-0">{(ctx.similarity_score * 100).toFixed(0)}% match</Badge>
                    </div>
                    <p className="text-muted-foreground line-clamp-2">{ctx.excerpt}</p>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {activeJob?.tavily_sources && activeJob.tavily_sources.length > 0 && (
            <Card>
              <CardHeader><CardTitle className="text-base">Official Documentation Validated</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {activeJob.tavily_sources.map((src, i) => (
                  <div key={i} className="text-sm flex items-start space-x-2">
                    <ExternalLink className="h-3 w-3 mt-1 shrink-0 text-primary" />
                    <div>
                      <a href={src.url} target="_blank" rel="noopener noreferrer" className="font-medium hover:underline text-primary">{src.title}</a>
                      <p className="text-muted-foreground line-clamp-1">{src.excerpt}</p>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
