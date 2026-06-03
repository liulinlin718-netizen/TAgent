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

// ─── Time-Travel Snapshots (plan §3.4 ⓪ + §4.3) ────

export interface Snapshot {
  id: string;
  sessionId: string;
  agentId: string;
  iteration: number;
  timestamp: string;
  /** 当时的消息上下文（序列化） */
  messagesSnapshot: unknown[];
  /** 当时的状态 */
  agentState?: Record<string, unknown>;
}

/**
 * SnapshotManager — 时间旅行支撑
 *
 * 每次 Agent Loop 迭代前保存快照，用户可：
 * 1. 回溯到任意快照查看当时状态
 * 2. 从快照点 Fork 新 Session 重新执行
 */
export class SnapshotManager {
  private snapshots = new Map<string, Snapshot[]>();

  /** 保存快照 */
  save(snapshot: Snapshot): void {
    const key = `${snapshot.sessionId}:${snapshot.agentId}`;
    if (!this.snapshots.has(key)) {
      this.snapshots.set(key, []);
    }
    this.snapshots.get(key)!.push(snapshot);
  }

  /** 获取某 session+agent 的所有快照 */
  list(sessionId: string, agentId: string): Snapshot[] {
    return this.snapshots.get(`${sessionId}:${agentId}`) || [];
  }

  /** 获取特定快照 */
  get(snapshotId: string): Snapshot | undefined {
    for (const list of this.snapshots.values()) {
      const found = list.find(s => s.id === snapshotId);
      if (found) return found;
    }
    return undefined;
  }

  /** 获取某 session 的所有快照（跨 agent） */
  listBySession(sessionId: string): Snapshot[] {
    const result: Snapshot[] = [];
    for (const [key, list] of this.snapshots) {
      if (key.startsWith(`${sessionId}:`)) {
        result.push(...list);
      }
    }
    return result.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }

  /** 从快照回滚：返回该快照点的消息 */
  rollback(snapshotId: string): unknown[] | null {
    const snapshot = this.get(snapshotId);
    return snapshot ? snapshot.messagesSnapshot : null;
  }
}
