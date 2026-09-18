'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Bot, CheckCircle2, Clock, Download, FlaskConical, Pencil, Plus, Search, ShieldAlert, Tag, Trash2, X } from 'lucide-react';
import styles from './skills.module.css';

import { API_BASE as API, apiFetch as fetch } from '../../../lib/api-client';
import { AccessControl } from '../../../components/AccessGate';
import { providerStateLabel, providerStatusDetail } from '../../../lib/discovery-status';

import type { Skill, SkillPackage, SkillPackageDocument as SkillDocument, SkillDocumentType, SkillRiskLevel as RiskLevel, DiscoveryProviderStatus as ProviderStatus } from '@tagent/core';

interface RiskPreview {
  level: RiskLevel;
  flags: string[];
  commands: string[];
  envVars: string[];
}

interface SearchCandidate {
  source: string;
  providerId?: string;
  name: string;
  description?: string;
  url?: string;
  id?: string;
  category?: string;
  riskLevel?: RiskLevel;
  stars?: number;
  updatedAt?: string;
}

type Draft = Omit<Skill, 'id' | 'createdAt' | 'updatedAt'>;

interface ImportChoice { name: string; path: string; url: string }

const documentTypeOptions: Array<{ value: SkillDocumentType; label: string }> = [
  { value: 'sop', label: '核心 SOP' },
  { value: 'prompt', label: '提示词 Prompt' },
  { value: 'reference', label: '参考资料' },
  { value: 'checklist', label: '检查清单' },
  { value: 'policy', label: '约束策略' },
  { value: 'notes', label: '补充说明' },
];

const commonTools: Array<{ name: string; label: string; type: SkillPackage['tools'][number]['type']; notes: string }> = [
  { name: 'web_research', label: '联网调研', type: 'builtin', notes: '搜索并阅读网页资料' },
  { name: 'read_url', label: '读取网页', type: 'builtin', notes: '打开指定 URL 并提取内容' },
  { name: 'browser_navigate', label: '浏览器操作', type: 'browser', notes: '需要可视化浏览器步骤时使用' },
];

function emptyPackage(name = '', category = 'general'): SkillPackage {
  return {
    manifest: {
      name,
      category,
      version: '1.0.0',
      triggers: [],
      applicableAgents: [],
      riskLevel: 'low',
      tags: [],
    },
    instructions: '',
    documents: [{
      id: 'doc-core-sop',
      type: 'sop',
      title: '核心 SOP',
      content: '',
      order: 1,
      required: true,
      format: 'markdown',
    }],
    inputs: [{ name: 'task', description: '用户任务描述', required: true }],
    outputs: [{ name: 'result', description: '结构化产出', required: true }],
    tools: [],
    examples: [],
    tests: [{ name: 'basic-output', input: '执行一个简单任务', expectedIncludes: [] }],
    riskNotes: [],
  };
}

function emptyDraft(): Draft {
  return {
    name: '',
    description: '',
    category: 'general',
    trigger: '',
    body: '',
    package: emptyPackage(),
  };
}

function normalizeDraft(skill: Partial<Skill>): Draft {
  const base = {
    ...emptyDraft(),
    name: skill.name || '',
    description: skill.description || '',
    category: skill.category || 'general',
    trigger: skill.trigger || '',
    body: skill.body || skill.package?.instructions || '',
  };
  const instructions = skill.package?.instructions || base.body;
  const documents = normalizeDocuments(
    skill.package?.documents?.length ? skill.package.documents : documentsFromMarkdown(instructions),
    instructions,
  );

  return {
    ...base,
    package: {
      ...emptyPackage(base.name, base.category),
      ...(skill.package || {}),
      manifest: {
        ...emptyPackage(base.name, base.category).manifest,
        ...(skill.package?.manifest || {}),
        name: skill.name || skill.package?.manifest.name || '',
        category: skill.category || skill.package?.manifest.category || 'general',
        triggers: skill.package?.manifest.triggers?.length
          ? skill.package.manifest.triggers
          : base.trigger ? [base.trigger] : [],
      },
      instructions: pickPrimaryInstructions(documents, instructions),
      documents,
    },
  };
}

async function fetchSkills(signal?: AbortSignal): Promise<Skill[]> {
  const res = await fetch(`${API}/api/skills`, { signal });
  const data = await res.json();
  if (!res.ok || !Array.isArray(data.skills)) throw new Error(data.error || '无法读取 Skill 库');
  return data.skills;
}

