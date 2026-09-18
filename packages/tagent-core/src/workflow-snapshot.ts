import type { AgentCard } from './agent-card.js';
import type { WorkflowAgentSnapshot } from './protocol.js';

/** Display evidence only: never include MCP configuration, env, credentials or full prompts. */
export function snapshotAgentForWorkflow(agent: AgentCard, role: string, capturedAt = Date.now()): WorkflowAgentSnapshot {
  return structuredClone({
    version: 1, capturedAt, id: agent.id, name: agent.name, description: agent.description,
    icon: agent.icon, type: agent.type, role, parentAgentId: agent.parentAgentId,
    capabilities: { skills: agent.capabilities.skills, tools: agent.capabilities.tools, mcpServers: agent.capabilities.mcpServers },
    constraints: { allowedTools: agent.constraints.allowedTools, allowedDomains: agent.constraints.allowedDomains,
      maxCostPerTask: agent.constraints.maxCostPerTask, maxFissionDepth: agent.constraints.maxFissionDepth, approvalMode: agent.constraints.approvalMode },
    card: { responsibilities: agent.card.responsibilities, boundaries: agent.card.boundaries,
      qualityChecks: agent.card.qualityChecks, outputStandards: agent.card.outputStandards },
  });
}
