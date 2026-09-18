import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LLMProvider, LLMResponse } from '@tagent/ai';
import type { ResearchSource } from '../research-evidence.js';

const fixture = vi.hoisted(() => ({ sources: [] as ResearchSource[], queries: [] as string[], searchSessions: [] as Array<string | undefined>, searchProviders: [] as Array<string | undefined> }));
vi.mock('../trace.js', () => ({ TraceWriter: class { write() {} getPath() { return 'fixture-trace'; } } }));
vi.mock('../tools/web-research.js', async importOriginal => ({
  ...await importOriginal<typeof import('../tools/web-research.js')>(),
  createWebResearchTool: (options?: { onSources?: (sources: ResearchSource[]) => void; searchSessionId?: string; searchProvider?: string }) => ({
    definition: { name: 'web_research', description: 'Fixture research', parameters: { type: 'object' } },
    execute: async (args: Record<string, unknown>) => {
      fixture.queries.push(String(args.query));
      fixture.searchSessions.push(options?.searchSessionId);
      fixture.searchProviders.push(options?.searchProvider);
      options?.onSources?.(fixture.sources);
      return 'Research sources: ' + fixture.sources.map(source => source.url).join(' ');
    },
  }),
}));

import { formatSkillForPrompt, runOrchestrator } from '../orchestrator.js';
import { createSkillPackageDraft } from '../skills-registry.js';
import { AgentPool } from '../agent-pool.js';

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); fixture.sources = []; fixture.queries = []; fixture.searchSessions = []; fixture.searchProviders = []; });
function answer(content: string): LLMResponse {
  return { content, toolCalls: [], model: 'fixture', stopReason: 'end', usage: { inputTokens: 10, outputTokens: 5, cost: 0 } };
}
function source(url: string): ResearchSource {
  return { id: url, url, title: 'AI Agent release', query: 'AI Agent', retrievedAt: '2026-09-11',
    publication: { date: '2026-09-09', basis: 'publication_metadata' }, readable: true, relevant: true,
    excerpt: 'AI Agent release evidence', publisher: 'primary' };
}

