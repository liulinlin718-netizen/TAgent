/**
 * Protocol & MessageBus — 单元测试 (D11)
 *
 * 覆盖: 6 种消息类型 + MessageBus 的 subscribe/send/history
 */

import { describe, it, expect, vi } from 'vitest';
import { MessageBus, type AgentMessage } from '../protocol.js';

describe('MessageBus', () => {
  // ─── createMessage ───────────────────────────────
  describe('createMessage', () => {
    it('should create a message with required fields', () => {
      const msg = MessageBus.createMessage('TaskRequest', 'agent-a', 'agent-b', { taskId: 't1', objective: 'test' });
      expect(msg.type).toBe('TaskRequest');
      expect(msg.fromAgent).toBe('agent-a');
      expect(msg.toAgent).toBe('agent-b');
      expect(msg.id).toMatch(/^msg-/);
      expect(msg.timestamp).toBeTruthy();
      expect(msg.payload).toEqual({ taskId: 't1', objective: 'test' });
    });

    it('should create unique IDs for each message', () => {
      const m1 = MessageBus.createMessage('TaskRequest', 'a', 'b', {});
      const m2 = MessageBus.createMessage('TaskRequest', 'a', 'b', {});
      expect(m1.id).not.toBe(m2.id);
    });
  });

  // ─── subscribe / send ────────────────────────────
  describe('subscribe + send', () => {
    it('should deliver message to subscribed agent', () => {
      const bus = new MessageBus();
      const handler = vi.fn();
      bus.subscribe('agent-b', handler);

      const msg = MessageBus.createMessage('TaskRequest', 'agent-a', 'agent-b', { taskId: 't1', objective: 'go' });
      bus.send(msg);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(msg);
    });

    it('should NOT deliver to unrelated agents', () => {
      const bus = new MessageBus();
      const handler = vi.fn();
      bus.subscribe('agent-c', handler);

      const msg = MessageBus.createMessage('TaskRequest', 'agent-a', 'agent-b', { taskId: 't1', objective: 'go' });
      bus.send(msg);

      expect(handler).toHaveBeenCalledTimes(0);
    });

    it('should support unsubscribe', () => {
      const bus = new MessageBus();
      const handler = vi.fn();
      const unsub = bus.subscribe('agent-b', handler);

      unsub();
      const msg = MessageBus.createMessage('TaskRequest', 'agent-a', 'agent-b', { taskId: 't1', objective: 'go' });
      bus.send(msg);

      expect(handler).toHaveBeenCalledTimes(0);
    });
  });

  // ─── subscribeAll ────────────────────────────────
  describe('subscribeAll', () => {
    it('should receive all messages regardless of target', () => {
      const bus = new MessageBus();
      const handler = vi.fn();
      bus.subscribeAll(handler);

      bus.send(MessageBus.createMessage('TaskRequest', 'a', 'b', {}));
      bus.send(MessageBus.createMessage('TaskComplete', 'b', 'a', {}));

      expect(handler).toHaveBeenCalledTimes(2);
    });
  });

  // ─── history ─────────────────────────────────────
  describe('getHistory', () => {
    it('should return all messages when no agentId given', () => {
      const bus = new MessageBus();
      bus.send(MessageBus.createMessage('TaskRequest', 'a', 'b', {}));
      bus.send(MessageBus.createMessage('TaskComplete', 'b', 'a', {}));

      expect(bus.getHistory()).toHaveLength(2);
    });

    it('should filter by agent when agentId given', () => {
      const bus = new MessageBus();
      bus.send(MessageBus.createMessage('TaskRequest', 'a', 'b', {}));
      bus.send(MessageBus.createMessage('TaskComplete', 'b', 'a', {}));
      bus.send(MessageBus.createMessage('GovernanceEvent', 'gov', 'c', {}));

      const historyA = bus.getHistory('a');
      expect(historyA).toHaveLength(2); // a sent to b, b sent to a
      const historyC = bus.getHistory('c');
      expect(historyC).toHaveLength(1);
    });
  });

  // ─── All 6 message types ─────────────────────────
  describe('message types', () => {
    const types = ['TaskRequest', 'TaskProgress', 'TaskComplete', 'TaskFailed', 'GovernanceEvent', 'HumanInputRequest'] as const;
    types.forEach(type => {
      it(`should handle ${type} message type`, () => {
        const bus = new MessageBus();
        const handler = vi.fn();
        bus.subscribe('target', handler);
        const msg = MessageBus.createMessage(type, 'source', 'target', { test: true });
        bus.send(msg);
        expect(handler).toHaveBeenCalledWith(expect.objectContaining({ type }));
      });
    });
  });
});
