'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { Activity, Bot, FlaskConical, GitBranch, GripVertical, Pencil, Plus, RefreshCw, Save, Search, Shield, Star, Wrench, X } from 'lucide-react';
import { PolarAngleAxis, PolarGrid, PolarRadiusAxis, Radar, RadarChart, ResponsiveContainer } from 'recharts';
import type { TaskAgentSpawnMeta } from '@tagent/core';
import type { BenchmarkRun, AgentBenchmarkProfile, BenchmarkDimension } from '@tagent/core';
import BenchmarkDialog from './BenchmarkDialog';
import styles from './agents.module.css';

import { API_BASE as API, apiFetch as fetch } from '../../../lib/api-client';
import { AccessControl } from '../../../components/AccessGate';

interface AgentCard {
  id: string;
  configurationRevision?: number;
  name: string;
  type: 'resident' | 'task_spawned';
  description: string;
  icon: string;
  capabilities: {
    skills: string[];
    tools: string[];
    mcpServers: string[];
  };
  constraints: {
    maxFissionDepth: number;
    maxCostPerTask: number;
    allowedTools: string[];
    approvalMode: 'suggest' | 'auto_edit' | 'full_auto';
    allowedDomains: string[];
  };
  state: {
    business: 'idle' | 'busy' | 'waiting';
    runtime: 'running' | 'stopped' | 'error';
    humanInteraction: 'idle' | 'waiting_human';
    orchestration: 'none' | 'waiting_workers' | 'fissioned';
  };
  parentAgentId?: string | null;
  childAgentIds?: string[];
  spawnMeta?: TaskAgentSpawnMeta;
  card?: {
    version: 'v2';
    soul: string;
    responsibilities: string[];
    boundaries: string[];
    mcpPreferences: string[];
    qualityChecks: string[];
    fallbackStrategy: string;
    exampleTasks: string[];
    outputStandards: string[];
    scoreProfile?: AgentScoreProfile;
    capabilityGraph?: AgentCapabilityGraph;
    runtimeProfile?: AgentRuntimeProfile;
  };
}

interface BenchmarkScoreSnapshot {
  totalScore: number;
  dimensions: Record<BenchmarkDimension, number>;
  source: 'estimated' | 'benchmark';
}

interface BenchmarkMetadata {
  suiteId: string;
  suiteVersion: string;
  runId?: string;
  sampleCount: number;
  passRate: number;
  evaluatedAt: number;
  weakDimensions: BenchmarkDimension[];
  recommendations: string[];
}

interface AgentScoreProfile {
  research?: number;
  writing?: number;
  data?: number;
  planning?: number;
  governance?: number;
  tooling?: number;
  communication?: number;
  presentation?: number;
  estimatedScore?: BenchmarkScoreSnapshot;
  benchmarkScore?: BenchmarkScoreSnapshot;
  benchmarkMetadata?: BenchmarkMetadata;
}

interface AgentBenchmarkState {
  liveStale?: boolean;
  profile?: AgentBenchmarkProfile;
  latestRun?: BenchmarkRun;
  stale?: boolean;
}

interface Skill {
  id: string;
  name: string;
  category: string;
  description: string;
}

interface MCPServer {
  id: string;
  name: string;
  type: 'stdio' | 'sse' | 'http';
  toolName?: string;
  executionApproved?: boolean;
}

type AgentExecutionStage = 'understand' | 'plan' | 'execute' | 'verify' | 'synthesize' | 'handoff';

interface AgentCapabilityGraph {
  domains: string[];
  primarySkills: string[];
  toolAffordances: string[];
  mcpAffordances: string[];
  handoffTargets: string[];
}

interface AgentRuntimeProfile {
  planner: 'reactive' | 'plan_execute' | 'reflect_repair';
  executor: 'tool_first' | 'browser_enabled' | 'document_generator' | 'analysis_first';
  verifier: string[];
  toolPolicy: string[];
  memoryPolicy: string[];
  handoffPolicy: string[];
  fallbackPolicy: string[];
  artifactSchemas: string[];
  stages: AgentExecutionStage[];
}

const defaultTools = ['web_research', 'web_search', 'read_url'];

const defaultRuntimeProfile: AgentRuntimeProfile = {
  planner: 'plan_execute',
  executor: 'tool_first',
  verifier: ['检查事实依据', '检查工具权限', '输出不确定性'],
  toolPolicy: ['只使用白名单工具', '高风险动作先解释再确认'],
  memoryPolicy: ['保留任务摘要与交接上下文'],
  handoffPolicy: ['交接目标、证据、未决问题和下一步'],
  fallbackPolicy: ['工具失败时返回可读降级报告'],
  artifactSchemas: ['结构化办公交付物'],
  stages: ['understand', 'plan', 'execute', 'verify', 'synthesize', 'handoff'],
};

const defaultCapabilityGraph: AgentCapabilityGraph = {
  domains: ['办公协作'],
  primarySkills: [],
  toolAffordances: defaultTools,
  mcpAffordances: [],
  handoffTargets: ['orchestrator'],
};

const stageLabels: Record<AgentExecutionStage, string> = {
  understand: '理解',
  plan: '规划',
  execute: '执行',
  verify: '验证',
  synthesize: '综合',
  handoff: '交接',
};

const plannerLabels: Record<AgentRuntimeProfile['planner'], string> = {
  reactive: '反应式',
  plan_execute: '计划执行',
  reflect_repair: '反思修正',
};

const executorLabels: Record<AgentRuntimeProfile['executor'], string> = {
  tool_first: '工具优先',
  browser_enabled: '浏览增强',
  document_generator: '文档生成',
  analysis_first: '分析优先',
};

const benchmarkDimensionLabels: Record<BenchmarkDimension, string> = {
  research_verification: '调研',
  instruction_following: '指令',
  tool_use: '工具',
  planning_decomposition: '规划',
  office_deliverable: '交付',
  governance_safety: '治理',
  collaboration_handoff: '协作',
};

const benchmarkDimensionOrder: BenchmarkDimension[] = [
  'research_verification',
  'instruction_following',
  'tool_use',
  'planning_decomposition',
  'office_deliverable',
  'governance_safety',
  'collaboration_handoff',
];

