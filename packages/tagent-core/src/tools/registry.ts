/**
 * Tool Registry — 工具注册和执行
 *
 * Agent 通过工具与外部世界交互。
 * 裂变也是一种"工具"调用（← OpenCode 设计）。
 */

import type { ToolDefinition } from '@tagent/ai';

export interface ToolExecutor {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>): Promise<string>;
}

export class ToolRegistry {
  private tools = new Map<string, ToolExecutor>();

  register(tool: ToolExecutor): void {
    this.tools.set(tool.definition.name, tool);
  }

  get(name: string): ToolExecutor | undefined {
    return this.tools.get(name);
  }

  getDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map(t => t.definition);
  }

  async execute(name: string, args: Record<string, unknown>): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Tool not found: ${name}`);
    return tool.execute(args);
  }

  list(): string[] {
    return Array.from(this.tools.keys());
  }
}
