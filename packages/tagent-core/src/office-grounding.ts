import type { OfficeCheck } from './office-delivery.js';
import { officeOutputBlocks } from './office-blocks.js';

const quantity = String.raw`(?<![\d.+\-\u2212])(\d{1,9}(?:,\d{3})*(?:\.\d+)?)[ \t]*([家名位条项笔份台件所批组户个])`;
const serial = /无并行条件|不允许并行|不得并行|禁止并行|严格串行|必须串行|仅允许串行/;
const alternative = /(?:如果|假如|假设|若|未来|将来|下次|下一轮|后续变更|更改|改变|变更|改为|另一个|另一份|新一轮|示例|举例|旧计划|旧版|过去|原来|翻译|反例)/;
const serialAlternative = /(?:下次|下一轮|后续变更|另一个|另一份|新一轮|示例|举例|旧计划|旧版|过去|原来|翻译|反例|(?:确认|批准|同意|许可|授权)后)/;
const correction = /不要|不应|不必|无需|无须|不得|错误|误读|不准确|不成立|已明确|已经明确/;
const uncertainSource = /是否|能否|可能|预计|大约|约有|尚未|未确认|不确定|未知|并非|不是|取消|不再|\?|？/;

function sentences(value: string): string[] {
  // Only plain prose is checked. Quoted examples/code are not new user requirements.
  const prose = value.replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, '')
    .split('\n').filter(line => !/^\s*>/.test(line)).join('\n');
  return (prose.match(/[^。！？!?\r\n]+[！？!?]?/g) || []).map(sentence => sentence.trim()).filter(Boolean);
}

function numericValues(value: string): number[] {
  return [...value.matchAll(/(?:[-+\u2212]\s*)?\d+(?:,\d{3})*(?:\.\d+)?/g)]
    .map(match => Number(match[0].replace(/[,\s]/g, '').replace(/\u2212/g, '-')));
}

function conditionalSerialChange(statement: string): boolean {
  // A desired outcome ("if we need a shorter schedule") does not change a task constraint.
  return serialAlternative.test(statement)
    || /(?:如果|假如|假设|若|未来|将来)[^。\n]{0,36}(?:更改|改变|变更|调整|取消|放宽)[^。\n]{0,16}(?:串行|依赖|约束|条件)/.test(statement);
}

const sourceLabels = (value: string) => [...value.matchAll(/来源\s*([a-z]|[甲乙丙丁一二三四五六])/gi)].map(match => match[1].toUpperCase());
interface Subset { total: number; part: number; unit: string; quote: string; source?: string }

function explicitSubsets(input: string[]): Subset[] {
  const subsets: Subset[] = [];
  for (const sentence of input) {
    if (alternative.test(sentence) || uncertainSource.test(sentence)) continue;
    const pattern = new RegExp(`${quantity}[^\\d\\n。；;!?！？]{0,24}?[,，、]\\s*(?:其中|内含|含有)\\s*${quantity}`, 'g');
    for (const match of sentence.matchAll(pattern)) {
      const total = Number(match[1].replace(/,/g, '')), part = Number(match[3].replace(/,/g, ''));
      if (match[2] !== match[4] || part <= 0 || part >= total) continue;
      const labels = sourceLabels(sentence);
      subsets.push({ total, part, unit: match[2], quote: sentence, source: labels.length === 1 ? labels[0] : undefined });
    }
  }
  // Repeated counts across sources may describe different sets; do not guess their identity.
  return subsets.filter(item => subsets.filter(other => other.total === item.total && other.part === item.part).length === 1);
}

