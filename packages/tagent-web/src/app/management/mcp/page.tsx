'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, Download, Globe, Pencil, Plus, Server, ShieldAlert, Terminal, Trash2, Wifi, X } from 'lucide-react';
import styles from './mcp.module.css';
import type { MCPServerConfig, DiscoveryProviderStatus as ProviderStatus } from '@tagent/core';
import { providerStateLabel, providerStatusDetail } from '../../../lib/discovery-status';

import { API_BASE as API, apiFetch as fetch } from '../../../lib/api-client';
import { AccessControl } from '../../../components/AccessGate';

type MCPServer = MCPServerConfig;
type VariableRow = [string, string];
const SAVED_SECRET = '[saved-secret]';

async function fetchServers(signal?: AbortSignal): Promise<MCPServer[]> {
  const response = await fetch(`${API}/api/mcp`, { signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'MCP 列表读取失败。');
  return data.servers;
}

interface RiskPreview {
  level: 'low' | 'medium' | 'high';
  flags: string[];
  commands: string[];
  envVars: string[];
}

interface ImportChoice { id: string; name: string; url?: string; type?: MCPServer['type']; commandPreview?: string; error?: string; available: boolean }

interface SearchCandidate {
  source: string;
  providerId?: string;
  id?: string;
  name: string;
  description?: string;
  url?: string;
  packageName?: string;
  type?: MCPServer['type'];
  stars?: number;
  updatedAt?: string;
}

const emptyDraft: Omit<MCPServer, 'id'> = {
  name: '',
  type: 'stdio',
  command: '',
  args: [],
  env: {},
  url: '',
};

export default function MCPPage() {
  const [servers, setServers] = useState<MCPServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState(emptyDraft);
  const [args, setArgs] = useState<string[]>([]);
  const [variables, setVariables] = useState<VariableRow[]>([]);
  const [headers, setHeaders] = useState<VariableRow[]>([]);
  const [importSource, setImportSource] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchCandidate[]>([]);
  const [searchErrors, setSearchErrors] = useState<string[]>([]);
  const [searchNotice, setSearchNotice] = useState('');
  const [searchProviders, setSearchProviders] = useState<ProviderStatus[]>([]);
  const [risk, setRisk] = useState<RiskPreview | null>(null);
  const [importChoices, setImportChoices] = useState<{ source: string; items: ImportChoice[] } | null>(null);
  const [importWarnings, setImportWarnings] = useState<string[]>([]);
  const [testResult, setTestResult] = useState('');
  const [testTools, setTestTools] = useState<Array<{ name: string; description?: string; inputSchema?: unknown }>>([]);
  const [connectionChecks, setConnectionChecks] = useState<Record<string, { revision: number; ok: boolean }>>({});
  const [approvalTarget, setApprovalTarget] = useState<MCPServer | null>(null);
  const [busy, setBusy] = useState('');

  const loadServers = useCallback(async () => {
    setServers(await fetchServers());
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetchServers(controller.signal).then(setServers).catch(error => {
      if (!controller.signal.aborted) setSearchNotice(error.message);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  const sortedServers = useMemo(() => [...servers].sort((a, b) => a.name.localeCompare(b.name)), [servers]);

  const openNew = () => {
    if (busy || (editorOpen && !confirm('放弃当前未保存的编辑，创建新配置？'))) return;
    setEditingId(null);
    setDraft(emptyDraft);
    setArgs([]);
    setVariables([]);
    setHeaders([]);
    setRisk(null);
    setImportChoices(null);
    setImportWarnings([]);
    setTestResult('');
    setEditorOpen(true);
  };

  const openEdit = (server: MCPServer) => {
    if (busy || (editorOpen && !confirm('放弃当前未保存的编辑，打开另一项配置？'))) return;
    setEditingId(server.id);
    setDraft(server);
    setArgs(server.args || []);
    setVariables(Object.entries(server.env || {}));
    setHeaders(Object.entries(server.headers || {}));
    setRisk(null);
    setImportChoices(null);
    setImportWarnings([]);
    setTestResult('');
    setEditorOpen(true);
  };

  const importMcp = async (sourceOverride?: string, choiceId?: string) => {
    if (busy || (editorOpen && !confirm('导入预览将替换当前未保存的编辑，继续？'))) return;
    const source = (sourceOverride || importSource).trim();
    if (!source) {
      setSearchNotice('请先输入 GitHub URL、普通 URL 或 npm 包名，再进入导入预览。');
      return;
    }
    setBusy('import');
    try {
      const res = await fetch(`${API}/api/mcp/import/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ source, choiceId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSearchNotice(data.error || `导入预览失败（HTTP ${res.status}）。`);
        return;
      }
      setImportSource(source);
      setImportWarnings(data.warnings || []);
      if (data.status === 'selection_required') {
        setImportChoices({ source: ['github', 'npm'].includes(data.source?.kind) ? data.source.url : source, items: data.choices || [] });
        setEditorOpen(false);
        setSearchNotice('请选择来源中的 MCP 文档或配置。尚未保存或执行。');
        return;
      }
      if (!data.candidate) { setSearchNotice('来源未返回可用配置，未创建草稿。'); return; }
      setImportChoices(null);
      setDraft({ ...emptyDraft, ...data.candidate });
      setArgs(data.candidate.args || []);
      setVariables(Object.entries(data.candidate.env || {}));
      setHeaders(Object.entries(data.candidate.headers || {}));
      setRisk(data.risk);
      setEditingId(null);
      setEditorOpen(true);
      setSearchNotice(data.status === 'needs_input' ? '配置已读取，请补齐待填写项后确认保存。' : '已读取 MCP 配置。尚未验证连接，确认保存前不会执行命令。');
    } catch (error) {
      setSearchNotice(`导入预览失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy('');
    }
  };

  const searchMcp = async () => {
    if (!searchQuery.trim() || busy) return;
    setBusy('search');
    setSearchErrors([]);
    setSearchNotice('');
    setSearchResults([]);
    setSearchProviders([]);
    try {
    const res = await fetch(`${API}/api/discovery/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ domain: 'mcp', query: searchQuery.trim() }),
    });
    const data = await res.json();
    if (!res.ok) {
      setSearchResults([]);
      setSearchErrors([data.error || 'MCP 搜索失败']);
      return;
    }
    const candidates = data.candidates || [];
    setSearchResults(candidates);
    setSearchErrors(data.errors || []);
    setSearchProviders(data.providerStatuses || []);
    if (candidates.length === 0 && data.errors?.length) {
      setSearchNotice('联网搜索暂不可用，未生成任何 MCP 草稿。你可以稍后重试，或输入 npm 包名 / URL 后手动导入预览。');
    } else if (candidates.length === 0) {
      setSearchNotice('没有找到 MCP 候选。搜索不会自动创建 stdio 草稿。');
    } else {
      setSearchNotice(data.note || '已找到候选。搜索结果不会自动生成配置；请进入导入预览确认命令和风险。');
    }
    } catch {
      setSearchErrors(['联网搜索请求失败，请检查后端和网络后重试。']);
    } finally { setBusy(''); }
  };

  const handleCandidate = (candidate: SearchCandidate) => {
    if (candidate.source === 'local' && candidate.id) {
      const localServer = servers.find(server => server.id === candidate.id);
      if (localServer) {
        openEdit(localServer);
        setSearchNotice(`已打开本地 MCP Server：${localServer.name}`);
      }
      return;
    }
    if (candidate.packageName && !candidate.url) {
      setImportSource(candidate.packageName);
      setSearchNotice(`已填入 npm 包名：${candidate.packageName}。请点击“导入预览”查看命令、env 和风险。`);
      return;
    }
    if (candidate.url) {
      setImportSource(candidate.url);
      setSearchNotice(`已填入导入源：${candidate.url}。请点击“导入预览”查看配置候选和风险。`);
      return;
    }
    setSearchNotice(`${candidate.name} 没有可导入 URL 或 npm 包名。搜索阶段不会自动创建 MCP 草稿。`);
  };

  const saveServer = async () => {
    if (!draft.name.trim()) {
      setSearchNotice('请先填写 MCP Server 名称，再确认保存。');
      return;
    }
    const rows = draft.type === 'stdio' ? variables : headers;
    if (rows.some(([key]) => !key.trim()) || new Set(rows.map(([key]) => draft.type === 'stdio' ? key : key.toLowerCase())).size !== rows.length) {
      setSearchNotice('变量名称不能为空或重复。');
      return;
    }

    const payload: Omit<MCPServer, 'id'> = {
      ...draft,
      args,
      env: Object.fromEntries(variables),
      headers: Object.fromEntries(headers),
      revision: draft.revision || 0,
    };

    setBusy('save');
    const endpoint = editingId ? `/api/mcp/${editingId}` : '/api/mcp';
    const method = editingId ? 'PUT' : 'POST';
    try {
      const res = await fetch(`${API}${endpoint}`, {
        method,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSearchNotice(data.error || `保存 MCP Server 失败（HTTP ${res.status}），请检查后重试。`);
        return;
      }
      setEditorOpen(false);
      setRisk(null);
      setSearchNotice(`${editingId ? '已更新' : '已保存'} MCP Server：${data.name || payload.name}`);
      await loadServers();
    } catch (error) {
      setSearchNotice(`保存 MCP Server 失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy('');
    }
  };

  const deleteServer = async (id: string) => {
    if (!confirm('确认删除这个 MCP Server？')) return;
    setBusy(`delete:${id}`);
    try {
      const response = await fetch(`${API}/api/mcp/${id}`, { method: 'DELETE' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '删除失败。');
      await loadServers();
    } catch (error) { setSearchNotice(error instanceof Error ? error.message : '删除失败。'); }
    finally { setBusy(''); }
  };

  const testServer = async (server: MCPServer) => {
    setBusy(`test:${server.id}`);
    setTestTools([]);
    try {
      const res = await fetch(`${API}/api/mcp/${server.id}/test`, { method: 'POST' });
      const data = await res.json();
      setTestResult(`${server.name}: ${data.message || data.error || (data.ok ? 'MCP 握手成功' : '测试失败')}`);
      if (server.type !== 'stdio') setConnectionChecks(previous => ({ ...previous, [server.id]: { revision: server.revision || 0, ok: res.ok && data.ok === true } }));
      if (data.ok) setTestTools(data.tools || []);
    } catch {
      setTestResult(`${server.name}: 测试请求失败，请重试。`);
      if (server.type !== 'stdio') setConnectionChecks(previous => ({ ...previous, [server.id]: { revision: server.revision || 0, ok: false } }));
    }
    finally { setBusy(''); }
  };

  const setApproval = async (server: MCPServer, confirmed: boolean) => {
    setBusy('approval');
    try {
      const res = await fetch(`${API}/api/mcp/${server.id}/approval`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmed, revision: server.revision || 0 }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '授权保存失败。');
      setApprovalTarget(null);
      setSearchNotice(confirmed ? '已授权任务内调用。此操作没有启动进程；Agent 仍须满足工具白名单。' : '已撤销后续任务的执行授权。正在执行的外部操作不会自动撤销。');
      await loadServers();
    } catch (error) { setSearchNotice(error instanceof Error ? error.message : '授权保存失败。'); }
    finally { setBusy(''); }
  };

  const getTypeIcon = (type: string) => {
    switch (type) {
      case 'stdio': return <Terminal size={16} />;
      case 'sse': return <Activity size={16} />;
      case 'http': return <Globe size={16} />;
      default: return <Server size={16} />;
    }
  };

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <AccessControl />
        <div>
          <h1 className={styles.title}>MCP 工具集</h1>
          <p className={styles.subtitle}>添加、预览和测试 Model Context Protocol 工具服务。</p>
        </div>
        <button className={styles.primaryButton} onClick={openNew} disabled={Boolean(busy)}>
          <Plus size={18} />
          添加 Server
        </button>
      </header>

      <section className={styles.discoveryPanel}>
        <div>
          <h2>联网发现</h2>
          <p>搜索 GitHub、npm 和本地 MCP 候选。点击候选只会填入导入源；导入预览前不会生成命令或执行 stdio。</p>
        </div>
        <div className={styles.importBox}>
          <input
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="搜索 MCP，例如 filesystem、github、browser"
          />
          <button className={styles.secondaryButton} onClick={searchMcp} disabled={Boolean(busy)}>
            <Download size={16} />
            搜索候选
          </button>
        </div>
      </section>

      {(searchNotice || searchResults.length > 0 || searchErrors.length > 0) && (
        <div className={styles.discoveryResults}>
          {searchNotice && <p className={styles.discoveryNote}>{searchNotice}</p>}
          {searchProviders.length > 0 && (
            <div className={styles.providerStatusBar}>
              {searchProviders.map(provider => (
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
          {searchResults.map(candidate => (
            <article
              key={`${candidate.source}-${candidate.name}-${candidate.url || candidate.packageName || ''}`}
              className={styles.candidateCard}
            >
              <strong>{candidate.name}</strong>
              <span>{candidate.providerId || candidate.source}{candidate.stars ? ` · ${candidate.stars} stars` : ''}</span>
              <p>{candidate.description || candidate.packageName || candidate.url || '无描述'}</p>
              <div className={styles.candidateActions}>
                <button type="button" className={styles.secondaryButton} onClick={() => handleCandidate(candidate)} disabled={Boolean(busy)}>
                  {candidate.source === 'local' ? '编辑本地' : '填入来源'}
                </button>
                {(candidate.packageName || candidate.url) && (
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    onClick={() => importMcp(candidate.url || candidate.packageName)}
                    disabled={Boolean(busy)}
                  >
                    导入预览
                  </button>
                )}
              </div>
            </article>
          ))}
          {searchErrors.map(error => <p key={error} className={styles.discoveryError}>{error}</p>)}
        </div>
      )}

      <div className={styles.importBox}>
        <input
          value={importSource}
          onChange={e => setImportSource(e.target.value)}
          placeholder="输入 GitHub URL、普通 URL 或 npm 包名"
        />
        <button className={styles.secondaryButton} onClick={() => importMcp()} disabled={Boolean(busy)}>
          <Download size={16} />
          导入预览
        </button>
      </div>

      {importChoices && <section className={styles.importSelection} aria-label="选择 MCP 配置">
        <h2>选择配置</h2>
        <div className={styles.choiceList}>
          {importChoices.items.map(choice => <article className={styles.choiceRow} key={choice.id}>
            <div><strong>{choice.name}</strong>{choice.type && <small>{choice.type}</small>}{choice.commandPreview && <pre className={styles.choiceCommand}>{choice.commandPreview}</pre>}{choice.error && <p role="status">{choice.error}</p>}</div>
            <button type="button" className={styles.secondaryButton} disabled={Boolean(busy) || !choice.available}
              onClick={() => importMcp(choice.url || importChoices.source, choice.url ? undefined : choice.id)}>
              <Download size={16} />{choice.url ? '读取文档' : '预览配置'}
            </button>
          </article>)}
        </div>
      </section>}

      {editorOpen && (
        <section className={styles.editorPanel}>
          <div className={styles.editorHeader}>
            <div>
              <h2>{editingId ? '编辑 MCP Server' : 'MCP Server 草稿'}</h2>
              <p>保存前检查命令、URL 和所需环境变量。URL 导入不会自动执行任何命令。</p>
            </div>
            <button className={styles.iconButton} onClick={() => setEditorOpen(false)} aria-label="关闭编辑器" disabled={Boolean(busy)}>
              <X size={18} />
            </button>
          </div>

          {draft.source && <details className={styles.importMetadata}>
            <summary>导入来源{draft.source.version ? ` / ${draft.source.version}` : ''}</summary>
            {draft.source.kind === 'inline' ? <p>粘贴的配置</p> : <a href={draft.source.url} target="_blank" rel="noreferrer">{draft.source.url}</a>}
            {draft.source.commit && <p>提交：{draft.source.commit}</p>}
            {draft.source.path && <p>文件：{draft.source.path}</p>}
            {importWarnings.map(warning => <p key={warning}>{warning}</p>)}
          </details>}
          {draft.requirements?.some(item => item.required) && <div className={styles.requiredFields} role="status">
            <strong>待核对字段</strong>
            <ul>{draft.requirements.filter(item => item.required).map((item, index) => <li key={`${item.location}-${item.key}-${index}`}>
              {item.location === 'arg' ? `参数 ${Number(item.key) + 1}` : item.key}：{item.description}
            </li>)}</ul>
          </div>}

          {risk && (
            <div className={`${styles.riskBox} ${styles[`risk_${risk.level}`]}`}>
              <ShieldAlert size={18} />
              <div>
                <strong>风险等级：{risk.level}</strong>
                <p>{risk.flags.length ? risk.flags.join('；') : '未发现明显风险。'}</p>
                {draft.type === 'stdio' && <small>当前命令：{[draft.command || '', ...args].map(part => JSON.stringify(part)).join(' ')}</small>}
                {risk.envVars.length > 0 && <small>环境变量：{risk.envVars.join(', ')}</small>}
              </div>
            </div>
          )}

          <fieldset className={styles.formGrid} disabled={Boolean(busy)}>
            <label>
              名称
              <input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} />
            </label>
            <label>
              类型
              <select value={draft.type} onChange={e => setDraft({ ...draft, type: e.target.value as MCPServer['type'], requirements: [] })}>
                <option value="stdio">stdio</option>
                <option value="http">http</option>
                <option value="sse">sse</option>
              </select>
            </label>
            {draft.type === 'stdio' ? (
              <>
                <label>
                  命令
                  <input value={draft.command || ''} onChange={e => setDraft({ ...draft, command: e.target.value })} />
                </label>
                <div className={`${styles.fullWidth} ${styles.fieldRows}`}>
                  <strong>命令参数</strong>
                  {args.map((arg, index) => <div className={styles.argumentRow} key={index}>
                    <textarea aria-label={`参数 ${index + 1}`} value={arg} onChange={e => setArgs(args.map((value, i) => i === index ? e.target.value : value))} rows={2} />
                    <button type="button" className={styles.iconButton} title="删除参数" aria-label={`删除参数 ${index + 1}`}
                      disabled={draft.requirements?.some(item => item.location === 'arg' && item.key === String(index) && item.required)}
                      onClick={() => {
                        setArgs(args.filter((_, i) => i !== index));
                        setDraft({ ...draft, requirements: draft.requirements?.filter(item => item.location !== 'arg' || item.key !== String(index)).map(item => item.location === 'arg' && Number(item.key) > index ? { ...item, key: String(Number(item.key) - 1) } : item) });
                      }}><Trash2 size={16} /></button>
                  </div>)}
                  <button type="button" className={styles.secondaryButton} onClick={() => setArgs([...args, ''])}><Plus size={16} />添加参数</button>
                </div>
              </>
            ) : (
              <label className={styles.fullWidth}>
                URL
                <input value={draft.url || ''} onChange={e => setDraft({ ...draft, url: e.target.value })} />
              </label>
            )}
            <VariableFields title={draft.type === 'stdio' ? '环境变量' : '认证请求头'} rows={draft.type === 'stdio' ? variables : headers} onChange={draft.type === 'stdio' ? setVariables : setHeaders} />
          </fieldset>

          <div className={styles.buttonRow}>
            <button className={styles.secondaryButton} onClick={() => setEditorOpen(false)} disabled={Boolean(busy)}>取消</button>
            <button className={styles.primaryButton} onClick={saveServer} disabled={Boolean(busy)}>
              {risk ? '确认保存配置' : '保存 Server'}
            </button>
          </div>
        </section>
      )}

      {approvalTarget && <section className={styles.editorPanel} aria-label="执行授权确认">
        <h2>允许 {approvalTarget.name} 在任务中执行？</h2>
        <p>外部程序将以当前系统用户权限运行，可能安装依赖、访问文件或联网。这不是沙箱。仅在信任来源、核对命令后授权。</p>
        <pre className={styles.commandBlock}>{[approvalTarget.command, ...(approvalTarget.args || []).map(arg => JSON.stringify(arg))].join(' ')}</pre>
        <p>环境变量：{Object.keys(approvalTarget.env || {}).join('、') || '无额外变量'}</p>
        <div className={styles.buttonRow}>
          <button className={styles.secondaryButton} onClick={() => setApprovalTarget(null)} disabled={Boolean(busy)}>取消</button>
          <button className={styles.primaryButton} onClick={() => setApproval(approvalTarget, true)} disabled={Boolean(busy)}>确认授权任务调用</button>
        </div>
      </section>}
      {testResult && <section className={styles.testResult} aria-live="polite">
        <p>{testResult}</p>
        {testTools.map(tool => <details key={tool.name}><summary>{tool.name}</summary><p>{tool.description}</p><pre className={styles.commandBlock}>{JSON.stringify(tool.inputSchema, null, 2)}</pre></details>)}
      </section>}

      {loading ? (
        <div className={styles.loading}>加载中...</div>
      ) : (
        <div className={styles.serverList}>
          {sortedServers.map(server => (
            <div key={server.id} className={styles.serverCard}>
              <div className={styles.cardLeft}>
                <div className={styles.iconBox}>
                  <Server size={24} />
                </div>
                <div className={styles.serverInfo}>
                  <div className={styles.nameRow}>
                    <h3 className={styles.serverName}>{server.name}</h3>
                    <div className={styles.statusBadge}>
                      <Wifi size={12} />
                      <span>{server.type === 'stdio' ? (server.executionApproved ? '任务调用已授权' : '待执行授权')
                        : busy === `test:${server.id}` ? '正在验证'
                        : connectionChecks[server.id]?.revision === (server.revision || 0) ? (connectionChecks[server.id].ok ? '握手已验证' : '连接验证失败') : '已保存，连接待验证'}</span>
                    </div>
                  </div>

                  <div className={styles.detailsRow}>
                    <span className={styles.typeBadge}>
                      {getTypeIcon(server.type)}
                      {server.type.toUpperCase()}
                    </span>
                    <span className={styles.codeSnippet}>
                      {server.type === 'stdio'
                        ? `${server.command || ''} ${(server.args || []).join(' ')}`
                        : server.url}
                    </span>
                  </div>
                </div>
              </div>

              <div className={styles.cardRight}>
                {server.type === 'stdio' && <button className={styles.actionButton} disabled={Boolean(busy)} onClick={() => server.executionApproved ? setApproval(server, false) : setApprovalTarget(server)}>
                  <ShieldAlert size={14} />{server.executionApproved ? '撤销授权' : '执行授权'}
                </button>}
                <button className={styles.actionButton} onClick={() => testServer(server)} disabled={Boolean(busy)}>
                  测试
                </button>
                <button className={styles.actionButton} onClick={() => openEdit(server)} disabled={Boolean(busy)}>
                  <Pencil size={14} />
                  配置
                </button>
                <button className={styles.actionButtonDanger} onClick={() => deleteServer(server.id)} disabled={Boolean(busy)}>
                  <Trash2 size={14} />
                  删除
                </button>
              </div>
            </div>
          ))}

          {servers.length === 0 && (
            <div className={styles.emptyState}>
              <Server size={48} className={styles.emptyIcon} />
              <h3>暂无 MCP Server</h3>
              <p>添加 URL 或 npm 包名后，先预览风险，再保存配置。</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function VariableFields({ title, rows, onChange }: { title: string; rows: VariableRow[]; onChange: (rows: VariableRow[]) => void }) {
  return <div className={`${styles.fullWidth} ${styles.fieldRows}`}>
    <strong>{title}</strong>
    {rows.map(([key, value], index) => <div className={styles.variableRow} key={index}>
      <input aria-label={`${title}名称 ${index + 1}`} value={key} onChange={e => onChange(rows.map((row, i) => i === index ? [e.target.value, value] : row))} placeholder="名称" />
      <input aria-label={`${title}值 ${index + 1}`} type="password" autoComplete="new-password" value={value === SAVED_SECRET ? '' : value} placeholder={value === SAVED_SECRET ? '已保存，未修改则保留' : '值'} onChange={e => onChange(rows.map((row, i) => i === index ? [key, e.target.value] : row))} />
      <button className={styles.iconButton} type="button" title="删除变量" aria-label={`删除${title} ${index + 1}`} onClick={() => onChange(rows.filter((_, i) => i !== index))}><Trash2 size={16} /></button>
    </div>)}
    <button className={styles.secondaryButton} type="button" onClick={() => onChange([...rows, ['', '']])}><Plus size={16} />添加{title}</button>
  </div>;
}
