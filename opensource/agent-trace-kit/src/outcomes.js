import { issue, scopeKey } from './events.js';

/** Producer claims only. A completed operation is not proof that it succeeded. */
export function recordedOutcome(event, issues = []) {
  const interrupted = ['run_interrupted', 'run_cancelled', 'agent_cancelled'].includes(event.type)
    || ['interrupted', 'cancelled'].includes(event.status);
  const failed = ['run_failed', 'agent_failed'].includes(event.type) || event.status === 'failed'
    || event.data?.success === false || event.data?.isError === true;
  const unsettled = ['blocked', 'pending', 'running'].includes(event.status);
  const positive = event.data?.success === true || event.status === 'passed';
  if ((positive && (failed || interrupted || unsettled)) || (failed && interrupted)) {
    const claims = [{ field: 'type', value: event.type }];
    if (event.status !== undefined) claims.push({ field: 'status', value: event.status });
    for (const name of ['success', 'isError']) {
      if (event.data?.[name] !== undefined) claims.push({ field: `data.${name}`, value: event.data[name] });
    }
    issues.push(issue('conflicting_outcome', 'warning', 'Producer outcome claims disagree; success was not inferred.',
      { eventId: event.eventId, runKey: scopeKey(event), claims }));
  }
  if (interrupted) return 'interrupted';
  if (failed) return 'failed';
  if (unsettled) return 'unknown';
  return event.data?.success === true ? 'succeeded' : 'unknown';
}
