'use client';

import { useMemo, useState } from 'react';
import { Calculator, ChevronRight, FileCheck2, LoaderCircle } from 'lucide-react';
import type { TableAnalysisReceipt } from '@tagent/core';
import type { ChatMessage } from '../lib/conversations';
import { groupLabel, matchTableSource, metricLabels, operationLabels, parseTableReceipt, receiptNeedsAttention, sourceCandidate, tableEntries, type CalculationEntry } from './TableCalculations.logic';
import styles from './TableCalculations.module.css';
import TableExport from './TableExport';
import type { TableExportContext } from '../lib/table-workbook';

export default function TableCalculations({ message, messages }: { message: ChatMessage; messages: ChatMessage[] }) {
  const [open, setOpen] = useState(false);
  const entries = useMemo(() => tableEntries(message.traces, message.run?.id), [message.traces, message.run?.id]);
  if (!entries.length) return null;
  const attention = entries.filter(entry => !entry.receipt || receiptNeedsAttention(entry.receipt)).length;
  return <details className={styles.root} data-testid="table-calculations" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className={styles.summary}><ChevronRight size={16} className={styles.chevron} aria-hidden="true" /><Calculator size={18} aria-hidden="true" />
      <span>表格计算</span><span className={styles.overview}>{entries.length} 条记录{attention > 0 ? ` · ${attention} 条需留意` : ''}</span></summary>
    {open && <div className={styles.content}>
      {message.persisted === false && <p className={styles.warning}>计算记录尚未保存，刷新可能丢失。</p>}
      <div className={styles.records}>{entries.map((entry, index) => <CalculationRecord key={entry.eventId} entry={entry} index={index}
        source={sourceCandidate(entry, message, messages)} persisted={message.persisted} running={message.isStreaming || message.run?.status === 'running'} />)}</div>
    </div>}
  </details>;
}

export function TableEventCalculation({ value, context }: { value: unknown; context: TableExportContext }) {
  const receipt = useMemo(() => parseTableReceipt(value), [value]);
  return <CalculationRecord entry={{ ...context, runId: context.runId || '', receipt }} persisted={context.persisted} running={context.running} />;
}

function CalculationRecord({ entry, index, source, persisted, running }: { entry: CalculationEntry; index?: number; source?: string; persisted?: boolean; running?: boolean }) {
  const [open, setOpen] = useState(false);
  const receipt = entry.receipt;
  if (!receipt) return <p className={styles.warning} role="status">计算记录格式不完整或版本不支持，不能展示为有效结果；原始事件保留在执行记录中。</p>;
  const p = receipt.provenance;
  return <details className={styles.record} data-calculation-action={receipt.action} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className={styles.recordSummary}><ChevronRight size={14} className={styles.chevron} aria-hidden="true" />
      <span>{index !== undefined ? `${index + 1}. ` : ''}{receipt.action === 'inspect' ? '字段检查' : '统计结果'}</span>
      <span className={styles.overview}>{p.rows} 行{receiptNeedsAttention(receipt) ? ' · 需留意' : ''}</span></summary>
    {open && <div className={styles.recordBody}>
      <p className={styles.metadata}>{p.sourceId === 'current' ? '本次用户消息' : '历史用户消息'} · 原文第 {p.startLine}–{p.endLine} 行（含表头） · {p.columns.length} 列 · {p.format.toUpperCase()}</p>
      <TableExport receipt={receipt} context={{ eventId: entry.eventId, runId: entry.runId || undefined, agentId: entry.agentId, taskId: entry.taskId, persisted, running }} />
      {receipt.action === 'inspect' ? <Inspection receipt={receipt} /> : <Aggregation receipt={receipt} />}
      {source !== undefined && <Source key={`${p.sourceSha256}:${p.selectionSha256}`} provenance={p} candidate={source} />}
      {entry.runId && source === undefined && <p className={styles.metadata}>当前视图未提供可匹配的完整用户原文。</p>}
      <details className={styles.audit}><summary>记录信息</summary><dl>
        {entry.agentId && <><dt>协作者</dt><dd>{entry.agentId}</dd></>}{entry.taskId && <><dt>子任务</dt><dd>{entry.taskId}</dd></>}
        <dt>来源</dt><dd>{p.sourceId}</dd><dt>原文指纹</dt><dd>{p.sourceSha256}</dd><dt>选区指纹</dt><dd>{p.selectionSha256}</dd>
      </dl></details>
    </div>}
  </details>;
}

