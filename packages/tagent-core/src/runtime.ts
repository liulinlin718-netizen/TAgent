/**
 * Heartbeat + Cron + Metrics — D15, D16, D17
 *
 * D15: Agent 心跳 — 跟踪 Agent 活跃度和健康状态
 * D16: Cron 调度 — 简单的定时任务调度器
 * D17: 性能指标 — 收集运行时性能数据
 */

// ─── D15: Heartbeat ──────────────────────────────────

export interface HeartbeatEntry {
  agentId: string;
  lastBeat: number;    // Unix timestamp (ms)
  status: 'alive' | 'stale' | 'dead';
  metadata?: Record<string, unknown>;
}

export class HeartbeatMonitor {
  private beats = new Map<string, HeartbeatEntry>();
  /** Agent 超过此时间无心跳视为 stale (ms) */
  private staleThreshold: number;
  /** Agent 超过此时间无心跳视为 dead (ms) */
  private deadThreshold: number;

  constructor(staleMs = 30000, deadMs = 120000) {
    this.staleThreshold = staleMs;
    this.deadThreshold = deadMs;
  }

  /** Agent 发送心跳 */
  beat(agentId: string, metadata?: Record<string, unknown>): void {
    this.beats.set(agentId, {
      agentId,
      lastBeat: Date.now(),
      status: 'alive',
      metadata,
    });
  }

  /** 检查所有 Agent 状态 */
  checkAll(): HeartbeatEntry[] {
    const now = Date.now();
    for (const [id, entry] of this.beats) {
      const elapsed = now - entry.lastBeat;
      if (elapsed > this.deadThreshold) {
        entry.status = 'dead';
      } else if (elapsed > this.staleThreshold) {
        entry.status = 'stale';
      } else {
        entry.status = 'alive';
      }
      this.beats.set(id, entry);
    }
    return Array.from(this.beats.values());
  }

  /** 获取单个 Agent 状态 */
  getStatus(agentId: string): HeartbeatEntry | undefined {
    return this.beats.get(agentId);
  }

  /** 移除 Agent */
  remove(agentId: string): void {
    this.beats.delete(agentId);
  }
}

// ─── D16: Cron Scheduler ─────────────────────────────

export interface CronJob {
  id: string;
  name: string;
  /** Cron 表达式（简化版：interval in ms） */
  intervalMs: number;
  /** 要执行的任务描述（发送给 Orchestrator） */
  taskMessage: string;
  /** 目标 workspaceId */
  workspaceId?: string;
  enabled: boolean;
  lastRun?: number;
  nextRun?: number;
}

type CronHandler = (job: CronJob) => Promise<void>;

export class CronScheduler {
  private jobs = new Map<string, CronJob>();
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private handler?: CronHandler;

  /** 注册执行处理器 */
  onTick(handler: CronHandler): void {
    this.handler = handler;
  }

  /** 添加定时任务 */
  addJob(job: Omit<CronJob, 'id'>): CronJob {
    const id = `cron-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const newJob: CronJob = { ...job, id, nextRun: Date.now() + job.intervalMs };
    this.jobs.set(id, newJob);
    if (job.enabled) this.startJob(id);
    return newJob;
  }

  /** 启动任务 */
  private startJob(id: string): void {
    const job = this.jobs.get(id);
    if (!job || !this.handler) return;

    const timer = setInterval(async () => {
      job.lastRun = Date.now();
      job.nextRun = Date.now() + job.intervalMs;
      try {
        await this.handler!(job);
      } catch (err) {
        console.error(`[Cron] Job ${job.name} failed:`, err);
      }
    }, job.intervalMs);

    this.timers.set(id, timer);
  }

  /** 停止任务 */
  stopJob(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(id);
    }
    const job = this.jobs.get(id);
    if (job) job.enabled = false;
  }

  /** 删除任务 */
  removeJob(id: string): void {
    this.stopJob(id);
    this.jobs.delete(id);
  }

  /** 列出所有任务 */
  listJobs(): CronJob[] {
    return Array.from(this.jobs.values());
  }

  /** 停止所有 */
  stopAll(): void {
    for (const [id] of this.timers) {
      this.stopJob(id);
    }
  }
}

// ─── D17: Metrics Collector ──────────────────────────

export interface PerformanceMetrics {
  /** 请求总数 */
  totalRequests: number;
  /** 平均响应时间 (ms) */
  avgResponseTime: number;
  /** 总 Token 使用量 */
  totalTokens: { input: number; output: number };
  /** 总成本 (USD) */
  totalCost: number;
  /** Agent 执行统计 */
  agentStats: Record<string, {
    runs: number;
    avgIterations: number;
    totalCost: number;
    successRate: number;
  }>;
  /** 工具调用统计 */
  toolStats: Record<string, { calls: number; avgDuration: number }>;
  /** 启动时间 */
  startedAt: string;
  /** 运行时间 (ms) */
  uptimeMs: number;
}

export class MetricsCollector {
  private startTime = Date.now();
  private requests = 0;
  private responseTimes: number[] = [];
  private tokens = { input: 0, output: 0 };
  private cost = 0;
  private agents: Record<string, { runs: number; iterations: number[]; costs: number[]; successes: number }> = {};
  private tools: Record<string, { calls: number; durations: number[] }> = {};

  /** 记录请求 */
  recordRequest(durationMs: number): void {
    this.requests++;
    this.responseTimes.push(durationMs);
    // 保留最近 1000 个
    if (this.responseTimes.length > 1000) this.responseTimes.shift();
  }

  /** 记录 Token 使用 */
  recordTokens(input: number, output: number, cost: number): void {
    this.tokens.input += input;
    this.tokens.output += output;
    this.cost += cost;
  }

  /** 记录 Agent 执行 */
  recordAgentRun(agentId: string, iterations: number, cost: number, success: boolean): void {
    if (!this.agents[agentId]) {
      this.agents[agentId] = { runs: 0, iterations: [], costs: [], successes: 0 };
    }
    const a = this.agents[agentId];
    a.runs++;
    a.iterations.push(iterations);
    a.costs.push(cost);
    if (success) a.successes++;
  }

  /** 记录工具调用 */
  recordToolCall(toolName: string, durationMs: number): void {
    if (!this.tools[toolName]) {
      this.tools[toolName] = { calls: 0, durations: [] };
    }
    this.tools[toolName].calls++;
    this.tools[toolName].durations.push(durationMs);
  }

  /** 获取指标快照 */
  getMetrics(): PerformanceMetrics {
    const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

    const agentStats: PerformanceMetrics['agentStats'] = {};
    for (const [id, a] of Object.entries(this.agents)) {
      agentStats[id] = {
        runs: a.runs,
        avgIterations: Math.round(avg(a.iterations) * 10) / 10,
        totalCost: a.costs.reduce((s, c) => s + c, 0),
        successRate: a.runs > 0 ? Math.round((a.successes / a.runs) * 100) : 0,
      };
    }

    const toolStats: PerformanceMetrics['toolStats'] = {};
    for (const [name, t] of Object.entries(this.tools)) {
      toolStats[name] = {
        calls: t.calls,
        avgDuration: Math.round(avg(t.durations)),
      };
    }

    return {
      totalRequests: this.requests,
      avgResponseTime: Math.round(avg(this.responseTimes)),
      totalTokens: { ...this.tokens },
      totalCost: Math.round(this.cost * 10000) / 10000,
      agentStats,
      toolStats,
      startedAt: new Date(this.startTime).toISOString(),
      uptimeMs: Date.now() - this.startTime,
    };
  }
}