interface ScoreDimension {
  dimension: string;
  score: number;
}

function emptyDraft(): Partial<AgentCard> {
  return {
    name: '',
    type: 'resident',
    description: '',
    icon: '◆',
    capabilities: { skills: [], tools: defaultTools, mcpServers: [] },
    constraints: {
      maxFissionDepth: 1,
      maxCostPerTask: 0.4,
      allowedTools: defaultTools,
      approvalMode: 'full_auto',
      allowedDomains: [],
    },
    card: {
      version: 'v2',
      soul: '',
      responsibilities: [],
      boundaries: [],
      mcpPreferences: [],
      qualityChecks: [],
      fallbackStrategy: '信息不足或工具失败时，说明不确定性并返回部分结果。',
      exampleTasks: [],
      outputStandards: ['结构清晰', '事实与判断分开', '给出下一步建议'],
      capabilityGraph: defaultCapabilityGraph,
      runtimeProfile: defaultRuntimeProfile,
    },
  };
}

function runtimeOf(agent: AgentCard): AgentRuntimeProfile {
  const runtime = agent.card?.runtimeProfile;
  return {
    ...defaultRuntimeProfile,
    ...(runtime || {}),
    verifier: runtime?.verifier?.length ? runtime.verifier : defaultRuntimeProfile.verifier,
    toolPolicy: runtime?.toolPolicy?.length ? runtime.toolPolicy : defaultRuntimeProfile.toolPolicy,
    memoryPolicy: runtime?.memoryPolicy?.length ? runtime.memoryPolicy : defaultRuntimeProfile.memoryPolicy,
    handoffPolicy: runtime?.handoffPolicy?.length ? runtime.handoffPolicy : defaultRuntimeProfile.handoffPolicy,
    fallbackPolicy: runtime?.fallbackPolicy?.length ? runtime.fallbackPolicy : defaultRuntimeProfile.fallbackPolicy,
    artifactSchemas: runtime?.artifactSchemas?.length ? runtime.artifactSchemas : defaultRuntimeProfile.artifactSchemas,
    stages: runtime?.stages?.length ? runtime.stages : defaultRuntimeProfile.stages,
  };
}

function capabilityGraphOf(agent: AgentCard): AgentCapabilityGraph {
  const graph = agent.card?.capabilityGraph;
  return {
    ...defaultCapabilityGraph,
    ...(graph || {}),
    domains: graph?.domains?.length ? graph.domains : defaultCapabilityGraph.domains,
    primarySkills: graph?.primarySkills?.length ? graph.primarySkills : agent.capabilities.skills,
    toolAffordances: graph?.toolAffordances?.length ? graph.toolAffordances : agent.constraints.allowedTools,
    mcpAffordances: graph?.mcpAffordances?.length ? graph.mcpAffordances : agent.capabilities.mcpServers,
    handoffTargets: graph?.handoffTargets?.length ? graph.handoffTargets : defaultCapabilityGraph.handoffTargets,
  };
}

