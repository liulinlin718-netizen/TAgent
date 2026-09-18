'use client';

import { ArrowUpRight, ChartColumn, FileText, ListChecks, Mail, Presentation, Search } from 'lucide-react';
import { OFFICE_TASKS, type OfficeTask } from '../lib/task-brief';
import { recentWorkspaceTasks } from '../lib/workspace-activity';
import type { ConversationEntry, Workspace } from '../lib/conversations';
import styles from './TaskWorkbench.module.css';

export const TASK_ICONS = { research: Search, document: FileText, data: ChartColumn, project: ListChecks, communication: Mail, presentation: Presentation };

export default function TaskWorkbench({ workspace, entries, disabled, onPrepare, onSelect }: {
  workspace?: Workspace; entries: Record<string, ConversationEntry>; disabled: boolean;
  onPrepare: (task: OfficeTask, trigger: HTMLElement) => void; onSelect: (sessionId: string) => void;
}) {
  const recent = workspace ? recentWorkspaceTasks(workspace.id, workspace.sessions, entries) : [];
  return <div className={styles.workbench}>
    <header className={styles.heading}><h1>TAgent 办公任务</h1><span role="status" aria-label="尚未开始任务">尚未开始任务</span></header>
    <section aria-labelledby="prepare-task-title" className={styles.section}>
      <h2 id="prepare-task-title">准备任务</h2>
      <div className={styles.taskGrid}>
        {OFFICE_TASKS.map(task => {
          const Icon = TASK_ICONS[task.id];
          return <button type="button" className={styles.taskChoice} key={task.id} data-task={task.id} disabled={disabled}
            aria-label={`准备${task.title}`} onClick={event => onPrepare(task, event.currentTarget)}>
            <Icon size={22} aria-hidden="true" /><span><strong>{task.title}</strong><small>{task.agent}</small></span><ArrowUpRight size={17} aria-hidden="true" />
          </button>;
        })}
      </div>
    </section>
    <section aria-labelledby="recent-task-title" className={styles.section}>
      <h2 id="recent-task-title">近期对话</h2>
      {recent.length ? <ul className={styles.recent}>
        {recent.map(({ session, activity, time }) => <li key={session.id}>
          <button type="button" className={styles.recentRow} onClick={() => onSelect(session.id)} aria-label={`继续对话：${session.title}`}>
            <FileText size={18} aria-hidden="true" /><span className={styles.sessionTitle}>{session.title}</span>
            <span className={styles.activity} data-tone={activity.tone}>{activity.label}</span>
            <time dateTime={time ? new Date(time).toISOString() : undefined}>{time ? new Date(time).toLocaleDateString('zh-CN') : '日期未知'}</time>
            <ArrowUpRight size={16} aria-hidden="true" />
          </button>
        </li>)}
      </ul> : <p className={styles.empty}>当前工作空间暂无对话。</p>}
    </section>
  </div>;
}
