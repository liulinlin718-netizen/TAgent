/**
 * JSONL Trace Writer — Append-only 可观测性日志
 *
 * 每次 Agent Loop 迭代自动追加 span 到 .jsonl 文件。
 * O(1) 写入性能（← OpenCode 设计）。
 *
 * 所有可视化（推理时间线、工作流图、治理仪表盘）均消费此数据。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname } from 'path';

export type SpanType =
  | 'snapshot'
  | 'planning'
  | 'decision'
  | 'tool_call'
  | 'tool_result'
  | 'explore'
  | 'governance_check'
  | 'fission'
  | 'output'
  | 'error'
  | 'verify';

export interface TraceSpan {
  type: SpanType;
  timestamp: string;
  summary?: string;
  tokens?: number;
  cost?: number;
  tool?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  durationMs?: number;
  model?: string;
  policy?: string;
  result?: string;
  childAgentId?: string;
  reason?: string;
  confidence?: number;
}

export interface TraceEntry {
  traceId: string;
  agentId: string;
  sessionId: string;
  parentTraceId: string | null;
  snapshotId: string | null;
  span: TraceSpan;
}

export class TraceWriter {
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /** Append a single span to the JSONL file */
  write(entry: TraceEntry): void {
    const line = JSON.stringify(entry) + '\n';
    appendFileSync(this.filePath, line, 'utf-8');
  }

  /** Read all entries from the trace file */
  readAll(): TraceEntry[] {
    if (!existsSync(this.filePath)) return [];
    const content = readFileSync(this.filePath, 'utf-8');
    return content
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line) as TraceEntry);
  }

  /** Get the file path */
  getPath(): string {
    return this.filePath;
  }
}
