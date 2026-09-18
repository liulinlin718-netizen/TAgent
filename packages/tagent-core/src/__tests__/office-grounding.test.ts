import { describe, expect, it, vi } from 'vitest';
import { CostTracker, type LLMProvider, type LLMResponse } from '@tagent/ai';
import { inspectOfficeGrounding } from '../office-grounding.js';
import { officeOutputBlocks, parseOfficeReview, verifyOfficeDelivery } from '../office-delivery.js';

const researchTask = '核对两份来源材料的矛盾，不擅自选其中一份为真。来源A：内部简报说试点覆盖240家门店，但未说明统计日期。来源B：项目台账记载2026年8月31日启用210家门店、其中30家暂停。';
const projectTask = '给出任务排期表和风险/验收标准。A需求确认2个工作日；B设计3日依赖A；C开发4日依赖B；D测试2日依赖C。第1工作日开始，无并行条件，不指定日历日期；研发负责人待定。';
const researchBad = '不能确认“30家暂停”是否计入 210。台账原文“启用210家、其中30家暂停”字面暗示包含，若成立则净运营数为 180，但这属于推断，需口径说明确认。';
const projectBad = '1. 研发负责人具体人选何时确定。\n2. 是否允许在 B/C/D 阶段存在任何并行或赶工安排（当前按“不允许”处理）。\n3. D 测试的通过标准与遗留问题处理规则由谁裁定。';

function positiveReview(task: string, output: string) {
  return JSON.stringify({ areas: ['instructions', 'material_consistency', 'arithmetic', 'deliverable', 'actions']
    .map(area => ({ area, status: 'passed', reason: '模拟核对器漏检；不能覆盖本地冲突检查' })),
  blocks: officeOutputBlocks(output).map(block => ({ index: block.index, verdict: 'grounded', reason: '模拟核对通过', evidence: [{ materialId: 'input', quote: task }] })),
  lengthLimits: [], calculations: [] });
}
const response = (content: string): LLMResponse => ({ model: 'deepseek-chat', content, toolCalls: [], stopReason: 'end',
  usage: { inputTokens: 100, outputTokens: 100, cost: .01 } });

