import { withoutQuotes } from './text.js';
import { fail } from './errors.js';
import { LIMITS } from './limits.js';

const serial = /无并行条件|不允许并行|不得并行|禁止并行|严格串行|必须串行|仅允许串行/;
const hypothetical = /如果|假如|假设|若(?!干)|未来|将来|下次|下一轮|后续变更|另行(?:批准|变更)|示例|举例|旧计划|旧版|过去|原来|翻译|反例/;
const uncertain = /是否|能否|可能|预计|大约|约有|尚未|未确认|不确定|未知|并非|不是|取消|不再|\?|？/;
const negative = /不要|不应|不必|无需|无须|不得|不能|避免|禁止|错误|误读|不准确|不成立/;
const unitPattern = '[家名位条项笔份台件所批组户个]';
const quantity = String.raw`(?<![\w.,+\-\u2212])(\d[\d,]*)(?:[ \t]*)(${unitPattern})`;
const labels = text => [...text.matchAll(/来源\s*([a-z][a-z0-9_-]*|[甲乙丙丁一二三四五六])(?![a-z0-9_-])/gi)]
  .map(match => match[1].toUpperCase());

function skip(coverage, rule, reason) {
  if (!coverage.skipped.some(item => item.rule === rule && item.reason === reason)) coverage.skipped.push({ rule, reason });
}

// Delimiters inside quoted text and thousands separators do not create scopes.
function split(index, ref, commas = false) {
  const plain = withoutQuotes(ref.quote), parts = [];
  let start = 0;
  const append = end => {
    const raw = ref.quote.slice(start, end), left = raw.length - raw.trimStart().length, text = raw.trim();
    if (text) {
      const part = index.reference(ref.start + start + left, ref.start + start + left + text.length);
      parts.push({ ref: part, plain: withoutQuotes(part.quote) });
    }
    start = end;
  };
  for (let i = 0; i < plain.length; i++) {
    if (/[;；]/.test(plain[i]) || (commas && /[,，]/.test(plain[i]) && !(plain[i] === ',' && /\d/.test(plain[i - 1] || '') && /\d/.test(plain[i + 1] || '')))) append(i + 1);
  }
  append(plain.length);
  return parts;
}

function scopes(index, ref) {
  let inherited = false;
  return split(index, ref, true).map(part => {
    // An explicit return to the present ends an earlier conditional branch.
    if (/^(?:但|但是|不过|然而)(?:本轮|本次|当前|现在)/.test(part.plain)) inherited = false;
    const conditional = inherited;
    inherited ||= hypothetical.test(part.plain);
    return { ...part, conditional };
  });
}

function scopedOut(part, match, coverage, rule) {
  if (!part.conditional && !hypothetical.test(part.plain.slice(0, match.index + match[0].length))) return false;
  skip(coverage, rule, '候选位于条件、未来或示例范围；不把它当成当前执行约束。');
  return true;
}

function negatedMatch(text, match, after = 0) {
  const prefix = text.slice(after, match.index).split(/[,，;；:：]/).at(-1) || '';
  return /(?:不|未|别)\s*$/.test(prefix) || negative.test(prefix.slice(-18)) || negative.test(match[0]);
}

function positiveInteger(token, coverage) {
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(token)) return undefined;
  const digits = token.replace(/,/g, '');
  if (digits.length > LIMITS.integerDigits) {
    skip(coverage, 'material.subset', `数量超过 ${LIMITS.integerDigits} 位字面整数边界，未进行舍入或匹配。`);
    return undefined;
  }
  return digits.replace(/^0+(?=\d)/, '');
}
const lessThan = (a, b) => a.length < b.length || (a.length === b.length && a < b);

function counts(text, coverage) {
  const result = new Map();
  // Consume the entire malformed/decimal/signed token rather than matching its suffix.
  for (const match of text.matchAll(/(?<![\w.,+\-\u2212])((?:[-+\u2212]\s*)?\d[\d,.]*(?:[eE][+-]?\d+)?)[ \t]*([家名位条项笔份台件所批组户个人])?/g)) {
    const value = positiveInteger(match[1].replace(/^\+\s*/, ''), coverage);
    if (value === undefined) continue;
    if (!result.has(value)) result.set(value, new Set());
    result.get(value).add(match[2]);
  }
  return result;
}

