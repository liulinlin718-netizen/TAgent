import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export function event(eventId, type = 'agent_progress', fields = {}) {
  return { eventId, type, runId: 'run-1', sessionId: 'session-1', taskId: 'task-1', agentId: 'agent-1',
    timestamp: 1000, summary: 'Synthetic test event.', ...fields };
}

const base = resolve(dirname(fileURLToPath(import.meta.url)), '.tmp');
export async function temporary(test) {
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, 'trace-'));
  test.after(async () => {
    if (!resolve(dir).startsWith(base + sep)) throw new Error('Unexpected cleanup target');
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}