describe('evidence-bound office contradiction checks', () => {
  it.each([
    'A无时点，B有时点（2026-08-31），两份数字不在同一时点上，无法直接做同期比较。',
    '来源A未说明统计日期，因此两份材料的时点不同。',
    '来源A日期未知，两组数据时间不一致。',
  ])('does not let missing dates establish distinct dates: %s', statement => {
    const checks = inspectOfficeGrounding(researchTask, statement);
    expect(checks).toEqual([expect.objectContaining({ id: expect.stringContaining('grounding-date-uncertainty'),
      status: 'failed', evidence: [expect.objectContaining({ quote: expect.stringContaining('未说明统计日期') })] })]);
    const review = parseOfficeReview(positiveReview(researchTask, statement), researchTask, statement,
      [{ id: 'input', label: '材料', text: researchTask }], 'fixture');
    expect(review.status).toBe('needs_revision');
  });
  it.each([
    '来源A未说明统计日期，无法确认两份数字是否在同一时点上。',
    '来源A日期未知，两份材料的时点可能不同。',
    '来源A日期未知，不能确认两份材料的时点不同。',
    '来源A日期未知，不足以证明两份数字不在同一时点上。',
    '来源A日期未知，不代表两份材料的时点不同。',
    '来源A日期未知，可能两份材料的时点不同。',
    '来源A日期未知，原句为“两份材料的时点不同”。',
    '来源A日期未知，不应据此声称两份材料的时点不同。',
    '如果两份材料的时点不同，需要另行说明；目前来源A日期未知。',
    '来源A日期未知，另有证据已确认两份材料的时点不同。',
    '> 来源A日期未知，两份材料的时点不同。',
    '```text\n来源A日期未知，两份材料的时点不同。\n```',
  ])('preserves uncertainty, independent evidence, alternatives and quoted date comparisons: %s', statement => {
    expect(inspectOfficeGrounding(researchTask, statement)).toEqual([]);
  });
  it('does not override an explicitly supplied date relationship or invent a missing date', () => {
    const statement = '来源A未说明统计日期，两份材料的时点不同。';
    expect(inspectOfficeGrounding(researchTask + '另有材料明确说明两份材料的时点不同。', statement)).toEqual([]);
    expect(inspectOfficeGrounding('来源A日期为2026-08-01；来源B日期为2026-09-01。', statement)).toEqual([]);
    const task = '来源甲记录72项，但未注明日期。来源乙记录60项，日期为2026-09-01。';
    expect(inspectOfficeGrounding(task, '来源甲未注明日期，两份数据不在同一时点。')).toHaveLength(1);
  });
  it.each([
    '| 责任归属无法落实 | 研发负责人待定；各项任务责任人未提供 | 进入实际指派阶段仍无法确定负责人 |',
    '| 返工时间未纳入排期 | 材料仅给出测试工期2日 | 测试后出现需返工的问题 |',
    '| 工期未含缓冲风险 | 材料未提及缓冲 | 出现返工 |',
  ])('does not let a positive model review turn missing evidence into a confirmed defect: %s', row => {
    const output = '| 风险 | 材料依据 | 触发条件 |\n| --- | --- | --- |\n' + row;
    const result = parseOfficeReview(positiveReview(projectTask, output), projectTask, output, [{ id: 'input', label: '材料', text: projectTask }], 'fixture');
    expect(result.status).toBe('needs_revision');
    expect(result.checks).toContainEqual(expect.objectContaining({ id: expect.stringContaining('grounding-risk-label'), outputQuote: row, status: 'failed' }));
  });
  it.each([
    '| 责任人信息未完整提供 | 研发负责人待定；其他责任人未提供 | 如执行时仍未落实具体指派 |',
    '| 返工安排未说明 | 材料仅给出测试工期2日 | 若出现返工需另估工期 |',
    '| 责任归属无法落实 | 材料明示各任务已无人负责 | 继续无人承接 |',
    '| 返工时间未纳入排期 | 材料明示不含返工 | 出现返工 |',
    '| 不应推断责任归属无法落实 | 研发负责人待定 | 需区分范围 |',
    '| 是否存在责任归属无法落实 | 责任人未提供 | 待核实 |',
    '| 责任归属无法落实\\|旧标题 | 责任人未提供 | 含转义列，交给模型核对 |',
  ])('preserves scoped unknowns, explicit defects and unsupported table syntax: %s', row => {
    expect(inspectOfficeGrounding(projectTask, '| 风险 | 材料依据 | 触发条件 |\n| --- | --- | --- |\n' + row)).toEqual([]);
  });
  it('does not interpret quotations and unrelated table columns as risk assertions', () => {
    const table = '| 风险 | 材料依据 |\n| --- | --- |\n| 责任归属无法落实 | 责任人未提供 |';
    for (const output of ['```md\n' + table + '\n```', table.split('\n').map(line => '> ' + line).join('\n'), table.replace('风险 | 材料依据', '旧标题 | 批注意见')]) {
      expect(inspectOfficeGrounding(projectTask, output)).toEqual([]);
    }
  });
  it('rejects executable parallelization advice for an explicitly serial project', () => {
    const result = inspectOfficeGrounding(projectTask, '建议设计与开发并行推进以缩短排期。');
    expect(result).toHaveLength(1); expect(result[0].label).toBe('建议违反已知串行约束');
    expect(inspectOfficeGrounding(projectTask, '若未来另行批准改变串行条件，可考虑并行开展。')).toEqual([]);
    expect(inspectOfficeGrounding(projectTask, '不要并行开展，按11个工作日串行交付。')).toEqual([]);
  });
  it.each([
    '| 缓冲安排未说明 | 材料给定“无并行条件”，未说明缓冲安排 | 是否设置缓冲需用户决策 |',
    '建议遵守无并行条件，缓冲安排未说明。',
    '建议不允许并行，按串行排期。',
    '| 建议 | 无并行条件 |',
    '| 无并行条件 | 是否设置缓冲待确认 |',
  ])('does not join unrelated cells or treat a prohibition as parallelization: %s', output => {
    expect(inspectOfficeGrounding(projectTask, output)).toEqual([]);
  });
  it('still detects actual parallelization advice in a row mentioning the original constraint', () => {
    const output = '| 原条件无并行条件 | 建议设计与开发并行推进 |';
    expect(inspectOfficeGrounding(projectTask, output)).toContainEqual(expect.objectContaining({ label: '建议违反已知串行约束' }));
  });
  it.each(['建议改为并行执行以缩短工期。', '建议更改设计与开发为并行推进。', '可以变更流程并行处理。'])('does not treat direct changes as conditional alternatives: %s', statement => {
    expect(inspectOfficeGrounding(projectTask, statement)).toEqual([expect.objectContaining({ status: 'failed', label: '建议违反已知串行约束' })]);
    expect(inspectOfficeGrounding(projectTask, '经用户批准后，另做并行方案；当前仍按串行交付。')).toEqual([]);
  });
  it.each([
    '如需调整总工期，可评估并行化或缩短单项工期，但这属于变更，需要用户决策。',
    '若要缩短工期，可以安排设计和开发并行开展。',
    '如果时间紧张，建议同时开展设计和开发。',
    '未来需要提前交付，可考虑并行执行。',
    '| R4 | 串行导致工期固定 | 如需缩短工期，可尝试并行推进 |',
  ])('does not confuse a conditional schedule goal with permission to change dependencies: %s', statement => {
    expect(inspectOfficeGrounding(projectTask, statement)).toContainEqual(expect.objectContaining({
      status: 'failed', label: '建议违反已知串行约束', outputQuote: statement.replace(/。$/, ''),
    }));
  });
  it.each([
    '若用户另行批准改变串行条件，可以在新方案中评估并行开展。',
    '如果未来变更依赖约束，是否并行需另行批准；当前按串行完成。',
    '当前不应并行开展，也不擅自缩短单项工期。',
    '下一轮是否允许并行，需在下一轮规划时决定。',
  ])('preserves explicitly separate alternatives and prohibitions: %s', statement => {
    expect(inspectOfficeGrounding(projectTask, statement)).toEqual([]);
  });
  it.each([
    '没有时点，任何数字比对都无意义。',
    '由于日期未知，所有数值比较都没有意义。',
    '缺少统计日期，因此不能计算任何差额。',
  ])('does not turn a missing source date into impossibility of arithmetic: %s', statement => {
    const checks = inspectOfficeGrounding(researchTask, statement);
    expect(checks).toEqual([expect.objectContaining({ status: 'failed', label: '日期缺口被扩大为全部数字不可比较',
      evidence: [expect.objectContaining({ quote: expect.stringContaining('未说明统计日期') })] })]);
    expect(checks[0].reason).toContain('业务解释');
    const result = parseOfficeReview(positiveReview(researchTask, statement), researchTask, statement,
      [{ id: 'input', label: '材料', text: researchTask }], 'fixture');
    expect(result.status).toBe('needs_revision');
  });
  it.each([
    '两个给定数字相差30家，但来源A缺少日期，不能确认其业务口径与时点相同。',
    '缺少统计日期，无法判断是否同一时点或确实存在业务冲突。',
    '不应声称没有时点就使任何数字比对都无意义。',
    '假设材料没有时点，任何数字比对都无意义，这是需要讨论的错误观点。',
    '> 没有时点，任何数字比对都无意义。',
    '```text\n没有时点，任何数字比对都无意义。\n```',
  ])('keeps legitimate date limitations and quotations: %s', statement => {
    expect(inspectOfficeGrounding(researchTask, statement)).toEqual([]);
  });
  it.each([
    '只有一个门店数字240家，没有统计日期。',
    '来源A覆盖240家门店，来源B有210名员工，均未说明统计日期。',
    '来源A240家，来源B210家。',
  ])('does not invent comparable dated quantities from inadequate input: %s', task => {
    expect(inspectOfficeGrounding(task, '没有时点，任何数字比对都无意义。')).toEqual([]);
  });
  it('catches the real research over-hedging and preserves the original material, not a made-up net operating count', () => {
    const checks = inspectOfficeGrounding(researchTask, researchBad);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ status: 'failed', method: 'programmatic', outputQuote: '不能确认“30家暂停”是否计入 210',
      evidence: [{ materialId: 'input', quote: expect.stringContaining('其中30家暂停') }] });
    expect(checks[0].reason).toContain('材料归因');
    expect(checks[0].reason).not.toContain('180');
  });

  it.each([
    '来源B：登记1,200份合同，其中200份到期。',
    '材料：收取1200份文件，内含200份附件。',
    '资料：1200份清单、含有200份暂停项。',
  ])('recognizes explicit part/whole relations beyond the acceptance example: %s', task => {
    expect(inspectOfficeGrounding(task, '不清楚1200份是否包含200份。')).toHaveLength(1);
  });

  it.each([
    '材料B列出210家，其中30家暂停；按原文30是210的子集。来源A的240家是否同一时点和范围，仍不能确认。',
    '原文210家中包含30家暂停，但无法独立确认这份台账是否真实。',
    '不能确认240家是否包含30家暂停；来源A未提供口径。',
    '不能确认2100家是否包含30家暂停。',
    '不能确认210家是否包含−30家暂停。',
    '来源A的210家是否包含30家暂停，不能确认。',
    '未来新的210家是否包含30家暂停，需按新台账核对。',
    '不应再问30家是否计入210，原文已说明。',
    '> 错误示例：210家是否包含30家暂停。',
    '```md\n210家是否包含30家暂停。\n```',
  ])('does not reject legitimate uncertainty or quoted/negative examples: %s', output => {
    expect(inspectOfficeGrounding(researchTask, output)).toEqual([]);
  });

  it.each([
    '若启用210家门店，其中30家暂停，给出可能分析。',
    '来源B：可能启用210家门店，其中30家暂停。',
    '来源B：并非启用210家门店，其中30家暂停。',
    '来源B：启用210家门店，另外30家暂停。',
    '来源B：涉及210名人员，其中30家暂停。',
    '来源B：启用210家门店，其中300家暂停。',
    '来源B：调整-210份合同，其中30份暂停。',
    '来源B：启用210家门店，其中-30家暂停。',
    '来源B：启用210家门店，其中30家暂停？',
    '來源B：启用210家门店，其中30家暂停。来源C：启用210家门店，其中30家暂停。',
    '> 台账记载启用210家门店，其中30家暂停。',
  ])('does not promote hypothetical, ambiguous or quoted data to certain facts: %s', task => {
    expect(inspectOfficeGrounding(task, researchBad)).toEqual([]);
  });

  it('catches the real redundant project question without treating the entire clarification list as wrong', () => {
    const checks = inspectOfficeGrounding(projectTask, projectBad);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ label: '已知条件被重复询问', outputQuote: expect.stringContaining('是否允许在 B/C/D') });
    expect(checks[0].evidence?.[0].quote).toContain('无并行条件');
  });

  it.each(['无并行条件', '不允许并行', '不得并行', '禁止并行', '严格串行', '必须串行', '仅允许串行'])('honors an explicit %s constraint', input => {
    expect(inspectOfficeGrounding(`任务${input}。`, '能否同时开展任务A与B？')).toHaveLength(1);
  });

  it.each([
    '严格串行，11个工作日。责任人待定。',
    '无需再次确认是否允许并行。',
    '如果未来变更约束，是否允许并行需另行批准。',
    '下一轮是否允许并行，尚未确定；本轮按串行交付。',
    '> 是否允许并行？',
    '~~~text\n是否允许并行？\n~~~',
  ])('permits known conditions, future changes and quotes: %s', output => {
    expect(inspectOfficeGrounding(projectTask, output)).toEqual([]);
  });

  it.each([
    '请排期，人员待定。',
    '之前的旧计划不允许并行。现在可以并行。',
    '如果不允许并行，请讨论备选方案。',
    '是否必须串行？',
    '不允许并行？',
    '不再禁止并行，请重新规划。',
    '翻译这句话：不允许并行。',
    '用户说过“无并行条件”，请分析这句话。',
    '用户说过"无并行条件"，请分析这句话。',
    '> 无并行条件。',
    '```\n无并行条件\n```',
  ])('does not invent a constraint from missing, superseded or quoted input: %s', task => {
    expect(inspectOfficeGrounding(task, projectBad)).toEqual([]);
  });

  it.each([[researchTask, researchBad], [projectTask, projectBad]])('cannot be overridden by a fully positive model review', (task, output) => {
    const result = parseOfficeReview(positiveReview(task, output), task, output, [{ id: 'input', label: '材料', text: task }], 'deepseek-chat');
    expect(result.status).toBe('needs_revision');
    expect(result.checks.some(check => check.method === 'programmatic' && check.status === 'failed')).toBe(true);
    expect(result.coverage?.checkedBlocks).toBe(officeOutputBlocks(output).length);
  });

  it.each([
    '确定日历起算日与节假日口径，以便把工作日换算为具体日期。',
    '| R5 | 起算日未确定 | 无法换算具体日期，外部协同缺少时间锚点 |',
    '待补充：具体日期尚未提供。',
    '请确认开始日期。',
  ])('does not demand calendar dates excluded by the user: %s', output => {
    const result = parseOfficeReview(positiveReview(projectTask, output), projectTask, output, [{ id: 'input', label: '材料', text: projectTask }], 'fixture');
    expect(result.status).toBe('needs_revision');
    expect(result.checks).toContainEqual(expect.objectContaining({ id: expect.stringContaining('grounding-calendar'), status: 'failed',
      evidence: [expect.objectContaining({ quote: expect.stringContaining('不指定日历日期') })] }));
  });

  it.each([
    '本轮按工作日排期，不指定日历日期。',
    '无需确定日历起算日，研发负责人待定。',
    '如果后续变更为日历排期，需确定起算日。',
    '不应把“起算日未确定”列为风险。',
    '> 请确认开始日期。',
    '```\n请确认开始日期。\n```',
  ])('allows relative-day schedules and clearly conditional future calendar plans: %s', output => {
    expect(inspectOfficeGrounding(projectTask, output)).toEqual([]);
  });

  it.each([
    '给出排期，开始时间待定。',
    '若不指定日历日期，如何排期？',
    '不指定日历日期？',
    '翻译：不指定日历日期。',
    '请分析“不指定日历日期”这一句。',
    '旧计划不指定日历日期。现在需要提供具体日期。',
    '不指定日历日期。现在需要提供具体日期。',
    '> 不指定日历日期。',
  ])('does not infer an exclusion from quoted, uncertain or superseded instructions: %s', task => {
    expect(inspectOfficeGrounding(task, '请确认开始日期。')).toEqual([]);
  });

  it('passes precise findings and only genuine project gaps through the same check', () => {
    for (const [task, output] of [
      [researchTask, '来源B原文210家中包含30家暂停，不能再相加；没有独立核验。A的240家缺日期及统计定义，不能据此判断谁对。'],
      [projectTask, '串行工期11个工作日。研发负责人待定；其余任务责任归属尚未给出。建议验收标准：各阶段产出满足下一阶段输入。'],
    ]) {
      const result = parseOfficeReview(positiveReview(task, output), task, output, [{ id: 'input', label: '材料', text: task }], 'deepseek-chat');
      expect(result.status).toBe('passed');
    }
  });
});

