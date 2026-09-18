/**
 * Tool Registry — 工具注册和执行
 *
 * Agent 通过工具与外部世界交互。
 * 裂变也是一种"工具"调用（← OpenCode 设计）。
 */

import type { ToolDefinition } from '@tagent/ai';

export interface ToolExecutionContext { signal?: AbortSignal }

export interface ToolExecutor {
  /** Trusted built-in metadata only; never accept this from MCP or imported Skills. */
  approval?: 'local_read_only';
  definition: ToolDefinition;
  execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<string>;
}

export class ToolRegistry {
  private tools = new Map<string, ToolExecutor>();

  constructor(private signal?: AbortSignal) {}

  register(tool: ToolExecutor): void {
    this.tools.set(tool.definition.name, tool);
  }

  get(name: string): ToolExecutor | undefined {
    return this.tools.get(name);
  }

  getDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map(t => t.definition);
  }

  async execute(name: string, args: Record<string, unknown>, context?: ToolExecutionContext): Promise<string> {
    const signal = this.signal && context?.signal ? AbortSignal.any([this.signal, context.signal]) : context?.signal || this.signal;
    signal?.throwIfAborted();
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Tool not found: ${name}`);
    return tool.execute(args, { signal });
  }

  list(): string[] {
    return Array.from(this.tools.keys());
  }
}