function Inspection({ receipt }: { receipt: Extract<TableAnalysisReceipt, { action: 'inspect' }> }) {
  return <>
    <div className={`${styles.tableScroll} ${styles.profile}`} role="region" aria-label="字段检查表" tabIndex={0}><table>
      <caption>字段检查</caption><thead><tr><th>字段</th><th>数值</th><th>其他文本</th><th>空白</th></tr></thead>
      <tbody>{receipt.profile.map(column => <tr key={column.column}><th scope="row"><GroupName value={[column.column]} /></th>
        <td><span className={styles.compactLabel} aria-hidden="true">数值</span>{column.numeric}</td>
        <td><span className={styles.compactLabel} aria-hidden="true">其他文本</span>{column.nonNumeric}</td>
        <td><span className={styles.compactLabel} aria-hidden="true">空白</span>{column.missing}</td></tr>)}</tbody>
    </table></div>
    <p className={styles.note}>其他文本可能是名称、日期或无效数值，未自动转换。</p>
    <details className={styles.audit}><summary>数据样本</summary>
      <p className={styles.note}>前 {receipt.sample.length} 条记录，每个单元格最多显示160字符；统计使用完整选区。</p>
      <div className={styles.tableScroll} role="region" aria-label="原表样本" tabIndex={0}><table><thead><tr><th>记录</th>{receipt.provenance.columns.map(column => <th key={column}>{column}</th>)}</tr></thead>
        <tbody>{receipt.sample.map(row => <tr key={row.record}><th scope="row">{row.record}</th>{row.values.map((value, index) => <td key={index}>{value || '（空白）'}</td>)}</tr>)}</tbody></table></div>
    </details>
  </>;
}

