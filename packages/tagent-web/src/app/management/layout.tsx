'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutGrid, Users, Link as LinkIcon, ChevronLeft, Shield } from 'lucide-react';
import styles from './management.module.css';

export default function ManagementLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  const navItems = [
    { name: 'Skills 技能库', href: '/management/skills', icon: LayoutGrid },
    { name: 'Agents 大厅', href: '/management/agents', icon: Users },
    { name: 'MCP 工具', href: '/management/mcp', icon: LinkIcon },
    { name: '治理仪表盘', href: '/management/governance', icon: Shield },
  ];

  return (
    <div className={styles.layout}>
      {/* Sidebar Navigation */}
      <aside className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <h2>管理中心</h2>
        </div>
        
        <nav className={styles.nav}>
          {navItems.map((item) => {
            const isActive = pathname.startsWith(item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`${styles.navItem} ${isActive ? styles.active : ''}`}
              >
                <Icon size={18} />
                <span>{item.name}</span>
              </Link>
            );
          })}
        </nav>

        <div className={styles.sidebarFooter}>
          <Link href="/" className={styles.backButton}>
            <ChevronLeft size={16} />
            返回工作区
          </Link>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className={styles.mainContent}>
        {children}
      </main>
    </div>
  );
}
