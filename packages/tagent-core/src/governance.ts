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
  deliveryStatus?: 'passed' | 'needs_revision' | 'unverified';
  independentSources?: number;
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
    if (ctx.deliveryStatus !== 'passed') {
      return {
        passed: true,
        event: {
          policyType: 'quality', severity: 'soft', result: 'warning',
          message: ctx.deliveryStatus === 'needs_revision' ? '实际交付核对发现问题，不能标记为已核验。' : '尚无完整交付核对结果，不以迭代次数或费用推断内容质量。',
          suggestion: '保留原稿与核对缺口，先查看具体失败项；不自动追加搜索或模型调用。',
        },
      };
    }
    return { passed: true, event: { policyType: 'quality', severity: 'info', result: 'passed', message: '实际交付核对记录通过；模型辅助核对不等于独立事实核查。' } };
  },
};

/** D9: 质量协议增强 — 信息源多样性检查 */
const sourceDiversityRule: GovernanceRule = {
  type: 'quality',
  name: 'source_diversity',
  severity: 'info',
  check(ctx) {
    if (ctx.independentSources === undefined || ctx.independentSources < 2) {
      return {
        passed: true,
        event: {
          policyType: 'quality', severity: 'info', result: 'warning',
          message: ctx.independentSources === undefined ? '尚无来源独立性核对记录。' : `当前识别到${ctx.independentSources}个独立发布方，交叉支持不足。`,
          suggestion: '查看来源原文与转载关系；搜索次数不能代替独立来源数量。',
        },
      };
    }
    return { passed: true, event: { policyType: 'quality', severity: 'info', result: 'passed', message: '已识别多个独立发布方；仍需逐条核对内容是否相互支持。' } };
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
    return { passed: true, event: { policyType: 'alignment', severity: 'info', result: 'passed', message: '尚未达到路径复核提醒阈值；不代表语义方向已验证。' } };
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

  constructor(private readonly template: GovernanceTemplate = 'standard') {
    this.rules = [...TEMPLATES[template]];
  }

  evaluate(ctx: GovernanceContext): {
    allPassed: boolean;
    results: GovernanceResult[];
    blockers: GovernanceResult[];
  } {
    const results = this.rules.map(rule => this.evaluateRule(rule, ctx));
    const blockers = results.filter(r => !r.passed);
    return { allPassed: blockers.length === 0, results, blockers };
  }

  /** 获取所有检查结果（包括 passed 的），用于决策链回溯 */
  evaluateAll(ctx: GovernanceContext): GovernanceResult[] {
    return this.rules.map(rule => this.evaluateRule(rule, ctx));
  }

  private evaluateRule(rule: GovernanceRule, ctx: GovernanceContext): GovernanceResult {
    const result = rule.check(ctx);
    const inputs: Record<string, string | number | boolean> = {};
    const keys: (keyof GovernanceContext)[] = rule.name === 'budget_cap' ? ['currentCost', 'maxCost']
      : rule.name === 'iteration_limit' || rule.name === 'intent_alignment' ? ['currentIterations', 'maxIterations']
      : rule.name === 'tool_whitelist' ? ['toolName', 'approvalMode']
      : rule.name === 'fission_depth' ? ['fissionDepth', 'maxFissionDepth']
      : rule.name === 'output_quality' ? ['deliveryStatus']
      : rule.name === 'source_diversity' ? ['independentSources'] : ['activeAgentCount', 'maxAgents'];
    for (const key of keys) {
      const value = ctx[key];
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') inputs[key] = value;
    }
    if (rule.name === 'tool_whitelist' && ctx.toolName && ctx.allowedTools) inputs.allowed = ctx.allowedTools.includes(ctx.toolName);
    return { ...result, event: { ...result.event, ruleName: rule.name, decision: {
      policyVersion: 1, template: this.template, ruleId: rule.name,
      effect: !result.passed ? 'stop' : result.event.result === 'warning' ? (result.event.severity === 'soft' ? 'review' : 'inform') : 'allow',
      reason: result.event.message, alternatives: result.event.suggestion ? [result.event.suggestion] : [], inputs,
    } } };
  }

  addRule(rule: GovernanceRule): void {
    this.rules.push(rule);
  }
}
