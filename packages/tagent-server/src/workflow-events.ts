import type { OrchestratorEventHandler, WorkflowEvent } from '@tagent/core';
import { snapshotAgentForWorkflow } from './workflow-snapshot.js';
import { previewToolArguments } from './tool-arguments.js';

interface WorkflowHandlerOptions {
  emit: (type: string, data: Record<string, unknown>, overrides?: Partial<WorkflowEvent>) => void;
  text: (text: string) => void;
  complete?: NonNullable<OrchestratorEventHandler['onComplete']>;
  governance?: NonNullable<OrchestratorEventHandler['onGovernanceEvent']>;
  approval?: NonNullable<OrchestratorEventHandler['onApprovalRequest']>;
}

export function createWorkflowHandlers(options: WorkflowHandlerOptions): OrchestratorEventHandler {
  const { emit } = options;
  return {
    onApprovalRequest: options.approval,
    onTaskDecomposition: tasks => emit('task_decomposition', { tasks }),
    onAgentSpawned: (agent, task) => emit('agent_spawn', {
      agentId: agent.id, agentName: agent.name, agentType: agent.type, parentAgentId: agent.parentAgentId,
      icon: agent.icon, taskId: task.id, parentTaskId: task.spawn?.parentTaskId,
      ...(agent.type === 'task_spawned' && agent.spawnMeta?.depth === 1 && !task.spawn?.parentTaskId
        ? { dispatchedBy: 'orchestrator' } : {}),
      objective: task.objective, createdReason: agent.spawnMeta?.createdReason,
    }, { agentSnapshot: snapshotAgentForWorkflow(agent, task.agentRole) }),
    onAgentProgress: (agentId, iteration, task) => emit('agent_progress', { agentId, iteration, ...task }),
    onAgentStage: (agentId, stage, summary, task) => emit('agent_stage', { agentId, stage, summary, ...task }),
    onAgentToolCall: (agentId, tool, args, task) => emit('agent_tool_call', { agentId, tool, args: previewToolArguments(args).value, ...task }),
    onAgentToolResult: (agentId, tool, resultLength, task, tableAnalysis) => emit('agent_tool_result', { agentId, tool, resultLength, ...task,
      ...(tableAnalysis ? { tableAnalysis } : {}) }),
    onAgentComplete: (agentId, result, task) => emit('agent_complete', { agentId, ...task,
      success: result.success, iterations: result.iterations, cost: result.totalCost, outputSummary: result.output.slice(0, 2000) }),
    onAgentFailed: (agentId, error, task) => emit('agent_failed', { agentId, error, ...task }),
    onGovernanceEvent: (agentId, event, task) => {
      emit('governance', { agentId, ...event, ...task });
      options.governance?.(agentId, event, task);
    },
    onSynthesisStart: () => emit('synthesis_start', {}),
    onTextDelta: options.text,
    onComplete: options.complete,
  };
}
