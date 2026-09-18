import { ChevronRight, ClipboardCheck } from 'lucide-react';
import type { OfficeCheck, OfficeDeliveryReview, OfficeReviewReceipt } from '@tagent/core';
import Markdown from './Markdown';
import styles from './ResearchReview.module.css';

const labels = { passed: '通过', failed: '未通过', unverified: '未核对' };

export default function DeliveryReview({ review }: { review: OfficeDeliveryReview }) {
  const status = review.status === 'passed' ? '办公交付核对通过' : review.status === 'needs_revision' ? '办公交付未通过完整核对' : '办公交付尚未完成核对';
  const visible = [...review.checks].sort((a, b) => Number(a.status === 'passed') - Number(b.status === 'passed'));
  return <details className={styles.root} data-testid="delivery-review">
    <summary className={styles.summary}>
      <ChevronRight className={styles.chevron} size={16} aria-hidden="true" />
      <ClipboardCheck size={18} aria-hidden="true" />
      <span>{status}</span>
      <span className={styles.overview}>{review.checks.length > 0
        ? `${review.checks.filter(check => check.status === 'passed').length}/${review.checks.length} 项`
        : '暂无检查结果'}</span>
    </summary>
    <div className={styles.content}>
      <p className={styles.notice}>程序检查长度与已登记算式，模型辅助检查材料和交付要求；不等于独立事实核查，未登记的约束与计算仍可能遗漏。</p>
      <p className={styles.metadata}>{review.materialCount} 份输入/工具材料 · {review.model}{review.previous ? ' · 已修订一次' : ''}</p>
      {review.coverage && <p className={styles.metadata}>核对覆盖 {review.coverage.checkedBlocks}/{review.coverage.expectedBlocks} 处内容；字段与原文匹配不等于事实或质量通过。</p>}
      {review.issues.length > 0 && <ul className={styles.issues}>{review.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>}
      <div className={styles.checks}>{visible.map(check => <Check key={check.id} check={check} />)}</div>
      {review.receipt && <Receipt receipt={review.receipt} title="核对模型回执" />}
      {review.revisionAttempt && <Receipt receipt={review.revisionAttempt} title="修订模型回执" />}
      {review.previous && <details className={styles.history}>
        <summary>上一次核对与保留原稿</summary>
        <ul className={styles.issues}>{review.previous.review.checks.filter(check => check.status !== 'passed').map(check => <li key={check.id}>{check.label}：{check.reason}</li>)}</ul>
        {review.previous.review.issues.length > 0 && <ul className={styles.issues}>{review.previous.review.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>}
        <Markdown content={review.previous.output} />
        {review.previous.review.receipt && <Receipt receipt={review.previous.review.receipt} title="上一次核对模型回执" />}
        {review.previous.review.revisionAttempt && <Receipt receipt={review.previous.review.revisionAttempt} title="修订模型回执" />}
      </details>}
    </div>
  </details>;
}

function Receipt({ receipt, title }: { receipt: OfficeReviewReceipt; title: string }) {
  const stop = receipt.stopReason && ({ end: '正常结束', max_tokens: '输出达到长度限制', tool_use: '返回工具请求', unknown: '结束原因不明' })[receipt.stopReason];
  return <details className={styles.history}>
    <summary>{title}</summary>
    {receipt.status === 'pending' && <p className={styles.notice}>该请求未保存完整返回，实际执行结果未知；不会自动重试。</p>}
    <p className={styles.metadata}>输入 {receipt.inputCharacters} 字符 · 输出上限 {receipt.maxOutputTokens} tokens{stop ? ` · ${stop}` : ''}</p>
    {receipt.usage && <p className={styles.metadata}>本次调用：输入 {receipt.usage.inputTokens} / 输出 {receipt.usage.outputTokens} tokens · 已知费用 ${receipt.usage.cost.toFixed(6)}</p>}
    {receipt.unsettledRequests > 0 && <p className={styles.notice}>未收到完整用量，不代表免费；请核对模型供应商账单。</p>}
    {receipt.error && <p className={styles.notice}>{receipt.error}</p>}
    {receipt.rawOutput !== undefined && <>
      <p className={styles.metadata}>模型原始返回，保留供回查，不代表核对通过。{receipt.rawOutputTruncated ? '仅保留前24000字，已明确截断。' : ''}</p>
      <pre className={styles.rawReceipt}>{receipt.rawOutput || '（空返回）'}</pre>
    </>}
  </details>;
}

function Check({ check }: { check: OfficeCheck }) {
  return <details className={styles.check} data-review-status={check.status}>
    <summary className={styles.checkSummary}>
      <ChevronRight className={styles.chevron} size={14} aria-hidden="true" />
      <span className={styles.heading}>{check.label}</span>
      <span className={styles.status} data-status={check.status === 'failed' ? 'rejected' : check.status === 'passed' ? 'supported' : 'unverified'}>{labels[check.status]}</span>
    </summary>
    <div className={styles.checkBody}>
      <p className={styles.metadata}>{check.method === 'programmatic' ? '程序复核' : '模型辅助判断'}</p>
      <p className={styles.reason}>{check.reason}</p>
      {check.outputQuote && <blockquote>{check.outputQuote}</blockquote>}
      {check.evidence?.map((reference, index) => <div className={styles.citation} key={index}>
        <h4>{reference.label}</h4><blockquote>{reference.quote}</blockquote>
      </div>)}
    </div>
  </details>;
}
