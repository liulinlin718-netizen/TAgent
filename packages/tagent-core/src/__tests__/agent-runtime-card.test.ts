import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LLMProvider, LLMResponse } from '@tagent/ai';
import type { MCPRegistry } from '../mcp-registry.js';
import { AgentPool } from '../agent-pool.js';
import { createSkillPackageDraft, type Skill, type SkillsRegistry } from '../skills-registry.js';

const bridge = vi.hoisted(() => ({ execute: vi.fn(async () => '已授权的办公材料') }));
vi.mock('../trace.js', () => ({ TraceWriter: class { write() {} getPath() { return 'fixture'; } } }));
vi.mock('../tools/browser.js', () => ({ createBrowserToolSession: () => ({ tools: [], close: async () => {} }) }));
vi.mock('../tools/mcp-bridge.js', () => ({ createMCPBridgeTool: () => ({
  definition: { name: 'mcp_office', description: 'Local fixture only', parameters: { type: 'object' } }, execute: bridge.execute,
}) }));
import { runOrchestrator } from '../orchestrator.js';
import { OFFICE_MATERIAL_BOUNDARY } from '../office-delivery.js';

const reply = (content: string): LLMResponse => ({ content, toolCalls: [], model: 'fixture', stopReason: 'end',
  usage: { inputTokens: 10, outputTokens: 5, cost: 0 } });
const provider = (call: LLMProvider['call']): LLMProvider => ({ name: 'fixture', call, stream: async function* () {} });
afterEach(() => { vi.restoreAllMocks(); bridge.execute.mockClear(); });

