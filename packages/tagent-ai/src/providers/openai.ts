/**
 * OpenAI GPT Provider
 *
 * 支持 GPT-4o / GPT-4o-mini，流式和非流式调用。
 */

import OpenAI from 'openai';
import type { LLMProvider, LLMCallParams, LLMResponse, LLMStreamEvent, ToolCall } from '../types.js';
import { MODEL_PRICING } from '../types.js';
import { ProviderRequestError, providerRequest, type ProviderOptions } from '../provider-request.js';

export class OpenAIProvider implements LLMProvider {
  name: string;
  private client: OpenAI;
  private timeout: number;

  constructor(options?: string | ProviderOptions) {
    const apiKey = typeof options === 'string' ? options : options?.apiKey;
    const baseURL = typeof options === 'string' ? undefined : options?.baseURL;
    this.name = typeof options === 'string' ? 'openai' : options?.name || 'openai';
    this.timeout = typeof options === 'object' ? options.timeout ?? 60000 : 60000;
    this.client = new OpenAI({
      apiKey: apiKey || process.env.OPENAI_API_KEY,
      baseURL,
      timeout: this.timeout,
      maxRetries: typeof options === 'object' ? options.maxRetries ?? 0 : 0,
      fetch: typeof options === 'object' ? options.fetch : undefined,
    });
  }

  async call(params: LLMCallParams): Promise<LLMResponse> {
    const request = providerRequest(this.name, this.timeout, params.signal);
    try { return await this.callResponse({ ...params, signal: request.signal }); }
    catch (error) { return request.fail(error); }
    finally { request.dispose(); }
  }

  private async callResponse(params: LLMCallParams): Promise<LLMResponse> {
    const response = await this.client.chat.completions.create({
      model: params.model,
      ...this.modelOptions(params),
      messages: this.formatMessages(params.messages),
      max_tokens: params.maxTokens || 4096,
      temperature: params.temperature,
      tools: params.tools?.map((t) => ({
        type: 'function' as const,
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
    }, { signal: params.signal });

    const choice = response?.choices?.[0];
    if (!choice?.message) throw new ProviderRequestError(this.name, 'invalid_response');
    const message = choice.message;
    const toolCalls: ToolCall[] = [];

    if (message.tool_calls) {
      for (const tc of message.tool_calls) {
        if (tc.type === 'function') {
          toolCalls.push({
            id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          });
        }
      }
    }

    const counts = response.usage;
    if (!counts || ![counts.prompt_tokens, counts.completion_tokens].every(value => Number.isSafeInteger(value) && value >= 0)) {
      throw new ProviderRequestError(this.name, 'invalid_response');
    }
    const usage = {
      inputTokens: counts.prompt_tokens,
      outputTokens: counts.completion_tokens,
      cost: this.calcCost(params.model, counts.prompt_tokens, counts.completion_tokens),
    };

    return {
      content: message.content || '',
      toolCalls,
      usage,
      model: params.model,
      stopReason: choice.finish_reason === 'tool_calls' ? 'tool_use'
        : choice.finish_reason === 'stop' ? 'end'
        : choice.finish_reason === 'length' ? 'max_tokens'
        : 'unknown',
    };
  }

  async *stream(params: LLMCallParams): AsyncIterable<LLMStreamEvent> {
    const request = providerRequest(this.name, this.timeout, params.signal);
    try { yield* this.streamResponse({ ...params, signal: request.signal }); }
    catch (error) { request.fail(error); }
    finally { request.dispose(); }
  }

  private async *streamResponse(params: LLMCallParams): AsyncIterable<LLMStreamEvent> {
    const stream = await this.client.chat.completions.create({
      model: params.model,
      ...this.modelOptions(params),
      messages: this.formatMessages(params.messages),
      max_tokens: params.maxTokens || 4096,
      temperature: params.temperature,
      tools: params.tools?.map((t) => ({
        type: 'function' as const,
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
      stream: true,
      stream_options: { include_usage: true },
    }, { signal: params.signal });

    const toolCallAccumulators = new Map<number, { id: string; name: string; arguments: string }>();
    let finished = false;

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (chunk.choices[0]?.finish_reason) finished = true;

      if (delta && 'content' in delta && delta.content) {
        yield { type: 'text_delta', content: delta.content };
      }

      if (delta && 'tool_calls' in delta && delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (!toolCallAccumulators.has(tc.index)) {
            toolCallAccumulators.set(tc.index, { id: tc.id || '', name: tc.function?.name || '', arguments: '' });
            yield {
              type: 'tool_call_start',
              toolCall: { id: tc.id || undefined, name: tc.function?.name || undefined },
            };
          }
          const acc = toolCallAccumulators.get(tc.index)!;
          if (tc.function?.arguments) {
            acc.arguments += tc.function.arguments;
            yield { type: 'tool_call_delta', toolCall: acc };
          }
        }
      }

      if (chunk.usage) {
        if (![chunk.usage.prompt_tokens, chunk.usage.completion_tokens].every(value => Number.isSafeInteger(value) && value >= 0)) {
          throw new ProviderRequestError(this.name, 'invalid_response');
        }
        yield {
          type: 'usage',
          usage: {
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
            cost: this.calcCost(params.model, chunk.usage.prompt_tokens, chunk.usage.completion_tokens),
          },
        };
      }
    }

    if (!finished) throw new ProviderRequestError(this.name, 'invalid_response');
    for (const [, tc] of toolCallAccumulators) {
      yield { type: 'tool_call_end', toolCall: tc };
    }

    yield { type: 'done' };
  }

  private formatMessages(msgs: LLMCallParams['messages']): OpenAI.Chat.ChatCompletionMessageParam[] {
    return msgs.map((msg): OpenAI.Chat.ChatCompletionMessageParam => {
      if (msg.role === 'system') {
        return { role: 'system', content: msg.content };
      }
      if (msg.role === 'tool') {
        return { role: 'tool', tool_call_id: msg.toolCallId!, content: msg.content };
      }
      if (msg.role === 'assistant' && msg.toolCalls?.length) {
        return {
          role: 'assistant',
          content: msg.content || null,
          tool_calls: msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: tc.arguments },
          })),
        };
      }
      if (msg.role === 'assistant') {
        return { role: 'assistant', content: msg.content };
      }
      return { role: 'user', content: msg.content };
    });
  }

  private calcCost(model: string, input: number, output: number): number {
    const pricing = MODEL_PRICING[model];
    if (!pricing) return 0;
    return (input / 1_000_000) * pricing.inputPer1M + (output / 1_000_000) * pricing.outputPer1M;
  }

  private modelOptions(params: LLMCallParams) {
    if (this.name !== 'deepseek' || !['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-pro'].includes(params.model)) return {};
    // Structured reviews can reserve their output allowance for the complete result, not hidden reasoning.
    const reasoning = params.reasoning ?? (params.purpose === 'verification' ? 'low' : 'disabled');
    return reasoning === 'low' && !params.tools?.length
      ? { thinking: { type: 'enabled' as const }, reasoning_effort: 'low' as const }
      : { thinking: { type: 'disabled' as const } };
  }

}
