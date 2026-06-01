/**
 * Anthropic Claude Provider
 *
 * 支持 Claude Sonnet 4 / Haiku 3，流式和非流式调用。
 */

import Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider, LLMCallParams, LLMResponse, LLMStreamEvent, ToolCall } from '../types.js';
import { MODEL_PRICING } from '../types.js';

export class AnthropicProvider implements LLMProvider {
  name: string;
  private client: Anthropic;

  constructor(options?: { apiKey?: string; baseURL?: string; name?: string }) {
    this.name = options?.name || 'anthropic';
    this.client = new Anthropic({
      apiKey: options?.apiKey || process.env.ANTHROPIC_API_KEY,
      baseURL: options?.baseURL,
    });
  }

  async call(params: LLMCallParams): Promise<LLMResponse> {
    const { systemPrompt, messages } = this.formatMessages(params.messages);

    const response = await this.client.messages.create({
      model: params.model,
      max_tokens: params.maxTokens || 4096,
      temperature: params.temperature,
      system: systemPrompt,
      messages,
      tools: params.tools?.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as Anthropic.Messages.Tool['input_schema'],
      })),
    });

    const content = response.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('');

    const toolCalls: ToolCall[] = response.content
      .filter((b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use')
      .map(b => ({
        id: b.id,
        name: b.name,
        arguments: JSON.stringify(b.input),
      }));

    const usage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cost: this.calcCost(params.model, response.usage.input_tokens, response.usage.output_tokens),
    };

    return {
      content,
      toolCalls,
      usage,
      model: params.model,
      stopReason: response.stop_reason === 'tool_use' ? 'tool_use'
        : response.stop_reason === 'end_turn' ? 'end'
        : response.stop_reason === 'max_tokens' ? 'max_tokens'
        : 'unknown',
    };
  }

  async *stream(params: LLMCallParams): AsyncIterable<LLMStreamEvent> {
    const { systemPrompt, messages } = this.formatMessages(params.messages);

    const stream = this.client.messages.stream({
      model: params.model,
      max_tokens: params.maxTokens || 4096,
      temperature: params.temperature,
      system: systemPrompt,
      messages,
      tools: params.tools?.map((t: { name: string; description: string; parameters: Record<string, unknown> }) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as Anthropic.Messages.Tool['input_schema'],
      })),
    });

    let currentToolCall: Partial<ToolCall> | null = null;

    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        const block = event.content_block;
        if (block.type === 'tool_use') {
          currentToolCall = { id: block.id, name: block.name, arguments: '' };
          yield { type: 'tool_call_start', toolCall: currentToolCall };
        }
      } else if (event.type === 'content_block_delta') {
        const delta = event.delta;
        if (delta.type === 'text_delta') {
          yield { type: 'text_delta', content: delta.text };
        } else if (delta.type === 'input_json_delta' && currentToolCall) {
          currentToolCall.arguments = (currentToolCall.arguments || '') + delta.partial_json;
          yield { type: 'tool_call_delta', toolCall: currentToolCall };
        }
      } else if (event.type === 'content_block_stop' && currentToolCall) {
        yield { type: 'tool_call_end', toolCall: currentToolCall };
        currentToolCall = null;
      } else if (event.type === 'message_delta' && event.usage) {
        // Final usage comes with message_delta
      }
    }

    const finalMessage = await stream.finalMessage();
    yield {
      type: 'usage',
      usage: {
        inputTokens: finalMessage.usage.input_tokens,
        outputTokens: finalMessage.usage.output_tokens,
        cost: this.calcCost(params.model, finalMessage.usage.input_tokens, finalMessage.usage.output_tokens),
      },
    };
    yield { type: 'done' };
  }

  private formatMessages(msgs: LLMCallParams['messages']) {
    let systemPrompt = '';
    const messages: Anthropic.Messages.MessageParam[] = [];

    for (const msg of msgs) {
      if (msg.role === 'system') {
        systemPrompt += msg.content + '\n';
      } else if (msg.role === 'tool') {
        messages.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: msg.toolCallId!,
            content: msg.content,
          }],
        });
      } else if (msg.role === 'assistant' && msg.toolCalls?.length) {
        const content: Anthropic.Messages.ContentBlockParam[] = [];
        if (msg.content) content.push({ type: 'text', text: msg.content });
        for (const tc of msg.toolCalls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: JSON.parse(tc.arguments),
          });
        }
        messages.push({ role: 'assistant', content });
      } else {
        messages.push({
          role: msg.role as 'user' | 'assistant',
          content: msg.content,
        });
      }
    }

    return { systemPrompt: systemPrompt.trim(), messages };
  }

  private calcCost(model: string, input: number, output: number): number {
    const pricing = MODEL_PRICING[model];
    if (!pricing) return 0;
    return (input / 1_000_000) * pricing.inputPer1M + (output / 1_000_000) * pricing.outputPer1M;
  }
}
