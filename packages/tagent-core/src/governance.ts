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
  type: 'resource' | 'security' | 'quality' | 'alignment' | 'organization';
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
  /** 组织治理: 当前活跃 Agent 数 */
  activeAgentCount?: number;
  /** 组织治理: 最大允许 Agent 数 */
  maxAgents?: number;
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
    if (ctx.currentIterations > ctx.maxIterations) {
      return {
        passed: false,
        event: { policyType: 'resource', severity: 'hard', result: 'blocked', message: `迭代次数已超上限 ${ctx.maxIterations}` },
      };
    }
    if (ctx.currentIterations >= ctx.maxIterations * 0.8) {
      return {
        passed: true,
        event: { policyType: 'resource', severity: 'info', result: 'warning', message: `迭代次数已达上限 ${Math.round((ctx.currentIterations / ctx.maxIterations) * 100)}%` },
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

/** 质量协议: 输出置信度检查 (plan §3.10 五类治理协议 - 质量治理) */
const qualityCheckRule: GovernanceRule = {
  type: 'quality',
  name: 'output_quality',
  severity: 'soft',
  check(ctx) {
    // D9: 迭代次数过低时发出警告（可能草率完成）
    if (ctx.currentIterations < 2 && ctx.currentCost > 0) {
      return {
        passed: true,
        event: {
          policyType: 'quality', severity: 'soft', result: 'warning',
          message: '迭代次数较少，建议更深入分析以确保输出质量',
          suggestion: '增加搜索范围或交叉验证信息源',
        },
      };
    }
    return { passed: true, event: { policyType: 'quality', severity: 'info', result: 'passed', message: '质量检查通过' } };
  },
};

/** D9: 质量协议增强 — 信息源多样性检查 */
const sourceDiversityRule: GovernanceRule = {
  type: 'quality',
  name: 'source_diversity',
  severity: 'info',
  check(ctx) {
    // 如果 Agent 使用了工具但迭代次数 < 3，提示信息源可能不够多样
    if (ctx.toolName === 'web_search' && ctx.currentIterations < 3) {
      return {
        passed: true,
        event: {
          policyType: 'quality', severity: 'info', result: 'warning',
          message: '搜索次数较少，建议使用多个关键词以提高信息源多样性',
          suggestion: '尝试不同角度的搜索查询，交叉验证信息',
        },
      };
    }
    return { passed: true, event: { policyType: 'quality', severity: 'info', result: 'passed', message: '信息源多样性检查通过' } };
  },
};

/** 方向协议: 意图对齐检测 (plan §3.10 五类治理协议 - 方向治理) */
const alignmentCheckRule: GovernanceRule = {
  type: 'alignment',
  name: 'intent_alignment',
  severity: 'soft',
  check(ctx) {
    // 当迭代次数超过上限的 60% 且仍在运行，可能偏离方向
    if (ctx.currentIterations > ctx.maxIterations * 0.6) {
      return {
        passed: true,
        event: {
          policyType: 'alignment', severity: 'info', result: 'warning',
          message: `已执行 ${ctx.currentIterations} 次迭代，请确认任务方向是否正确`,
          suggestion: '检查当前执行路径是否偏离了原始用户意图',
        },
      };
    }
    return { passed: true, event: { policyType: 'alignment', severity: 'info', result: 'passed', message: '方向检查通过' } };
  },
};

/** 组织治理: 团队变更/能力评估 (plan §3.10 五类治理协议 - 组织治理) */
const organizationRule: GovernanceRule = {
  type: 'organization',
  name: 'team_change_review',
  severity: 'soft',
  check(ctx) {
    const maxAgents = ctx.maxAgents ?? 10;
    const activeCount = ctx.activeAgentCount ?? 0;
    // 当活跃 Agent 数超过限制的 80%，警告
    if (activeCount >= maxAgents) {
      return {
        passed: false,
        event: {
          policyType: 'organization', severity: 'hard', result: 'blocked',
          message: `活跃 Agent 数已达上限 ${maxAgents}，无法创建新 Agent`,
          suggestion: '归档不活跃的任务 Agent 或提高上限',
        },
      };
    }
    if (activeCount >= maxAgents * 0.8) {
      return {
        passed: true,
        event: {
          policyType: 'organization', severity: 'soft', result: 'warning',
          message: `活跃 Agent 数已达 ${activeCount}/${maxAgents}，接近上限`,
          suggestion: '评估是否有可归档的 Agent，避免角色重复',
        },
      };
    }
    return { passed: true, event: { policyType: 'organization', severity: 'info', result: 'passed', message: '组织检查通过' } };
  },
};

// ─── Governance Engine ───────────────────────────────

export type GovernanceTemplate = 'strict_cost' | 'quality_first' | 'standard';

/**
 * 模板差异化 (plan §3.10):
 * - strict_cost: 所有规则 + 质量 + 方向 — 强调成本控制
 * - quality_first: 所有规则 + 质量 + 方向 — 质量检查为 soft（审议）而非 info
 * - standard: 基础规则（成本+迭代+白名单+裂变）— 最宽松
 */
const TEMPLATES: Record<GovernanceTemplate, GovernanceRule[]> = {
  strict_cost: [budgetCapRule, iterationLimitRule, toolWhitelistRule, fissionDepthRule, qualityCheckRule, sourceDiversityRule, alignmentCheckRule, organizationRule],
  quality_first: [budgetCapRule, iterationLimitRule, toolWhitelistRule, fissionDepthRule, qualityCheckRule, sourceDiversityRule, alignmentCheckRule, organizationRule],
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

  /** 获取所有检查结果（包括 passed 的），用于决策链回溯 */
  evaluateAll(ctx: GovernanceContext): GovernanceResult[] {
    return this.rules.map(rule => rule.check(ctx));
  }

  addRule(rule: GovernanceRule): void {
    this.rules.push(rule);
  }
}

