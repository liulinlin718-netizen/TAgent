import { ChevronRight, FileSearch, ExternalLink } from 'lucide-react';
import { evidenceUrl, researchReviewItems, type ResearchRecord } from './ResearchReview.logic';
import styles from './ResearchReview.module.css';

const labels = { supported: '支持', rejected: '未通过', unverified: '未核对' };

export default function ResearchReview({ research }: { research: ResearchRecord }) {
  const items = researchReviewItems(research);
  const supported = items.filter(item => item.status === 'supported').length;
  const review = research.review;
  const issues = [...new Set([...research.assessment.issues, ...(review?.missingRequirements || [])])];
  return (
    <details className={styles.root} data-testid="research-review">
      <summary className={styles.summary}>
        <ChevronRight className={styles.chevron} size={16} aria-hidden="true" />
        <FileSearch size={18} aria-hidden="true" />
        <span>来源与核对</span>
        <span className={styles.overview}>{review ? `${supported}/${items.length} 条支持` : '尚无结论核对'} · {research.sources.length} 个来源</span>
      </summary>
      <div className={styles.content}>
        <p className={styles.notice}>{review?.passed ? '支持性核对通过' : '未通过完整交付核验'}。模型辅助核对不等于独立事实核查。</p>
        <p className={styles.metadata}>调研日期：{research.assessment.researchDate}{research.assessment.windowStart ? ` · 时间窗口：${research.assessment.windowStart} 至 ${research.assessment.researchDate}` : ''}</p>
        {issues.length > 0 && <ul className={styles.issues}>{issues.map(issue => <li key={issue}>{issue}</li>)}</ul>}
        <div className={styles.checks}>
          {items.map(item => <details key={item.id} className={styles.check} data-review-status={item.status}>
            <summary className={styles.checkSummary}>
              <ChevronRight className={styles.chevron} size={14} aria-hidden="true" />
              <span className={styles.heading}>{item.heading}</span>
              <span className={styles.status} data-status={item.status}>{labels[item.status]}</span>
            </summary>
            <div className={styles.checkBody}>
              <p className={styles.reason}>{item.reason}</p>
              {item.statement && <><h4>{item.statementLabel}</h4><p>{item.statement}</p></>}
              {item.citations.map((citation, index) => <div key={index} className={styles.citation}>
                <h4>{citation.matched ? '匹配的原文片段' : '草稿引用（未匹配原文）'}</h4>
                <blockquote>{citation.quote}</blockquote>
                <p>{citation.source ? <SourceLink title={citation.source.title} url={citation.source.url} /> : '本次没有该来源记录'}</p>
                {citation.source && <p className={styles.metadata}>
                  发布日期：{citation.source.publication.basis === 'publication_metadata' && citation.source.publication.date || '未核实'}
                  {' · '}{citation.source.relevant ? '主题匹配' : '主题相关性未通过'}
                </p>}
              </div>)}
              {!item.citations.length && <p className={styles.metadata}>未保存该条目的原文引用。</p>}
            </div>
          </details>)}
        </div>
        {review?.previousReview && <details className={styles.history}>
          <summary>上一次核对记录</summary>
          <ul className={styles.issues}>{review.previousReview.checks.map(check => <li key={check.id}>{check.id} · {labels[check.status]}：{check.reason}</li>)}
            {review.previousReview.missingRequirements.map((reason, index) => <li key={`missing-${index}`}>{reason}</li>)}
          </ul>
        </details>}
        <details className={styles.history}>
          <summary>全部来源（{research.sources.length}）</summary>
          <ul className={styles.sources}>{research.sources.map(source => <li key={source.id}>
            <SourceLink title={source.title} url={source.url} />
            <p className={styles.metadata}>发布日期：{source.publication.basis === 'publication_metadata' && source.publication.date || '未核实'} · 读取时间：{source.retrievedAt}</p>
            <p className={styles.metadata}>{source.readable ? '正文已读取' : '未取得可读正文'} · {source.relevant ? '主题匹配' : '主题相关性未通过'} · {source.publisher === 'primary' ? '已识别域名，具体事实仍需核查' : '发布者身份未独立核实'}</p>
            {source.publication.metadataMatch && <p className={styles.metadata}>日期匹配方式：同站内容别名，标题与可见正文一致。</p>}
          </li>)}</ul>
        </details>
      </div>
    </details>
  );
}

function SourceLink({ title, url }: { title: string; url: string }) {
  const href = evidenceUrl(url);
  return href ? <a href={href} target="_blank" rel="noopener noreferrer">{title || href} <ExternalLink size={12} aria-hidden="true" /><span className={styles.sourceUrl}>{href}</span></a> : <span>{title || '无可用来源链接'}</span>;
}
