import type { WorkflowEventStatus } from '@tagent/core';

export function workflowStatus(type: string, data: Record<string, unknown>): WorkflowEventStatus {
  if ((type === 'complete' || type === 'agent_complete') && data.success === false) {
    return data.researchAssessment ? 'warning' : 'failed';
  }
  if (type.includes('failed') || type === 'error') return 'failed';
  if (type === 'governance') {
    const result = String(data.result || '').toLowerCase();
    if (result === 'blocked') return 'blocked';
    if (result === 'warning') return 'warning';
    return 'passed';
  }
  if (type === 'complete' || type === 'agent_complete' || type.endsWith('_result')) return 'complete';
  return 'running';
}
