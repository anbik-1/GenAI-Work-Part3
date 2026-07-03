import { useState, useEffect } from 'react';
import { FileText, Download, ExternalLink, CheckCircle, Loader2, AlertCircle, Cpu, Coins, Zap, ThumbsUp, RefreshCw, ChevronDown, ChevronRight } from 'lucide-react';
import { TemplateSelector } from '@/components/TemplateSelector';
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
  { value: 'cloud_adoption', label: 'Cloud Adoption' },
  { value: 'disaster_recovery', label: 'Disaster Recovery' },
  { value: 'cloud_optimization', label: 'Cloud Optimization' },
  { value: 'other', label: 'Other' },
];

const CONSTRAINT_CHIPS = [
  { label: 'AWS Best Practices', text: 'Always follow AWS Well-Architected Framework best practices.' },
  { label: 'Reference Official Docs', text: 'Reference official AWS documentation for all services mentioned.' },
  { label: 'Serverless First', text: 'Prefer serverless architectures where possible.' },
  { label: 'Cost Optimized', text: 'Optimize for cost efficiency and include pricing estimates.' },
  { label: 'Security First', text: 'Prioritize security at every layer following AWS security best practices.' },
  { label: 'Multi-AZ HA', text: 'Design for high availability with Multi-AZ deployments.' },
];

// Step definitions with progress %
const PIPELINE_STEPS = [
  { key: 'queued',              label: 'Queued',                        pct: 5,   icon: '⏳' },
  { key: 'retrieving_context', label: 'Searching knowledge base...',   pct: 20,  icon: '🔍' },
  { key: 'validating_sources', label: 'Validating documentation...',  pct: 35,  icon: '🌐' },
  { key: 'drafting_document',  label: 'Claude is drafting...',        pct: 55,  icon: '✍️' },
  { key: 'generating_diagram', label: 'Designing architecture...',    pct: 70,  icon: '🏗️' },
  { key: 'awaiting_review',    label: 'Review architecture',          pct: 80,  icon: '👁' },
  { key: 'formatting_output',  label: 'Formatting .docx...',          pct: 92,  icon: '📄' },
  { key: 'complete',           label: 'Complete!',                     pct: 100, icon: '✅' },
];

// Friendly model name display
function modelLabel(id?: string) {
  if (!id) return 'Claude Sonnet 4.6';
  if (id.includes('claude-sonnet-4-6')) return 'Claude Sonnet 4.6';
  if (id.includes('claude-sonnet-4')) return 'Claude Sonnet 4';
  if (id.includes('claude-haiku')) return 'Claude Haiku';
  return id.split('/').pop() || id;
}

