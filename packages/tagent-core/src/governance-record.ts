import type { ToolApprovalView } from './tool-approval.js';
import type { GovernanceEventPayload } from './protocol.js';
export interface GovernanceRecord {
  decision?: GovernanceEventPayload['decision'];
  id: string; timestamp: number; workspaceId: string; sessionId: string; runId: string; taskId?: string;
  agentId: string; agentName: string; policyType: string; ruleName: string; severity: string; result: string;
  message: string; suggestion?: string; approval?: ToolApprovalView; persisted: boolean;
}
export interface GovernanceStats {
  totalChecks: number; totalBlocked: number; totalWarnings: number; totalPassed: number;
  byPolicyType: Record<string, { checks: number; blocked: number }>;
  costTimeline: { timestamp: number; cost: number; runId: string }[];
}
