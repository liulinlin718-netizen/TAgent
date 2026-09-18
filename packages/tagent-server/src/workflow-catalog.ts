import type { WorkflowEvent } from '@tagent/core';
import type { ChatMessage, Store } from './store.js';

export interface LiveWorkflowRun { workspaceId: string; sessionId: string; runId: string; traces: WorkflowEvent[] }
export interface WorkflowSource extends LiveWorkflowRun { persisted: boolean; message: ChatMessage; cost?: number }

/** Rebuild only after committed workspace mutations, not once per history request. */
export class WorkflowCatalog {
  private revision = -1;
  private saved = new Map<string, WorkflowSource>();
  constructor(private readonly store: Store, private readonly live: () => LiveWorkflowRun[] = () => []) {}
  list(): WorkflowSource[] {
    if (this.revision !== this.store.getRevision()) {
      const saved = new Map<string, WorkflowSource>();
      for (const workspace of this.store.listWorkspaces()) for (const session of workspace.sessions) for (const message of session.messages) {
        if (message.role !== 'assistant') continue;
        const scope = { workspaceId: workspace.id, sessionId: session.id, message };
        if (message.run) {
          saved.set(message.run.id, { ...scope, runId: message.run.id, traces: message.traces || [], persisted: message.run.status !== 'running', cost: message.cost });
          continue;
        }
        const groups = new Map<string, WorkflowEvent[]>();
        for (const trace of message.traces || []) {
          if (!trace.runId || trace.sessionId !== session.id || !trace.eventId) continue;
          const group = groups.get(trace.runId) || []; group.push(trace); groups.set(trace.runId, group);
        }
        for (const [runId, traces] of groups) {
          const previous = saved.get(runId);
          if (previous && (previous.workspaceId !== workspace.id || previous.sessionId !== session.id)) continue;
          saved.set(runId, { ...scope, runId, traces, persisted: true, cost: groups.size === 1 ? message.cost : undefined });
        }
      }
      this.saved = saved; this.revision = this.store.getRevision();
    }
    const runs = new Map(this.saved);
    for (const current of this.live()) {
      const saved = runs.get(current.runId);
      if (saved && !saved.persisted && saved.workspaceId === current.workspaceId && saved.sessionId === current.sessionId) {
        runs.set(current.runId, { ...saved, traces: current.traces });
      }
    }
    return [...runs.values()];
  }
  find(workspaceId: string, sessionId: string, runId: string) {
    return this.list().find(source => source.workspaceId === workspaceId && source.sessionId === sessionId && source.runId === runId);
  }
}