export function GeneratePage() {
  const { toast } = useToast();
  const { activeJob, startPolling, clearJob } = useJob();

  const [docType, setDocType] = useState('proposal');
  const [clientName, setClientName] = useState('');
  const [engagementType, setEngagementType] = useState('aws_migration');
  const [requirements, setRequirements] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
  const [contextNotes, setContextNotes] = useState('');
  const [generationConstraints, setGenerationConstraints] = useState('');
  const [constraintsOpen, setConstraintsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  // Architecture review state
  const [archPreviewUrl, setArchPreviewUrl] = useState<string | null>(null);
  const [archIteration, setArchIteration] = useState(0);
  const [archFeedback, setArchFeedback] = useState('');
  const [archLoading, setArchLoading] = useState(false);

  // Fetch architecture preview when status is awaiting_review
  useEffect(() => {
    if (activeJob?.status === 'awaiting_review' && activeJob.job_id) {
      api.get<{ preview_url: string; arch_iteration: number }>(`/generate/${activeJob.job_id}/architecture`)
        .then(data => {
          setArchPreviewUrl(data.preview_url);
          setArchIteration(data.arch_iteration);
        })
        .catch(() => {});
    }
  }, [activeJob?.status, activeJob?.job_id]);

  const handleApproveArch = async () => {
    if (!activeJob) return;
    setArchLoading(true);
    try {
      await api.post(`/generate/${activeJob.job_id}/approve`);
      toast({ title: 'Architecture approved!', description: 'Generating your final document now...', variant: 'success' });
      setArchPreviewUrl(null);
    } catch (err) {
      toast({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to approve', variant: 'destructive' });
    } finally {
      setArchLoading(false);
    }
  };

  const handleIterateArch = async () => {
    if (!activeJob || !archFeedback.trim()) return;
    setArchLoading(true);
    try {
      await api.post(`/generate/${activeJob.job_id}/iterate-architecture`, { feedback: archFeedback });
      toast({ title: 'Feedback submitted!', description: 'Revising architecture...', variant: 'success' });
      setArchFeedback('');
      setArchPreviewUrl(null);
    } catch (err) {
      toast({ title: 'Error', description: err instanceof Error ? err.message : 'Failed', variant: 'destructive' });
    } finally {
      setArchLoading(false);
    }
  };

  const handleAddConstraintChip = (text: string) => {
    setGenerationConstraints(prev => {
      const trimmed = prev.trim();
      if (!trimmed) return text;
      if (trimmed.includes(text)) return prev;
      return trimmed.endsWith('.') || trimmed.endsWith('\n')
        ? `${trimmed} ${text}`
        : `${trimmed}. ${text}`;
    });
    setConstraintsOpen(true);
  };

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!clientName.trim() || !requirements.trim()) {
      toast({ title: 'Missing fields', description: 'Please fill in client name and requirements.', variant: 'destructive' });
      return;
    }
    clearJob();
    setLoading(true);
    try {
      const result = await api.post<{ job_id: string }>('/generate', {
        document_type: docType, client_name: clientName,
        engagement_type: engagementType, key_requirements: requirements,
        context_notes: contextNotes || undefined,
        generation_constraints: generationConstraints.trim() || undefined,
        template_name: selectedTemplate || undefined,
      });
      toast({ title: 'Generation started!', description: 'Your document is being drafted. Sit tight.', variant: 'success' });
      startPolling(result.job_id);
    } catch (err) {
      toast({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to start', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  // Determine current step
  const currentStep = PIPELINE_STEPS.find(s => s.key === activeJob?.status) || PIPELINE_STEPS[0];
  const isBusy = activeJob && !['complete', 'failed'].includes(activeJob.status);

  // Cost and token display
  const inputTokens  = (activeJob as any)?.input_tokens  || 0;
  const outputTokens = (activeJob as any)?.output_tokens || 0;
  const totalTokens  = inputTokens + outputTokens;
  // Claude Sonnet 4.6: $0.003/1K input, $0.015/1K output
  const costUsd   = (inputTokens / 1000) * 0.003 + (outputTokens / 1000) * 0.015;
  const modelName = modelLabel((activeJob as any)?.llm_model);

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* ── Page Header ── */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Generate Document</h1>
        <p className="text-muted-foreground mt-1">AI-powered proposals, SoWs and case studies — Genese-branded, ready to edit.</p>
      </div>

      {/* ── Document Details Form ── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle>Document Details</CardTitle>
          <CardDescription>Complete the fields below to generate a branded proposal, SoW, or case study.</CardDescription>
        </CardHeader>
        <CardContent className="p-6 pt-2">
          <form onSubmit={handleGenerate} className="space-y-5">

            {/* Document Type */}
            <div className="space-y-2">
              <Label>Document Type</Label>
              <Select value={docType} onValueChange={setDocType}>
                <SelectTrigger className="h-11">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-background border shadow-lg z-50">
                  {DOC_TYPES.map(t => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            {/* Client Name */}
            <div className="space-y-2">
              <Label htmlFor="client">Client Name *</Label>
              <Input
                id="client"
                className="h-11"
                placeholder="e.g. Nepal Rastra Bank, Daraz Nepal"
                value={clientName}
                onChange={e => setClientName(e.target.value)}
                required
              />
            </div>

            {/* Engagement Type */}
            <div className="space-y-2">
              <Label>Engagement Type</Label>
              <Select value={engagementType} onValueChange={setEngagementType}>
                <SelectTrigger className="h-11">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-background border shadow-lg z-50">
                  {ENGAGEMENT_TYPES.map(t => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            {/* Key Requirements */}
            <div className="space-y-2">
              <Label htmlFor="req">Key Requirements *</Label>
              <Textarea
                id="req"
                placeholder="Describe the client's main requirements, challenges and goals..."
                className="min-h-[160px]"
                value={requirements}
                onChange={e => setRequirements(e.target.value)}
                required
              />
            </div>

            {/* Additional Context */}
            <div className="space-y-2">
              <Label htmlFor="ctx">Additional Context <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Textarea
                id="ctx"
                placeholder="Specific technologies, constraints, preferences..."
                className="min-h-[100px]"
                value={contextNotes}
                onChange={e => setContextNotes(e.target.value)}
              />
            </div>

            {/* Divider before collapsible sections */}
            <hr className="border-border my-2" />

            {/* ── Generation Constraints (collapsible) ── */}
            <div className="border rounded-lg overflow-hidden">
              <button
                type="button"
                className="w-full flex items-center justify-between px-3 py-2.5 text-sm font-medium hover:bg-muted/50 transition-colors"
                onClick={() => setConstraintsOpen(o => !o)}
                aria-expanded={constraintsOpen}
              >
                <span className="flex items-center gap-2">
                  Generation Constraints
                  <span className="text-xs font-normal text-muted-foreground">(optional)</span>
                  {generationConstraints.trim() && (
                    <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-primary text-primary-foreground text-[10px] font-bold">✓</span>
                  )}
                </span>
                {constraintsOpen
                  ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  : <ChevronRight className="h-4 w-4 text-muted-foreground" />
                }
              </button>

              {constraintsOpen && (
                <div className="px-3 pb-3 pt-1 space-y-3 border-t bg-muted/20">
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {CONSTRAINT_CHIPS.map(chip => (
                      <button
                        key={chip.label}
                        type="button"
                        onClick={() => handleAddConstraintChip(chip.text)}
                        className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium border border-primary/30 bg-primary/5 text-primary hover:bg-primary/15 hover:border-primary/50 transition-colors"
                      >
                        + {chip.label}
                      </button>
                    ))}
                  </div>
                  <Textarea
                    id="constraints"
                    placeholder="e.g. Always follow AWS Well-Architected Framework. Reference official AWS documentation. Prefer serverless where possible. Use Nepal rupee for pricing estimates."
                    className="min-h-[90px] text-sm"
                    value={generationConstraints}
                    onChange={e => setGenerationConstraints(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    These instructions will steer the AI's generation style, preferred services, and output format.
                  </p>
                </div>
              )}
            </div>

            {/* Template Selector */}
            <TemplateSelector docType={docType} onChange={setSelectedTemplate} />

            {/* Generate Button */}
            <Button type="submit" className="w-full h-12 text-base font-semibold" disabled={loading || !!isBusy}>
              {loading
                ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Starting...</>
                : <><FileText className="mr-2 h-4 w-4" />Generate Document</>
              }
            </Button>

            {/* Helper text */}
            <p className="text-center text-xs text-muted-foreground -mt-1">
              Takes 1–2 minutes · Architecture review included · Downloads as .docx
            </p>

          </form>
        </CardContent>
      </Card>

      {/* ── Status / Progress Panel (below form when a job is active) ── */}
      {activeJob && (
        <div className="mt-6 space-y-4">
          {/* Progress Card */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">Generation Progress</CardTitle>
                <div className="flex items-center space-x-1 text-xs bg-primary/10 text-primary px-2 py-1 rounded-full">
                  <Cpu className="h-3 w-3" />
                  <span>{modelName}</span>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {activeJob.status === 'failed' ? (
                <div className="space-y-3">
                  <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>
                      <p className="font-medium mb-1">Generation failed</p>
                      <p className="text-sm">
                        {activeJob.error_message === 'Cancelled by user'
                          ? 'You cancelled this generation.'
                          : activeJob.error_message?.includes('timeout') || activeJob.error_message?.includes('Timeout')
                          ? 'The AI model took too long to respond. This happens with very long documents. Please try again.'
                          : activeJob.error_message?.includes('ValidationException')
                          ? 'The request was invalid — try simplifying your requirements.'
                          : activeJob.error_message?.includes('ThrottlingException')
                          ? 'Too many requests at once. Please wait a moment and try again.'
                          : activeJob.error_message
                          ? `Error: ${activeJob.error_message.slice(0, 150)}`
                          : 'An unexpected error occurred. Please try again.'}
                      </p>
                    </AlertDescription>
                  </Alert>
                  <Button className="w-full" variant="outline" onClick={() => { clearJob(); }}>
                    Try Again
                  </Button>
                </div>
              ) : (
                <>
                  {/* Step-by-step progress */}
                  <div className="space-y-3">
                    {PIPELINE_STEPS.filter(s => s.key !== 'queued').map((step) => {
                      const stepIdx = PIPELINE_STEPS.findIndex(s => s.key === step.key);
                      const curIdx  = PIPELINE_STEPS.findIndex(s => s.key === activeJob.status);
                      const done    = stepIdx <= curIdx;
                      const active  = step.key === activeJob.status;
                      return (
                        <div key={step.key} className="flex items-center space-x-3">
                          <div className={`flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs
                            ${done && !active ? 'bg-green-500 text-white' : active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}>
                            {done && !active ? '\u2713' : active ? <Loader2 className="h-3 w-3 animate-spin" /> : stepIdx}
                          </div>
                          <span className={`text-sm ${active ? 'font-medium text-foreground' : done && !active ? 'text-muted-foreground line-through' : 'text-muted-foreground'}`}>
                            {step.label}
                          </span>
                        </div>
                      );
                    })}
                  </div>

                  {/* Progress bar */}
                  <div className="space-y-1">
                    <Progress value={currentStep.pct} className="h-2" />
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>{currentStep.pct}%</span>
                      {currentStep.pct < 100 && <span>~1–2 min remaining</span>}
                    </div>
                  </div>

                  {/* Cancel button — only for queued jobs */}
                  {activeJob.status === 'queued' && (
                    <Button
                      variant="outline" size="sm" className="w-full text-destructive border-destructive/30 hover:bg-destructive/10"
                      onClick={async () => {
                        try {
                          await api.delete(`/generate/${activeJob.job_id}/cancel`);
                          clearJob();
                        } catch { /* ignore — job may have started */ }
                      }}
                    >
                      Cancel
                    </Button>
                  )}

                  {/* Architecture review panel */}
                  {activeJob.status === 'awaiting_review' && (
                    <div className="border rounded-lg p-4 space-y-3 bg-primary/5 border-primary/20">
                      <div className="flex items-center space-x-2">
                        <span className="text-lg">&#x1F3D7;</span>
                        <div>
                          <p className="font-medium text-sm">Architecture Ready — Your Review Required</p>
                          <p className="text-xs text-muted-foreground">Iteration {archIteration} · Approve to generate final .docx</p>
                        </div>
                      </div>

                      {archPreviewUrl ? (
                        <div className="border rounded overflow-hidden bg-white">
                          <img
                            src={archPreviewUrl}
                            alt="Architecture Diagram"
                            className="w-full h-auto max-h-80 object-contain"
                          />
                        </div>
                      ) : (
                        <div className="border rounded p-4 text-center text-sm text-muted-foreground">
                          <Loader2 className="h-4 w-4 animate-spin mx-auto mb-1" />
                          Loading diagram preview...
                        </div>
                      )}

                      <Button className="w-full" onClick={handleApproveArch} disabled={archLoading}>
                        {archLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ThumbsUp className="mr-2 h-4 w-4" />}
                        Approve Architecture &amp; Generate Document
                      </Button>

                      <div className="space-y-2">
                        <p className="text-xs text-muted-foreground font-medium">Or request changes:</p>
                        <textarea
                          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm min-h-[70px] resize-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          placeholder="e.g. Add a WAF in front of CloudFront, remove the EC2 and use Lambda instead, add a separate staging VPC..."
                          value={archFeedback}
                          onChange={e => setArchFeedback(e.target.value)}
                        />
                        <Button
                          variant="outline" className="w-full"
                          onClick={handleIterateArch}
                          disabled={archLoading || !archFeedback.trim()}
                        >
                          {archLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                          Revise Architecture
                        </Button>
                      </div>
                    </div>
                  )}

                  {/* Complete */}
                  {activeJob.status === 'complete' && (
                    <div className="space-y-2">
                      <div className="flex items-center text-green-600 space-x-2">
                        <CheckCircle className="h-5 w-5" />
                        <span className="font-medium">Document ready for download!</span>
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

          {/* Token + Cost Card */}
          {totalTokens > 0 && (
            <Card className="border-primary/20">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center space-x-2">
                  <Coins className="h-4 w-4 text-primary" />
                  <span>Usage &amp; Cost</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="bg-muted/50 rounded-lg p-3">
                    <p className="text-xs text-muted-foreground mb-1">Model</p>
                    <p className="font-medium text-xs">{modelName}</p>
                  </div>
                  <div className="bg-muted/50 rounded-lg p-3">
                    <p className="text-xs text-muted-foreground mb-1">Total Tokens</p>
                    <p className="font-medium">{totalTokens.toLocaleString()}</p>
                  </div>
                  <div className="bg-muted/50 rounded-lg p-3">
                    <p className="text-xs text-muted-foreground mb-1">Input Tokens</p>
                    <p className="font-medium">{inputTokens.toLocaleString()}</p>
                    <p className="text-xs text-muted-foreground">@ $0.003/1K</p>
                  </div>
                  <div className="bg-muted/50 rounded-lg p-3">
                    <p className="text-xs text-muted-foreground mb-1">Output Tokens</p>
                    <p className="font-medium">{outputTokens.toLocaleString()}</p>
                    <p className="text-xs text-muted-foreground">@ $0.015/1K</p>
                  </div>
                </div>
                <div className="flex items-center justify-between bg-primary/5 rounded-lg px-3 py-2 mt-1">
                  <span className="text-sm font-medium flex items-center space-x-1">
                    <Zap className="h-3 w-3 text-primary" />
                    <span>Estimated Cost</span>
                  </span>
                  <span className="font-bold text-primary">${costUsd.toFixed(4)}</span>
                </div>
              </CardContent>
            </Card>
          )}

          {/* RAG sources */}
          {activeJob.rag_context && activeJob.rag_context.length > 0 && (
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">Knowledge Base Sources</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {activeJob.rag_context.slice(0, 3).map((ctx, i) => (
                  <div key={i} className="text-sm border rounded p-2 space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="font-medium truncate">{ctx.source_document}</span>
                      <Badge variant="secondary" className="ml-2 shrink-0 text-xs">{(ctx.similarity_score * 100).toFixed(0)}% match</Badge>
                    </div>
                    <p className="text-muted-foreground line-clamp-2 text-xs">{ctx.excerpt}</p>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {/* Tavily sources */}
          {activeJob.tavily_sources && activeJob.tavily_sources.length > 0 && (
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">Web Sources Validated</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {activeJob.tavily_sources.map((src, i) => (
                  <div key={i} className="text-sm flex items-start space-x-2">
                    <ExternalLink className="h-3 w-3 mt-1 shrink-0 text-primary" />
                    <div>
                      <a href={src.url} target="_blank" rel="noopener noreferrer" className="font-medium hover:underline text-primary text-xs">{src.title}</a>
                      <p className="text-muted-foreground line-clamp-1 text-xs">{src.excerpt}</p>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