function subsetRelations(materials, coverage) {
  const pairs = new Map();
  let count = 0;
  for (const material of materials) for (const sentence of material.index.sentences()) {
    const parts = scopes(material.index, sentence);
    for (const group of split(material.index, sentence)) {
      const pattern = new RegExp(`${quantity}[^\\d\\n。；;!?！？]{0,24}?[,，、]\\s*(?:其中|内含|含有)\\s*${quantity}`, 'g');
      for (const match of group.plain.matchAll(pattern)) {
        const start = group.ref.start + match.index, end = start + match[0].length;
        const touched = parts.filter(part => part.ref.end > start && part.ref.start < end);
        if (touched.some(part => part.conditional || hypothetical.test(part.plain) || uncertain.test(part.plain))) {
          skip(coverage, 'material.subset', '包含关系有条件或不确定措辞，未视为明确集合关系。');
          continue;
        }
        const total = positiveInteger(match[1], coverage), part = positiveInteger(match[3], coverage);
        if (total === undefined || part === undefined || match[2] !== match[4] || part === '0' || !lessThan(part, total)) continue;
        if (count++ >= LIMITS.subsetRelations) fail('limit_exceeded', `${material.path}/text`, 'Too many subset relations; split the material explicitly.');
        const sourceLabels = [...new Set(labels(group.plain))];
        const key = `${total}/${part}`;
        if (!pairs.has(key)) pairs.set(key, []);
        pairs.get(key).push({ total, part, unit: match[2], ref: group.ref, label: sourceLabels.length === 1 ? sourceLabels[0] : undefined });
      }
    }
  }
  return pairs;
}

