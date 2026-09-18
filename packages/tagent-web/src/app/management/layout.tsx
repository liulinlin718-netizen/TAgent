'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { LayoutGrid, Users, Link as LinkIcon, ChevronLeft, Shield, Search, Cable, CalendarClock } from 'lucide-react';
import styles from './management.module.css';

export default function ManagementLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const navigation = useRef<HTMLElement>(null);

  useEffect(() => {
    const nav = navigation.current;
    if (!nav) return;
    const revealCurrent = () => nav.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    revealCurrent();
    const observer = new ResizeObserver(revealCurrent);
    observer.observe(nav);
    return () => observer.disconnect();
  }, [pathname]);

  const navItems = [
    { name: 'Skills 技能库', href: '/management/skills', icon: LayoutGrid },
    { name: 'Agents 大厅', href: '/management/agents', icon: Users },
    { name: 'MCP 工具', href: '/management/mcp', icon: LinkIcon },
    { name: '调研搜索', href: '/management/search', icon: Search },
    { name: '模型连接', href: '/management/model', icon: Cable },
    { name: '治理仪表盘', href: '/management/governance', icon: Shield },
    { name: '运行与周期任务', href: '/management/runtime', icon: CalendarClock },
  ];

  return (
    <div className={styles.layout}>
      {/* Sidebar Navigation */}
      <aside className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <h2>管理中心</h2>
        </div>
        
        <nav ref={navigation} className={styles.nav}>
          {navItems.map((item) => {
            const isActive = pathname.startsWith(item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActive ? 'page' : undefined}
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
