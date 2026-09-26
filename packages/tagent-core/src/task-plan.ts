export interface SubTask {
  id: string;
  agentRole: string;
  objective: string;
  context?: string;
  contextMessageIds?: string[];
  originalTask?: string;
  searchQuery?: string;
  dependsOn?: string[];
  spawn?: { name: string; reason: string; parentTaskId?: string };
}

const ROLES = new Set(['research', 'document', 'data', 'project', 'communication', 'presentation']);

export function normalizeTaskPlan(value: unknown, originalTask: string): SubTask[] {
  if (!Array.isArray(value) || value.length > 6) return [];
  const tasks: SubTask[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !/^[\w-]{1,64}$/.test(item.id)
      || ids.has(item.id) || !ROLES.has(item.agentRole) || typeof item.objective !== 'string' || !item.objective.trim()) return [];
    if (item.dependsOn !== undefined && (!Array.isArray(item.dependsOn) || !item.dependsOn.every((id: unknown) => typeof id === 'string'))) return [];
    if (item.contextMessageIds !== undefined && (!Array.isArray(item.contextMessageIds) || item.contextMessageIds.length > 12
      || !item.contextMessageIds.every((id: unknown) => typeof id === 'string' && id.length > 0 && id.length <= 256))) return [];
    if (item.spawn !== undefined && (!item.spawn || typeof item.spawn !== 'object' || Array.isArray(item.spawn)
      || Object.keys(item.spawn).some(key => !['name', 'reason', 'parentTaskId'].includes(key))
      || typeof item.spawn.name !== 'string' || !item.spawn.name.trim() || item.spawn.name.length > 120
      || typeof item.spawn.reason !== 'string' || !item.spawn.reason.trim() || item.spawn.reason.length > 1000
      || (item.spawn.parentTaskId !== undefined && typeof item.spawn.parentTaskId !== 'string'))) return [];
    ids.add(item.id);
    tasks.push({ id: item.id, agentRole: item.agentRole, objective: item.objective.slice(0, 2000), originalTask,
      context: typeof item.context === 'string' ? item.context.slice(0, 4000) : undefined,
      searchQuery: typeof item.searchQuery === 'string' ? item.searchQuery.replace(/\s+/g, ' ').trim().slice(0, 200) : undefined,
      dependsOn: [...new Set<string>(item.dependsOn || [])] });
    if (item.contextMessageIds) tasks.at(-1)!.contextMessageIds = [...new Set<string>(item.contextMessageIds)];
    if (item.spawn) tasks.at(-1)!.spawn = { name: item.spawn.name, reason: item.spawn.reason, parentTaskId: item.spawn.parentTaskId };
  }
  const gatherers = tasks.filter(task => ['research', 'data'].includes(task.agentRole)).map(task => task.id);
  for (const task of tasks) {
    if (task.spawn?.parentTaskId) task.dependsOn = [...new Set([...(task.dependsOn || []), task.spawn.parentTaskId])];
    if (['document', 'presentation', 'communication'].includes(task.agentRole) && !task.dependsOn!.length) task.dependsOn = gatherers;
    if (task.dependsOn!.some(id => id === task.id || !ids.has(id))) return [];
  }
  const resolved = new Set<string>();
  while (resolved.size < tasks.length) {
    const ready = tasks.filter(task => !resolved.has(task.id) && task.dependsOn!.every(id => resolved.has(id)));
    if (!ready.length) return [];
    ready.forEach(task => resolved.add(task.id));
  }
  return tasks;
}

/** Independent tasks run concurrently; handoffs cannot race their required input. */
export async function executeTaskPlan<T>(tasks: SubTask[], execute: (task: SubTask, dependencies: T[]) => Promise<T>, signal?: AbortSignal): Promise<Map<string, T>> {
  const results = new Map<string, T>();
  const started = new Set<string>();
  const running = new Map<string, Promise<{ id: string; result?: T; error?: unknown; failed: boolean }>>();
  while (results.size < tasks.length) {
    if (signal?.aborted) {
      await Promise.all(running.values());
      signal.throwIfAborted();
    }
    for (const task of tasks) {
      if (running.size >= 3) break;
      if (started.has(task.id) || !(task.dependsOn || []).every(id => results.has(id))) continue;
      started.add(task.id);
      running.set(task.id, (async () => {
        try { return { id: task.id, result: await execute(task, (task.dependsOn || []).map(id => results.get(id)!)), failed: false }; }
        catch (error) { return { id: task.id, error, failed: true }; }
      })());
    }
    if (!running.size) throw new Error('Task dependency cycle or missing dependency');
    const finished = await Promise.race(running.values());
    running.delete(finished.id);
    if (finished.failed) {
      // In-flight siblings settle before failure propagates, preserving their cleanup and receipts.
      await Promise.all(running.values());
      throw finished.error;
    }
    results.set(finished.id, finished.result as T);
  }
  signal?.throwIfAborted();
  return results;
}