export function checkGrounding(input, addFinding, coverage) {
  const required = input.requirements.index.sentences().flatMap(ref => scopes(input.requirements.index, ref));
  const sentences = input.reportIndex.sentences(), report = sentences.flatMap(ref => scopes(input.reportIndex, ref));
  coverage.proseStatements = sentences.length;
  const add = (ruleId, title, reason, evidence, ref) => addFinding({ ruleId, title, reason, evidence: [evidence], report: ref });
  const active = rule => { if (!coverage.activeRules.includes(rule)) coverage.activeRules.push(rule); };
  const requirement = (pattern, rule) => required.find(part => {
    const match = pattern.exec(part.plain);
    if (!match || scopedOut(part, match, coverage, rule)) return false;
    if (uncertain.test(part.plain)) {
      skip(coverage, rule, '约束所在子句含不确定或撤销措辞，未作为确定要求。');
      return false;
    }
    return true;
  })?.ref;
  const scan = (pattern, rule, onMatch) => {
    for (const part of report) {
      let after = 0;
      for (const match of part.plain.matchAll(pattern)) {
        if (!negatedMatch(part.plain, match, after) && !scopedOut(part, match, coverage, rule)) onMatch(part.ref);
        after = match.index + match[0].length;
      }
    }
  };

  const serialRef = requirement(serial, 'requirements.serial');
  const parallelPermission = requirement(/(?<!不|未)(?:允许|可以|可)并行/, 'requirements.serial');
  if (serialRef && parallelPermission) skip(coverage, 'requirements.serial', '材料同时包含串行与并行许可，未猜测哪条优先。');
  else if (serialRef) {
    active('requirements.serial');
    const actionRefs = new Set();
    scan(/(?:建议|应当|可以|采用|通过|改成|改为|安排|让)[^。\n]{0,32}?(?:并行(?:开发|执行|处理|推进|开展)?|同时开展|同时进行)/g, 'requirements.serial', ref => {
      actionRefs.add(ref.start);
      add('requirements.serial.parallel_action', '建议违反明确的串行约束', '材料明确要求串行；当前执行建议不能改为并行。变更前提需要另外说明和确认。', serialRef, ref);
    });
    scan(/(?:是否|能否|可否|能不能|可不可以)[^。\n]{0,65}?(?:并行|同时开展|同时进行)|并行[^。\n]{0,30}?(?:待确认|需确认|待定|待明确)/g, 'requirements.serial', ref => {
      if (!actionRefs.has(ref.start)) add('requirements.serial.redundant_question', '已知串行条件被当成未知', '按明确串行条件完成排期，不再要求确认是否可以并行。未给出的负责人等信息仍可列为缺口。', serialRef, ref);
    });
  }

  const calendarRef = requirement(/(?:不指定|不要求|不需要|无需(?:提供|指定)?|无须(?:提供|指定)?|不要)(?:具体)?(?:日历日期|日历起算日|日期)/, 'requirements.calendar');
  const requestsCalendar = requirement(/(?<!不|未|无)(?:需要|要求|请)(?:提供|指定|确定)?(?:具体)?(?:日历日期|日历起算日|日期)/, 'requirements.calendar');
  if (calendarRef && requestsCalendar) skip(coverage, 'requirements.calendar', '材料同时要求和排除日历日期，未猜测哪条优先。');
  else if (calendarRef) {
    active('requirements.calendar');
    const date = '(?:日历起算日|日历日期|具体日期|起算日|开始日期)';
    scan(new RegExp(`(?:确定|确认|提供|补充|明确)\\s*${date}|${date}[^。\\n]{0,12}?(?:未确定|未提供|待确认|待定|待明确)`, 'g'), 'requirements.calendar', ref =>
      add('requirements.calendar.excluded', '报告要求了任务已排除的信息', '任务排除了日历日期，应保留相对工作日排期，不把日历起算日当作阻塞条件。', calendarRef, ref));
  }

  const relations = subsetRelations([input.requirements, ...input.materials], coverage);
  if (!relations.size) return;
  active('material.subset');
  for (const sentence of sentences) {
    const parts = scopes(input.reportIndex, sentence);
    for (const group of split(input.reportIndex, sentence)) {
      const questionPattern = /(?:是否|有无)\s*(?:已|已经|仍|还|也|被|应当|应|已被|全部)?\s*(?:包含|包括|计入|剔除|纳入)|(?:未说明|未明确|不清楚)[^，,；;]{0,40}?(?:包含|包括|计入|剔除|纳入)/g;
      const questions = [...group.plain.matchAll(questionPattern)].filter(match => {
        const at = group.ref.start + match.index;
        const owner = parts.find(part => part.ref.start <= at && part.ref.end > at);
        const local = { index: at - owner.ref.start, 0: match[0] };
        return !negatedMatch(group.plain.replace(/不能确认/g, '尚未确认'), match) && !scopedOut(owner, local, coverage, 'material.subset');
      });
      if (!questions.length) continue;
      const numbers = counts(group.ref.quote, coverage), sourceLabels = [...new Set(labels(group.plain))];
      for (const candidates of relations.values()) {
        const { total, part } = candidates[0];
        if (!numbers.has(total) || !numbers.has(part)) continue;
        const matches = candidates.filter(relation => [total, part].every(value => numbers.get(value).has(undefined) || numbers.get(value).has(relation.unit))
          && (!sourceLabels.length || (sourceLabels.length === 1 && relation.label === sourceLabels[0])));
        if (matches.length !== 1) {
          if (matches.length > 1 || sourceLabels.length > 1) skip(coverage, 'material.subset', '同一组数字的单位和来源仍不足以唯一绑定材料，未将不同集合视为同一个集合。');
          continue;
        }
        const relation = matches[0];
        add('material.subset.already_explicit', '材料已明确字面包含关系',
          `给定材料明确${part}${relation.unit}属于${total}${relation.unit}，不再把这个字面关系列为未知。不推导实际运营数量、不核实材料真伪，也不将不同来源口径混为一谈。`, relation.ref, group.ref);
      }
    }
  }
}
