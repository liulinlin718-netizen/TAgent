import { describe, expect, it } from 'vitest';
import { Store, type ChatMessage } from '../store.js';

describe('session encoding regression', () => {
  it('preserves mixed Chinese, emoji, and ASCII content across session reads', async () => {
    const store = new Store();
    const workspace = await store.createWorkspace('编码回归工作区', 'UTF-8 smoke test');
    const session = await store.createSession(workspace.id, '初始标题');
    expect(session).toBeTruthy();

    const userContent = '调研近 30 天 AI Agent 最新进展 🚀 / Docker? Kubernetes? $0.01';
    const assistantContent = '## 调研结果\n\n- 中文正常\n- emoji 正常 ✅\n- URL: https://example.com/report';
    const userMessage: ChatMessage = {
      id: 'msg-user-encoding',
      role: 'user',
      content: userContent,
      timestamp: new Date('2026-06-18T00:00:00.000Z').toISOString(),
    };
    const assistantMessage: ChatMessage = {
      id: 'msg-assistant-encoding',
      role: 'assistant',
      content: assistantContent,
      timestamp: new Date('2026-06-18T00:00:01.000Z').toISOString(),
    };

    await store.addMessage(workspace.id, session!.id, userMessage);
    await store.addMessage(workspace.id, session!.id, assistantMessage);

    const reloaded = store.getSession(workspace.id, session!.id);
    const messages = store.getMessages(workspace.id, session!.id);

    expect(reloaded?.title).toBe(`${Array.from(userContent).slice(0, 30).join('')}...`);
    expect(messages.map(message => message.content)).toEqual([userContent, assistantContent]);
    expect(JSON.stringify(reloaded)).not.toContain('�');
  });
});