export default function SkillsPage() {
  const [importChoices, setImportChoices] = useState<ImportChoice[]>([]);
  const [importError, setImportError] = useState('');
  const [skills, setSkills] = useState<Skill[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [importUrl, setImportUrl] = useState('');
  const [importRisk, setImportRisk] = useState<RiskPreview | null>(null);
  const [importPreview, setImportPreview] = useState('');
  const [discoverQuery, setDiscoverQuery] = useState('');
  const [discoverResults, setDiscoverResults] = useState<SearchCandidate[]>([]);
  const [discoverErrors, setDiscoverErrors] = useState<string[]>([]);
  const [discoverNotice, setDiscoverNotice] = useState('');
  const [discoverProviders, setDiscoverProviders] = useState<ProviderStatus[]>([]);
  const [suggestPrompt, setSuggestPrompt] = useState('');
  const [testResult, setTestResult] = useState('');
  const [busy, setBusy] = useState('');
  const editorRef = useRef<HTMLElement | null>(null);

  const loadSkills = useCallback(async () => {
    setSkills(await fetchSkills());
    setLoading(false);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetchSkills(controller.signal).then(skills => {
      if (!controller.signal.aborted) { setSkills(skills); setLoading(false); }
    }).catch(error => {
      if (!controller.signal.aborted) { setLoading(false); setDiscoverNotice(`读取 Skill 库失败：${error instanceof Error ? error.message : String(error)}`); }
    });
    return () => controller.abort();
  }, []);

  const filteredSkills = useMemo(() => {
    const query = search.toLowerCase();
    return skills.filter(skill =>
      skill.name.toLowerCase().includes(query) ||
      skill.description.toLowerCase().includes(query) ||
      skill.category.toLowerCase().includes(query) ||
      skill.package?.manifest.tags.join(' ').toLowerCase().includes(query),
    );
  }, [search, skills]);

  const packageDraft = draft.package || emptyPackage(draft.name, draft.category);
  const packageDocuments = useMemo(
    () => normalizeDocuments(packageDraft.documents, packageDraft.instructions || draft.body),
    [draft.body, packageDraft.documents, packageDraft.instructions],
  );
  const selectedToolNames = useMemo(
    () => new Set(packageDraft.tools.map(tool => tool.name)),
    [packageDraft.tools],
  );
  const customToolsText = useMemo(
    () => packageDraft.tools
      .filter(tool => !commonTools.some(common => common.name === tool.name))
      .map(formatToolLine)
      .join('\n'),
    [packageDraft.tools],
  );

  const updatePackage = (updates: Partial<SkillPackage>) => {
    setDraft(prev => ({
      ...prev,
      package: {
        ...(prev.package || emptyPackage(prev.name, prev.category)),
        ...updates,
      },
    }));
  };

  const replacePackage = (nextPackage: SkillPackage) => {
    setDraft(prev => ({
      ...prev,
      body: pickPrimaryInstructions(nextPackage.documents, nextPackage.instructions) || prev.body,
      package: nextPackage,
    }));
  };

  const updateManifest = (updates: Partial<SkillPackage['manifest']>) => {
    updatePackage({
      manifest: {
        ...packageDraft.manifest,
        ...updates,
      },
    });
  };

  const updateDocument = (id: string, updates: Partial<SkillDocument>) => {
    const documents = packageDocuments
      .map(document => document.id === id ? { ...document, ...updates } : document)
      .map((document, index) => ({ ...document, order: index + 1 }));
    replacePackage({
      ...packageDraft,
      documents,
      instructions: pickPrimaryInstructions(documents, packageDraft.instructions),
    });
  };

  const addDocument = () => {
    const nextDocument = newSkillDocument('prompt', '新 Prompt 文档', '', false, packageDocuments.length + 1);
    replacePackage({
      ...packageDraft,
      documents: [...packageDocuments, nextDocument],
      instructions: pickPrimaryInstructions([...packageDocuments, nextDocument], packageDraft.instructions),
    });
  };

  const removeDocument = (id: string) => {
    const documents = packageDocuments
      .filter(document => document.id !== id)
      .map((document, index) => ({ ...document, order: index + 1 }));
    replacePackage({
      ...packageDraft,
      documents: documents.length ? documents : [newSkillDocument('sop', '核心 SOP', '', true, 1)],
      instructions: pickPrimaryInstructions(documents, packageDraft.instructions),
    });
  };

  const toggleCommonTool = (toolName: string, enabled: boolean) => {
    const common = commonTools.find(tool => tool.name === toolName);
    if (!common) return;
    const customTools = packageDraft.tools.filter(tool => !commonTools.some(item => item.name === tool.name));
    const enabledCommonTools = commonTools
      .filter(tool => (tool.name === toolName ? enabled : selectedToolNames.has(tool.name)))
      .map(tool => ({ type: tool.type, name: tool.name, required: false, notes: tool.notes }));
    updatePackage({ tools: [...enabledCommonTools, ...customTools] });
  };

  const updateCustomTools = (value: string) => {
    const enabledCommonTools = commonTools
      .filter(tool => selectedToolNames.has(tool.name))
      .map(tool => ({ type: tool.type, name: tool.name, required: false, notes: tool.notes }));
    updatePackage({ tools: [...enabledCommonTools, ...parseTools(value)] });
  };

  const openNew = () => {
    setEditingId(null);
    setDraft(emptyDraft());
    setImportRisk(null);
    setImportPreview('');
    setTestResult('');
    setEditorOpen(true);
  };

  const openEdit = (skill: Skill) => {
    setEditingId(skill.id);
    setDraft(normalizeDraft(skill));
    setImportRisk(null);
    setImportPreview('');
    setTestResult('');
    setEditorOpen(true);
  };

  const saveSkill = async () => {
    const documents = normalizeDocuments(packageDocuments, packageDraft.instructions || draft.body);
    const instructions = pickPrimaryInstructions(documents, packageDraft.instructions || draft.body);
    if (!draft.name.trim()) {
      setDiscoverNotice('请先填写 Skill 名称，再确认保存。');
      return;
    }
    if (!instructions.trim()) {
      setDiscoverNotice('请至少填写一段 SOP / Prompt / 文档内容，再确认保存。');
      return;
    }
    setBusy('save');
    const payload: Draft = {
      ...draft,
      category: draft.category || packageDraft.manifest.category,
      trigger: draft.trigger || packageDraft.manifest.triggers[0] || '',
      body: instructions,
      package: {
        ...packageDraft,
        manifest: {
          ...packageDraft.manifest,
          name: draft.name,
          category: draft.category || packageDraft.manifest.category,
          triggers: packageDraft.manifest.triggers.length
            ? packageDraft.manifest.triggers
            : draft.trigger ? [draft.trigger] : [],
        },
        instructions,
        documents,
      },
    };
    const endpoint = editingId ? `/api/skills/${editingId}` : '/api/skills';
    const method = editingId ? 'PUT' : 'POST';
    try {
      const res = await fetch(`${API}${endpoint}`, {
        method,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDiscoverNotice(data.error || `保存 Skill 失败（HTTP ${res.status}），请检查后重试。`);
        return;
      }
      setEditorOpen(false);
      setImportPreview('');
      setImportRisk(null);
      setDiscoverNotice(`${editingId ? '已更新' : '已保存'} Skill：${data.name || payload.name}`);
      await loadSkills();
    } catch (error) {
      setDiscoverNotice(`保存 Skill 失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy('');
    }
  };

  const deleteSkill = async (id: string) => {
    if (!confirm('确认删除这个 Skill？')) return;
    await fetch(`${API}/api/skills/${id}`, { method: 'DELETE' });
    await loadSkills();
  };

  const importSkill = async (sourceOverride?: string) => {
    const source = (sourceOverride || importUrl).trim();
    if (!source || busy) return;
    if (editorOpen && !confirm('当前编辑尚未保存，是否关闭并预览新的 Skill？')) return;
    setEditorOpen(false);
    setBusy('import');
    setImportChoices([]);
    setImportError('');
    try {
      const res = await fetch(`${API}/api/skills/import/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ source }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '导入预览失败');
      if (data.status === 'selection_required') {
        setImportChoices(data.choices || []);
        return;
      }
      if (!data.candidate || data.requiresConfirmation !== true || data.willWrite !== false || data.willExecute !== false) {
        throw new Error('导入响应缺少候选内容或安全确认信息。');
      }
      setImportUrl(source);
      setDraft(normalizeDraft(data.candidate));
      setImportRisk(data.risk);
      setImportPreview(data.preview || '');
      setEditingId(null);
      setEditorOpen(true);
      window.setTimeout(() => editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
    } catch (error) {
      setImportError(`未导入：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy('');
    }
  };

  const searchRemoteSkills = async () => {
    if (!discoverQuery.trim() || busy) return;
    setBusy('discover');
    setDiscoverErrors([]);
    setDiscoverNotice('');
    setDiscoverResults([]);
    setDiscoverProviders([]);
    try {
      const res = await fetch(`${API}/api/discovery/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ domain: 'skill', query: discoverQuery.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setDiscoverErrors([data.error || '联网发现失败']);
        setDiscoverResults([]);
        return;
      }
      const candidates = data.candidates || [];
      setDiscoverResults(candidates);
      setDiscoverErrors(data.errors || []);
      setDiscoverProviders(data.providerStatuses || []);
      if (candidates.length === 0 && data.errors?.length) {
        setDiscoverNotice('联网搜索暂不可用，未生成任何草稿。你可以稍后重试，或粘贴 URL 后手动导入预览。');
      } else if (candidates.length === 0) {
        setDiscoverNotice('没有找到候选。搜索不会自动创建草稿，可以使用下方 AI 草稿入口显式创建。');
      } else {
        setDiscoverNotice(data.note || '已找到候选。搜索结果不会自动创建草稿；远程候选需进入导入预览。');
      }
    } catch (error) {
      setDiscoverErrors([`搜索失败：${error instanceof Error ? error.message : String(error)}`]);
    } finally { setBusy(''); }
  };

  const handleCandidate = (candidate: SearchCandidate) => {
    if (candidate.source === 'local' && candidate.id) {
      const localSkill = skills.find(skill => skill.id === candidate.id);
      if (localSkill) {
        openEdit(localSkill);
        setDiscoverNotice(`已打开本地 Skill：${localSkill.name}`);
      }
      return;
    }
    if (candidate.url) {
      setImportUrl(candidate.url);
      setDiscoverNotice(`已填入导入源：${candidate.url}。请点击“导入预览”查看风险和候选内容。`);
      return;
    }
    setDiscoverNotice(`${candidate.name} 没有可导入 URL。搜索阶段不会自动创建草稿；如需新建，请使用“新建 Skill”或“AI 草稿”。`);
  };

  const previewCandidate = async (candidate: SearchCandidate) => {
    if (candidate.source === 'local' && candidate.id) {
      handleCandidate(candidate);
      return;
    }
    if (!candidate.url) {
      setDiscoverNotice(`${candidate.name} 没有可导入 URL，无法进入导入预览。`);
      return;
    }
    await importSkill(candidate.url);
  };

  const suggestSkill = async () => {
    if (!suggestPrompt.trim()) return;
    setBusy('suggest');
    const res = await fetch(`${API}/api/skills/suggest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ taskDescription: suggestPrompt.trim() }),
    });
    const data = await res.json();
    setBusy('');
    if (!res.ok) {
      alert(data.error || 'AI 草稿生成失败');
      return;
    }
    setDraft(normalizeDraft({
      name: 'AI 草稿 Skill',
      description: suggestPrompt.trim().slice(0, 120),
      category: 'draft',
      trigger: suggestPrompt.trim(),
      body: data.draft || '',
    }));
    setEditingId(null);
    setEditorOpen(true);
  };

  const testSkill = async (skill: Skill) => {
    setBusy(`test:${skill.id}`);
    const res = await fetch(`${API}/api/skills/${skill.id}/test`, { method: 'POST' });
    const data = await res.json();
    setBusy('');
    setTestResult(`${skill.name}: ${data.ok ? '测试通过' : '测试未通过'} (${data.results?.length || 0} 条)`);
  };

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <AccessControl />
        <div>
          <h1 className={styles.title}>Skills 技能库</h1>
          <p className={styles.subtitle}>用结构化 Skill Package 管理 SOP、输入输出、工具依赖、示例、测试和风险。</p>
        </div>
        <button className={styles.primaryButton} onClick={openNew}>
          <Plus size={18} />
          新建 Skill
        </button>
      </header>

      <section className={styles.discoveryPanel}>
        <div className={styles.discoveryHeader}>
          <div>
            <h2>联网发现</h2>
            <p>搜索 GitHub、网页和本地 Skill 候选。搜索不会创建草稿；远程候选需手动进入导入预览。</p>
          </div>
          <div className={styles.importBox}>
            <input value={discoverQuery} onChange={e => setDiscoverQuery(e.target.value)} placeholder="输入关键词，例如 last30days agent research" />
            <button className={styles.secondaryButton} onClick={searchRemoteSkills} disabled={Boolean(busy)}>
              <Search size={16} />
              搜索候选
            </button>
          </div>
        </div>
        {(discoverNotice || discoverResults.length > 0 || discoverErrors.length > 0) && (
          <div className={styles.discoveryResults}>
            {discoverNotice && <p className={styles.discoveryNote}>{discoverNotice}</p>}
            {discoverProviders.length > 0 && (
              <div className={styles.providerStatusBar}>
                {discoverProviders.map(provider => (
                  <span
                    key={provider.id}
                    className={`${styles.providerPill} ${styles[`provider_${provider.state}`]}`}
                    title={providerStatusDetail(provider)}
                  >
                    {provider.name}: {providerStateLabel(provider)}
                  </span>
                ))}
              </div>
            )}
            {discoverResults.map(candidate => (
              <article key={`${candidate.source}-${candidate.name}-${candidate.url || candidate.id || ''}`} className={styles.candidateCard}>
                <strong>{candidate.name}</strong>
                <span>{candidate.providerId || candidate.source}{candidate.stars ? ` · ${candidate.stars} stars` : ''}</span>
                <p>{candidate.description || '无描述'}</p>
                <div className={styles.candidateActions}>
                  <button type="button" className={styles.secondaryButton} onClick={() => handleCandidate(candidate)}>
                    {candidate.source === 'local' ? '编辑本地' : '填入来源'}
                  </button>
                  {candidate.url && (
                    <button type="button" className={styles.secondaryButton} onClick={() => previewCandidate(candidate)} disabled={busy === 'import'}>
                      导入预览
                    </button>
                  )}
                </div>
              </article>
            ))}
            {discoverErrors.map(error => <p key={error} className={styles.discoveryError}>{error}</p>)}
          </div>
        )}
      </section>

      <div className={styles.toolbar}>
        <div className={styles.searchBar}>
          <Search size={20} className={styles.searchIcon} />
          <input
            type="text"
            placeholder="搜索技能名称、分类、标签或描述..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={styles.searchInput}
          />
        </div>
        <div className={styles.importBox}>
          <input value={importUrl} onChange={e => { setImportUrl(e.target.value); setImportChoices([]); setImportError(''); }} disabled={busy === 'import'} aria-label="Skill 导入链接" placeholder="粘贴 SKILL.md 或 GitHub 目录链接" />
          <button className={styles.secondaryButton} onClick={() => importSkill()} disabled={Boolean(busy)}>
            <Download size={16} />
            {busy === 'import' ? '读取中...' : '导入预览'}
          </button>
        </div>
      </div>

      {importError && <p role="alert" className={styles.discoveryError}>{importError}</p>}
      {importChoices.length > 0 && (
        <section className={styles.importChoices} aria-label="选择仓库内的 Skill">
          <h2>选择 Skill ({importChoices.length})</h2>
          <ul>
            {importChoices.map(choice => (
              <li key={choice.url}>
                <a href={choice.url} target="_blank" rel="noreferrer">{choice.path}</a>
                <button className={styles.secondaryButton} disabled={Boolean(busy)} onClick={() => importSkill(choice.url)}><Download size={16} />预览</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className={styles.aiDraftBox}>
        <Bot size={18} />
        <input value={suggestPrompt} onChange={e => setSuggestPrompt(e.target.value)} placeholder="描述一个任务场景，让 AI 起草 Skill Package..." />
        <button className={styles.secondaryButton} onClick={suggestSkill} disabled={busy === 'suggest'}>生成草稿</button>
      </div>

      {testResult && <div className={styles.testResult}>{testResult}</div>}

      {editorOpen && (
        <section ref={editorRef} className={styles.editorPanel}>
          <div className={styles.editorHeader}>
            <div>
              <h2>{editingId ? '编辑 Skill Package' : 'Skill Package 草稿'}</h2>
              <p>按分区补齐基础信息、执行步骤、工具依赖、示例、测试和风险；确认保存前不会落盘。</p>
            </div>
            <button className={styles.iconButton} onClick={() => setEditorOpen(false)} aria-label="关闭编辑器">
              <X size={18} />
            </button>
          </div>

          {importRisk && (
            <div className={`${styles.riskBox} ${styles[`risk_${importRisk.level}`]}`}>
              <ShieldAlert size={18} />
              <div>
                <strong>风险等级：{importRisk.level}</strong>
                <p>{importRisk.flags.length ? importRisk.flags.join('；') : '未发现明显风险。'}</p>
                {importRisk.commands.length > 0 && <details className={styles.riskDetails}><summary>命令线索 ({importRisk.commands.length}) · 未执行</summary><pre>{importRisk.commands.join('\n')}</pre></details>}
                {importRisk.envVars.length > 0 && <details className={styles.riskDetails}><summary>配置变量线索 ({importRisk.envVars.length})</summary><pre>{importRisk.envVars.join('\n')}</pre></details>}
              </div>
            </div>
          )}

          {packageDraft.source && (
            <details className={styles.resourceFiles}>
              <summary>来源文件 ({packageDraft.files?.length || 0}) · {packageDraft.source.complete ? '完整读取' : '部分资源'}</summary>
              <p>来源快照{packageDraft.source.commit ? ` · ${packageDraft.source.commit.slice(0, 12)}` : ''}</p>
              {packageDraft.source.kind !== 'inline' && <a href={packageDraft.source.url} target="_blank" rel="noreferrer">{packageDraft.source.url}</a>}
              <ul>{packageDraft.files?.map(file => (
                <li key={file.path}>
                  <details>
                    <summary>{file.path} · {file.status === 'included' ? `${file.size} bytes` : file.reason}</summary>
                    {file.encoding === 'utf8' ? <pre>{file.content}</pre> : <p>{file.status === 'included' ? '二进制附件，未执行' : '仅保留来源，未导入内容'}</p>}
                  </details>
                </li>
              ))}</ul>
            </details>
          )}

          <section className={styles.editorSection}>
            <h3>基础信息</h3>
            <div className={styles.formGrid}>
              <label>名称<input value={draft.name} onChange={e => {
                setDraft({ ...draft, name: e.target.value });
                updateManifest({ name: e.target.value });
              }} /></label>
              <label>分类<input value={draft.category} onChange={e => {
                setDraft({ ...draft, category: e.target.value });
                updateManifest({ category: e.target.value });
              }} /></label>
              <label>版本<input value={packageDraft.manifest.version} onChange={e => updateManifest({ version: e.target.value })} /></label>
              <label>风险等级
                <select value={packageDraft.manifest.riskLevel} onChange={e => updateManifest({ riskLevel: e.target.value as RiskLevel })}>
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                </select>
              </label>
              <label className={styles.fullWidth}>描述<input value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })} /></label>
              <label className={styles.fullWidth}>触发条件<input value={draft.trigger || ''} onChange={e => {
                setDraft({ ...draft, trigger: e.target.value });
                updateManifest({ triggers: splitList(e.target.value) });
              }} placeholder="多个触发条件用逗号分隔" /></label>
              <label className={styles.fullWidth}>适用 Agent<input value={packageDraft.manifest.applicableAgents.join(', ')} onChange={e => updateManifest({ applicableAgents: splitList(e.target.value) })} /></label>
              <label className={styles.fullWidth}>标签<input value={packageDraft.manifest.tags.join(', ')} onChange={e => updateManifest({ tags: splitList(e.target.value) })} /></label>
            </div>
          </section>

          <section className={styles.editorSection}>
            <div className={styles.sectionHeader}>
              <div>
                <h3>文档包</h3>
                <p>这里只放执行说明：SOP、提示词、参考资料、检查清单和策略边界。输出、示例和测试在下方单独配置。</p>
              </div>
              <button className={styles.secondaryButton} onClick={addDocument} type="button">
                <Plus size={15} />
                添加文档
              </button>
            </div>
            <div className={styles.documentList}>
              {packageDocuments.map(document => (
                <article key={document.id} className={styles.documentCard}>
                  <div className={styles.documentMetaGrid}>
                    <label>类型
                      <select value={document.type} onChange={event => updateDocument(document.id, { type: event.target.value as SkillDocumentType })}>
                        {documentTypeOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    </label>
                    <label>标题
                      <input value={document.title} onChange={event => updateDocument(document.id, { title: event.target.value })} />
                    </label>
                    <label className={styles.checkboxLabel}>
                      <input type="checkbox" checked={Boolean(document.required)} onChange={event => updateDocument(document.id, { required: event.target.checked })} />
                      必需
                    </label>
                    <button className={styles.iconButton} onClick={() => removeDocument(document.id)} type="button" aria-label="删除文档" disabled={packageDocuments.length <= 1}>
                      <Trash2 size={15} />
                    </button>
                    <label className={styles.fullWidth}>说明
                      <input value={document.description || ''} onChange={event => updateDocument(document.id, { description: event.target.value })} placeholder="这份文档在 Skill 中的用途" />
                    </label>
                  </div>
                  <textarea
                    className={styles.sectionTextarea}
                    value={document.content}
                    onChange={event => updateDocument(document.id, { content: event.target.value })}
                    rows={document.type === 'sop' ? 10 : 7}
                    placeholder={placeholderForDocument(document.type)}
                  />
                </article>
              ))}
            </div>
          </section>

          <section className={styles.editorSection}>
            <div className={styles.sectionHeader}>
              <div>
                <h3>工具依赖</h3>
                <p>先勾选常用工具；只有接入特殊 MCP 或 API 时，才填写高级工具。</p>
              </div>
            </div>
            <div className={styles.toolChoiceGrid}>
              {commonTools.map(tool => (
                <label key={tool.name} className={styles.toolChoice}>
                  <input
                    type="checkbox"
                    checked={selectedToolNames.has(tool.name)}
                    onChange={event => toggleCommonTool(tool.name, event.target.checked)}
                  />
                  <span>
                    <strong>{tool.label}</strong>
                    <small>{tool.notes}</small>
                  </span>
                </label>
              ))}
            </div>
            <label className={styles.simpleField}>其他高级工具
              <textarea
                className={styles.sectionTextarea}
                value={customToolsText}
                onChange={event => updateCustomTools(event.target.value)}
                rows={3}
                placeholder="可选。每行一个，例如 mcp:filesystem:required 或 api:github"
              />
            </label>
          </section>

          <section className={styles.packageGrid}>
            <div className={styles.editorSection}>
              <h3>输入</h3>
              <textarea
                className={styles.sectionTextarea}
                value={formatIO(packageDraft.inputs)}
                onChange={event => updatePackage({ inputs: parseNamedLines(event.target.value, 'task', '用户任务描述') })}
                rows={5}
                placeholder="每行一个，例如：任务目标 - 用户想完成什么"
              />
            </div>
            <div className={styles.editorSection}>
              <h3>输出</h3>
              <textarea
                className={styles.sectionTextarea}
                value={formatIO(packageDraft.outputs)}
                onChange={event => updatePackage({ outputs: parseNamedLines(event.target.value, 'result', '结构化产出') })}
                rows={5}
                placeholder="每行一个，例如：调研报告 - 结构化结论、来源和建议"
              />
            </div>
            <div className={styles.editorSection}>
              <h3>示例</h3>
              <textarea
                className={styles.sectionTextarea}
                value={formatExamples(packageDraft.examples)}
                onChange={event => updatePackage({ examples: parseExamples(event.target.value) })}
                rows={5}
                placeholder="每行一个：用户任务 => 期望输出"
              />
            </div>
            <div className={styles.editorSection}>
              <h3>最小测试</h3>
              <textarea
                className={styles.sectionTextarea}
                value={formatTests(packageDraft.tests)}
                onChange={event => updatePackage({ tests: parseTests(event.target.value) })}
                rows={5}
                placeholder="每行一个：测试名 - 输出必须包含的关键词，用逗号分隔"
              />
            </div>
          </section>

          <section className={styles.editorSection}>
            <h3>风险备注</h3>
            <textarea className={styles.sectionTextarea} value={packageDraft.riskNotes.join('\n')} onChange={e => updatePackage({ riskNotes: splitLines(e.target.value) })} rows={4} />
          </section>

          {importPreview && (
            <details className={styles.previewPanel}>
              <summary>查看导入原文预览</summary>
              <pre>{importPreview}</pre>
            </details>
          )}

          <div className={styles.buttonRow}>
            <button className={styles.secondaryButton} onClick={() => setEditorOpen(false)}>取消</button>
            <button className={styles.primaryButton} onClick={saveSkill} disabled={busy === 'save'}>
              {importPreview ? '确认保存导入' : '保存 Skill'}
            </button>
          </div>
        </section>
      )}

      {loading ? (
        <div className={styles.loading}>加载中...</div>
      ) : (
        <div className={styles.bentoGrid}>
          {filteredSkills.map(skill => (
            <div key={skill.id} className={styles.bentoCard}>
              <div className={styles.cardHeader}>
                <div className={styles.iconWrapper}><BookOpen size={20} /></div>
                <span className={styles.categoryBadge}>{skill.category}</span>
              </div>

              <h3 className={styles.cardTitle}>{skill.name}</h3>
              <p className={styles.cardDescription}>{skill.description}</p>

              <div className={styles.packageMeta}>
                <span>{skill.package?.manifest.version || '1.0.0'}</span>
                <span>{skill.package?.manifest.riskLevel || 'low'} risk</span>
                <span>{skill.package?.documents?.length || 1} docs</span>
                <span>{skill.package?.tools.length || 0} tools</span>
                <span>{skill.package?.tests.length || 0} tests</span>
              </div>

              <div className={styles.cardFooter}>
                <div className={styles.metaItem}><Clock size={14} /><span>{formatDate(skill.createdAt)}</span></div>
                {skill.trigger && <div className={styles.metaItem}><Tag size={14} /><span>{skill.trigger}</span></div>}
              </div>
              <div className={styles.cardActions}>
                <button className={styles.secondaryButton} onClick={() => testSkill(skill)} disabled={busy === `test:${skill.id}`}><FlaskConical size={15} />测试</button>
                <button className={styles.secondaryButton} onClick={() => openEdit(skill)}><Pencil size={15} />编辑</button>
                <button className={styles.dangerButton} onClick={() => deleteSkill(skill.id)}><Trash2 size={15} />删除</button>
              </div>
            </div>
          ))}

          {filteredSkills.length === 0 && <div className={styles.emptyState}><CheckCircle2 size={22} /><p>未找到符合条件的 Skill</p></div>}
        </div>
      )}
    </div>
  );
}

function newSkillDocument(
  type: SkillDocumentType,
  title: string,
  content = '',
  required = false,
  order = 1,
): SkillDocument {
  return {
    id: `doc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type,
    title,
    content,
    order,
    required,
    format: 'markdown',
  };
}

function normalizeDocuments(documents: SkillDocument[] | undefined, fallbackInstructions = ''): SkillDocument[] {
  const normalized = (documents || [])
    .map((document, index) => {
      const type = editableDocumentType(document.type || 'notes');
      return {
        id: document.id || `doc-${index + 1}`,
        type,
        title: document.title || labelForDocumentType(type),
        content: document.content || '',
        order: Number.isFinite(document.order) ? document.order : index + 1,
        required: document.required,
        format: document.format || 'markdown',
        description: document.description || '',
      };
    })
    .filter(document => document.title.trim() || document.content.trim())
    .sort((a, b) => a.order - b.order)
    .map((document, index) => ({ ...document, order: index + 1 }));

  if (normalized.length) return normalized;

  return [{
    id: 'doc-core-sop',
    type: 'sop',
    title: '核心 SOP',
    content: fallbackInstructions,
    order: 1,
    required: true,
    format: 'markdown',
  }];
}

function documentsFromMarkdown(markdown = ''): SkillDocument[] {
  if (!markdown.trim()) return [];
  const startsWithSection = markdown.trimStart().startsWith('## ');
  const chunks = markdown.split(/^##\s+/m);
  const documents: SkillDocument[] = [];

  chunks.forEach((chunk, index) => {
    if (!chunk.trim()) return;
    const [titleLine = '', ...rest] = chunk.split('\n');
    const title = index === 0 && !startsWithSection ? '核心 SOP' : titleLine.trim() || '补充文档';
    const content = index === 0 && !startsWithSection ? chunk.trim() : rest.join('\n').trim();
    if (!content) return;
    documents.push({
      id: `doc-${index + 1}-${slugify(title)}`,
      type: inferDocumentType(title, index),
      title,
      content,
      order: documents.length + 1,
      required: index === 0 || /sop|执行|步骤|prompt|提示词/i.test(title),
      format: 'markdown',
    });
  });

  return documents;
}

function pickPrimaryInstructions(documents: SkillDocument[] | undefined, fallback = ''): string {
  const ordered = normalizeDocuments(documents, fallback);
  return (
    ordered.find(document => document.type === 'sop' && document.required && document.content.trim())?.content ||
    ordered.find(document => document.type === 'sop' && document.content.trim())?.content ||
    ordered.find(document => document.required && document.content.trim())?.content ||
    ordered.find(document => document.content.trim())?.content ||
    fallback ||
    ''
  );
}

function inferDocumentType(title: string, index: number): SkillDocumentType {
  const lower = title.toLowerCase();
  if (index === 0 || /执行|步骤|sop|workflow/.test(lower)) return 'sop';
  if (/prompt|提示词|system/.test(lower)) return 'prompt';
  if (/参考|资料|reference|context/.test(lower)) return 'reference';
  if (/清单|检查|checklist|quality/.test(lower)) return 'checklist';
  if (/策略|约束|policy|guardrail|risk/.test(lower)) return 'policy';
  return 'notes';
}

function labelForDocumentType(type: SkillDocumentType): string {
  return documentTypeOptions.find(option => option.value === type)?.label || '补充说明';
}

function editableDocumentType(type: SkillDocumentType): SkillDocumentType {
  return documentTypeOptions.some(option => option.value === type) ? type : 'notes';
}

function placeholderForDocument(type: SkillDocumentType): string {
  const placeholders: Record<SkillDocumentType, string> = {
    sop: '写清楚执行步骤、判断条件、降级策略。',
    prompt: '写可直接注入 Agent 的提示词片段。',
    reference: '放背景知识、资料链接、术语解释或领域规则。',
    checklist: '- 检查输出是否覆盖关键问题\n- 检查来源和风险',
    template: '定义输出结构、表格字段或报告章节。',
    policy: '写安全边界、禁止行为、需要用户确认的条件。',
    example: '给出示例输入和高质量输出样例。',
    test: '写最小验证样例或期望包含的关键字。',
    notes: '补充说明。',
  };
  return placeholders[type];
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36) || 'document';
}

function splitList(value: string) {
  return value.split(',').map(item => item.trim()).filter(Boolean);
}

function splitLines(value: string) {
  return value.split('\n').map(item => item.trim()).filter(Boolean);
}

function formatDate(timestamp: number) {
  if (!timestamp) return '-';
  return new Date(timestamp).toISOString().slice(0, 10);
}

function formatToolLine(tool: SkillPackage['tools'][number]) {
  return `${tool.type}:${tool.name}${tool.required ? ':required' : ''}`;
}

function parseTools(value: string): SkillPackage['tools'] {
  return splitLines(value).map(line => {
    const [typeRaw, name, required] = line.split(':').map(item => item.trim());
    const type = ['builtin', 'mcp', 'api', 'browser'].includes(typeRaw) ? typeRaw as SkillPackage['tools'][number]['type'] : 'builtin';
    return { type, name: name || line, required: required === 'required' };
  }).filter(item => item.name);
}

function formatIO(items: SkillPackage['inputs'] | SkillPackage['outputs']) {
  return items.map(item => `${item.name} - ${item.description}`).join('\n');
}

function parseNamedLines(value: string, fallbackName: string, fallbackDescription: string) {
  const items = splitLines(value).map(line => {
    const match = line.match(/^(.+?)\s*(?:-|:|：)\s*(.+)$/);
    const name = match?.[1]?.trim() || line.trim();
    const description = match?.[2]?.trim() || line.trim();
    return { name, description, required: true };
  });

  return items.length ? items : [{ name: fallbackName, description: fallbackDescription, required: true }];
}

function formatExamples(examples: SkillPackage['examples']) {
  return examples.map(example => `${example.input} => ${example.expectedOutput}`).join('\n');
}

function parseExamples(value: string): SkillPackage['examples'] {
  return splitLines(value).map(line => {
    const [input = '', expectedOutput = ''] = line.split('=>');
    return { input: input.trim(), expectedOutput: expectedOutput.trim() };
  }).filter(example => example.input || example.expectedOutput);
}

function formatTests(tests: SkillPackage['tests']) {
  return tests.map(test => {
    const expected = test.expectedIncludes.join(', ');
    return expected ? `${test.name} - ${expected}` : test.name;
  }).join('\n');
}

function parseTests(value: string): SkillPackage['tests'] {
  const tests = splitLines(value).map(line => {
    const match = line.match(/^(.+?)\s*(?:-|:|：)\s*(.*)$/);
    const name = match?.[1]?.trim() || line.trim();
    const expectedIncludes = (match?.[2] || '')
      .split(/[,，|]/)
      .map(item => item.trim())
      .filter(Boolean);
    return { name, input: name, expectedIncludes };
  });

  return tests.length ? tests : [{ name: 'basic-output', input: '执行一个简单任务', expectedIncludes: [] }];
}
