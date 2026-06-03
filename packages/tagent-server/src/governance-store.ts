/**
 * Governance Event Store — Phase 4 治理事件持久化
 *
 * 记录每次治理检查的结果，供仪表盘查询。
 */

export interface GovernanceRecord {
  id: string;
  timestamp: number;
  agentId: string;
  policyType: string;    // resource | security | quality | alignment
  ruleName: string;
  severity: string;      // hard | soft | info
  result: string;        // passed | blocked | warning
  message: string;
  suggestion?: string;
  sessionId?: string;
}

export interface GovernanceStats {
  totalChecks: number;
  totalBlocked: number;
  totalWarnings: number;
  byPolicyType: Record<string, { checks: number; blocked: number }>;
  costTimeline: { timestamp: number; cost: number }[];
}

class GovernanceStore {
  private events: GovernanceRecord[] = [];
  private costTimeline: { timestamp: number; cost: number }[] = [];

  record(event: Omit<GovernanceRecord, 'id' | 'timestamp'>): GovernanceRecord {
    const record: GovernanceRecord = {
      ...event,
      id: `gov-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
    };
    this.events.push(record);
    return record;
  }

  recordCost(cost: number): void {
    this.costTimeline.push({ timestamp: Date.now(), cost });
  }

  getEvents(limit = 50): GovernanceRecord[] {
    return this.events.slice(-limit).reverse();
  }

  getStats(): GovernanceStats {
    const totalChecks = this.events.length;
    const totalBlocked = this.events.filter(e => e.result === 'blocked').length;
    const totalWarnings = this.events.filter(e => e.result === 'warning').length;

    const byPolicyType: Record<string, { checks: number; blocked: number }> = {};
    for (const event of this.events) {
      if (!byPolicyType[event.policyType]) {
        byPolicyType[event.policyType] = { checks: 0, blocked: 0 };
      }
      byPolicyType[event.policyType].checks++;
      if (event.result === 'blocked') {
        byPolicyType[event.policyType].blocked++;
      }
    }

    return {
      totalChecks,
      totalBlocked,
      totalWarnings,
      byPolicyType,
      costTimeline: this.costTimeline.slice(-100),
    };
  }
}

export const governanceStore = new GovernanceStore();
