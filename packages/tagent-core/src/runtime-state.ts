export interface ScheduledTask {
  id: string;
  name: string;
  taskMessage: string;
  workspaceId: string;
  intervalMs: number;
  nextRun: number;
  lastRun?: number;
  enabled: boolean;
  execution: 'confirm_each_run';
  revision: number;
}

export interface ScheduledOccurrence {
  id: string;
  jobId: string;
  name: string;
  taskMessage: string;
  workspaceId: string;
  dueAt: number;
  createdAt: number;
  status: 'pending' | 'prepared' | 'dismissed';
  sessionId?: string;
}

export interface RuntimeOverview {
  recordedRuns: number;
  finishedRuns: number;
  failedRuns: number;
  unknownOutcomes: number;
  activeRuns: number;
  knownCost: number;
  runsWithoutCost: number;
  totalTokens: { input: number; output: number };
  agents: { id: string; name: string; status: 'not_used' | 'idle' | 'running' | 'waiting' | 'stalled';
    activeRuns: number; lastEventAt?: number; completed: number; failed: number; unknown: number }[];
  tools: { name: string; calls: number; results: number; averageMs?: number }[];
  costTrend: { date: string; cost: number; runs: number }[];
  note: string;
}
