/**
 * 治理引擎 — plan §3.10 三层治理模型
 *
 * 策略层: 用户约束 → 治理规则集
 * 协议层: 资源 / 安全 / 质量 / 方向
 * 执行层: 通过 / 拦截 / 升级
 *
 * 作为 Hook 内嵌到 Agent Loop 步骤④
 */

import type { GovernanceEventPayload } from './protocol.js';
import type { ApprovalMode } from './agent-card.js';

// ─── Types ───────────────────────────────────────────

export interface GovernanceRule {
  type: 'resource' | 'security' | 'quality' | 'alignment';
  name: string;
  severity: 'hard' | 'soft' | 'info';
  check: (ctx: GovernanceContext) => GovernanceResult;
}

export interface GovernanceContext {
  agentId: string;
  currentCost: number;
  maxCost: number;
  currentIterations: number;
  maxIterations: number;
  toolName?: string;
  allowedTools?: string[];
  fissionDepth?: number;
  maxFissionDepth?: number;
  approvalMode: ApprovalMode;
}

export interface GovernanceResult {
  passed: boolean;
  event: GovernanceEventPayload;
}

// ─── Built-in Rules ──────────────────────────────────

/** 资源协议: 成本硬上限 + 80% 预警 */
const budgetCapRule: GovernanceRule = {
  type: 'resource',
  name: 'budget_cap',
  severity: 'hard',
  check(ctx) {
    if (ctx.currentCost >= ctx.maxCost) {
      return {
        passed: false,
        event: {
          policyType: 'resource', severity: 'hard', result: 'blocked',
          message: `成本已达上限 $${ctx.maxCost.toFixed(2)}（当前 $${ctx.currentCost.toFixed(4)}）`,
          suggestion: '降低搜索次数或使用更便宜的模型',
        },
      };
    }
    if (ctx.currentCost >= ctx.maxCost * 0.8) {
      return {
        passed: true,
        event: {
          policyType: 'resource', severity: 'info', result: 'warning',
          message: `成本已达 ${((ctx.currentCost / ctx.maxCost) * 100).toFixed(0)}% 预算`,
        },
      };
    }
    return { passed: true, event: { policyType: 'resource', severity: 'info', result: 'passed', message: '成本检查通过' } };
  },
};

/** 资源协议: 迭代次数限制 */
const iterationLimitRule: GovernanceRule = {
  type: 'resource',
  name: 'iteration_limit',
  severity: 'hard',
  check(ctx) {
    if (ctx.currentIterations >= ctx.maxIterations) {
      return {
        passed: false,
        event: { policyType: 'resource', severity: 'hard', result: 'blocked', message: `迭代次数已达上限 ${ctx.maxIterations}` },
      };
    }
    return { passed: true, event: { policyType: 'resource', severity: 'info', result: 'passed', message: '迭代检查通过' } };
  },
};

/** 安全协议: 工具权限白名单 */
const toolWhitelistRule: GovernanceRule = {
  type: 'security',
  name: 'tool_whitelist',
  severity: 'hard',
  check(ctx) {
    if (!ctx.toolName || !ctx.allowedTools) {
      return { passed: true, event: { policyType: 'security', severity: 'info', result: 'passed', message: '无工具调用' } };
    }
    if (ctx.toolName === 'spawn_agent') {
      return { passed: true, event: { policyType: 'security', severity: 'info', result: 'passed', message: 'spawn_agent 为内建能力' } };
    }
    if (!ctx.allowedTools.includes(ctx.toolName)) {
      return {
        passed: false,
        event: {
          policyType: 'security', severity: 'hard', result: 'blocked',
          message: `工具 "${ctx.toolName}" 未在白名单中`,
          suggestion: `允许的工具: ${ctx.allowedTools.join(', ')}`,
        },
      };
    }
    return { passed: true, event: { policyType: 'security', severity: 'info', result: 'passed', message: `工具 "${ctx.toolName}" 已授权` } };
  },
};

/** 安全协议: 裂变深度限制 */
const fissionDepthRule: GovernanceRule = {
  type: 'security',
  name: 'fission_depth',
  severity: 'hard',
  check(ctx) {
    if (ctx.fissionDepth === undefined || ctx.maxFissionDepth === undefined) {
      return { passed: true, event: { policyType: 'security', severity: 'info', result: 'passed', message: '裂变检查跳过' } };
    }
    if (ctx.fissionDepth >= ctx.maxFissionDepth) {
      return {
        passed: false,
        event: {
          policyType: 'security', severity: 'hard', result: 'blocked',
          message: `裂变深度已达上限 ${ctx.maxFissionDepth}`,
          suggestion: '直接使用已有 Agent 或自行完成子任务',
        },
      };
    }
    return { passed: true, event: { policyType: 'security', severity: 'info', result: 'passed', message: '裂变深度检查通过' } };
  },
};

// ─── Governance Engine ───────────────────────────────

export type GovernanceTemplate = 'strict_cost' | 'quality_first' | 'standard';

const TEMPLATES: Record<GovernanceTemplate, GovernanceRule[]> = {
  strict_cost: [budgetCapRule, iterationLimitRule, toolWhitelistRule, fissionDepthRule],
  quality_first: [budgetCapRule, iterationLimitRule, toolWhitelistRule, fissionDepthRule],
  standard: [budgetCapRule, iterationLimitRule, toolWhitelistRule, fissionDepthRule],
};

export class GovernanceEngine {
  private rules: GovernanceRule[];

  constructor(template: GovernanceTemplate = 'standard') {
    this.rules = [...TEMPLATES[template]];
  }

  evaluate(ctx: GovernanceContext): {
    allPassed: boolean;
    results: GovernanceResult[];
    blockers: GovernanceResult[];
  } {
    const results = this.rules.map(rule => rule.check(ctx));
    const blockers = results.filter(r => !r.passed);
    return { allPassed: blockers.length === 0, results, blockers };
  }

  addRule(rule: GovernanceRule): void {
    this.rules.push(rule);
  }
}
