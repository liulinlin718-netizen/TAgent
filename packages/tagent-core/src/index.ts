/**
 * @tagent/core — Agent Runtime
 *
 * TAgent 的系统心脏。完全独立于 UI，可被 CLI/Web/移动端嵌入。
 *
 * 使用方式：
 *   import { runAgentLoop, ToolRegistry, createWebSearchTool } from '@tagent/core';
 *   const result = await runAgentLoop(config, "帮我调研支付 agent 的现状");
 */

// Agent Loop
export { runAgentLoop } from './agent-loop.js';
export type { AgentConfig, AgentLoopResult, LoopEventHandler, ApprovalRequest } from './agent-loop.js';

// Trace
export { TraceWriter, SnapshotManager } from './trace.js';
export type { TraceEntry, TraceSpan, SpanType, Snapshot } from './trace.js';

// Tools
export { ToolRegistry } from './tools/registry.js';
export type { ToolExecutor } from './tools/registry.js';
export { createWebSearchTool } from './tools/web-search.js';
export { createUrlReaderTool } from './tools/url-reader.js';
// D6: MCP Tool Bridge
export { createMCPBridgeTool, registerMCPTools } from './tools/mcp-bridge.js';

// Explore
export { runExplore } from './explore.js';
export type { ExploreResult, ExploreConfig } from './explore.js';

// Phase 2: Protocol (plan §3.7)
export { MessageBus } from './protocol.js';
export type {
  AgentMessage, AgentMessageType,
  TaskRequestPayload, TaskProgressPayload, TaskCompletePayload, TaskFailedPayload,
  GovernanceEventPayload, HumanInputRequestPayload,
} from './protocol.js';

// Phase 2: Agent Card + Pool (plan §3.2, §3.5)
export { createAgentCard, createIdleState, createBusyState, createOrchestrationState } from './agent-card.js';
export type { AgentCard, AgentState, ApprovalMode } from './agent-card.js';
export { AgentPool, AGENT_SOULS } from './agent-pool.js';
export { SkillsRegistry } from './skills-registry.js';
export { MCPRegistry } from './mcp-registry.js';
export { AgentRegistry } from './agent-registry.js';

// Phase 2: Governance (plan §3.10)
export { GovernanceEngine } from './governance.js';
export type { GovernanceRule, GovernanceContext, GovernanceResult, GovernanceTemplate } from './governance.js';

// Phase 2: Orchestrator (plan §3.4)
export { runOrchestrator } from './orchestrator.js';
export type { OrchestratorConfig, OrchestratorResult, OrchestratorEventHandler, SubTask } from './orchestrator.js';

// D13: Persistence (plan §5.2)
export { FilePersistence, MemoryPersistence, createPersistence } from './persistence.js';
export type { PersistenceAdapter } from './persistence.js';
export { PostgresPersistence } from './postgres-persistence.js';
export { RedisCache } from './redis-cache.js';

// D14: Sandbox
export { createSandboxTool } from './tools/sandbox.js';

// D15/D16/D17: Runtime Infrastructure
export { HeartbeatMonitor, CronScheduler, MetricsCollector } from './runtime.js';
export type { HeartbeatEntry, CronJob, PerformanceMetrics } from './runtime.js';

// Team Export/Import
export { exportTeam, importTeam } from './team-export.js';
export type { TeamExport, SanitizeOptions } from './team-export.js';
