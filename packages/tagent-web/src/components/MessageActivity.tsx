'use client';

import { useMemo, useState } from 'react';
import { Activity, ChevronDown } from 'lucide-react';
import { runPresentation, toWorkflowEvent } from '../app/WorkflowDrawer.logic';
import type { ChatMessage } from '../lib/conversations';
import styles from './MessageActivity.module.css';
import TraceHistory from './TraceHistory';

export default function MessageActivity({ message, workspaceId, sessionId }: { message: ChatMessage; workspaceId?: string; sessionId?: string }) {
  const [open, setOpen] = useState(false);
  const events = useMemo(() => message.traces.map(toWorkflowEvent), [message.traces]);
  const presentation = runPresentation(events, !!message.isStreaming);
  const runId = message.run?.id || message.traces[0]?.runId;
  const canQuery = workspaceId && sessionId && runId && !message.isStreaming && message.persisted !== false
    && message.traces.every(event => event.eventId && event.runId === runId && event.sessionId === sessionId);
  return <details className={styles.activity} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className={styles.summary}>
      <Activity size={16} aria-hidden="true" />
      <span className={styles.label}>{presentation.active ? '任务进度' : '执行记录'}</span>
      <span className={styles.state}>{presentation.label}</span>
      <span className={styles.count}>{events.length} 条</span>
      <ChevronDown size={16} className={styles.chevron} aria-hidden="true" />
    </summary>
    {open && canQuery ? <TraceHistory key={`${workspaceId}:${sessionId}:${runId}`} scope={{ workspaceId, sessionId, runId }} /> : open && <ol className={styles.events} tabIndex={0} aria-label="任务执行记录">
      {events.map(event => <li key={event.eventId} className={styles.event}>
        <span className={styles.dot} data-status={event.status} aria-hidden="true" />
        <span>{event.summary}</span>
      </li>)}
    </ol>}
  </details>;
}
