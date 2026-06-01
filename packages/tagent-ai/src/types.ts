/**
 * @tagent/ai — Core Type Definitions
 *
 * 所有 LLM 相关类型。被 @tagent/core 和 @tagent/server 消费。
 */

// ─── Messages ────────────────────────────────────────

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // JSON string
}

// ─── Tool Definitions ────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

// ─── LLM Call ────────────────────────────────────────

export interface LLMCallParams {
  model: string;
  messages: Message[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
}

export interface LLMResponse {
  content: string;
  toolCalls: ToolCall[];
  usage: TokenUsage;
  model: string;
  stopReason: 'end' | 'tool_use' | 'max_tokens' | 'unknown';
}

export interface LLMStreamEvent {
  type: 'text_delta' | 'tool_call_start' | 'tool_call_delta' | 'tool_call_end' | 'usage' | 'done';
  content?: string;
  toolCall?: Partial<ToolCall>;
  usage?: TokenUsage;
}

// ─── Token Usage & Cost ──────────────────────────────

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cost: number; // USD
}

// ─── Provider Interface ──────────────────────────────

export interface LLMProvider {
  name: string;
  /** Non-streaming call */
  call(params: LLMCallParams): Promise<LLMResponse>;
  /** Streaming call */
  stream(params: LLMCallParams): AsyncIterable<LLMStreamEvent>;
}

// ─── Model Pricing (per 1M tokens) ──────────────────

export interface ModelPricing {
  inputPer1M: number;  // USD per 1M input tokens
  outputPer1M: number; // USD per 1M output tokens
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  // Anthropic
  'claude-sonnet-4-20250514': { inputPer1M: 3, outputPer1M: 15 },
  'claude-haiku-3-20250414': { inputPer1M: 0.25, outputPer1M: 1.25 },
  // OpenAI
  'gpt-4o': { inputPer1M: 2.5, outputPer1M: 10 },
  'gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.6 },
  // DeepSeek (Anthropic-compatible API)
  'deepseek-chat': { inputPer1M: 0.27, outputPer1M: 1.10 },
  'deepseek-reasoner': { inputPer1M: 0.55, outputPer1M: 2.19 },
};

export function calculateCost(model: string, usage: Omit<TokenUsage, 'cost'>): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return 0;
  return (usage.inputTokens / 1_000_000) * pricing.inputPer1M +
         (usage.outputTokens / 1_000_000) * pricing.outputPer1M;
}
