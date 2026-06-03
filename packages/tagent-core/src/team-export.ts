/**
 * 团队导出/导入 + 敏感信息脱敏 — Phase 4 (plan §6)
 *
 * 导出完整的 Agent Pool 配置（Agent Cards + Skills 绑定 + MCP 绑定）
 * 导入时自动合并，支持脱敏模式隐藏 API Key 等敏感信息
 */

import type { AgentCard } from './agent-card.js';

// ─── Types ───────────────────────────────────────────

export interface TeamExport {
  version: string;
  exportedAt: string;
  agents: AgentCard[];
  skillBindings: Record<string, string[]>;     // agentId → skill IDs
  mcpBindings: Record<string, string[]>;        // agentId → MCP server IDs
  metadata?: Record<string, unknown>;
}

export interface SanitizeOptions {
  /** 移除 API Key 和凭证 */
  removeCredentials?: boolean;
  /** 模糊化 Agent 描述中的公司名等 */
  anonymize?: boolean;
  /** 自定义脱敏正则 */
  customPatterns?: RegExp[];
}

// ─── Sensitive Patterns ──────────────────────────────

const SENSITIVE_PATTERNS = [
  /(?:api[_-]?key|apikey|secret|token|password|credential|auth)["\s:=]+["']?[a-zA-Z0-9\-_]{16,}["']?/gi,
  /sk-[a-zA-Z0-9]{32,}/g,             // OpenAI key
  /sk-ant-[a-zA-Z0-9\-]{32,}/g,       // Anthropic key
  /ghp_[a-zA-Z0-9]{36}/g,             // GitHub PAT
  /Bearer\s+[a-zA-Z0-9\-_.]{20,}/gi,  // Bearer tokens
];

// ─── Export ──────────────────────────────────────────

export function exportTeam(
  agents: AgentCard[],
  options: SanitizeOptions = {},
): TeamExport {
  const { removeCredentials = true, anonymize = false, customPatterns = [] } = options;

  let exportedAgents = agents.map(a => structuredClone(a));

  if (removeCredentials || anonymize) {
    exportedAgents = exportedAgents.map(agent => sanitizeAgent(agent, {
      removeCredentials,
      anonymize,
      customPatterns,
    }));
  }

  // Build bindings
  const skillBindings: Record<string, string[]> = {};
  const mcpBindings: Record<string, string[]> = {};
  for (const agent of exportedAgents) {
    if (agent.capabilities.skills?.length) {
      skillBindings[agent.id] = [...agent.capabilities.skills];
    }
    if (agent.capabilities.mcpServers?.length) {
      mcpBindings[agent.id] = [...agent.capabilities.mcpServers];
    }
  }

  return {
    version: '1.0.0',
    exportedAt: new Date().toISOString(),
    agents: exportedAgents,
    skillBindings,
    mcpBindings,
  };
}

// ─── Import ──────────────────────────────────────────

export function importTeam(
  data: TeamExport,
  existingAgents: AgentCard[],
  mode: 'merge' | 'replace' = 'merge',
): AgentCard[] {
  if (mode === 'replace') {
    return data.agents;
  }

  // Merge: add new agents, update existing by ID
  const merged = [...existingAgents];
  for (const imported of data.agents) {
    const existingIdx = merged.findIndex(a => a.id === imported.id);
    if (existingIdx >= 0) {
      // Update existing
      merged[existingIdx] = { ...merged[existingIdx], ...imported };
    } else {
      // Add new
      merged.push(imported);
    }
  }
  return merged;
}

// ─── Sanitize ────────────────────────────────────────

function sanitizeAgent(agent: AgentCard, options: SanitizeOptions): AgentCard {
  const sanitized = structuredClone(agent);

  if (options.removeCredentials) {
    // Sanitize all string values recursively
    sanitizeObject(sanitized as unknown as Record<string, unknown>, [...SENSITIVE_PATTERNS, ...(options.customPatterns || [])]);
  }

  if (options.anonymize) {
    // Replace company-like names in description
    sanitized.description = sanitized.description
      .replace(/[\u4e00-\u9fa5]{2,}公司/g, '[公司名]')
      .replace(/[\u4e00-\u9fa5]{2,}团队/g, '[团队名]');
  }

  return sanitized;
}

function sanitizeObject(obj: Record<string, unknown>, patterns: RegExp[]): void {
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (typeof value === 'string') {
      let sanitized = value;
      for (const pattern of patterns) {
        // Reset regex lastIndex
        pattern.lastIndex = 0;
        sanitized = sanitized.replace(pattern, '[REDACTED]');
      }
      obj[key] = sanitized;
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      sanitizeObject(value as Record<string, unknown>, patterns);
    }
  }
}
