export const STAGES = Object.freeze(['understand', 'plan', 'dispatch', 'research', 'execute', 'tools', 'governance', 'verify', 'synthesize', 'handoff', 'complete', 'other']);
export const isToolCall = event => event.type === 'agent_tool_call' || event.type === 'tool_call';
export const isToolResult = event => event.type === 'agent_tool_result' || event.type === 'tool_result';
export const isToolEvent = event => isToolCall(event) || isToolResult(event);
const researchTools = new Set(['web_research', 'web_search', 'read_url']);

export function stageForEvent(event) {
  if (event.type === 'agent_stage') return STAGES.includes(event.data?.stage) ? event.data.stage : 'other';
  if (event.type === 'task_decomposition' || event.type === 'task_plan') return 'plan';
  if (event.type === 'agent_spawn') return 'dispatch';
  if (isToolEvent(event)) return researchTools.has(event.toolName) ? 'research' : 'tools';
  if (event.type === 'agent_progress') return 'execute';
  if (event.type === 'governance') return 'governance';
  if (event.type === 'synthesis_start' || event.type === 'synthesis') return 'synthesize';
  if (event.type === 'handoff') return 'handoff';
  if (['complete', 'agent_complete', 'agent_failed', 'run_failed', 'run_interrupted', 'run_cancelled', 'agent_cancelled'].includes(event.type)) return 'complete';
  return 'other';
}

export function groupStages(events) {
  return STAGES.map(stage => ({ stage, eventIds: events.filter(event => stageForEvent(event) === stage).map(event => event.eventId) }))
    .filter(group => group.eventIds.length);
}