describe('orchestrator research handoff and completion quality', () => {
  it.each([false, true])('retains the original today window through single/multi-agent completion (multi=%s)', async multi => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-15T02:00:00Z'));
    fixture.sources = [source('https://openai.com/index/a'), source('https://anthropic.com/news/b')]
      .map(item => ({ ...item, publication: { basis: 'publication_metadata', date: '2026-09-14' } }));
    const call = vi.fn<LLMProvider['call']>().mockResolvedValueOnce(answer(multi
      ? '[{"id":"r","agentRole":"research","objective":"AI Agent research","searchQuery":"AI Agent"}]' : '[]'))
      .mockResolvedValue(answer('Only yesterday evidence was available.'));
    const complete = vi.fn();
    const result = await runOrchestrator({ model: 'fixture', provider: { name: 'fixture', call, stream: async function* () {} } },
      '调研AI资讯，今天的', { onComplete: complete });
    expect(result.success).toBe(false);
    expect(result.research?.assessment).toMatchObject({ researchDate: '2026-09-15', windowStart: '2026-09-15', datedSourceCount: 0 });
    expect(fixture.queries.every(query => query.includes('2026-09-15'))).toBe(true);
    expect(fixture.queries.length).toBeGreaterThan(0);
    expect(complete).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])('merges actual request aliases across results without losing a readable source (failure first=%s)', async failureFirst => {
    const good = { ...source('https://publisher.example/report'), requestedUrls: ['https://publisher.example/old-report'] };
    const failed = { ...good, readable: false, relevant: false, excerpt: '', publication: { basis: 'unknown' as const },
      requestedUrls: ['https://short.example/report'] };
    fixture.sources = failureFirst ? [failed, good] : [good, failed];
    const call = vi.fn<LLMProvider['call']>().mockResolvedValueOnce(answer('[]')).mockResolvedValue(answer('Insufficient source coverage'));
    const snapshots: ResearchSource[][] = [];
    const result = await runOrchestrator({ model: 'fixture', provider: { name: 'fixture', call, stream: async function* () {} } },
      '调研 AI Agent 现状', { onResearchSources: sources => snapshots.push(structuredClone(sources)) });
    expect(result.research?.sources).toHaveLength(1);
    expect(result.research?.sources[0]).toMatchObject({ readable: true, excerpt: good.excerpt, publication: good.publication });
    expect([...(result.research?.sources[0].requestedUrls || [])].sort()).toEqual([...good.requestedUrls, ...failed.requestedUrls].sort());
    expect(snapshots.at(-1)?.[0].requestedUrls).toEqual(result.research?.sources[0].requestedUrls);
    expect(JSON.parse(JSON.stringify(result.research)).sources[0].requestedUrls).toHaveLength(2);
    expect(result.success).toBe(false);
  });
  it('routes required freshness research through the scoped approval handler before any search', async () => {
    const pool = new AgentPool(), agent = pool.getAgent('research-agent')!;
    agent.constraints.approvalMode = 'suggest';
    vi.spyOn(pool, 'findBestAgentForTask').mockReturnValue(agent);
    const call = vi.fn<LLMProvider['call']>().mockResolvedValueOnce(answer('[{"id":"r","agentRole":"research","objective":"AI Agent research"}]')).mockResolvedValue(answer('No approved external evidence'));
    const approvals: string[] = [];
    await runOrchestrator({ agentPool: pool, model: 'fixture', provider: { name: 'fixture', call, stream: async function* () {} } }, '调研 AI Agent 最新进展', {
      onApprovalRequest: (id, request, context) => {
        expect(fixture.queries).toEqual([]); expect(id).toBe('research-agent'); expect(context?.taskId).toBe('r');
        approvals.push(request.toolName); request.resolve(false);
      },
    });
    expect(approvals).toContain('web_research'); expect(fixture.queries).toEqual([]);
  });
  it('scopes concurrent uses of the same resident agent and their outcomes to distinct tasks', async () => {
    const pool = new AgentPool();
    vi.spyOn(pool, 'findBestAgentForTask').mockReturnValue(pool.getAgent('research-agent')!);
    const call = vi.fn<LLMProvider['call']>().mockResolvedValueOnce(answer('[{"id":"a","agentRole":"research","objective":"AI Agent releases"},{"id":"b","agentRole":"research","objective":"AI Agent tools"}]'))
      .mockResolvedValue(answer('Fixture task result'));
    const records: Array<{ agentId: string; type: string; taskId?: string }> = [];
    const result = await runOrchestrator({ agentPool: pool, model: 'fixture', provider: { name: 'fixture', call, stream: async function* () {} } }, '调研 AI Agent 最新进展', {
      onAgentProgress: (agentId, _iteration, task) => records.push({ agentId, type: 'progress', taskId: task?.taskId }),
      onAgentStage: (agentId, _stage, _summary, task) => records.push({ agentId, type: 'stage', taskId: task?.taskId }),
      onAgentToolCall: (agentId, _tool, _args, task) => records.push({ agentId, type: 'call', taskId: task?.taskId }),
      onAgentToolResult: (agentId, _tool, _length, task) => records.push({ agentId, type: 'result', taskId: task?.taskId }),
      onGovernanceEvent: (agentId, _event, task) => records.push({ agentId, type: 'governance', taskId: task?.taskId }),
      onAgentComplete: (agentId, _result, task) => records.push({ agentId, type: 'complete', taskId: task?.taskId }),
    });
    expect(records.filter(record => record.agentId !== 'orchestrator').every(record => ['a', 'b'].includes(record.taskId || ''))).toBe(true);
    for (const taskId of ['a', 'b']) {
      const types = records.filter(record => record.taskId === taskId).map(record => record.type);
      expect(types).toEqual(expect.arrayContaining(['progress', 'stage', 'call', 'result', 'governance', 'complete']));
    }
    expect(result.subResults.map(item => item.taskId).sort()).toEqual(['a', 'b']);
    expect(new Set(result.subResults.map(item => item.agentId)).size).toBe(1);
  });

  it('uses the selected card snapshot when a hall edit changes the live agent during execution', async () => {
    const pool = new AgentPool();
    const original = pool.getAgent('research-agent')!;
    const name = original.name;
    original.constraints.allowedTools = ['web_research'];
    const call = vi.fn<LLMProvider['call']>().mockResolvedValueOnce(answer('[{"id":"a","agentRole":"research","objective":"AI Agent research"}]'));
    call.mockImplementation(async params => {
      expect(params.tools?.map(tool => tool.name)).toEqual(['web_research']);
      return answer('Task result');
    });
    const result = await runOrchestrator({ agentPool: pool, model: 'fixture', provider: { name: 'fixture', call, stream: async function* () {} } }, '调研 AI Agent 最新进展', {
      onAgentSpawned: () => { original.name = 'Changed later'; original.constraints.allowedTools.splice(0, 1, 'browser_navigate'); },
    });
    expect(result.subResults[0].agentName).toBe(name);
    expect(original.name).toBe('Changed later');
  });

  it('emits a task-scoped terminal event for the single-agent fallback', async () => {
    const onAgentComplete = vi.fn();
    const call = vi.fn<LLMProvider['call']>().mockResolvedValueOnce(answer('[]')).mockResolvedValue(answer('Hello'));
    const result = await runOrchestrator({ model: 'fixture', provider: { name: 'fixture', call, stream: async function* () {} } }, '你好', { onAgentComplete });
    expect(onAgentComplete).toHaveBeenCalledTimes(1);
    expect(onAgentComplete.mock.calls[0][2]).toEqual({ taskId: 't-single' });
    expect(result.subResults[0].taskId).toBe('t-single');
  });
  it.each([true, false])('snapshots the selected search provider before planning for every subtask (explicit=%s)', async explicit => {
    vi.stubEnv('TAGENT_SEARCH_PROVIDER', explicit ? 'auto' : 'parallel');
    const call = vi.fn<LLMProvider['call']>().mockImplementationOnce(async () => {
      vi.stubEnv('TAGENT_SEARCH_PROVIDER', 'auto');
      return answer('[{"id":"r1","agentRole":"research","objective":"Research AI Agent releases"},{"id":"r2","agentRole":"research","objective":"Research AI Agent tools"}]');
    }).mockResolvedValue(answer('Insufficient fixture evidence'));
    await runOrchestrator({ model: 'fixture', ...(explicit ? { searchProvider: 'parallel' as const } : {}),
      provider: { name: 'fixture', call, stream: async function* () {} } }, '调研 AI Agent 最新进展');
    expect(fixture.searchProviders).toEqual(['parallel', 'parallel']);
  });
  it('injects migrated SOP content once and retains distinct safety/quality documents', () => {
    const pkg = createSkillPackageDraft({ name: 'Research', body: 'Unique SOP\nVerify source dates.' });
    pkg.documents.push({ id: 'policy', type: 'policy', title: 'Policy', content: 'Never install external commands.', required: true, order: 2 });
    pkg.tests = [{ name: 'source-check', input: 'task', expectedIncludes: ['URL', 'date'] }];
    const prompt = formatSkillForPrompt({ id: 'skill', name: 'Research', category: 'research', description: 'Research skill',
      body: pkg.instructions, package: pkg, createdAt: 0 });
    expect(prompt.match(/Unique SOP/g)).toHaveLength(1);
    expect(prompt).toContain('Never install external commands.');
    expect(prompt).not.toContain('source-check');
    expect(prompt).not.toContain('输出应包含 URL, date');
    expect(pkg.tests).toEqual([{ name: 'source-check', input: 'task', expectedIncludes: ['URL', 'date'] }]);
  });
  it.each([true, false])('keeps Skill test fixtures out of real task requirements without changing stored content (package=%s)', packaged => {
    const skill = { id: 'project-skill', name: '风险整理', description: '按材料整理', category: 'project', body: '说明真实风险与材料缺口。', createdAt: 0 };
    const pkg = createSkillPackageDraft(skill);
    pkg.tests = [{ name: 'isolated-test', input: '测试任务，不是用户任务', expectedIncludes: ['必须输出测试暗号'] }];
    pkg.documents.push({ id: 'test-doc', type: 'test', title: '测试脚本说明', content: '只在样例中创建虚构人员Alice', order: 2 });
    pkg.documents.push({ id: 'policy', type: 'policy', title: '权限', content: '不得发送邮件', order: 3 });
    const candidate = packaged ? { ...skill, package: pkg } : skill;
    const before = structuredClone(candidate), prompt = formatSkillForPrompt(candidate);
    expect(candidate).toEqual(before);
    expect(prompt).toContain('模板字段不是材料事实');
    expect(prompt).toContain('材料未提供/未评估');
    expect(prompt).not.toContain('必须输出测试暗号');
    expect(prompt).not.toContain('虚构人员Alice');
    expect(prompt).not.toContain('isolated-test');
    if (packaged) expect(prompt).toContain('不得发送邮件');
  });
  it('does not label truncated orchestrator synthesis successful or discard its paid-for draft', async () => {
    const call = vi.fn<LLMProvider['call']>()
      .mockResolvedValueOnce(answer('[{"id":"p","agentRole":"project","objective":"Plan"},{"id":"d","agentRole":"document","objective":"Write","dependsOn":["p"]}]'))
      .mockResolvedValueOnce(answer('Plan source material'))
      .mockResolvedValueOnce(answer('Subtask source material'))
      .mockResolvedValueOnce({ ...answer('Paid-for final draft'), stopReason: 'max_tokens' });
    const complete = vi.fn();
    const result = await runOrchestrator({ model: 'fixture', provider: { name: 'fixture', call, stream: async function* () {} } }, '整理已提供材料', { onComplete: complete });
    expect(result.success).toBe(false);
    expect(result.output).toContain('Paid-for final draft');
    expect(result.output).toContain('任务未完整完成');
    expect(complete).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledTimes(4);
  });
  it('does not promote a truncated sole worker to a successful direct deliverable', async () => {
    const call = vi.fn<LLMProvider['call']>()
      .mockResolvedValueOnce(answer('[{"id":"d","agentRole":"document","objective":"Write"}]'))
      .mockResolvedValueOnce({ ...answer('Incomplete paid-for draft'), stopReason: 'max_tokens' })
      .mockImplementationOnce(async params => {
        expect(params.messages[0].content).toContain('你是办公交付助手');
        expect(params.messages[1].content).toContain('[部分结果]');
        expect(params.messages[1].content).toContain('Incomplete paid-for draft');
        return answer('Partial result remains incomplete');
      });
    const result = await runOrchestrator({ model: 'fixture', provider: { name: 'fixture', call, stream: async function* () {} } }, '整理已提供材料');
    expect(result.success).toBe(false);
    expect(result.deliveryReview).toBeUndefined();
    expect(result.subResults[0].summary).toContain('Incomplete paid-for draft');
    expect(call).toHaveBeenCalledTimes(3);
  });
  it.each([true, false])('grounds research synthesis in the original task and sources, including a sole researcher (writer=%s)', async writer => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-11T00:00:00Z'));
    fixture.sources = [source('https://openai.com/index/a'), source('https://anthropic.com/news/b')];
    const call = vi.fn<LLMProvider['call']>();
    call.mockResolvedValueOnce(answer(JSON.stringify([
      { id: 'r', agentRole: 'research', objective: '搜集发布资料', searchQuery: 'AI Agent release' },
      ...(writer ? [{ id: 'd', agentRole: 'document', objective: '整理报告' }] : []),
    ])));
    call.mockImplementationOnce(async params => {
      expect(params.messages.at(-1)?.content).toContain('近30天 AI Agent 最新进展');
      return answer('Evidence '.repeat(400) + '\nCitation: https://openai.com/index/a');
    });
    if (writer) call.mockImplementationOnce(async params => {
      expect(params.messages.at(-1)?.content).toContain('Citation: https://openai.com/index/a');
      expect(params.messages.at(-1)?.content).toContain('publication_metadata');
      return answer('Document output');
    });
    call.mockImplementationOnce(async params => {
      expect(params.messages.at(-1)?.content).toContain('近30天 AI Agent 最新进展');
      expect(params.messages.at(-1)?.content).toContain('https://openai.com/index/a');
      expect(params.messages.at(-1)?.content).toContain('https://anthropic.com/news/b');
      expect(params.messages.at(-1)?.content).toContain(fixture.sources[0].excerpt);
      expect(params.messages.at(-1)?.content).not.toContain('Document output');
      expect(params.messages.at(-1)?.content).not.toContain('Evidence Evidence');
      return answer(JSON.stringify({ title: 'Final report', findings: [{ id: 'f1', heading: '来源报道',
        statement: '来源页面报道了 AI Agent release evidence。', timeScope: 'recent', basis: 'reported',
        evidence: [{ sourceId: fixture.sources[0].id, quote: fixture.sources[0].excerpt }] }], limitations: ['Fixture-only evidence'], unmetRequirements: [] }));
    });
    call.mockResolvedValueOnce(answer(JSON.stringify({ taskSatisfied: true, missingRequirements: [], claims: [{ id: 'f1', verdict: 'supported', kind: 'finding', reason: 'Fixture support' }] })));
    const complete = vi.fn();
    const result = await runOrchestrator({ model: 'deepseek-chat', searchSessionId: 'opaque-search-session', provider: { name: 'fixture', call, stream: async function* () {} } }, '近30天 AI Agent 最新进展', { onComplete: complete });
    expect(call).toHaveBeenCalledTimes(writer ? 5 : 4);
    expect(result.success).toBe(true);
    expect(result.research?.review?.passed).toBe(true);
    expect(fixture.queries).toHaveLength(1);
    expect(fixture.searchSessions).toEqual(['opaque-search-session']);
    expect(result.research?.assessment.status).toBe('sufficient_evidence');
    expect(result.output).toContain('来源核验记录');
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('does not report success for a confident answer with no verified research evidence', async () => {
    const call = vi.fn<LLMProvider['call']>().mockResolvedValueOnce(answer('[]')).mockResolvedValueOnce(answer('所有最新进展已核实。'));
    const result = await runOrchestrator({ model: 'fixture', provider: { name: 'fixture', call, stream: async function* () {} } }, 'AI Agent 最新资讯');
    expect(result.success).toBe(false);
    expect(result.research?.assessment.status).toBe('insufficient_evidence');
    expect(result.output).toMatch(/^> \*\*调研证据不足/);
    expect(result.output).not.toContain('所有最新进展已核实');
  });

  it('retains other agents results and restores idle state when one subtask fails', async () => {
    const pool = new AgentPool();
    const call = vi.fn<LLMProvider['call']>().mockImplementation(async params => {
      if (params.messages[0].content.includes('你是任务编排器')) return answer('[{"id":"r","agentRole":"research","objective":"FAIL"},{"id":"d","agentRole":"document","objective":"WRITE"}]');
      if (params.messages.at(-1)?.content.includes('当前子任务：FAIL')) throw new Error('provider down');
      return answer('Partial output with useful next steps');
    });
    const complete = vi.fn();
    const result = await runOrchestrator({ agentPool: pool, model: 'fixture', provider: { name: 'fixture', call, stream: async function* () {} } }, '整理现有材料', { onComplete: complete });
    expect(result.success).toBe(false);
    expect(result.output).toContain('Partial output');
    expect(complete).toHaveBeenCalledTimes(1);
    expect(pool.getAgent('research-agent')?.state.business).toBe('idle');
  });

  it.each(['error', 'empty'])('preserves completed work, sources and actual cost when final synthesis returns %s', async mode => {
    fixture.sources = [source('https://openai.com/index/a'), source('https://anthropic.com/news/b')];
    const call = vi.fn<LLMProvider['call']>();
    const charged = (content: string) => ({ ...answer(content), usage: { inputTokens: 100, outputTokens: 10, cost: 0.01 } });
    call.mockResolvedValueOnce(charged('[{"id":"r","agentRole":"research","objective":"整理来源"}]'));
    call.mockResolvedValueOnce(charged('已完成研究材料与来源 https://openai.com/index/a'));
    if (mode === 'error') call.mockRejectedValueOnce(new Error('Connection error'));
    else call.mockResolvedValueOnce(charged(''));
    const complete = vi.fn();
    const result = await runOrchestrator({ model: 'fixture', provider: { name: 'fixture', call, stream: async function* () {} } }, '调研 AI Agent 现状', { onComplete: complete });
    expect(result.success).toBe(false);
    expect(result.output).toContain('最终综合暂未成功');
    expect(result.output).toContain('已完成研究材料');
    expect(result.research?.sources[0].url).toBe('https://openai.com/index/a');
    expect(result.totalCost).toBeCloseTo(mode === 'error' ? 0.02 : 0.03);
    expect(result.totalTokens.input).toBe(mode === 'error' ? 200 : 300);
    expect(result.subResults).toHaveLength(1);
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
