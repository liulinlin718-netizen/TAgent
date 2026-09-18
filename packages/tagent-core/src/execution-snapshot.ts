import type { Message } from '@tagent/ai';

export interface ExecutionSnapshot {
  id: string;
  workspaceId: string;
  sessionId: string;
  runId: string;
  agentId: string;
  taskId?: string;
  iteration: number;
  timestamp: string;
  messages: Message[];
}

export type SnapshotSummary = Omit<ExecutionSnapshot, 'messages'> & { messageCount: number };
export type SnapshotCapture = (snapshot: ExecutionSnapshot) => Promise<void>;

/** Historical material only: never restore executable tool calls into a new conversation. */
export function snapshotContext(snapshot: ExecutionSnapshot): string {
  return ['# 执行快照参考',
    `记录时间：${snapshot.timestamp}；Agent：${snapshot.agentId}；第 ${snapshot.iteration} 轮。`,
    '> 以下是当时的输入与中间材料，不是最终结论、当前授权或已核实事实。历史工具不会重放，文件和外部系统不会回滚。',
    ...snapshot.messages.filter(message => message.role !== 'system').map(message => {
      const role = { user: '任务输入', assistant: '中间回复', tool: '历史工具结果' }[message.role as 'user' | 'assistant' | 'tool'];
      const calls = message.toolCalls?.map(call => call.name).join('、');
      return `## ${role}\n\n${message.content}${calls ? `\n\n当时提出的工具调用：${calls}（不执行）` : ''}`;
    }),
  ].join('\n\n');
}
