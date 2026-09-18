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
export { requestToolApproval } from './tool-approval.js';
export type { ToolApprovalView, ToolApprovalStatus, ApprovalHandler } from './tool-approval.js';
export type { GovernanceRecord, GovernanceStats } from './governance-record.js';
export type { WorkflowTraceScope, WorkflowTracePage } from './workflow-history.js';
export { buildConversationContext, conversationContextReceipt, formatConversationTask, selectConversationContext, CONVERSATION_POLICY } from './conversation-context.js';
export type { ConversationContext, ConversationContextItem, ConversationContextReceipt, SessionQuote, SessionQuotePreview } from './conversation-context.js';
export { prepareSummaryFork, summarySourceHash, extractSummary, SummaryForkError } from './session-summary.js';
export type { SummaryMessage, SummaryExcerpt, SummaryForkPreview, SummaryForkConsent, SummaryForkRecord, SummaryForkView } from './session-summary.js';

// Trace
export { TraceWriter, SnapshotManager } from './trace.js';
export type { TraceEntry, TraceSpan, SpanType, Snapshot } from './trace.js';

// Tools
export { ToolRegistry } from './tools/registry.js';
export type { ToolExecutor } from './tools/registry.js';
export { createWebSearchTool, searchConfigurationStatus } from './tools/web-search.js';
export { resolveResearchSearchProvider } from './search-settings.js';
export type { ResearchSearchProvider, ResearchSearchSelection, SearchSettingsView, SearchProviderOption, SearchProbeDiagnostic, SearchProbeResult } from './search-settings.js';
export { createWebResearchTool, getResearchDateContext } from './tools/web-research.js';
export { createUrlReaderTool } from './tools/url-reader.js';
// D6: MCP Tool Bridge
export { createMCPBridgeTool, getMCPToolName, registerMCPTools } from './tools/mcp-bridge.js';
// Browser Agent (Playwright + Snapshot/Refs) — ref-agent-browser
export {
  createBrowserToolSession,
  createBrowserNavigateTool,
  createBrowserClickTool,
  createBrowserTypeTool,
  createBrowserSnapshotTool,
  createBrowserScrollTool,
  setBrowserAgentId,
  closeBrowser,
} from './tools/browser.js';

// Explore
export { runExplore } from './explore.js';
export type { ExecutionSnapshot, SnapshotSummary, SnapshotCapture } from './execution-snapshot.js';
export { snapshotContext } from './execution-snapshot.js';
export type { ScheduledTask, ScheduledOccurrence, RuntimeOverview } from './runtime-state.js';
export type { ExploreResult, ExploreConfig } from './explore.js';

// Phase 2: Protocol (plan §3.7)
export { MessageBus } from './protocol.js';
export type {
  AgentMessage, AgentMessageType,
  TaskRequestPayload, TaskProgressPayload, TaskCompletePayload, TaskFailedPayload,
  GovernanceEventPayload, HumanInputRequestPayload,
  WorkflowEvent, WorkflowEventStatus, WorkflowEventType, WorkflowAgentSnapshot,
} from './protocol.js';

