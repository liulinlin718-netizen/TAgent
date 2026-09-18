import { sentences, withoutQuotes } from './text.js';

const serial = /无并行条件|不允许并行|不得并行|禁止并行|严格串行|必须串行|仅允许串行/;
const hypothetical = /如果|假如|假设|若|未来|将来|下次|下一轮|后续变更|另行(?:批准|变更)|示例|举例|旧计划|旧版|过去|原来|翻译|反例/;
const uncertain = /是否|能否|可能|预计|大约|约有|尚未|未确认|不确定|未知|并非|不是|取消|不再|\?|？/;
const negative = /不要|不应|不必|无需|无须|不得|不能|避免|禁止|错误|误读|不准确|不成立/;
const quantity = String.raw`(?<![\d.,+\-\u2212])(\d{1,9}(?:,\d{3})*)(?:[ \t]*)([家名位条项笔份台件所批组户个])`;
const labels = value => [...value.matchAll(/来源\s*([a-z]|[甲乙丙丁一二三四五六])/gi)].map(match => match[1].toUpperCase());
const counts = value => [...value.matchAll(/((?:[-+\u2212]\s*)?\d+(?:,\d{3})*(?:\.\d+)?)[ \t]*([家名位条项笔份台件所批组户个人])?/g)]
  .map(match => ({ value: Number(match[1].replace(/[,\s]/g, '').replace(/\u2212/g, '-')), unit: match[2] }));
const definite = text => !hypothetical.test(text) && !uncertain.test(text);

function negatedMatch(statement, match) {
  const clause = statement.slice(0, match.index).split(/[,，;；:：]/).at(-1) || '';
  return /(?:不|未|别)\s*$/.test(clause) || negative.test(clause.slice(-18)) || negative.test(match[0]);
}

function subsetRelations(materials) {
  const relations = [];
  for (const material of materials) for (const ref of sentences(material.text, material.id)) {
    if (!definite(ref.quote)) continue;
    const plain = withoutQuotes(ref.quote);
    const pattern = new RegExp(`${quantity}[^\\d\\n。；;!?！？]{0,24}?[,，、]\\s*(?:其中|内含|含有)\\s*${quantity}`, 'g');
    for (const match of plain.matchAll(pattern)) {
      const total = Number(match[1].replace(/,/g, '')), part = Number(match[3].replace(/,/g, ''));
      if (match[2] !== match[4] || part <= 0 || part >= total) continue;
      const sourceLabels = labels(plain);
      if (relations.length >= 200) throw new TypeError('Too many subset relations; split the material explicitly.');
      relations.push({ total, part, unit: match[2], ref, label: sourceLabels.length === 1 ? sourceLabels[0] : undefined });
    }
  }
  return relations;
}