function Aggregation({ receipt }: { receipt: Extract<TableAnalysisReceipt, { action: 'aggregate' }> }) {
  const [visible, setVisible] = useState(20);
  const c = receipt.comparison;
  const results = receipt.groups.flatMap(group => group.metrics);
  const unavailable = results.filter(metric => metric.value === null).length;
  const partial = results.filter(metric => metric.status === 'partial').length;
  const missing = results.filter(metric => metric.missing > 0).length;
  return <>
    <p className={styles.note}>{receipt.groupBy.length ? `分组：${receipt.groupBy.join(' / ')}` : '统计全部选中数据'} · 空白不计为零 · {receipt.invalidValues === 'exclude' ? '排除无效数值' : '无效数值阻止该指标计算'}</p>
    {receipt.invalidValues === 'exclude' && <p className={styles.warning}>本次选择了排除无效数值；局部结果不等于全部原始数据。</p>}
    {(unavailable > 0 || partial > 0 || missing > 0) && <p className={styles.warning} data-testid="table-quality">
      {unavailable > 0 && `${unavailable} 项分组指标未计算。`}{partial > 0 && `${partial} 项为局部结果。`}{missing > 0 && `${missing} 项含空白数据。`}
    </p>}
    <div className={`${styles.tableScroll} ${styles.statistics}`} role="region" aria-label="统计结果表" tabIndex={0}><table>
      <caption>统计结果</caption><thead><tr><th>分组 / 行数</th><th>指标</th><th>结果</th><th>数据范围</th></tr></thead>
      <tbody>{receipt.groups.slice(0, visible).flatMap((group, groupIndex) => group.metrics.map((metric, metricIndex) => <tr key={`${groupIndex}:${metricIndex}`}>
        <th scope="row" className={styles.group}><GroupName value={group.key} /><span className={styles.subtext}>{group.rows} 行</span></th>
        <td><span className={styles.compactLabel} aria-hidden="true">指标</span>{metric.column}<span className={styles.subtext}>{operationLabels[metric.operation]}</span></td>
        <td className={styles.numeric}><span className={styles.compactLabel} aria-hidden="true">结果</span><strong data-testid="table-metric-value">{metric.value === null ? '未计算' : metric.value}</strong><span className={`${styles.subtext} ${metric.status !== 'computed' ? styles.warningText : ''}`}>{metricLabels[metric.status]}</span></td>
        <td className={styles.range}><span>有效 {metric.valid}</span><span className={styles.subtext}>空白 {metric.missing} · 无效 {metric.invalid}</span>
          {metric.invalidExamples.length > 0 && <details className={styles.invalidExamples}><summary>异常样本</summary><ul>{metric.invalidExamples.map((example, index) =>
            <li key={index}>第 {example.record} 条：<code>{example.value}</code></li>)}</ul><span className={styles.subtext}>数据记录号不含表头，样本最多5条，每项最多160字符。</span></details>}
        </td>
      </tr>))}</tbody>
    </table></div>
    {receipt.groups.length > 20 && <div className={styles.pagination}><span>{Math.min(visible, receipt.groups.length)} / {receipt.groups.length} 组</span>
      {visible < receipt.groups.length && <button type="button" onClick={() => setVisible(count => count + 20)}>加载更多分组</button>}</div>}
    {c && <section className={styles.comparison} aria-label="基期与本期比较">
      <h4>{receipt.metrics[c.metric].column} · {operationLabels[receipt.metrics[c.metric].operation]}比较</h4>
      <dl><dt>基期</dt><dd><GroupName value={c.baseline} /></dd><dt>本期</dt><dd><GroupName value={c.current} /></dd>
        <dt>变化量</dt><dd>{c.difference === null ? '未计算' : c.difference}</dd><dt>变化率</dt><dd>{c.percentChange === null ? '未计算' : `${c.percentChange}%`}</dd></dl>
      {c.status === 'non_positive_baseline' && <p className={styles.warning}>基期为零或负数，不适用普通增长率。</p>}
      {c.status === 'unavailable' && <p className={styles.warning}>比较指标缺少可计算结果，未生成变化率。</p>}
      {c.partial && <p className={styles.warning}>比较涉及缺失或无效数据，不能当作完整口径结论。</p>}
    </section>}
    <p className={styles.note}>按原表单位计算，未做单位换算。非空计数包含文本；均值和变化率四舍五入到最多8位小数，其余统计保留精度。计算回执不证明数据真实或业务解释成立。</p>
  </>;
}

function GroupName({ value }: { value: string[] }) {
  const label = groupLabel(value);
  if (label.length <= 48) return <span>{label}</span>;
  return <details className={styles.longName}>
    <summary><span className={styles.namePreview}>{label}</span><span className={styles.expandLabel}>全文</span><ChevronRight size={12} className={styles.chevron} aria-hidden="true" /></summary>
    <span className={styles.fullName}>{label}</span>
  </details>;
}

function Source({ provenance, candidate }: { provenance: TableAnalysisReceipt['provenance']; candidate: string }) {
  const [pending, setPending] = useState(false);
  const [checked, setChecked] = useState<{ candidate: string; result: Awaited<ReturnType<typeof matchTableSource>> }>();
  const result = checked?.candidate === candidate ? checked.result : undefined;
  const verify = async () => {
    setPending(true);
    try { setChecked({ candidate, result: await matchTableSource(provenance, candidate) }); }
    catch { setChecked({ candidate, result: { matched: false, reason: '浏览器无法完成原文指纹核对，未标记为匹配。' } }); }
    finally { setPending(false); }
  };
  return <div className={styles.source}>
    <button type="button" onClick={() => void verify()} disabled={pending}>{pending ? <LoaderCircle size={15} aria-hidden="true" /> : <FileCheck2 size={15} aria-hidden="true" />}核对原文</button>
    {result && <><p className={result.matched ? styles.note : styles.warning} role="status">{result.reason}</p>
      {result.matched && <pre tabIndex={0} aria-label="匹配的原始表格">{result.text}</pre>}</>}
  </div>;
}
