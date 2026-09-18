import { conversationKey, runIsActive, type ConversationEntry, type Session } from './conversations';

export function taskActivity(session: Session, local?: ConversationEntry) {
  const messages = local?.messages.length ? local.messages : session.messages;
  if (runIsActive(local?.run) && !local!.run!.clientId.startsWith('remote:')) return { label: local!.run!.phase === 'stopping' ? '正在停止' : '运行中', tone: 'active' } as const;
  if (local?.error || local?.run?.persisted === false || messages.some(message => message.persisted === false && !message.isStreaming)) return { label: '需核对', tone: 'warning' } as const;
  if (messages.some(message => message.run?.status === 'running')) return { label: '状态待核对', tone: 'warning' } as const;
  const reply = messages.findLast(message => message.role === 'assistant');
  if (reply?.run?.status === 'interrupted') return { label: '已中断', tone: 'warning' } as const;
  if (reply?.content) return { label: '已有回复', tone: 'neutral' } as const;
  return { label: messages.length ? '待回复' : '待开始', tone: 'neutral' } as const;
}

export function recentWorkspaceTasks(workspaceId: string, sessions: Session[], entries: Record<string, ConversationEntry>) {
  return sessions.map((session, order) => ({ session, order, activity: taskActivity(session, entries[conversationKey(workspaceId, session.id)]),
    time: Number.isFinite(Date.parse(session.updatedAt)) ? Date.parse(session.updatedAt) : 0 }))
    .sort((a, b) => Number(b.activity.tone === 'active') - Number(a.activity.tone === 'active') || b.time - a.time || a.order - b.order)
    .slice(0, 6);
}
