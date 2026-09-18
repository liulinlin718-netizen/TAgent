import { describe, expect, it } from 'vitest';
import { workflowStatus } from '../workflow-status.js';

describe('workflow event status', () => {
  it('does not mark an unsuccessful child or run complete', () => {
    expect(workflowStatus('agent_complete', { success: false })).toBe('failed');
    expect(workflowStatus('complete', { success: false })).toBe('failed');
    expect(workflowStatus('complete', { success: false, researchAssessment: {} })).toBe('warning');
    expect(workflowStatus('agent_complete', { success: true })).toBe('complete');
  });

  it('preserves stages and policy decisions instead of conflating them with completion', () => {
    expect(workflowStatus('agent_stage', { stage: 'verify' })).toBe('running');
    expect(workflowStatus('governance', { result: 'blocked' })).toBe('blocked');
    expect(workflowStatus('governance', { result: 'warning' })).toBe('warning');
    expect(workflowStatus('agent_failed', {})).toBe('failed');
  });
});
