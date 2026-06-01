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
export type { AgentConfig, AgentLoopResult, LoopEventHandler } from './agent-loop.js';

// Trace
export { TraceWriter } from './trace.js';
export type { TraceEntry, TraceSpan, SpanType } from './trace.js';

// Tools
export { ToolRegistry } from './tools/registry.js';
export type { ToolExecutor } from './tools/registry.js';
export { createWebSearchTool } from './tools/web-search.js';
export { createUrlReaderTool } from './tools/url-reader.js';

// Explore
export { runExplore } from './explore.js';
export type { ExploreResult, ExploreConfig } from './explore.js';
