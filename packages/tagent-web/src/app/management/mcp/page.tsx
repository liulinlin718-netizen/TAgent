'use client';

import { useEffect, useState } from 'react';
import { Plus, Server, Activity, Terminal, Globe, Wifi } from 'lucide-react';
import styles from './mcp.module.css';

interface MCPServer {
  id: string;
  name: string;
  type: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  url?: string;
}

export default function MCPPage() {
  const [servers, setServers] = useState<MCPServer[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('http://localhost:3001/api/mcp')
      .then(res => res.json())
      .then(data => {
        setServers(data.servers);
        setLoading(false);
      });
  }, []);

  const getTypeIcon = (type: string) => {
    switch(type) {
      case 'stdio': return <Terminal size={16} />;
      case 'sse': return <Activity size={16} />;
      case 'http': return <Globe size={16} />;
      default: return <Server size={16} />;
    }
  };

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>MCP 工具集</h1>
          <p className={styles.subtitle}>Model Context Protocol — 连接外部系统的数据与工具能力</p>
        </div>
        <button className={styles.primaryButton}>
          <Plus size={18} />
          添加 Server
        </button>
      </header>

      {loading ? (
        <div className={styles.loading}>加载中...</div>
      ) : (
        <div className={styles.serverList}>
          {servers.map(server => (
            <div key={server.id} className={styles.serverCard}>
              <div className={styles.cardLeft}>
                <div className={styles.iconBox}>
                  <Server size={24} />
                </div>
                <div className={styles.serverInfo}>
                  <div className={styles.nameRow}>
                    <h3 className={styles.serverName}>{server.name}</h3>
                    <div className={styles.statusBadge}>
                      <Wifi size={12} className={styles.statusIcon} />
                      <span>已连接</span>
                    </div>
                  </div>
                  
                  <div className={styles.detailsRow}>
                    <span className={styles.typeBadge}>
                      {getTypeIcon(server.type)}
                      {server.type.toUpperCase()}
                    </span>
                    
                    {server.type === 'stdio' && server.command && (
                      <span className={styles.codeSnippet}>
                        {server.command} {server.args?.join(' ')}
                      </span>
                    )}
                    
                    {(server.type === 'sse' || server.type === 'http') && server.url && (
                      <span className={styles.codeSnippet}>
                        {server.url}
                      </span>
                    )}
                  </div>
                </div>
              </div>
              
              <div className={styles.cardRight}>
                <button className={styles.actionButton}>配置</button>
                <button className={styles.actionButtonDanger}>断开</button>
              </div>
            </div>
          ))}
          
          {servers.length === 0 && (
            <div className={styles.emptyState}>
              <Server size={48} className={styles.emptyIcon} />
              <h3>暂无 MCP Server</h3>
              <p>点击右上角添加您的第一个工具服务</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