describe('bounded repair of known contradictions', () => {
  const materials = [{ id: 'input', label: '材料', text: projectTask }];
  const fixed = '按给定依赖严格串行，总工期11个工作日。研发负责人待定。建议各阶段产出经确认后交接。';
  const options = (call: LLMProvider['call']) => ({ provider: { name: 'fixture', call, stream: async function* () {} },
    task: projectTask, output: projectBad, materials, model: 'deepseek-chat', maxCost: 1, costTracker: new CostTracker(), qualityChecks: [] });

  it('feeds the precise conflict and source into the existing one-revision flow, retaining the original', async () => {
    const call = vi.fn<LLMProvider['call']>().mockResolvedValueOnce(response(positiveReview(projectTask, projectBad)))
      .mockResolvedValueOnce(response(fixed)).mockResolvedValueOnce(response(positiveReview(projectTask, fixed)));
    const saved: string[] = [], opts = options(call);
    const result = await verifyOfficeDelivery({ ...opts, onProgress: progress => { saved.push(progress.output); } });
    expect(call).toHaveBeenCalledTimes(3);
    expect(result.review.status).toBe('passed'); expect(result.output).toBe(fixed);
    expect(result.review.previous?.output).toBe(projectBad);
    expect(result.review.previous?.review.status).toBe('needs_revision');
    expect(saved).toContain(projectBad); expect(saved).toContain(fixed);
    expect(opts.costTracker.totalCost).toBeCloseTo(.03);
    const request = JSON.parse(call.mock.calls[0][0].messages[1].content);
    expect(request.deterministicChecks).toHaveLength(1);
    const revision = JSON.parse(call.mock.calls[1][0].messages[1].content);
    expect(revision.feedback[0].evidence[0].quote).toContain('无并行条件');
    expect(call.mock.calls.every(([params]) => !params.tools)).toBe(true);
  });

  it('does not loop or declare success if the one revision repeats the contradiction', async () => {
    const call = vi.fn<LLMProvider['call']>().mockResolvedValueOnce(response(positiveReview(projectTask, projectBad)))
      .mockResolvedValueOnce(response(projectBad)).mockResolvedValueOnce(response(positiveReview(projectTask, projectBad)));
    const result = await verifyOfficeDelivery(options(call));
    expect(result.review.status).toBe('needs_revision');
    expect(call).toHaveBeenCalledTimes(3);
  });

  it.each(['budget', 'network', 'malformed'])('retains local failure evidence even when the review is %s-limited', async mode => {
    const call = vi.fn<LLMProvider['call']>();
    if (mode === 'network') call.mockRejectedValue(new Error('private upstream failure'));
    else call.mockResolvedValue(response('{'));
    const opts = options(call);
    if (mode === 'budget') opts.maxCost = 0;
    const result = await verifyOfficeDelivery(opts);
    expect(result.output).toBe(projectBad); expect(result.review.status).toBe('unverified');
    expect(result.review.checks).toContainEqual(expect.objectContaining({ method: 'programmatic', status: 'failed' }));
    expect(call).toHaveBeenCalledTimes(mode === 'budget' ? 0 : 1);
  });
});
