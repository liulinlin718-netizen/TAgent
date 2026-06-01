/**
 * @tagent/ai — LLM 抽象层
 *
 * 统一多个 LLM Provider 的接口，屏蔽差异。
 * 内建 token 计算和成本追踪。
 *
 * 使用方式：
 *   import { AnthropicProvider, CostTracker } from '@tagent/ai';
 *   const provider = new AnthropicProvider();
 *   const response = await provider.call({ model: 'claude-sonnet-4-20250514', messages: [...] });
 */

// Types
export type {
  Message,
  ToolCall,
  ToolDefinition,
  LLMCallParams,
  LLMResponse,
  LLMStreamEvent,
  TokenUsage,
  LLMProvider,
  ModelPricing,
} from './types.js';

export { MODEL_PRICING, calculateCost } from './types.js';

// Providers
export { AnthropicProvider } from './providers/anthropic.js';
export { OpenAIProvider } from './providers/openai.js';

// Cost Tracking
export { CostTracker } from './cost-tracker.js';
export type { CostEntry } from './cost-tracker.js';
