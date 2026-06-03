/**
 * SessionDiffView — 分支对比视图 (plan §3.9)
 *
 * 左右分栏展示父 Session 与当前分支 Session 的消息差异。
 * 共同消息不高亮，分支独有消息用颜色区分。
 */

'use client';

import { useEffect, useState } from 'react';
import styles from './SessionDiffView.module.css';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
}

interface SessionDiffViewProps {
  parentSessionId: string;
  branchSessionId: string;
  workspaceId: string;
  onClose: () => void;
}

const API = 'http://localhost:3001';

export default function SessionDiffView({ parentSessionId, branchSessionId, workspaceId, onClose }: SessionDiffViewProps) {
  const [parentMessages, setParentMessages] = useState<ChatMessage[]>([]);
  const [branchMessages, setBranchMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const [pRes, bRes] = await Promise.all([
        fetch(`${API}/api/workspaces/${workspaceId}/sessions/${parentSessionId}/messages`),
        fetch(`${API}/api/workspaces/${workspaceId}/sessions/${branchSessionId}/messages`),
      ]);
      const pData = await pRes.json();
      const bData = await bRes.json();
      setParentMessages(pData.messages || []);
      setBranchMessages(bData.messages || []);
      setLoading(false);
    }
    load();
  }, [parentSessionId, branchSessionId, workspaceId]);

  // 找到分叉点：共同前缀消息数
  const commonCount = (() => {
    let i = 0;
    while (i < parentMessages.length && i < branchMessages.length) {
      if (parentMessages[i].content !== branchMessages[i].content) break;
      i++;
    }
    return i;
  })();

  if (loading) {
    return (
      <div className={styles.overlay}>
        <div className={styles.panel}>
          <div className={styles.loading}>加载对比数据...</div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.overlay}>
      <div className={styles.panel}>
        <div className={styles.diffHeader}>
          <h2 className={styles.diffTitle}>📊 分支对比视图</h2>
          <span className={styles.diffMeta}>共同消息: {commonCount} 条 · 分叉后各有 {parentMessages.length - commonCount} / {branchMessages.length - commonCount} 条独立消息</span>
          <button className={styles.closeBtn} onClick={onClose}>✕</button>
        </div>

        <div className={styles.diffBody}>
          {/* 左列：父 Session */}
          <div className={styles.column}>
            <div className={styles.columnHeader}>
              <span className={styles.columnIcon}>🟢</span>
              主线 Session
            </div>
            <div className={styles.messageList}>
              {parentMessages.map((msg, idx) => (
                <div key={msg.id} className={`${styles.msgItem} ${idx >= commonCount ? styles.parentOnly : styles.common}`}>
                  <span className={styles.role}>{msg.role === 'user' ? '👤' : '🤖'}</span>
                  <span className={styles.content}>{msg.content.slice(0, 200)}{msg.content.length > 200 ? '...' : ''}</span>
                </div>
              ))}
            </div>
          </div>

          {/* 右列：分支 Session */}
          <div className={styles.column}>
            <div className={styles.columnHeader}>
              <span className={styles.columnIcon}>🔀</span>
              分支 Session
            </div>
            <div className={styles.messageList}>
              {branchMessages.map((msg, idx) => (
                <div key={msg.id} className={`${styles.msgItem} ${idx >= commonCount ? styles.branchOnly : styles.common}`}>
                  <span className={styles.role}>{msg.role === 'user' ? '👤' : '🤖'}</span>
                  <span className={styles.content}>{msg.content.slice(0, 200)}{msg.content.length > 200 ? '...' : ''}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