describe('configured office agent execution', () => {
  it.each(['fallback', 'single', 'multiple', 'separate-review'])('keeps evidence scope through drafting, synthesis, review and one revision (%s)', async mode => {
    const pool = new AgentPool(), agent = pool.getAgent('project-agent')!;
    agent.constraints.allowedTools = [];
    vi.spyOn(pool, 'findBestAgentForTask').mockReturnValue(agent);
    const input = '仅根据材料整理责任缺口和行动建议。采购审批负责人待定；材料未说明设计和测试的责任人。';
    const draft = '所有阶段均无人负责，必须任命采购负责人后才能开始任何工作。';
    const corrected = '采购审批负责人待定；设计和测试责任人材料未提供，不能据此判断现实无人负责。建议分别确认职责归属。';
    let reviews = 0, revisions = 0, drafts = 0, syntheses = 0;
    const tasks = [{ id: 'p', agentRole: 'project', objective: '整理责任缺口' },
      ...(mode === 'multiple' ? [{ id: 'd', agentRole: 'document', objective: '整理行动建议', dependsOn: ['p'] }] : [])];
    const call = vi.fn<LLMProvider['call']>().mockResolvedValueOnce(reply(mode === 'fallback' ? '[]' : JSON.stringify(tasks)))
      .mockImplementation(async params => {
        const system = params.messages[0].content;
        expect(system).toContain(OFFICE_MATERIAL_BOUNDARY);
        expect(system).toContain('风险只写有材料依据的条件性影响');
        expect(system).toContain('任务责任人没有提供时只写“材料未提供”');
        expect(system).toContain('不虚构返工时点');
        expect(params.tools?.length ?? 0).toBe(0);
        if (params.purpose === 'verification') {
          reviews++;
          const payload = JSON.parse(params.messages[1].content);
          expect(payload.task).toBe(input);
          const failed = payload.blocks.some((block: { text: string }) => block.text.includes('所有阶段均无人负责'));
          return reply(JSON.stringify({ areas: ['instructions', 'material_consistency', 'arithmetic', 'deliverable', 'actions'].map(area =>
            ({ area, status: failed && area === 'material_consistency' ? 'failed' : 'passed', reason: failed ? '局部待定被扩大为全部缺人和开工前提' : '保留原材料范围' })),
            blocks: payload.blocks.map((block: { index: number }) => ({ index: block.index, verdict: failed ? 'unsupported' : 'grounded',
              reason: failed ? '材料仅指出采购审批负责人待定，不支持全部岗位空缺' : '材料归属与建议分开', evidence: [{ materialId: 'input', quote: input }] })),
            lengthLimits: [], calculations: [] }));
        }
        if (system.startsWith('你是办公交付修订器')) {
          revisions++;
          const payload = JSON.parse(params.messages[1].content);
          expect(payload.task).toBe(input);
          expect(payload.originalOutput).toBe(draft);
          expect(payload.feedback.some((item: { outputQuote?: string }) => item.outputQuote === draft)).toBe(true);
          return reply(corrected);
        }
        if (system.startsWith('你是办公交付助手')) syntheses++; else drafts++;
        return reply(draft);
      });
    const officeReview = { model: 'deepseek-v4-pro', reasoning: 'low' as const };
    const result = await runOrchestrator({ provider: { ...provider(call), name: mode === 'separate-review' ? 'deepseek' : 'fixture' },
      model: 'deepseek-chat', agentPool: pool, ...(mode === 'separate-review' ? { officeReview } : {}) }, input, {
      onAgentSpawned: () => { officeReview.model = 'unpriced-changed-during-run'; },
    });
    expect(result.output).toBe(corrected);
    expect(result.deliveryReview?.previous?.output).toBe(draft);
    expect(result.deliveryReview?.previous?.review.status).toBe('needs_revision');
    expect(result.deliveryReview?.status).toBe('passed');
    expect({ reviews, revisions, drafts, syntheses }).toEqual({ reviews: 2, revisions: 1,
      drafts: mode === 'multiple' ? 2 : 1, syntheses: mode === 'multiple' ? 1 : 0 });
    expect(agent.constraints.allowedTools).toEqual([]);
    for (const [params] of call.mock.calls) {
      const verifying = params.purpose === 'verification' || params.messages[0].content.startsWith('你是办公交付修订器');
      expect(params.model).toBe(mode === 'separate-review' && verifying ? 'deepseek-v4-pro' : 'deepseek-chat');
      if (mode === 'separate-review' && verifying) expect(params.reasoning).toBe('low');
      else expect(params.reasoning).not.toBe('low');
    }
    expect(result.deliveryReview?.model).toBe(mode === 'separate-review' ? 'deepseek-v4-pro' : 'deepseek-chat');
  });

  it.each([true, false])('passes bound Skill checks into verification and honors failed results (single=%s)', async single => {
    const pool = new AgentPool(), agent = pool.getAgent('document-agent')!;
    agent.capabilities.skills = ['office-qa'];
    vi.spyOn(pool, 'findBestAgentForTask').mockReturnValue(agent);
    const skill: Skill = { id: 'office-qa', name: '交付清单', description: '材料整理复核', category: 'office', body: '整理已提供材料', createdAt: 1 };
    skill.package = createSkillPackageDraft(skill);
    skill.package.documents.push({ id: 'check', type: 'checklist', title: '质量要求', content: '负责人缺失时明确标注待定。', order: 1 });
    skill.package.documents.push({ id: 'example', type: 'example', title: '示例', content: '无关示例不得成为强制输出', order: 2 });
    const registry = { getSkill: vi.fn(async () => skill) } as unknown as SkillsRegistry;
    let reviews = 0;
    const call = vi.fn<LLMProvider['call']>().mockResolvedValueOnce(reply(single ? '[]' : '[{"id":"d","agentRole":"document","objective":"整理材料"}]'))
      .mockImplementation(async params => {
        if (params.purpose !== 'verification') return reply('未说明负责人的报告原稿');
        reviews++;
        const input = JSON.parse(params.messages[1].content);
        expect(input.qualityChecks).toContain('交付清单（仅在适用当前任务时）：负责人缺失时明确标注待定。');
        expect(input.qualityChecks.join()).not.toContain('无关示例不得成为强制输出');
        return reply(JSON.stringify({ areas: ['instructions', 'material_consistency', 'arithmetic', 'deliverable', 'actions'].map(area =>
          ({ area, status: area === 'deliverable' ? 'failed' : 'passed', reason: area === 'deliverable' ? '已绑定清单要求负责人缺失时标注待定，本稿遗漏' : '模拟检查' })),
          blocks: input.blocks.map((block: { index: number }) => ({ index: block.index, verdict: 'non_factual', reason: '模拟内容', evidence: [] })),
          lengthLimits: [], calculations: [] }));
      });
    const result = await runOrchestrator({ provider: provider(call), model: 'deepseek-chat', agentPool: pool, skillsRegistry: registry }, '整理已有材料，遵循已绑定的交付清单');
    expect(reviews).toBe(2); expect(result.success).toBe(false); expect(result.deliveryReview?.status).toBe('needs_revision');
    expect(result.deliveryReview?.previous?.output).toBe('未说明负责人的报告原稿');
  });

  it.each([true, false])('retains the completed report when cancelled during verification (single=%s)', async single => {
    const pool = new AgentPool(), controller = new AbortController();
    const call = vi.fn<LLMProvider['call']>().mockResolvedValueOnce(reply(single ? '[]' : '[{"id":"d","agentRole":"document","objective":"整理材料"}]'))
      .mockResolvedValue(reply('已完成的报告原稿，不得丢弃。'));
    const result = await runOrchestrator({ provider: provider(call), model: 'deepseek-chat', agentPool: pool, signal: controller.signal }, '整理已有材料', {
      onAgentStage: (id, stage) => { if (id === 'orchestrator' && stage === 'verify') controller.abort(); },
    });
    expect(result.success).toBe(false); expect(result.termination).toBe('cancelled');
    expect(result.output).toContain('已完成的报告原稿，不得丢弃。');
    expect(result.subResults).toHaveLength(1);
    expect(result.deliveryReview).toMatchObject({ status: 'unverified', checks: [], receipt: { status: 'request_failed' } });
    expect(result.deliveryReview?.issues.join()).toContain('任务已中断');
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('keeps the complete single-agent deliverable and review lifecycle without a second drafting call', async () => {
    const pool = new AgentPool();
    pool.getAgent('document-agent')!.constraints.allowedTools = [];
    const output = Array.from({ length: 24 }, () => '离线流程合成样例。'.repeat(65)).join('\n\n') + '\n\n完整正文末尾';
    const timeline: string[] = [];
    const call = vi.fn<LLMProvider['call']>().mockResolvedValueOnce(reply('[{"id":"d","agentRole":"document","objective":"整理已有样例"}]'))
      .mockImplementation(async params => {
        if (params.purpose === 'verification') {
          timeline.push('review');
          const input = JSON.parse(params.messages[1].content);
          expect(input.blocks.at(-1).text).toContain('完整正文末尾');
          return reply(JSON.stringify({ areas: ['instructions', 'material_consistency', 'arithmetic', 'deliverable', 'actions'].map(area =>
            ({ area, status: 'passed', reason: '模拟检查，只验证完整正文传递' })),
            blocks: input.blocks.map((block: { index: number }) => ({ index: block.index, verdict: 'non_factual', reason: '合成样例', evidence: [] })),
            lengthLimits: [], calculations: [] }));
        }
        expect(params.messages[0].content).toContain('本任务由你完成整份交付物');
        expect(params.tools || []).toEqual([]);
        return reply(output);
      });
    const persist = vi.fn(), done = vi.fn(), delta = vi.fn();
    const result = await runOrchestrator({ provider: provider(call), model: 'deepseek-chat', agentPool: pool,
      persistOfficeDelivery: persist }, '整理已有样例，不联网', {
      onSynthesisStart: () => timeline.push('synthesis'),
      onTextDelta: delta,
      onComplete: result => { timeline.push('complete'); done(result); },
    });
    expect(output.length).toBeGreaterThan(12000);
    expect(result.output).toBe(output);
    expect(result.subResults[0].summary).toHaveLength(12000);
    expect(result.deliveryReview?.status).toBe('passed');
    expect(result.success).toBe(true);
    expect(persist.mock.calls.at(-1)?.[0]).toMatchObject({ output, review: { status: 'passed' } });
    expect(delta).toHaveBeenCalledWith(output);
    expect(done).toHaveBeenCalledExactlyOnceWith(result);
    expect(timeline).toEqual(['synthesis', 'review', 'complete']);
    expect(call).toHaveBeenCalledTimes(3);
  });

  it('preserves a direct deliverable as unverified when review fails, without retry or redrafting', async () => {
    const call = vi.fn<LLMProvider['call']>()
      .mockResolvedValueOnce(reply('[{"id":"d","agentRole":"document","objective":"整理已有材料"}]'))
      .mockResolvedValueOnce(reply('已完成的直接交付稿'))
      .mockRejectedValueOnce(new Error('Review connection failed'));
    const result = await runOrchestrator({ provider: provider(call), model: 'deepseek-chat' }, '整理已有材料');
    expect(result.output).toBe('已完成的直接交付稿');
    expect(result.deliveryReview).toMatchObject({ status: 'unverified', receipt: { status: 'request_failed' } });
    expect(result.success).toBe(false);
    expect(call.mock.calls[2][0].purpose).toBe('verification');
    expect(call).toHaveBeenCalledTimes(3);
  });

  it.each(['synthesis', 'delta'])('retains the full paid-for direct draft if cancelled at %s before verification', async stage => {
    const controller = new AbortController();
    const output = '已完成的合成报告。'.repeat(1500) + '完整报告的末尾';
    const call = vi.fn<LLMProvider['call']>()
      .mockResolvedValueOnce(reply('[{"id":"d","agentRole":"document","objective":"整理已有材料"}]'))
      .mockResolvedValueOnce(reply(output));
    const done = vi.fn();
    const result = await runOrchestrator({ provider: provider(call), model: 'deepseek-chat', signal: controller.signal }, '整理已有材料', {
      onSynthesisStart: () => { if (stage === 'synthesis') controller.abort(); },
      onTextDelta: () => { if (stage === 'delta') controller.abort(); },
      onComplete: done,
    });
    expect(result.success).toBe(false);
    expect(result.termination).toBe('cancelled');
    expect(result.output).toContain(output);
    expect(result.output).toContain('尚未完成核对');
    expect(result.deliveryReview).toBeUndefined();
    expect(done).toHaveBeenCalledExactlyOnceWith(result);
    expect(call).toHaveBeenCalledTimes(2);
  });
  it.each(['research', 'document', 'data', 'project', 'communication', 'presentation'])('uses the selected %s card rather than the built-in soul', async role => {
    const pool = new AgentPool(), card = pool.getAgent(`${role}-agent`)!;
    card.card.soul = `${role} 用户保存的角色设定`;
    card.card.boundaries = ['不得虚构本公司业绩'];
    card.card.qualityChecks = ['必须注明输入缺口'];
    card.card.outputStandards = ['保留用户指定的交付格式'];
    const call = vi.fn<LLMProvider['call']>()
      .mockResolvedValueOnce(reply(JSON.stringify([{ id: 'office', agentRole: role, objective: '整理已给出的输入' }])))
      .mockImplementation(async params => {
        if (params.purpose !== 'verification') return reply('已提供材料的整理结果');
        const { blocks, qualityChecks } = JSON.parse(params.messages[1].content);
        expect(qualityChecks).toContain('必须注明输入缺口');
        return reply(JSON.stringify({ areas: ['instructions', 'material_consistency', 'arithmetic', 'deliverable', 'actions'].map(area =>
          ({ area, status: 'passed', reason: '模拟核对，仅验证运行配置传递' })),
          blocks: blocks.map((block: { index: number }) => ({ index: block.index, verdict: 'grounded', reason: '模拟材料',
            evidence: [{ materialId: 'input', quote: '整理已提供材料' }] })), lengthLimits: [], calculations: [] }));
      });
    const spawned = vi.fn();
    const result = await runOrchestrator({ provider: provider(call), model: 'deepseek-chat', agentPool: pool }, '整理已提供材料', {
      onAgentSpawned: (agent, task) => { spawned(agent.id, task.id); card.card.soul = '运行之后才修改的设定'; },
    });
    expect(result.success).toBe(true);
    expect(result.deliveryReview?.status).toBe('passed');
    expect(spawned).toHaveBeenCalledWith(`${role}-agent`, 'office');
    const prompt = call.mock.calls[1]![0].messages[0]!.content;
    expect(prompt).toContain(`${role} 用户保存的角色设定`);
    expect(prompt).not.toContain('运行之后才修改的设定');
    expect(prompt).toContain('不得虚构本公司业绩');
    expect(prompt).toContain('必须注明输入缺口');
    expect(prompt).toContain('保留用户指定的交付格式');
    expect(prompt).toContain('不得把已知条件列为待确认');
    expect(prompt).toContain('不因缺少外部核实就改称材料未说明');
    expect(prompt).toContain('口径是否一致未知，不可改写为无可比口径');
    expect(prompt).toContain('职位名称不自动授予项目整体职责');
    expect(prompt).toContain('未说明缓冲不等于未含缓冲');
    expect(prompt).toContain('观测指标变化不证明方案导致改善');
    expect(prompt).toContain('建议在对应句就近标明');
  });

  it.each([true, false])('uses the selected single-agent card and its MCP whitelist (allowed=%s)', async allowed => {
    const pool = new AgentPool(), agent = pool.getAgent('communication-agent')!;
    agent.card.soul = '只交付主题和邮件正文，不代替用户发送';
    agent.capabilities.mcpServers = ['office'];
    agent.constraints.allowedTools = allowed ? ['mcp_office'] : [];
    vi.spyOn(pool, 'findBestAgentForTask').mockReturnValue(agent);
    const mcp = { getServer: vi.fn(async () => ({ id: 'office', name: 'office', type: 'http', url: 'https://example.com/mcp' })) } as unknown as MCPRegistry;
    const call = vi.fn<LLMProvider['call']>().mockResolvedValueOnce(reply('[]'));
    let attempted = false;
    call.mockImplementation(async params => {
      expect(params.messages[0]!.content).toContain(agent.card.soul);
      expect(params.tools?.map(tool => tool.name)).toEqual(allowed ? ['mcp_office'] : []);
      if (!attempted) { attempted = true; return { ...reply(''), stopReason: 'tool_use',
        toolCalls: [{ id: 'office-call', name: 'mcp_office', arguments: '{"method":"tools/call"}' }] }; }
      const toolResult = [...params.messages].reverse().find(message => message.role === 'tool')?.content;
      expect(toolResult).toContain(allowed ? '已授权的办公材料' : '白名单');
      return reply('主题：材料确认\n\n您好，请确认附件中的事项。');
    });
    const result = await runOrchestrator({ provider: provider(call), model: 'fixture', agentPool: pool, mcpRegistry: mcp }, '根据已有材料写一封确认邮件');
    expect(result.subResults[0]?.agentId).toBe(agent.id);
    expect(bridge.execute).toHaveBeenCalledTimes(allowed ? 1 : 0);
    expect(pool.getAgent(agent.id)?.state.business).toBe('idle');
  });

  it('keeps a qualified resident available across runs, and busy until every owned execution finishes', () => {
    const pool = new AgentPool();
    const releaseA = pool.beginExecution('document-agent');
    const releaseB = pool.beginExecution('document-agent');
    expect(pool.findBestAgentForTask('document', '整理已给出的文档')?.id).toBe('document-agent');
    releaseA(); releaseA();
    expect(pool.getAgent('document-agent')?.state.business).toBe('busy');
    releaseB();
    expect(pool.getAgent('document-agent')?.state.business).toBe('idle');
  });

  it.each([true, false])('tracks overlapping orchestrator runs using the same resident (single=%s)', async single => {
    const pool = new AgentPool(), agent = pool.getAgent('document-agent')!;
    vi.spyOn(pool, 'findBestAgentForTask').mockReturnValue(agent);
    const plan = single ? '[]' : '[{"id":"d","agentRole":"document","objective":"整理材料"}]';
    let finishA!: (value: LLMResponse) => void, finishB!: (value: LLMResponse) => void;
    const callA = vi.fn<LLMProvider['call']>().mockResolvedValueOnce(reply(plan))
      .mockImplementationOnce(() => new Promise(resolve => { finishA = resolve; })).mockResolvedValue(reply('A完整结果'));
    const callB = vi.fn<LLMProvider['call']>().mockResolvedValueOnce(reply(plan))
      .mockImplementationOnce(() => new Promise(resolve => { finishB = resolve; })).mockResolvedValue(reply('B完整结果'));
    const a = runOrchestrator({ provider: provider(callA), model: 'fixture', agentPool: pool }, '整理材料A');
    const b = runOrchestrator({ provider: provider(callB), model: 'fixture', agentPool: pool }, '整理材料B');
    await vi.waitFor(() => { expect(finishA).toBeTypeOf('function'); expect(finishB).toBeTypeOf('function'); });
    finishA(reply('A材料')); await a;
    expect(pool.getAgent(agent.id)?.state.business).toBe('busy');
    finishB(reply('B材料')); await b;
    expect(pool.getAgent(agent.id)?.state.business).toBe('idle');
  });

  it.each([true, false])('releases the resident when a lifecycle observer fails (single=%s)', async single => {
    const pool = new AgentPool(), agent = pool.getAgent('document-agent')!;
    vi.spyOn(pool, 'findBestAgentForTask').mockReturnValue(agent);
    const call = vi.fn<LLMProvider['call']>().mockResolvedValue(reply(single ? '[]' : '[{"id":"d","agentRole":"document","objective":"整理材料"}]'));
    await runOrchestrator({ provider: provider(call), model: 'fixture', agentPool: pool }, '整理材料', {
      onAgentSpawned: () => { throw new Error('Fixture observer failed'); },
    }).catch(() => {});
    expect(pool.getAgent(agent.id)?.state.business).toBe('idle');
  });

  it('does not select a stopped resident or grant a child tools denied by its parent', () => {
    const pool = new AgentPool(), parent = pool.getAgent('research-agent')!;
    parent.constraints.allowedTools = [];
    parent.card.runtimeProfile.verifier = ['父 Agent 特有检查'];
    const child = pool.spawnTaskAgent(parent.id, { name: '材料核对', objective: '核对已有材料', createdReason: '独立核对' });
    expect(child.constraints.allowedTools).toEqual([]);
    expect(child.card.runtimeProfile).toEqual(parent.card.runtimeProfile);
    child.card.runtimeProfile.verifier.push('子 Agent 检查');
    expect(parent.card.runtimeProfile.verifier).toEqual(['父 Agent 特有检查']);
    pool.updateState('document-agent', { runtime: 'stopped' });
    expect(pool.findBestAgentForTask('document', '整理文档')?.id).not.toBe('document-agent');
  });
});
