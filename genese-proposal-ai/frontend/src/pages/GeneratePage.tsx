import { useState } from 'react';
import { FileText, Download, ExternalLink, CheckCircle, Loader2, AlertCircle, Cpu, Coins, Zap } from 'lucide-react';
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

// Step definitions with progress %
const PIPELINE_STEPS = [
  { key: 'queued',              label: 'Queued',                         pct: 5,  icon: '⏳' },
  { key: 'retrieving_context', label: 'Searching knowledge base...',    pct: 25, icon: '🔍' },
  { key: 'validating_sources', label: 'Validating documentation...',   pct: 50, icon: '🌐' },
  { key: 'drafting_document',  label: 'Claude is drafting...',         pct: 75, icon: '✍️' },
  { key: 'formatting_output',  label: 'Formatting .docx...',           pct: 90, icon: '📄' },
  { key: 'complete',           label: 'Complete!',                      pct: 100, icon: '✅' },
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
  const [contextNotes, setContextNotes] = useState('');
  const [loading, setLoading] = useState(false);

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

  // Cost and token display — compute client-side from token counts
  const inputTokens  = (activeJob as any)?.input_tokens  || 0;
  const outputTokens = (activeJob as any)?.output_tokens || 0;
  const totalTokens  = inputTokens + outputTokens;
  // Claude Sonnet 4.6: $0.003/1K input, $0.015/1K output
  const costUsd = (inputTokens / 1000) * 0.003 + (outputTokens / 1000) * 0.015;
  const modelName    = modelLabel((activeJob as any)?.llm_model);

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Generate Document</h1>
        <p className="text-muted-foreground mt-1">AI-powered proposals, SoWs and case studies — Genese-branded, ready to edit.</p>
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        {/* ── Form ── */}
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
                <Textarea id="req" placeholder="Describe the client's main requirements, challenges and goals..." className="min-h-[120px]" value={requirements} onChange={e => setRequirements(e.target.value)} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ctx">Additional Context (optional)</Label>
                <Textarea id="ctx" placeholder="Specific technologies, constraints, preferences..." className="min-h-[80px]" value={contextNotes} onChange={e => setContextNotes(e.target.value)} />
              </div>
              <Button type="submit" className="w-full" disabled={loading || !!isBusy}>
                {loading ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Starting...</> : <><FileText className="mr-2 h-4 w-4" />Generate Document</>}
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* ── Status Panel ── */}
        <div className="space-y-4">
          {activeJob ? (
            <>
              {/* Progress Card */}
              <Card>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">Generation Progress</CardTitle>
                    {/* Model Badge */}
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
                          {/* Show friendly error reason */}
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
                        ↩ Try Again
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
                                {done && !active ? '✓' : active ? <Loader2 className="h-3 w-3 animate-spin" /> : stepIdx}
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
                          ✕ Cancel
                        </Button>
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

              {/* Token + Cost Card — shows when tokens are available */}
              {totalTokens > 0 && (
                <Card className="border-primary/20">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center space-x-2">
                      <Coins className="h-4 w-4 text-primary" />
                      <span>Usage & Cost</span>
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
            </>
          ) : (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center justify-center py-12 text-center">
                <FileText className="h-12 w-12 text-muted-foreground mb-4" />
                <p className="text-muted-foreground">Fill in the form and click Generate.</p>
                <p className="text-xs text-muted-foreground mt-2">Progress, model info, tokens and cost will appear here in real time.</p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