export default function AgentsPage() {
  const [agents, setAgents] = useState<AgentCard[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [mcpServers, setMcpServers] = useState<MCPServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Partial<AgentCard>>(emptyDraft());
  const [toolsText, setToolsText] = useState(defaultTools.join(', '));
  const [domainsText, setDomainsText] = useState('');
  const [saving, setSaving] = useState(false);
  const [skillSearch, setSkillSearch] = useState('');
  const [draggingSkillId, setDraggingSkillId] = useState<string | null>(null);
  const [dropAgentId, setDropAgentId] = useState<string | null>(null);
  const [benchmarks, setBenchmarks] = useState<Record<string, AgentBenchmarkState>>({});
  const [benchmarkAgent, setBenchmarkAgent] = useState<AgentCard | null>(null);
  const benchmarkTrigger = useRef<HTMLButtonElement | null>(null);
  const [activeView, setActiveView] = useState<'resident' | 'task' | 'draft'>('resident');
  const [draftCandidates, setDraftCandidates] = useState<AgentCard[]>([]);
  const [promotingAgentId, setPromotingAgentId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState('');
  const [pageError, setPageError] = useState('');
  const [candidateSources, setCandidateSources] = useState<Record<string, string>>({});
  const bindingAgents = useRef(new Set<string>());

  const loadData = useCallback(async (signal?: AbortSignal) => {
    try {
    const [agRes, skRes, mcpRes] = await Promise.all([
      fetch(`${API}/api/agents`, { signal }),
      fetch(`${API}/api/skills`, { signal }),
      fetch(`${API}/api/mcp`, { signal }),
    ]);
    if (!agRes.ok || !skRes.ok || !mcpRes.ok) throw new Error('Agent 列表加载失败，请刷新重试；当前草稿不会清除。');
    const agData = await agRes.json();
    const skData = await skRes.json();
    const mcpData = await mcpRes.json();
    const nextAgents = (agData.agents || []) as AgentCard[];
    signal?.throwIfAborted();
    setAgents(nextAgents);
    setSkills(skData.skills || []);
    setMcpServers(mcpData.servers || []);
    const benchmarkEntries = await Promise.all(nextAgents
      .filter(agent => agent.type === 'resident')
      .map(async agent => {
        try {
          const res = await fetch(`${API}/api/agents/${agent.id}/benchmark`, { signal });
          if (!res.ok) return null;
          const data = await res.json() as AgentBenchmarkState;
          return [agent.id, data] as const;
        } catch {
          return null;
        }
      }));
    signal?.throwIfAborted();
    setBenchmarks(Object.fromEntries(benchmarkEntries.filter(Boolean) as Array<readonly [string, AgentBenchmarkState]>));
    setPageError('');
    } finally { if (!signal?.aborted) setLoading(false); }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    loadData(controller.signal).catch(() => { if (!controller.signal.aborted) setPageError('Agent 列表加载失败，请刷新重试。'); });
    return () => controller.abort();
  }, [loadData]);

  const residentAgents = useMemo(() => agents.filter(agent => agent.type === 'resident'), [agents]);
  const taskAgents = useMemo(() => agents.filter(agent => agent.type === 'task_spawned'), [agents]);
  const filteredSkills = useMemo(() => {
    const query = skillSearch.trim().toLowerCase();
    if (!query) return skills;
    return skills.filter(skill =>
      skill.name.toLowerCase().includes(query) ||
      skill.category.toLowerCase().includes(query) ||
      skill.description.toLowerCase().includes(query) ||
      skill.id.toLowerCase().includes(query)
    );
  }, [skillSearch, skills]);

  const openNew = () => {
    if (saving) return;
    setSaveError('');
    const next = { ...emptyDraft(), id: `agent-${crypto.randomUUID()}` };
    setEditingId(null);
    setDraft(next);
    setToolsText(defaultTools.join(', '));
    setDomainsText('');
    setEditorOpen(true);
  };

  const createFromTemplate = async (template: string) => {
    if (saving) return;
    try {
    const res = await fetch(`${API}/api/agents/from-template`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ template, save: false }),
    });
    const data = await res.json();
    const agent = data.agent as AgentCard | undefined;
    if (!res.ok || !agent) throw new Error(data.error || '模板暂时不可用，请重试。');
    openEdit(agent);
    setEditingId(null);
    } catch (error) { setPageError(error instanceof Error ? error.message : '模板暂时不可用，请重试。'); }
  };

  const openDraftCandidate = (agent: AgentCard) => {
    if (saving) return;
    setSaveError('');
    const base = emptyDraft();
    setEditingId(null);
    setDraft({
      ...base,
      ...agent,
      type: 'resident',
      parentAgentId: null,
      childAgentIds: [],
      spawnMeta: undefined,
      card: {
        ...base.card!,
        ...(agent.card || {}),
      },
    });
    setToolsText((agent.constraints.allowedTools || []).join(', '));
    setDomainsText((agent.constraints.allowedDomains || []).join(', '));
    setEditorOpen(true);
  };

  const openEdit = (agent: AgentCard) => {
    if (saving) return;
    setSaveError('');
    const base = emptyDraft();
    setEditingId(agent.id);
    setDraft({
      ...base,
      ...agent,
      card: {
        ...base.card!,
        ...(agent.card || {}),
      },
    });
    setToolsText((agent.constraints.allowedTools || []).join(', '));
    setDomainsText((agent.constraints.allowedDomains || []).join(', '));
    setEditorOpen(true);
  };

  const promoteTaskAgent = async (agent: AgentCard) => {
    setPromotingAgentId(agent.id);
    try {
      const res = await fetch(`${API}/api/agents/${agent.id}/promote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          save: false,
          name: `${agent.name} 常驻版`,
          outputSummary: agent.spawnMeta?.outputSummary || agent.description,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.agent) throw new Error(data.error || 'promote failed');
      const candidate = data.agent as AgentCard;
      setCandidateSources(prev => ({ ...prev, [candidate.id]: agent.id }));
      setDraftCandidates(prev => [candidate, ...prev.filter(item => item.id !== candidate.id)]);
      setActiveView('draft');
      openDraftCandidate(candidate);
    } catch {
      window.alert('生成常驻 Agent 草稿失败，请确认后端已包含 /api/agents/:id/promote 接口。');
    } finally {
      setPromotingAgentId(null);
    }
  };

  const toggleSkill = (skillId: string) => {
    const current = draft.capabilities?.skills || [];
    const next = current.includes(skillId)
      ? current.filter(id => id !== skillId)
      : [...current, skillId];
    setDraft(prev => ({ ...prev, capabilities: { ...prev.capabilities!, skills: next } }));
  };

  const toggleMcp = (serverId: string) => {
    const current = draft.capabilities?.mcpServers || [];
    const next = current.includes(serverId)
      ? current.filter(id => id !== serverId)
      : [...current, serverId];
    setDraft(prev => ({ ...prev, capabilities: { ...prev.capabilities!, mcpServers: next } }));
  };

  const allowedToolNames = new Set(splitComma(toolsText));
  const toggleTool = (name: string, allowed: boolean) => {
    setToolsText(current => {
      const names = new Set(splitComma(current));
      if (allowed) names.add(name); else names.delete(name);
      return [...names].join(', ');
    });
  };

  const onSkillDragStart = (event: DragEvent<HTMLElement>, skillId: string) => {
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData('text/plain', skillId);
    setDraggingSkillId(skillId);
  };

  const onAgentDragOver = (event: DragEvent<HTMLElement>, agent: AgentCard) => {
    const skillId = draggingSkillId || event.dataTransfer.getData('text/plain');
    if (!skillId || agent.capabilities.skills.includes(skillId)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDropAgentId(agent.id);
  };

  const onAgentDrop = async (event: DragEvent<HTMLElement>, agent: AgentCard) => {
    event.preventDefault();
    const skillId = event.dataTransfer.getData('text/plain') || draggingSkillId;
    setDropAgentId(null);
    setDraggingSkillId(null);
    if (!skillId || agent.capabilities.skills.includes(skillId)) return;
    await bindSkillToAgent(agent, skillId);
  };

  const bindSkillToAgent = async (agent: AgentCard, skillId: string) => {
    if (bindingAgents.current.has(agent.id)) { setPageError('此 Agent 正在保存绑定，请完成后再添加。'); return; }
    bindingAgents.current.add(agent.id);
    setPageError('');
    try {
      const res = await fetch(`${API}/api/agents/${agent.id}/override`, {
        method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ skills: [...agent.capabilities.skills, skillId], configurationRevision: agent.configurationRevision }),
        signal: AbortSignal.timeout(30000),
      });
      const nextAgent = await res.json();
      if (!res.ok) throw new Error(nextAgent.error || '绑定保存失败，请重试。');
      if (nextAgent.id !== agent.id) throw new Error('无法确认绑定结果，请刷新列表核对。');
      setAgents(prev => prev.map(item => item.id === agent.id ? nextAgent : item));
      setBenchmarks(prev => { const next = { ...prev }; delete next[agent.id]; return next; });
    } catch (error) {
      setPageError(error instanceof Error && error.name === 'Error' ? error.message : '未收到绑定确认，请刷新核对是否已保存；不会自动重试。');
    } finally { bindingAgents.current.delete(agent.id); }
  };

  const runBenchmark = async (agent: AgentCard) => {
    setBenchmarkAgent(agent);
  };

  const saveAgent = async () => {
    if (saving || loading) return;
    if (!draft.name?.trim() || !draft.description?.trim()) return;
    const allowedTools = [...allowedToolNames];
    const allowedDomains = domainsText.split(',').map(item => item.trim()).filter(Boolean);
    const payload: Partial<AgentCard> = {
      ...draft,
      type: draft.type || 'resident',
      capabilities: {
        skills: draft.capabilities?.skills || [],
        tools: allowedTools,
        mcpServers: draft.capabilities?.mcpServers || [],
      },
      constraints: {
        maxFissionDepth: draft.constraints?.maxFissionDepth ?? 1,
        maxCostPerTask: Number(draft.constraints?.maxCostPerTask ?? 0.4),
        allowedTools,
        approvalMode: draft.constraints?.approvalMode || 'full_auto',
        allowedDomains,
      },
    };

    setSaving(true);
    setSaveError('');
    const endpoint = editingId ? `/api/agents/${editingId}` : '/api/agents';
    const method = editingId ? 'PUT' : 'POST';
    try {
    const res = await fetch(`${API}${endpoint}`, {
      method,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ ...payload, ...(!editingId && draft.id && candidateSources[draft.id] ? { sourceTaskAgentId: candidateSources[draft.id] } : {}) }),
      signal: AbortSignal.timeout(30000),
    });
    const saved = await res.json();
    if (!res.ok) throw new Error(saved.error || 'Agent 保存失败，请重试。');
    if (!saved.id || !saved.configurationRevision) throw new Error('未收到有效保存确认，请刷新核对；当前草稿仍保留。');
    const sourceId = draft.id ? candidateSources[draft.id] : undefined;
    setAgents(prev => [...prev.filter(item => item.id !== saved.id).map(item => item.id === sourceId && item.spawnMeta
      ? { ...item, spawnMeta: { ...item.spawnMeta, promotedAgentId: saved.id } } : item), saved]);
    setBenchmarks(prev => { const next = { ...prev }; delete next[saved.id]; return next; });
    setEditorOpen(false);
    if (!editingId && draft.id) {
      setDraftCandidates(prev => prev.filter(item => item.id !== draft.id));
    }
    } catch (error) {
      setSaveError(error instanceof Error && error.name === 'Error' ? error.message : '未收到保存确认，请刷新列表核对是否已保存；当前草稿仍保留，不会自动重试。');
    } finally { setSaving(false); }
  };

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <AccessControl />
        <div>
          <h1 className={styles.title}>Agents 大厅</h1>
          <p className={styles.subtitle}>创建、编辑常驻 Agent，并绑定 Skill、MCP Server 与工具白名单。</p>
        </div>
        <button className={styles.primaryButton} onClick={openNew} disabled={saving}>
          <Plus size={18} />
          新建 Agent
        </button>
      </header>
      {pageError && <p role="alert" className={styles.errorMessage}>{pageError}</p>}
      {(pageError || saveError) && <button className={styles.secondaryButton} disabled={saving || loading}
        onClick={() => { setLoading(true); void loadData().catch(() => setPageError('列表刷新失败；当前草稿仍保留。')); }}>
        <RefreshCw size={15} /> 刷新列表
      </button>}

      <div className={styles.templateBar}>
        {['research', 'document', 'data', 'project', 'communication', 'presentation'].map(template => (
          <button key={template} className={styles.secondaryButton} onClick={() => createFromTemplate(template)}>
            从 {template} 模板创建
          </button>
        ))}
      </div>

      {editorOpen && (
        <section className={styles.editorPanel}>
          <div className={styles.editorHeader}>
            <div>
              <h2>{editingId ? '编辑 Agent Card' : '新建 Agent Card'}</h2>
              <p>Agent Card 会定义角色、能力、工具边界和治理约束。</p>
            </div>
            <button className={styles.iconButton} onClick={() => setEditorOpen(false)} aria-label="关闭编辑器" disabled={saving}>
              <X size={18} />
            </button>
          </div>

          <fieldset disabled={saving} className={styles.editorFields}>
          <div className={styles.formGrid}>
            <label>
              名称
              <input value={draft.name || ''} onChange={e => setDraft({ ...draft, name: e.target.value })} />
            </label>
            <label>
              图标
              <input value={draft.icon || ''} onChange={e => setDraft({ ...draft, icon: e.target.value })} />
            </label>
            <label>
              成本上限
              <input
                type="number"
                step="0.05"
                value={draft.constraints?.maxCostPerTask ?? 0.4}
                onChange={e => setDraft({
                  ...draft,
                  constraints: { ...draft.constraints!, maxCostPerTask: Number(e.target.value) },
                })}
              />
            </label>
            <label className={styles.fullWidth}>
              描述 / Soul 摘要
              <textarea value={draft.description || ''} onChange={e => setDraft({ ...draft, description: e.target.value })} rows={4} />
            </label>
            <label className={styles.fullWidth}>
              Soul / 角色设定
              <textarea
                value={draft.card?.soul || ''}
                onChange={e => setDraft({ ...draft, card: { ...draft.card!, soul: e.target.value } })}
                rows={5}
                placeholder="写清楚这个 Agent 的身份、工作原则、何时该拒绝或降级。"
              />
            </label>
            <label className={styles.fullWidth}>
              职责边界
              <textarea
                value={(draft.card?.responsibilities || []).join('\n')}
                onChange={e => setDraft({ ...draft, card: { ...draft.card!, responsibilities: splitLines(e.target.value) } })}
                rows={4}
                placeholder="每行一个职责，例如：验证来源日期、生成结构化报告"
              />
            </label>
            <label className={styles.fullWidth}>
              禁止事项 / 边界
              <textarea
                value={(draft.card?.boundaries || []).join('\n')}
                onChange={e => setDraft({ ...draft, card: { ...draft.card!, boundaries: splitLines(e.target.value) } })}
                rows={4}
                placeholder="每行一个边界，例如：不编造来源、不执行外部写操作"
              />
            </label>
            <label className={styles.fullWidth}>
              工具白名单
              <input value={toolsText} onChange={e => setToolsText(e.target.value)} />
            </label>
            <label className={styles.fullWidth}>
              域名白名单
              <input value={domainsText} onChange={e => setDomainsText(e.target.value)} placeholder="留空表示不限制，多个域名用英文逗号分隔" />
            </label>
            <label>
              裂变深度
              <input
                type="number"
                min="0"
                max="3"
                value={draft.constraints?.maxFissionDepth ?? 1}
                onChange={e => setDraft({
                  ...draft,
                  constraints: { ...draft.constraints!, maxFissionDepth: Number(e.target.value) },
                })}
              />
            </label>
            <label>
              审批模式
              <select
                value={draft.constraints?.approvalMode || 'full_auto'}
                onChange={e => setDraft({
                  ...draft,
                  constraints: { ...draft.constraints!, approvalMode: e.target.value as AgentCard['constraints']['approvalMode'] },
                })}
              >
                <option value="suggest">suggest</option>
                <option value="auto_edit">受信本地只读自动，其余需确认</option>
                <option value="full_auto">full_auto</option>
              </select>
            </label>
            <label>
              MCP 偏好
              <input
                value={(draft.card?.mcpPreferences || []).join(', ')}
                onChange={e => setDraft({ ...draft, card: { ...draft.card!, mcpPreferences: splitComma(e.target.value) } })}
              />
            </label>
            <label className={styles.fullWidth}>
              质量检查规则
              <textarea
                value={(draft.card?.qualityChecks || []).join('\n')}
                onChange={e => setDraft({ ...draft, card: { ...draft.card!, qualityChecks: splitLines(e.target.value) } })}
                rows={4}
              />
            </label>
            <label className={styles.fullWidth}>
              输出质量标准
              <textarea
                value={(draft.card?.outputStandards || []).join('\n')}
                onChange={e => setDraft({ ...draft, card: { ...draft.card!, outputStandards: splitLines(e.target.value) } })}
                rows={4}
              />
            </label>
            <label className={styles.fullWidth}>
              失败降级策略
              <textarea
                value={draft.card?.fallbackStrategy || ''}
                onChange={e => setDraft({ ...draft, card: { ...draft.card!, fallbackStrategy: e.target.value } })}
                rows={3}
              />
            </label>
            <label className={styles.fullWidth}>
              示例任务
              <textarea
                value={(draft.card?.exampleTasks || []).join('\n')}
                onChange={e => setDraft({ ...draft, card: { ...draft.card!, exampleTasks: splitLines(e.target.value) } })}
                rows={4}
              />
            </label>
          </div>

          <div className={styles.bindingGrid}>
            <div className={styles.bindingColumn}>
              <h3><Star size={15} /> 绑定 Skills</h3>
              <label className={styles.resourcePermission}>
                <input type="checkbox" checked={allowedToolNames.has('read_skill_file')}
                  onChange={event => toggleTool('read_skill_file', event.target.checked)} />
                <span>允许读取 Skill 附属文件<small>仅限已绑定包内文本 · 不执行脚本</small></span>
              </label>
              <div className={styles.checkGrid}>
                {skills.map(skill => (
                  <label key={skill.id} className={styles.checkItem}>
                    <input
                      type="checkbox"
                      checked={(draft.capabilities?.skills || []).includes(skill.id)}
                      onChange={() => toggleSkill(skill.id)}
                    />
                    <span>{skill.name}</span>
                    <small>{skill.category}</small>
                  </label>
                ))}
                {skills.length === 0 && <p className={styles.emptyTag}>先去 Skills 技能库创建 Skill。</p>}
              </div>
            </div>

            <div className={styles.bindingColumn}>
              <h3><Wrench size={15} /> MCP 绑定与权限</h3>
              <div className={styles.checkGrid}>
                {mcpServers.map(server => {
                  const bound = (draft.capabilities?.mcpServers || []).includes(server.id);
                  const allowed = !!server.toolName && allowedToolNames.has(server.toolName);
                  const conflict = !!server.toolName && mcpServers.some(other => other.id !== server.id
                    && other.toolName === server.toolName && (draft.capabilities?.mcpServers || []).includes(other.id));
                  return (
                    <div key={server.id} className={styles.mcpBinding}>
                      <div className={styles.mcpBindingTitle}><strong>{server.name}</strong><small>{server.type}</small></div>
                      <div className={styles.permissionOptions}>
                        <label><input type="checkbox" aria-label={`绑定 ${server.name}`} checked={bound}
                          onChange={() => toggleMcp(server.id)} />绑定</label>
                        <label><input type="checkbox" aria-label={`允许调用 ${server.name}`} checked={allowed}
                          disabled={!server.toolName || ((!bound || conflict) && !allowed)}
                          onChange={event => { if (server.toolName) toggleTool(server.toolName, event.target.checked); }} />允许调用</label>
                      </div>
                      <small className={styles.permissionStatus}>
                        {bound && conflict ? '工具标识冲突：需在 MCP 管理中修改服务名称'
                          : !server.toolName ? '工具标识未加载，请刷新或更新后端'
                          : !bound ? '未绑定'
                          : !allowed ? '已绑定 · 尚未授予调用权限'
                          : '已绑定 · 调用权限已勾选'}
                      </small>
                      {bound && server.type === 'stdio' && !server.executionApproved && (
                        <a className={styles.permissionStatus} href="/management/mcp" target="_blank" rel="noreferrer">服务尚未授权执行 · MCP 管理</a>
                      )}
                    </div>
                  );
                })}
                {mcpServers.length === 0 && <p className={styles.emptyTag}>先去 MCP 工具集添加 Server。</p>}
              </div>
            </div>
          </div>

          </fieldset>
          {saveError && <p role="alert" className={styles.errorMessage}>{saveError}</p>}
          <div className={styles.buttonRow}>
            <button className={styles.secondaryButton} onClick={() => setEditorOpen(false)} disabled={saving}>取消</button>
            <button className={styles.primaryButton} onClick={saveAgent} disabled={saving || loading}>
              <Save size={16} />
              保存 Agent
            </button>
          </div>
        </section>
      )}

      {loading ? (
        <div className={styles.loading}>加载中...</div>
      ) : (
        <div className={styles.splitView}>
          <main className={styles.agentsArea}>
            <div className={styles.viewTabs} role="tablist" aria-label="Agent 分类">
              <button
                className={activeView === 'resident' ? styles.activeTab : styles.viewTab}
                onClick={() => setActiveView('resident')}
                type="button"
              >
                <Bot size={15} />
                常驻 Agent
                <span>{residentAgents.length}</span>
              </button>
              <button
                className={activeView === 'task' ? styles.activeTab : styles.viewTab}
                onClick={() => setActiveView('task')}
                type="button"
              >
                <GitBranch size={15} />
                任务子 Agent
                <span>{taskAgents.length}</span>
              </button>
              <button
                className={activeView === 'draft' ? styles.activeTab : styles.viewTab}
                onClick={() => setActiveView('draft')}
                type="button"
              >
                <Pencil size={15} />
                草稿/候选
                <span>{draftCandidates.length}</span>
              </button>
            </div>

            {activeView === 'resident' && (
              <div className={styles.agentGrid}>
              {residentAgents.map(agent => {
                const benchmarkState = benchmarks[agent.id];
                const benchmarkProfile = benchmarkState?.profile;
                const latestRun = benchmarkState?.latestRun;
                const scores = scoreAgent(benchmarkProfile);
                const totalScore = benchmarkProfile?.totalScore ?? '待检查';
                const measured = benchmarkProfile?.mode === 'controlled_office' && benchmarkProfile.source === 'benchmark';
                const sourceLabel = measured ? 'Benchmark 实测 · 固定材料题' : !benchmarkProfile ? '评分暂不可用' : benchmarkState?.stale || benchmarkState?.liveStale ? '配置已变更 · 静态估算' : latestRun ? '配置检查 · 未实跑题库' : '静态估算 · 未实测';
                const failedResults = latestRun?.results?.filter(result => !result.passed).slice(0, 2) || [];
                const runtime = runtimeOf(agent);
                const graph = capabilityGraphOf(agent);
                return (
                  <article
                    key={agent.id}
                    className={`${styles.agentCard} ${dropAgentId === agent.id ? styles.agentCardOver : ''}`}
                    onDragOver={event => onAgentDragOver(event, agent)}
                    onDragLeave={() => setDropAgentId(current => current === agent.id ? null : current)}
                    onDrop={event => onAgentDrop(event, agent)}
                  >
                    <div className={styles.cardHeader}>
                      <div className={styles.agentAvatar}>{agent.icon || <Bot size={24} />}</div>
                      <div className={styles.agentInfo}>
                        <h3 className={styles.agentName}>{agent.name}</h3>
                        <span className={styles.agentType}>常驻 Agent</span>
                      </div>
                      <div className={styles.statusDot} title={agent.state.business} />
                    </div>

                    <p className={styles.description}>{agent.description}</p>

                    <div className={styles.runtimePanel}>
                      <div className={styles.runtimeHeader}>
                        <span><Bot size={14} /> Agent Runtime v2</span>
                        <small>{plannerLabels[runtime.planner]} · {executorLabels[runtime.executor]}</small>
                      </div>
                      <div className={styles.runtimeStageRail}>
                        {runtime.stages.map((stage, index) => (
                          <span key={`${stage}-${index}`}>
                            <b>{index + 1}</b>
                            {stageLabels[stage] || stage}
                          </span>
                        ))}
                      </div>
                      <div className={styles.runtimeColumns}>
                        <div>
                          <h4><Activity size={13} /> 能力图</h4>
                          <div className={styles.runtimeTags}>
                            {graph.domains.slice(0, 4).map(domain => <span key={domain}>{domain}</span>)}
                            {graph.toolAffordances.slice(0, 3).map(tool => <span key={tool}>{tool}</span>)}
                          </div>
                        </div>
                        <div>
                          <h4><Shield size={13} /> 验证器</h4>
                          <ul className={styles.runtimeList}>
                            {runtime.verifier.slice(0, 3).map(check => <li key={check}>{check}</li>)}
                          </ul>
                        </div>
                      </div>
                    </div>

                    <div className={styles.benchmarkSummary}>
                      <div className={styles.benchmarkScoreBlock}>
                        <span className={styles.benchmarkEyebrow}><Activity size={14} /> Agent Benchmark</span>
                        <strong>{totalScore}</strong>
                        <small>{measured ? '受控题库评分' : '配置评分'}</small>
                      </div>
                      <div className={styles.benchmarkFacts}>
                        <span className={styles.benchmarkEstimated}>
                          {sourceLabel}
                        </span>
                        {benchmarkProfile && <span>{benchmarkProfile.sampleCount} {measured ? '道固定材料题' : '项配置检查'}</span>}
                        {benchmarkProfile && <span>{measured ? '材料题' : '配置'}通过率 {Math.round(benchmarkProfile.passRate * 100)}%</span>}
                        {benchmarkProfile?.lastRunAt && <span>{new Date(benchmarkProfile.lastRunAt).toLocaleString()}</span>}
                      </div>
                    </div>

                    <div className={styles.radarContainer}>
                      <ResponsiveContainer width="100%" height="100%">
                        <RadarChart data={scores} outerRadius="72%">
                          <PolarGrid stroke="rgba(124, 107, 196, 0.22)" />
                          <PolarRadiusAxis domain={[0, 100]} tick={false} axisLine={false} />
                          <PolarAngleAxis dataKey="dimension" tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }} />
                          <Radar
                            name={agent.name}
                            dataKey="score"
                            stroke="var(--color-accent-primary)"
                            fill="var(--color-accent-primary)"
                            fillOpacity={0.22}
                          />
                        </RadarChart>
                      </ResponsiveContainer>
                    </div>

                    <div className={styles.scoreStrip}>
                      {scores.map(item => (
                        <span key={item.dimension}>
                          <b>{item.score}</b>
                          {item.dimension}
                        </span>
                      ))}
                    </div>

                    <div className={styles.benchmarkPanel}>
                      <div>
                        <h4><FlaskConical size={14} /> 评测短板</h4>
                        <div className={styles.benchmarkTags}>
                          {benchmarkProfile?.weakDimensions?.length
                            ? benchmarkProfile.weakDimensions.map(dimension => (
                              <span key={dimension}>{benchmarkDimensionLabels[dimension]}</span>
                            ))
                            : <span>暂无明显短板</span>}
                        </div>
                      </div>
                      <div>
                        <h4>推荐优化</h4>
                        <ul className={styles.benchmarkList}>
                          {(benchmarkProfile?.recommendations || ['补充 Agent Card 的质量检查、边界和示例任务，评测会更可信。']).slice(0, 3).map(item => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                      </div>
                      {!measured && failedResults.length > 0 && (
                        <div>
                          <h4>未通过的配置项</h4>
                          <ul className={styles.benchmarkList}>
                            {failedResults.map(result => (
                              <li key={result.taskId}>{result.title} · {result.score}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>

                    <div className={styles.capabilitiesList}>
                      <div className={styles.capSection}>
                        <h4 className={styles.capTitle}><Star size={14} /> Skills</h4>
                        <div className={styles.tags}>
                          {agent.capabilities.skills.length
                            ? agent.capabilities.skills.map(skill => <span key={skill} className={styles.tag}>{skillName(skills, skill)}</span>)
                            : <span className={styles.emptyTag}>拖拽右侧 Skill 到这里绑定</span>}
                        </div>
                      </div>
                      <div className={styles.capSection}>
                        <h4 className={styles.capTitle}><Wrench size={14} /> Tools / MCP</h4>
                        <div className={styles.tags}>
                          {agent.constraints.allowedTools.map(tool => <span key={tool} className={styles.toolTag}>{tool}</span>)}
                          {agent.capabilities.mcpServers.map(server => <span key={server} className={styles.mcpTag}>{server}</span>)}
                        </div>
                      </div>
                    </div>

                    <div className={styles.governanceConstraints}>
                      <Shield size={14} className={styles.shieldIcon} />
                      <span>成本上限: ${agent.constraints.maxCostPerTask}</span>
                    </div>

                    <div className={styles.cardActions}>
                      <button
                        className={styles.secondaryButton}
                        onClick={event => { benchmarkTrigger.current = event.currentTarget; void runBenchmark(agent); }}
                      >
                        <FlaskConical size={15} />
                        评分与证据
                      </button>
                      <button className={styles.secondaryButton} onClick={() => openEdit(agent)}>
                        <Pencil size={15} />
                        编辑
                      </button>
                    </div>
                  </article>
                );
              })}
              </div>
            )}

            {activeView === 'task' && (
              <div className={styles.agentGrid}>
                {taskAgents.map(agent => (
                  <article key={agent.id} className={styles.taskAgentCard}>
                    <div className={styles.taskCardHeader}>
                      <div className={styles.agentAvatar}>{agent.icon || <GitBranch size={22} />}</div>
                      <div className={styles.agentInfo}>
                        <h3 className={styles.agentName}>{agent.name}</h3>
                        <span className={styles.agentType}>任务子 Agent</span>
                      </div>
                      <span className={styles.taskStatus} data-status={agent.spawnMeta?.status}>{taskStatusLabel(agent)}</span>
                    </div>
                    <p className={styles.description}>{agent.description}</p>
                    <div className={styles.spawnMetaGrid}>
                      <span>
                        <b>父 Agent</b>
                        {agent.spawnMeta?.parentName || parentAgentName(agents, agent.parentAgentId)}
                      </span>
                      <span>
                        <b>来源任务</b>
                        {agent.spawnMeta?.taskId || agent.spawnMeta?.runId || '未绑定运行'}
                      </span>
                      <span>
                        <b>创建原因</b>
                        {agent.spawnMeta?.createdReason || '由主 Agent 拆解任务生成'}
                      </span>
                      <span>
                        <b>预算</b>
                        ${agent.constraints.maxCostPerTask}
                      </span>
                      <span><b>来源会话</b>{agent.spawnMeta?.sessionId || '未关联会话'}</span>
                      <span><b>层级</b>{agent.spawnMeta?.depth || 1} / 2</span>
                    </div>
                    <div className={styles.taskObjective}>
                      <h4>任务目标</h4>
                      <p>{agent.spawnMeta?.objective || agent.description}</p>
                    </div>
                    <div className={styles.capabilitiesList}>
                      <div className={styles.capSection}>
                        <h4 className={styles.capTitle}><Star size={14} /> 继承 Skills</h4>
                        <div className={styles.tags}>
                          {agent.capabilities.skills.length
                            ? agent.capabilities.skills.slice(0, 8).map(skill => <span key={skill} className={styles.tag}>{skillName(skills, skill)}</span>)
                            : <span className={styles.emptyTag}>未绑定 Skill</span>}
                        </div>
                      </div>
                      <div className={styles.capSection}>
                        <h4 className={styles.capTitle}><Wrench size={14} /> 工具白名单</h4>
                        <div className={styles.tags}>
                          {agent.constraints.allowedTools.map(tool => <span key={tool} className={styles.toolTag}>{tool}</span>)}
                        </div>
                      </div>
                    </div>
                    <details className={styles.taskDetails}>
                      <summary>执行记录与输出</summary>
                      <dl>
                        <dt>来源运行</dt><dd>{agent.spawnMeta?.runId || '未关联运行'}</dd>
                        <dt>创建时间</dt><dd>{agent.spawnMeta ? new Date(agent.spawnMeta.createdAt).toLocaleString('zh-CN') : '未记录'}</dd>
                        <dt>MCP</dt><dd>{agent.capabilities.mcpServers.join('、') || '未绑定'}</dd>
                        <dt>质量检查规则</dt><dd>{agent.card?.qualityChecks.join('；') || '未配置'}</dd>
                      </dl>
                      {agent.spawnMeta?.inputSummary && <><h4>输入摘要</h4><p>{agent.spawnMeta.inputSummary}</p></>}
                      {agent.spawnMeta?.result ? <>
                        <p>记录费用 ${agent.spawnMeta.result.cost.toFixed(6)} · {agent.spawnMeta.result.iterations} 轮 · {agent.spawnMeta.result.tokens.input + agent.spawnMeta.result.tokens.output} tokens</p>
                        <h4>执行输出</h4>
                        <p>子任务输出尚未独立核对；整体交付状态以会话最终报告为准。</p>
                        <pre>{agent.spawnMeta.result.output}</pre>
                      </> : <p>{agent.spawnMeta?.status === 'interrupted' ? '服务中断，未保存完整执行输出。未自动重跑。' : '尚无已保存的执行输出。'}</p>}
                    </details>
                    <div className={styles.cardActions}>
                      <button
                        className={styles.primaryButton}
                        onClick={() => promoteTaskAgent(agent)}
                        disabled={promotingAgentId === agent.id || Boolean(agent.spawnMeta?.promotedAgentId)}
                      >
                        <Save size={15} />
                        {agent.spawnMeta?.promotedAgentId ? '已沉淀' : promotingAgentId === agent.id ? '生成草稿中' : '保存到大厅'}
                      </button>
                    </div>
                  </article>
                ))}
                {taskAgents.length === 0 && (
                  <div className={styles.emptyState}>
                    <GitBranch size={22} />
                    当前还没有任务子 Agent。复杂任务运行后，主 Agent 创建的子 Agent 会出现在这里。
                  </div>
                )}
              </div>
            )}

            {activeView === 'draft' && (
              <div className={styles.agentGrid}>
                {draftCandidates.map(agent => (
                  <article key={agent.id} className={styles.draftCard}>
                    <div className={styles.taskCardHeader}>
                      <div className={styles.agentAvatar}>{agent.icon || <Bot size={22} />}</div>
                      <div className={styles.agentInfo}>
                        <h3 className={styles.agentName}>{agent.name}</h3>
                        <span className={styles.agentType}>待确认草稿</span>
                      </div>
                    </div>
                    <p className={styles.description}>{agent.description}</p>
                    <div className={styles.taskObjective}>
                      <h4>沉淀说明</h4>
                      <p>这是从任务子 Agent 复制出的常驻 Agent 草稿。保存前不会写入常驻池。</p>
                    </div>
                    <div className={styles.cardActions}>
                      <button className={styles.secondaryButton} onClick={() => setDraftCandidates(prev => prev.filter(item => item.id !== agent.id))}>
                        移除
                      </button>
                      <button className={styles.primaryButton} onClick={() => openDraftCandidate(agent)}>
                        <Pencil size={15} />
                        继续编辑并保存
                      </button>
                    </div>
                  </article>
                ))}
                {draftCandidates.length === 0 && (
                  <div className={styles.emptyState}>
                    <Pencil size={22} />
                    暂无沉淀草稿。你可以从任务子 Agent 点击“保存到大厅”生成候选。
                  </div>
                )}
              </div>
            )}
          </main>

          <aside className={styles.skillsSidebar} aria-label="Skills 快速绑定库">
            <div className={styles.sidebarHeaderBlock}>
              <h2 className={styles.sidebarTitle}>Skills 库</h2>
              <span>{filteredSkills.length}/{skills.length}</span>
            </div>
            <label className={styles.skillSearch}>
              <Search size={15} />
              <input
                value={skillSearch}
                onChange={event => setSkillSearch(event.target.value)}
                placeholder="搜索 Skill..."
              />
            </label>
            <div className={styles.skillList}>
              {filteredSkills.map(skill => (
                <article
                  key={skill.id}
                  className={`${styles.draggableSkill} ${draggingSkillId === skill.id ? styles.dragging : ''}`}
                  draggable
                  onDragStart={event => onSkillDragStart(event, skill.id)}
                  onDragEnd={() => {
                    setDraggingSkillId(null);
                    setDropAgentId(null);
                  }}
                  title={skill.description}
                >
                  <GripVertical size={14} className={styles.dragHandle} />
                  <span>{skill.name}</span>
                  <small className={styles.skillCategory}>{skill.category}</small>
                </article>
              ))}
              {filteredSkills.length === 0 && <p className={styles.emptyTag}>没有匹配的 Skill</p>}
            </div>
          </aside>
        </div>
      )}
      {benchmarkAgent && <BenchmarkDialog key={benchmarkAgent.id} agent={benchmarkAgent}
        restoreFocus={() => { if (benchmarkTrigger.current?.isConnected) benchmarkTrigger.current.focus(); }}
        onClose={() => setBenchmarkAgent(null)} onSaved={state => setBenchmarks(previous => ({ ...previous, [benchmarkAgent.id]: state }))} />}
    </div>
  );
}

function scoreAgent(benchmark?: AgentBenchmarkProfile): ScoreDimension[] {
  return benchmarkDimensionOrder.map(dimension => ({
    dimension: benchmarkDimensionLabels[dimension],
    score: Math.max(0, Math.min(100, benchmark?.dimensionScores[dimension] ?? 0)),
  }));
}

function skillName(skills: Skill[], skillId: string) {
  return skills.find(skill => skill.id === skillId)?.name || skillId;
}

function parentAgentName(agents: AgentCard[], parentAgentId?: string | null) {
  if (!parentAgentId) return '未记录';
  return agents.find(agent => agent.id === parentAgentId)?.name || parentAgentId;
}

function taskStatusLabel(agent: AgentCard) {
  const status = agent.spawnMeta?.status;
  if (status === 'running' && agent.state.business !== 'busy') return '执行状态待核对';
  return status ? { queued: '尚未执行', running: '执行中', completed: '执行完成', failed: '执行失败', interrupted: '已中断' }[status] : '状态未记录';
}

function splitLines(value: string) {
  return value.split('\n').map(item => item.trim()).filter(Boolean);
}

function splitComma(value: string) {
  return value.split(',').map(item => item.trim()).filter(Boolean);
}
