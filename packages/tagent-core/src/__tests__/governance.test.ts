/**
 * Governance Engine — 单元测试 (D11)
 *
 * 覆盖: budgetCap, iterationLimit, toolWhitelist, fissionDepth,
 *       qualityCheck, alignmentCheck + 3 种模板差异
 */

import { describe, it, expect } from 'vitest';
import { GovernanceEngine, type GovernanceContext, type GovernanceTemplate } from '../governance.js';

function makeCtx(overrides: Partial<GovernanceContext> = {}): GovernanceContext {
  return {
    agentId: 'test-agent',
    currentCost: 0,
    maxCost: 1.0,
    currentIterations: 1,
    maxIterations: 15,
    approvalMode: 'full_auto',
    ...overrides,
  };
}

describe('GovernanceEngine', () => {
  // ─── Budget Cap Rule ─────────────────────────────
  describe('budgetCapRule', () => {
    it('should pass when cost is well below limit', () => {
      const engine = new GovernanceEngine('standard');
      const result = engine.evaluate(makeCtx({ currentCost: 0.1, maxCost: 1.0 }));
      expect(result.allPassed).toBe(true);
      expect(result.blockers).toHaveLength(0);
    });

    it('should warn at 80% budget', () => {
      const engine = new GovernanceEngine('standard');
      const result = engine.evaluate(makeCtx({ currentCost: 0.85, maxCost: 1.0 }));
      expect(result.allPassed).toBe(true);
      const warnings = result.results.filter(r => r.event.result === 'warning');
      expect(warnings.length).toBeGreaterThanOrEqual(1);
      expect(warnings.some(w => w.event.policyType === 'resource')).toBe(true);
    });

    it('should block when cost exceeds limit', () => {
      const engine = new GovernanceEngine('standard');
      const result = engine.evaluate(makeCtx({ currentCost: 1.5, maxCost: 1.0 }));
      expect(result.allPassed).toBe(false);
      expect(result.blockers[0].event.policyType).toBe('resource');
      expect(result.blockers[0].event.result).toBe('blocked');
    });
  });

  // ─── Iteration Limit Rule ────────────────────────
  describe('iterationLimitRule', () => {
    it('should pass under limit', () => {
      const engine = new GovernanceEngine('standard');
      const result = engine.evaluate(makeCtx({ currentIterations: 5, maxIterations: 15 }));
      expect(result.allPassed).toBe(true);
    });

    it('should block when iterations exceed limit', () => {
      const engine = new GovernanceEngine('standard');
      const result = engine.evaluate(makeCtx({ currentIterations: 20, maxIterations: 15 }));
      expect(result.allPassed).toBe(false);
      expect(result.blockers[0].event.policyType).toBe('resource');
    });
  });

  // ─── Tool Whitelist Rule ─────────────────────────
  describe('toolWhitelistRule', () => {
    it('should pass when tool is in whitelist', () => {
      const engine = new GovernanceEngine('standard');
      const result = engine.evaluate(makeCtx({ toolName: 'web_search', allowedTools: ['web_search', 'read_url'] }));
      expect(result.allPassed).toBe(true);
    });

    it('should block when tool is NOT in whitelist', () => {
      const engine = new GovernanceEngine('standard');
      const result = engine.evaluate(makeCtx({ toolName: 'dangerous_tool', allowedTools: ['web_search'] }));
      expect(result.allPassed).toBe(false);
      expect(result.blockers[0].event.policyType).toBe('security');
    });

    it('should always allow spawn_agent', () => {
      const engine = new GovernanceEngine('standard');
      const result = engine.evaluate(makeCtx({ toolName: 'spawn_agent', allowedTools: ['web_search'] }));
      expect(result.allPassed).toBe(true);
    });
  });

  // ─── Fission Depth Rule ──────────────────────────
  describe('fissionDepthRule', () => {
    it('should pass when depth is within limit', () => {
      const engine = new GovernanceEngine('standard');
      const result = engine.evaluate(makeCtx({ fissionDepth: 1, maxFissionDepth: 2 }));
      expect(result.allPassed).toBe(true);
    });

    it('should block when depth reaches limit', () => {
      const engine = new GovernanceEngine('standard');
      const result = engine.evaluate(makeCtx({ fissionDepth: 2, maxFissionDepth: 2 }));
      expect(result.allPassed).toBe(false);
      expect(result.blockers[0].event.policyType).toBe('security');
    });
  });

  // ─── Template Differentiation ────────────────────
  describe('template differentiation', () => {
    it('standard template should NOT have quality/alignment rules', () => {
      const engine = new GovernanceEngine('standard');
      // Low iterations should not trigger quality warning in standard
      const result = engine.evaluate(makeCtx({ currentIterations: 1, currentCost: 0.01 }));
      const qualityEvents = result.results.filter(r => r.event.policyType === 'quality');
      expect(qualityEvents).toHaveLength(0);
    });

    it('strict_cost template should have quality + alignment rules', () => {
      const engine = new GovernanceEngine('strict_cost');
      const result = engine.evaluate(makeCtx({ currentIterations: 1, currentCost: 0.01 }));
      const qualityEvents = result.results.filter(r => r.event.policyType === 'quality');
      expect(qualityEvents.length).toBeGreaterThanOrEqual(1);
    });

    it('quality_first template should have quality + alignment rules', () => {
      const engine = new GovernanceEngine('quality_first');
      const result = engine.evaluate(makeCtx({ currentIterations: 10, maxIterations: 15 }));
      const alignmentEvents = result.results.filter(r => r.event.policyType === 'alignment');
      expect(alignmentEvents.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── evaluateAll ─────────────────────────────────
  describe('evaluateAll', () => {
    it('should return all results including passed', () => {
      const engine = new GovernanceEngine('strict_cost');
      const results = engine.evaluateAll(makeCtx());
      // strict_cost has 8 rules (D9: +sourceDiversityRule, +organizationRule)
      expect(results.length).toBe(8);
    });
  });

  // ─── addRule ─────────────────────────────────────
  describe('addRule', () => {
    it('should allow adding custom rules', () => {
      const engine = new GovernanceEngine('standard');
      engine.addRule({
        type: 'quality',
        name: 'custom_rule',
        severity: 'info',
        check: () => ({ passed: true, event: { policyType: 'quality', severity: 'info', result: 'passed', message: 'ok' } }),
      });
      const results = engine.evaluateAll(makeCtx());
      // standard has 4 + 1 custom = 5
      expect(results.length).toBe(5);
    });
  });
});
