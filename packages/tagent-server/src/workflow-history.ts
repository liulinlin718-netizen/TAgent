import { Hono, type Context } from 'hono';
import type { WorkflowTraceScope } from '@tagent/core';
import { WorkflowCatalog } from './workflow-catalog.js';
import { WorkflowIndex, WorkflowIndexError } from './workflow-index.js';
import type { Store } from './store.js';

export function createWorkflowHistoryRoutes(store: Store, catalog: WorkflowCatalog, index: WorkflowIndex) {
  const app = new Hono();
  const page = async (c: Context, scope: WorkflowTraceScope, legacy = false) => {
    if (!store.hasSession(scope.workspaceId, scope.sessionId)) return c.json({ error: '来源会话不存在。' }, 404);
    const source = catalog.find(scope.workspaceId, scope.sessionId, scope.runId);
    if (!source) return c.json({ error: '该任务不属于所选会话，或没有可回查的事件标识。' }, 404);
    try {
      const result = await index.query(source, { limit: c.req.query('limit') === undefined ? 40 : Number(c.req.query('limit')),
        agentId: c.req.query('agentId'), type: c.req.query('type'), cursor: c.req.query('cursor') });
      // Deletion can commit while the index is being read; never publish the removed source.
      if (!store.hasSession(scope.workspaceId, scope.sessionId)) return c.json({ error: '来源会话已删除。' }, 404);
      return c.json(legacy ? { ...result, entries: result.events } : result);
    } catch (error) { return c.json({ error: error instanceof WorkflowIndexError ? error.message : '执行记录暂不可用。' }, error instanceof WorkflowIndexError ? error.status : 503); }
  };
  app.get('/workspaces/:wsId/sessions/:sessId/traces', c => {
    const workspaceId = c.req.param('wsId'), sessionId = c.req.param('sessId');
    if (!store.hasSession(workspaceId, sessionId)) return c.json({ error: 'Session not found' }, 404);
    return c.json({ runs: catalog.list().filter(source => source.workspaceId === workspaceId && source.sessionId === sessionId).map(source => ({
      runId: source.runId, workspaceId, sessionId, eventCount: source.traces.length, persisted: source.persisted,
    })) });
  });
  app.get('/workspaces/:wsId/sessions/:sessId/traces/:runId', c => page(c, {
    workspaceId: c.req.param('wsId'), sessionId: c.req.param('sessId'), runId: c.req.param('runId'),
  }));
  app.get('/trace/:sessionId', c => {
    const sessionId = c.req.param('sessionId'), runId = c.req.query('runId');
    const matches = catalog.list().filter(source => source.sessionId === sessionId && (!runId || source.runId === runId));
    if (!matches.length) return c.json({ error: '没有对应的任务执行记录。' }, 404);
    if (matches.length > 1) return c.json({ error: '请指定 runId 以选择一项任务。', runs: matches.map(source => source.runId) }, 400);
    return page(c, matches[0], true);
  });
  return app;
}