// Phase 2: Agent Card + Pool (plan §3.2, §3.5)
export { createAgentCard, createDefaultAgentCardV2, createIdleState, createBusyState, createOrchestrationState } from './agent-card.js';
export type {
  AgentCapabilityGraph,
  AgentBenchmarkMetadata,
  AgentCard,
  AgentCardV2,
  AgentExecutionStage,
  AgentRuntimeProfile,
  AgentScoreProfile,
  AgentScoreSnapshot,
  AgentState,
  ApprovalMode,
  TaskAgentSpawnMeta,
} from './agent-card.js';
export { AgentPool, AGENT_SOULS } from './agent-pool.js';
export { snapshotAgentForWorkflow } from './workflow-snapshot.js';
export { getOfficeBenchmarkTasks, gradeOfficeBenchmarkTask, scoreOfficeBenchmark, OFFICE_BENCHMARK_ID, OFFICE_BENCHMARK_VERSION } from './office-benchmark.js';
export type { OfficeBenchmarkTask, OfficeBenchmarkRule, OfficeBenchmarkGrade, OfficeBenchmarkObservation } from './office-benchmark.js';
export { previewOfficeBenchmark, executeOfficeBenchmark, OfficeBenchmarkCheckpointError } from './office-benchmark-runtime.js';
export type { OfficeBenchmarkPreview, OfficeBenchmarkExecution, OfficeBenchmarkTaskRun, OfficeBenchmarkConsent, OfficeBenchmarkView, OfficeBenchmarkHistoryEntry } from './office-benchmark-runtime.js';
export type { PromoteTaskAgentInput, SpawnTaskAgentInput, TaskAgentFilter } from './agent-pool.js';
export {
  BENCHMARK_DIMENSIONS,
  TAGENT_UNIVERSAL_BENCHMARK,
  estimateAgentBenchmarkProfile,
  getBenchmarkSuites,
  profileFromBenchmarkRun,
  runAgentBenchmark,
} from './benchmark.js';
export type {
  AgentBenchmarkProfile,
  BenchmarkTraceInput,
  BenchmarkDimension,
  BenchmarkDimensionInfo,
  BenchmarkResult,
  BenchmarkRun,
  BenchmarkRunStatus,
  BenchmarkSuite,
  BenchmarkTask,
  BenchmarkTaskType,
} from './benchmark.js';
export { fingerprintAgentConfiguration } from './benchmark.js';
export { reviewAgentRunEvidence } from './benchmark-evidence.js';
export type { AgentRunEvidenceReview, AgentRunEvidenceInput, AgentRunEvidenceSource } from './benchmark-evidence.js';
export { SkillsRegistry, createSkillPackageDraft, DEFAULT_RESIDENT_SKILLS } from './skills-registry.js';
export type {
  Skill,
  SkillDocumentFormat,
  SkillDocumentType,
  SkillExample,
  SkillInput,
  SkillPackage,
  SkillPackageFile,
  SkillPackageSource,
  SkillPackageDocument,
  SkillPackageIO,
  SkillPackageManifest,
  SkillRiskLevel,
  SkillTestCase,
  SkillToolDependency,
} from './skills-registry.js';
export { MCPRegistry, MCPConfigError, MCP_REDACTED, validateMCPConfig, missingMCPInputs, redactMCPConfig, redactMCPText } from './mcp-registry.js';
export { isMCPRecord } from './mcp-config.js';
export type { MCPImportSource, MCPInputRequirement } from './mcp-config.js';
export { testMCPConnection } from './tools/mcp-client.js';
export type { MCPServerConfig, MCPTransportType } from './mcp-registry.js';
export type {
  DiscoveryDomain,
  DiscoveryProviderKind,
  DiscoveryProviderState,
  DiscoveryProviderStatus,
  DiscoverySearchResponse,
  DiscoverySearchResult,
} from './discovery.js';
export { AgentRegistry } from './agent-registry.js';

// Phase 2: Governance (plan §3.10)
export { GovernanceEngine } from './governance.js';
export type { GovernanceRule, GovernanceContext, GovernanceResult, GovernanceTemplate } from './governance.js';

// Phase 2: Orchestrator (plan §3.4)
export { runOrchestrator } from './orchestrator.js';
export type { OrchestratorConfig, OrchestratorResult, OrchestratorEventHandler, SubTask } from './orchestrator.js';

// D13: Persistence (plan §5.2)
export { FilePersistence, MemoryPersistence, createPersistence } from './persistence.js';
export type { ResearchSource, ResearchAssessment, PublicationEvidence } from './research-evidence.js';
export { assessResearchSources } from './research-evidence.js';
export type { ResearchReportReview, ResearchDraft, ResearchFinding, ResearchCitationIssue } from './research-report.js';
export { completeOfficeReviewReceipt, interruptedOfficeReview } from './office-delivery.js';
export type { OfficeDeliveryReview, OfficeDeliveryResult, OfficeCheck, OfficeReviewReceipt, OfficeReviewProfile } from './office-delivery.js';
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
export { publicFetch, assertPublicUrl, PublicNetworkError } from './public-network.js';
export { RunAbortedError, runTermination, terminationNotice } from './run-control.js';
export type { RunTermination } from './run-control.js';
export type { ModelConnectionPreview, ModelConnectionCheck, ModelConnectionView } from './model-connection.js';
export type { TableAnalysisReceipt, TableProvenance } from './tools/table-analysis.js';
export type { TableImportPreview, TableImportSheet } from './table-import.js';
