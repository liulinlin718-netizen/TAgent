/**
 * Agent Pool — 常驻 Agent 管理 (plan §3.2 二态模型)
 *
 * 🟢 常驻态 (Resident): 固定通用 Agent 始终待命
 * 🟡 任务态 (Task-Spawned): 根据任务动态创建
 * ⚡ 裂变: 所有 Agent 的内建能力
 *
 * Phase 2: 3 个常驻 Agent — 研究/文档/数据
 */

import { createAgentCard, type AgentCard, type AgentState } from './agent-card.js';

// ─── Resident Agent Definitions ──────────────────────

const RESEARCH_AGENT: AgentCard = createAgentCard({
  id: 'research-agent',
  name: '研究助手',
  type: 'resident',
  description: '负责信息搜索、调研报告、竞品分析。擅长从互联网获取和整理信息。',
  icon: '🔍',
  capabilities: {
    skills: ['web-research', 'competitor-analysis'],
    tools: ['web_search', 'read_url'],
    mcpServers: [],
  },
  constraints: {
    maxFissionDepth: 2,
    maxCostPerTask: 0.5,
    allowedTools: ['web_search', 'read_url'],
    approvalMode: 'full_auto',
  },
});

const DOCUMENT_AGENT: AgentCard = createAgentCard({
  id: 'document-agent',
  name: '文档助手',
  type: 'resident',
  description: '负责文档撰写、报告生成、内容编辑和格式化。擅长将信息整理为结构化文档。',
  icon: '📄',
  capabilities: {
    skills: ['report-generation', 'content-editing'],
    tools: ['web_search', 'read_url'],
    mcpServers: [],
  },
  constraints: {
    maxFissionDepth: 1,
    maxCostPerTask: 0.3,
    allowedTools: ['web_search', 'read_url'],
    approvalMode: 'full_auto',
  },
});

const DATA_AGENT: AgentCard = createAgentCard({
  id: 'data-agent',
  name: '数据分析',
  type: 'resident',
  description: '负责数据整理、统计分析、趋势洞察。擅长从数据中提取关键信息。',
  icon: '📊',
  capabilities: {
    skills: ['data-analysis', 'trend-insight'],
    tools: ['web_search', 'read_url'],
    mcpServers: [],
  },
  constraints: {
    maxFissionDepth: 1,
    maxCostPerTask: 0.3,
    allowedTools: ['web_search', 'read_url'],
    approvalMode: 'full_auto',
  },
});

// ─── SOUL Definitions ────────────────────────────────

export const AGENT_SOULS: Record<string, string> = {
  'research-agent': `你是 TAgent 的研究助手（Research Agent）。

## 核心能力
- 使用 web_search 搜索互联网获取最新信息
- 使用 read_url 深入阅读网页内容
- 整合多来源信息生成结构化调研报告

## ⚠️ 关键行为规则（必须严格遵守）
1. **最多搜索 3 次**。搜索 3 次后，必须立即停止搜索，用已有信息生成报告。
2. **不要反复换关键词重试**。如果搜索返回了结果（哪怕不完美），就直接使用。
3. **搜索后立即整理输出**。不要等到"所有信息都完美"才写报告，有什么用什么。
4. 每次只调用一个工具
5. 最终输出必须是**完整的中文报告**，包含标题、要点、来源

## 工作流程
第 1-2 步：搜索关键信息（web_search）
第 3 步（可选）：深入阅读一个关键链接（read_url）
第 4 步：**必须输出最终报告**，不再调用任何工具

## 输出格式
用清晰的 Markdown 格式：标题、子标题、要点列表、信息来源。
保持客观，区分事实和观点。`,

  'document-agent': `你是 TAgent 的文档助手（Document Agent）。

## 核心能力
- 将研究数据和分析结果整合为高质量报告
- 结构化文档撰写（标题/段落/列表/表格）
- 内容润色和格式优化

## ⚠️ 关键行为规则（必须严格遵守）
1. **基于已有上下文直接撰写**，不要反复搜索。最多搜索 1 次作为补充。
2. **收到任务后立即开始写**，不要先搜索再说。
3. 输出必须是完整的 Markdown 文档
4. 不编造数据，标注不确定内容

## 输出格式
使用 Markdown：# 标题、## 子标题、- 列表、| 表格。
确保逻辑连贯、语言专业、可读性强。`,

  'data-agent': `你是 TAgent 的数据分析助手（Data Agent）。

## 核心能力
- 数据收集和整理（搜索公开数据源）
- 趋势分析和洞察提取
- 统计数据的解读和可视化建议

## ⚠️ 关键行为规则（必须严格遵守）
1. **最多搜索 2 次**获取数据，然后立即分析输出。
2. 不要无限搜索。有什么数据就分析什么。
3. 输出必须包含具体数字和分析结论

## 输出格式
提供具体数字、趋势分析、行动建议。标注数据时间范围和来源。`,
};

// ─── Agent Pool ──────────────────────────────────────

export class AgentPool {
  private agents = new Map<string, AgentCard>();
  private taskAgentCounter = 0;

  constructor() {
    this.agents.set(RESEARCH_AGENT.id, { ...RESEARCH_AGENT });
    this.agents.set(DOCUMENT_AGENT.id, { ...DOCUMENT_AGENT });
    this.agents.set(DATA_AGENT.id, { ...DATA_AGENT });
  }

  getResidentAgents(): AgentCard[] {
    return Array.from(this.agents.values()).filter(a => a.type === 'resident');
  }

  getAllAgents(): AgentCard[] {
    return Array.from(this.agents.values());
  }

  getAgent(id: string): AgentCard | undefined {
    return this.agents.get(id);
  }

  updateState(id: string, state: Partial<AgentState>): void {
    const agent = this.agents.get(id);
    if (agent) {
      agent.state = { ...agent.state, ...state };
    }
  }

  /** 创建任务态 Agent（动态裂变） */
  spawnTaskAgent(
    parentId: string,
    name: string,
    description: string,
    icon: string = '⚡',
  ): AgentCard {
    this.taskAgentCounter++;
    const id = `task-agent-${this.taskAgentCounter}-${Date.now()}`;

    const parent = this.agents.get(parentId);
    const card = createAgentCard({
      id,
      name,
      type: 'task_spawned',
      description,
      icon,
      constraints: {
        maxFissionDepth: parent ? parent.constraints.maxFissionDepth - 1 : 1,
        maxCostPerTask: parent ? parent.constraints.maxCostPerTask * 0.5 : 0.2,
        allowedTools: parent?.constraints.allowedTools || ['web_search', 'read_url'],
        approvalMode: parent?.constraints.approvalMode || 'full_auto',
      },
      parentAgentId: parentId,
    });

    this.agents.set(id, card);
    if (parent) parent.childAgentIds.push(id);

    return card;
  }

  archiveAgent(id: string): void {
    const agent = this.agents.get(id);
    if (agent && agent.type === 'task_spawned') {
      agent.state.runtime = 'stopped';
      agent.state.business = 'idle';
    }
  }

  findBestAgent(requiredCapabilities: string[]): AgentCard | null {
    const residents = this.getResidentAgents().filter(a =>
      a.state.business === 'idle' || a.state.business === 'waiting',
    );

    let best: AgentCard | null = null;
    let bestScore = 0;

    for (const agent of residents) {
      const score = requiredCapabilities.filter(
        c => agent.capabilities.skills.includes(c) || agent.description.includes(c),
      ).length;
      if (score > bestScore) {
        bestScore = score;
        best = agent;
      }
    }
    return best;
  }
}
