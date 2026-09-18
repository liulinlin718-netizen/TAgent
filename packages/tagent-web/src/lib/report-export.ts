import type { ChatMessage } from './conversations';

export interface ReportExportInput {
  content: string;
  messageId: string;
  runId?: string;
  status: string;
  saved: string;
  review: string;
  details: Array<{ label: string; text: string }>;
}

export function canExportReport(message: ChatMessage): boolean {
  return message.role === 'assistant' && !!message.content.trim() && !message.isStreaming && message.run?.status !== 'running';
}

export function reportExportInput(message: ChatMessage): ReportExportInput {
  if (!canExportReport(message)) throw new Error('请等待本条回复结束后再下载。');
  const terminal = message.traces.findLast(event => event.type === 'complete'
    && (!message.run?.id || event.runId === message.run.id));
  const status = message.quote ? '分支原文引用，未经独立核验'
    : message.run?.status === 'interrupted' ? '任务中断，已有内容不等于完整交付'
      : terminal?.data.success === false ? '任务未完整完成，保留已有结果与不足说明'
        : terminal?.data.success === true ? '任务已返回结果，不代表独立质量认证'
          : '未取得可核实的任务成功记录，不据此判定交付合格';
  const details: ReportExportInput['details'] = [];
  const office = message.deliveryReview;
  const research = message.research;
  const checks: string[] = [];
  if (office) {
    checks.push(office.status === 'passed' ? '办公交付核对通过' : office.status === 'needs_revision' ? '办公交付未通过完整核对' : '办公交付尚未完成核对');
    details.push({ label: '办公核对时间', text: office.checkedAt });
    if (office.coverage) details.push({ label: '核对覆盖', text: `${office.coverage.checkedBlocks}/${office.coverage.expectedBlocks} 处内容；不代表事实已独立核实。` });
    for (const check of office.checks) details.push({ label: `${check.label}（${check.method === 'programmatic' ? '程序复核' : '模型辅助'}）`,
      text: `${({ passed: '通过', failed: '未通过', unverified: '未核对' })[check.status]}：${check.reason}` });
    for (const issue of office.issues) details.push({ label: '办公核对缺口', text: issue });
  }
  if (research) {
    checks.push(research.review?.passed ? '调研支持性检查通过' : '调研尚未通过完整支持性检查');
    details.push({ label: '调研日期', text: research.assessment.researchDate });
    if (research.assessment.windowStart) details.push({ label: '近期窗口起点', text: research.assessment.windowStart });
    for (const issue of research.assessment.issues) details.push({ label: '来源缺口', text: issue });
    for (const issue of research.review?.missingRequirements || []) details.push({ label: '调研交付缺口', text: issue });
    for (const check of research.review?.checks || []) details.push({ label: `调研结论 ${check.id}`,
      text: `${({ supported: '有原文支持', rejected: '未通过', unverified: '未核对' })[check.status]}：${check.reason}` });
    for (const source of research.sources) {
      const date = source.publication.date;
      const scope = !date ? '日期未知，不作为最新依据' : date > research.assessment.researchDate ? '晚于调研日期，待核实'
        : research.assessment.windowStart && date < research.assessment.windowStart ? '窗口外旧来源，仅作背景' : '日期位于记录窗口，内容仍需核实';
      details.push({ label: `来源 ${source.id}：${source.title}`, text: [source.url,
        `来源日期：${date || '未知'}；${({ publication_metadata: '页面元数据', url_hint: '仅 URL 线索', unknown: '依据不明' })[source.publication.basis]}；${scope}`,
        `读取日期：${source.retrievedAt}；${source.readable ? '已读取正文' : '未取得可读正文'}；${source.relevant ? '主题相关' : '主题相关性未通过'}；发布者身份不据此独立认证。`].join('\n') });
    }
  }
  if (message.quote) details.push({ label: '引用来源会话', text: `${message.quote.sourceTitle}（${message.quote.sourceSessionId}）` });
  return { content: message.content, messageId: message.id, runId: message.run?.id, status,
    saved: message.persisted === true ? '来源回复已保存' : message.persisted === false ? '来源回复尚未确认保存，下载不代表后端保存成功' : '来源保存状态未在本入口核实',
    review: checks.length ? checks.join('；') : '没有可用核对记录', details };
}