export function checkGrounding(input, findings, coverage) {
  const required = sentences(input.requirements.text, input.requirements.id), report = sentences(input.report);
  coverage.proseStatements = report.length;
  const add = (ruleId, title, reason, evidence, statement) => {
    if (findings.length >= 2000) throw new TypeError('Too many findings; split the input explicitly.');
    findings.push({ ruleId, title, reason, evidence: [evidence], report: statement });
  };
  const active = rule => { if (!coverage.activeRules.includes(rule)) coverage.activeRules.push(rule); };

  const serialRef = required.find(ref => definite(withoutQuotes(ref.quote)) && serial.test(withoutQuotes(ref.quote)));
  const parallelPermission = required.some(ref => definite(withoutQuotes(ref.quote)) && /(?<!不|未)(?:允许|可以|可)并行/.test(withoutQuotes(ref.quote)));
  if (serialRef && parallelPermission) coverage.skipped.push({ rule: 'requirements.serial', reason: '材料同时包含串行与并行许可，未猜测哪条优先。' });
  else if (serialRef) {
    active('requirements.serial');
    for (const ref of report) {
      if (hypothetical.test(ref.quote)) continue;
      const action = /(?:建议|应当|可以|采用|通过|改成|改为|安排|让)[^。\n]{0,32}(?:并行(?:开发|执行|处理|推进|开展)?|同时开展|同时进行)/.exec(ref.quote);
      if (action && !negatedMatch(ref.quote, action)) {
        add('requirements.serial.parallel_action', '建议违反明确的串行约束', '材料明确要求串行；当前执行建议不能改为并行。变更前提需要另外说明和确认。', serialRef, ref);
        continue;
      }
      const question = /(?:是否|能否|可否|能不能|可不可以)[^。\n]{0,65}(?:并行|同时开展|同时进行)|并行[^。\n]{0,30}(?:待确认|需确认|待定|待明确)/.exec(ref.quote);
      if (question && !negatedMatch(ref.quote, question))
        add('requirements.serial.redundant_question', '已知串行条件被当成未知', '按明确串行条件完成排期，不再要求确认是否可以并行。未给出的负责人等信息仍可列为缺口。', serialRef, ref);
    }
  }

  const excludesCalendar = /(?:不指定|不要求|不需要|无需(?:提供|指定)?|无须(?:提供|指定)?|不要)(?:具体)?(?:日历日期|日历起算日|日期)/;
  const calendarRef = required.find(ref => definite(withoutQuotes(ref.quote)) && excludesCalendar.test(withoutQuotes(ref.quote)));
  const requestsCalendar = required.some(ref => definite(withoutQuotes(ref.quote)) && /(?<!不|未|无)(?:需要|要求|请)(?:提供|指定|确定)?(?:具体)?(?:日历日期|日历起算日|日期)/.test(withoutQuotes(ref.quote)));
  if (calendarRef && requestsCalendar) coverage.skipped.push({ rule: 'requirements.calendar', reason: '材料同时要求和排除日历日期，未猜测哪条优先。' });
  else if (calendarRef) {
    active('requirements.calendar');
    for (const ref of report) {
      if (hypothetical.test(ref.quote)) continue;
      const date = '(?:日历起算日|日历日期|具体日期|起算日|开始日期)';
      const demand = new RegExp(`(?:确定|确认|提供|补充|明确)\\s*${date}|${date}[^。\\n]{0,12}(?:未确定|未提供|待确认|待定|待明确)`).exec(ref.quote);
      if (demand && !negatedMatch(ref.quote, demand))
        add('requirements.calendar.excluded', '报告要求了任务已排除的信息', '任务排除了日历日期，应保留相对工作日排期，不把日历起算日当作阻塞条件。', calendarRef, ref);
    }
  }

  const relations = subsetRelations([input.requirements, ...input.materials]);
  for (const relation of relations) {
    if (relations.filter(other => other.total === relation.total && other.part === relation.part).length !== 1) {
      if (!coverage.skipped.some(item => item.rule === 'material.subset'))
        coverage.skipped.push({ rule: 'material.subset', reason: '同一组数字在多处出现，未将不同来源的集合视为同一个集合。' });
      continue;
    }
    active('material.subset');
    for (const ref of report) {
      if (hypothetical.test(ref.quote)) continue;
      const sourceLabels = labels(ref.quote);
      if (relation.label && sourceLabels.length && !sourceLabels.includes(relation.label)) continue;
      const nums = counts(ref.quote), matches = value => nums.some(item => item.value === value && (!item.unit || item.unit === relation.unit));
      if (!matches(relation.total) || !matches(relation.part)) continue;
      const question = /(?:是否|有无)\s*(?:已|已经|仍|还|也|被|应当|应|已被|全部)?\s*(?:包含|包括|计入|剔除|纳入)|(?:未说明|未明确|不清楚)[^，,；;]{0,40}(?:包含|包括|计入|剔除|纳入)/.exec(ref.quote);
      if (!question || negatedMatch(ref.quote.replace(/不能确认/g, '尚未确认'), question)) continue;
      add('material.subset.already_explicit', '材料已明确字面包含关系',
        `给定材料明确${relation.part}${relation.unit}属于${relation.total}${relation.unit}，不再把这个字面关系列为未知。不推导实际运营数量、不核实材料真伪，也不将不同来源口径混为一谈。`, relation.ref, ref);
    }
  }
}
