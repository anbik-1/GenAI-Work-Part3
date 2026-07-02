import { createContext, useContext, useState, useCallback, useRef } from 'react';
import { api } from '@/lib/api';

export interface JobStatus {
  job_id: string;
  status: string;
  status_detail?: string;
  rag_context?: Array<{ source_document: string; excerpt: string; similarity_score: number; }>;
  tavily_sources?: Array<{ url: string; title: string; excerpt: string; }>;
  download_url?: string;
  error_message?: string;
}

interface JobCtx {
  activeJob: JobStatus | null;
  startPolling: (jobId: string) => void;
  clearJob: () => void;
}

const JobContext = createContext<JobCtx | undefined>(undefined);

export function JobProvider({ children }: { children: React.ReactNode }) {
  const [activeJob, setActiveJob] = useState<JobStatus | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearJob = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    setActiveJob(null);
  }, []);

  const startPolling = useCallback((jobId: string) => {
    if (intervalRef.current) clearInterval(intervalRef.current);

    const poll = async () => {
      try {
        const status = await api.get<JobStatus>(`/generate/${jobId}`);
        setActiveJob(status);
        if (status.status === 'complete' || status.status === 'failed') {
          if (intervalRef.current) clearInterval(intervalRef.current);
        }
      } catch (err) {
        console.error('Job polling error:', err);
      }
    };

    poll(); // immediate first poll
    intervalRef.current = setInterval(poll, 3000); // then every 3s
  }, []);

  return <JobContext.Provider value={{ activeJob, startPolling, clearJob }}>{children}</JobContext.Provider>;
}

export const useJob = () => { const ctx = useContext(JobContext); if (!ctx) throw new Error('useJob must be inside JobProvider'); return ctx; };
