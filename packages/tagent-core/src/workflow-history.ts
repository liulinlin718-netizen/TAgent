import type { WorkflowEvent } from './protocol.js';

export interface WorkflowTraceScope { workspaceId: string; sessionId: string; runId: string }
export interface WorkflowTracePage extends WorkflowTraceScope {
  events: WorkflowEvent[];
  total: number;
  available: number;
  nextCursor: string | null;
  agents: string[];
  types: string[];
  persisted: boolean;
  rebuilt: boolean;
}