/** Narrow contradiction checks, not a general semantic verifier or independent fact check. */
export function inspectOfficeGrounding(task: string, output: string): OfficeCheck[] {
  const input = sentences(task), statements = sentences(output);
  const checks: OfficeCheck[] = [];
  const add = (kind: string, label: string, quote: string, statement: string, reason: string) => {
    checks.push({ id: `grounding-${kind}-${checks.length}`, method: 'programmatic', status: 'failed', label, reason,
      outputQuote: statement, evidence: [{ materialId: 'input', label: '用户提供的任务与材料', quote }] });
  };

  const serialInput = input.find(sentence => serial.test(sentence.replace(/"[^"\n]*"|'[^'\n]*'|“[^”\n]*”|‘[^’\n]*’|`[^`\n]*`/g, ''))
    && !alternative.test(sentence) && !uncertainSource.test(sentence));
  const permitsParallel = input.some(sentence => /(?<!不|未)(?:允许|可以|可)并行/.test(sentence) && !alternative.test(sentence));
  if (serialInput && !permitsParallel) {
    for (const statement of statements) {
      if (conditionalSerialChange(statement) || correction.test(statement)) continue;
      if (/(?:建议|应当|可以|可考虑|可评估|可尝试|采用|通过|改成|改为|安排|让)[^。\n]{0,32}(?:并行(?:开发|执行|处理|推进|开展)?|同时开展|同时进行)/.test(statement)) {
        add('serial-action', '建议违反已知串行约束', serialInput, statement,
          '当前任务明确要求串行，不能把并行化作为当前排期的可执行建议。保持已知依赖与工作日总数，只提出不违反原条件的方案；变更前提的替代方案必须明确另需用户许可。');
        continue;
      }
      if (/(?:是否|能否|可否|能不能|可不可以)[^。\n]{0,65}(?:并行|同时开展|同时进行)|并行[^。\n]{0,30}(?:待确认|需确认|待定|待明确)/.test(statement)) {
        add('serial', '已知条件被重复询问', serialInput, statement,
          '用户已给出串行或禁止并行的条件，这不是待补充信息。按该条件完成排期，删除重复询问；不改动仍未确定的人员或验收细节。');
      }
    }
  }

  const calendarInput = input.find(sentence => /(?:不指定|不要求|不需要|无需(?:提供|指定)?|无须(?:提供|指定)?|不要)(?:具体)?(?:日历日期|日历起算日|日期)/
    .test(sentence.replace(/"[^"\n]*"|'[^'\n]*'|“[^”\n]*”|‘[^’\n]*’|`[^`\n]*`/g, ''))
    && !alternative.test(sentence) && !uncertainSource.test(sentence));
  const requestsCalendar = input.some(sentence => /(?<!不|未|无)(?:需要|要求|请)(?:提供|指定|确定)?(?:具体)?(?:日历日期|日历起算日|日期)/.test(sentence)
    && !alternative.test(sentence) && !uncertainSource.test(sentence));
  if (calendarInput && !requestsCalendar) {
    const date = '(?:日历起算日|日历日期|具体日期|起算日|开始日期)';
    const demand = new RegExp(`(?:确定|确认|提供|补充|明确)\\s*${date}|${date}[^。\\n]{0,12}(?:未确定|未提供|待确认|待定|待明确)`);
    for (const statement of statements) {
      if (alternative.test(statement) || correction.test(statement) || !demand.test(statement)) continue;
      add('calendar', '要求了用户排除的信息', calendarInput, statement,
        '用户明确不指定日历日期，应按相对工作日交付，不把日历起算日列为阻塞条件或风险。保留真实的责任人和验收缺口；日历排期只能作为明确另行变更后的选项。');
    }
  }

  const missingDateInput = input.find(sentence => /(?:未说明|未注明|未提供|没有|缺少|无)(?:统计|截止)?(?:日期|时间|时点)|(?:日期|时间|时点)(?:未知|缺失|未提供)/.test(sentence)
    && !alternative.test(sentence));
  const quantities = new Map<string, number>();
  const hasComparableNumbers = missingDateInput && input.some(sentence => {
    for (const match of sentence.matchAll(new RegExp(quantity, 'g'))) {
      const value = Number(match[1].replace(/,/g, '')), previous = quantities.get(match[2]);
      if (previous !== undefined && previous !== value) return true;
      quantities.set(match[2], value);
    }
    return false;
  });
  if (missingDateInput && hasComparableNumbers) {
    for (const statement of statements) {
      if (alternative.test(statement) || correction.test(statement)) continue;
      const datePremise = /(?:没有|缺少|缺乏|未提供|缺失)(?:统计|明确|具体)?(?:日期|时间|时点)|(?:日期|时间|时点)(?:未知|缺失|未提供)/;
      const blanketConclusion = /(?:任何|所有|一切)(?:的)?(?:数字|数值|数量)(?:的)?(?:比较|比对|对比|计算)[^。\n]{0,8}(?:无意义|没有意义|无法进行|不能进行)|(?:无法|不能)(?:进行|完成)?任何(?:数字|数值|差额|差值)(?:的)?(?:比较|比对|计算)|(?:无法|不能)计算任何(?:差额|差值)/;
      if (datePremise.test(statement) && blanketConclusion.test(statement)) {
        add('date-comparison', '日期缺口被扩大为全部数字不可比较', missingDateInput, statement,
          '材料缺少日期限制的是时点对应及业务解释，不会自动使给定同单位数值的字面比较或算术失效。保留来源归因；差额不证明范围相同、包含关系或业务增减，也不能据此选定某份来源为真。');
      }
    }
  }

  // These checks only cover explicit risk/evidence columns, not arbitrary tables or business semantics.
  for (const block of officeOutputBlocks(output, 'table-rows-v1')) {
    if (!block.context?.tableHeader || !/^\|\s*风险\s*\|\s*材料依据\s*\|/.test(block.context.tableHeader)
      || block.text.includes('\\|')) continue;
    const cells = /^\|\s*([^|]+)\|\s*([^|]+)\|/.exec(block.text);
    if (!cells) continue;
    const label = cells[1].replace(/\*\*/g, '').trim(), basis = cells[2].trim();
    if (correction.test(label) || /是否|可能|若|假设|不等于|不代表/.test(label)) continue;
    const missingResponsibility = /(?:负责人|责任人)[^，,；;|]{0,10}(?:待定|未提供|未说明|未确定)/.test(basis);
    const assertedVacancy = /(?:责任归属|任务责任|人员配置)(?:无法落实|未落实|空缺|缺失)|(?:项目|任务)无人负责/.test(label);
    const missingAllowance = /未(?:提供|说明|提及)|仅给出/.test(basis);
    const assertedExclusion = /(?:返工|缓冲)(?:时间|工期|安排)?(?:未纳入|未计入|未含|不含|未预留)|(?:工期|排期)(?:未含|不含)(?:返工|缓冲)/.test(label);
    if (missingResponsibility && assertedVacancy || missingAllowance && assertedExclusion) {
      add('risk-label', '风险名称把未知写成已确认缺陷', task, block.text,
        '本行材料依据只说明信息未提供、岗位待定或仅给了工期，不能据此确认责任无法落实、现实无人负责或返工/缓冲被排除。风险名称、影响和建议均应保留未知范围；条件性风险不证明其触发条件已经成立。');
    }
  }

  for (const subset of explicitSubsets(input)) {
    for (const statement of statements) {
      if (alternative.test(statement) || correction.test(statement)) continue;
      const labels = sourceLabels(statement);
      if (subset.source && labels.length && !labels.includes(subset.source)) continue;
      const values = numericValues(statement);
      if (!values.includes(subset.total) || !values.includes(subset.part)) continue;
      if (!/(?:是否|有无)\s*(?:已|已经|仍|还|也|被|应当|应|已被|全部)?\s*(?:包含|包括|计入|剔除|纳入)|(?:未说明|未明确|不清楚)[^，,；;]{0,40}(?:包含|包括|计入|剔除|纳入)/.test(statement)) continue;
      add('subset', '材料已说明包含关系', subset.quote, statement,
        `给定材料用“其中/内含/含有”说明${subset.part}${subset.unit}属于${subset.total}${subset.unit}，不能再把该字面关系列为未知。保留材料归因；这不证明实际运营状态、其他来源口径或外部真实性，也不能重复相加。`);
    }
  }
  return checks;
}
