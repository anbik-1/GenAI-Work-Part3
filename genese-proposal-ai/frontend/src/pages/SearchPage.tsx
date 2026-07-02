import { useState } from 'react';
import { Search, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { useToast } from '@/components/ui/use-toast';

interface SearchResult { document_id: string; filename: string; document_type: string; client_name?: string; excerpt: string; similarity_score: number; }
interface SearchResponse { query: string; answer: string; sources: SearchResult[]; }

const EXAMPLE_QUERIES = [
  'What did we do for the last fintech client?',
  'How do we typically structure an AWS migration proposal?',
  'What SLAs have we committed to in managed services?',
  'What are our standard data platform deliverables?',
];

export function SearchPage() {
  const { toast } = useToast();
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SearchResponse | null>(null);

  const handleSearch = async (q?: string) => {
    const searchQuery = q || query;
    if (!searchQuery.trim()) return;
    setQuery(searchQuery);
    setLoading(true);
    setResult(null);
    try {
      const data = await api.post<SearchResponse>('/search', { query: searchQuery, top_k: 5 });
      setResult(data);
    } catch (err) {
      toast({ title: 'Search failed', description: err instanceof Error ? err.message : 'No results found', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Knowledge Search</h1>
        <p className="text-muted-foreground mt-1">Ask anything about past Genese proposals, SoWs, and project work.</p>
      </div>

      {/* Search input */}
      <div className="flex space-x-2">
        <Input placeholder="e.g. What did we do for the last fintech client?" value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSearch()}
          className="flex-1" />
        <Button onClick={() => handleSearch()} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
        </Button>
      </div>

      {/* Example queries */}
      {!result && !loading && (
        <div>
          <p className="text-sm text-muted-foreground mb-2">Try asking:</p>
          <div className="flex flex-wrap gap-2">
            {EXAMPLE_QUERIES.map(q => (
              <Button key={q} variant="outline" size="sm" className="text-xs" onClick={() => handleSearch(q)}>{q}</Button>
            ))}
          </div>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <Card>
          <CardContent className="py-8 text-center">
            <Loader2 className="h-8 w-8 animate-spin mx-auto text-primary mb-2" />
            <p className="text-muted-foreground">Searching knowledge base...</p>
          </CardContent>
        </Card>
      )}

      {/* Results */}
      {result && (
        <div className="space-y-4">
          {/* AI Answer */}
          <Card className="border-primary/20">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center space-x-2">
                <span className="h-2 w-2 rounded-full bg-primary" />
                <span>AI Answer</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm leading-relaxed whitespace-pre-line">{result.answer}</p>
            </CardContent>
          </Card>

          {/* Source documents */}
          <div>
            <h3 className="text-sm font-medium text-muted-foreground mb-3">{result.sources.length} source documents used</h3>
            <div className="space-y-3">
              {result.sources.map((src, i) => (
                <Card key={i} className="border-l-4 border-l-primary/30">
                  <CardContent className="py-3 px-4">
                    <div className="flex items-start justify-between mb-1">
                      <div>
                        <span className="font-medium text-sm">{src.filename}</span>
                        {src.client_name && <span className="text-xs text-muted-foreground ml-2">• {src.client_name}</span>}
                      </div>
                      <div className="flex items-center space-x-2 shrink-0 ml-2">
                        <Badge variant="outline" className="text-xs">{src.document_type}</Badge>
                        <Badge variant="secondary" className="text-xs">{(src.similarity_score * 100).toFixed(0)}%</Badge>
                      </div>
                    </div>
                    <p className="text-sm text-muted-foreground line-clamp-3">{src.excerpt}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
