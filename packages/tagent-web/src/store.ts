/**
 * Zustand Store — 全局状态管理 (plan §5.1)
 *
 * 替代 page.tsx 中分散的 useState，提供统一的状态访问和更新。
 * 渐进式采用：组件可通过 hook 选择性订阅状态切片。
 */

'use client';

import { create } from 'zustand';

const API = 'http://localhost:3001';

// ─── Types ───────────────────────────────────────────

interface Agent {
  id: string;
  name: string;
  type: string;
  description: string;
  icon?: string;
  state: { business: string; runtime: string; humanInteraction: string; orchestration: string };
  capabilities: { skills: string[]; tools: string[]; mcpServers: string[] };
}

interface Workspace {
  id: string;
  name: string;
  description: string;
}

interface Session {
  id: string;
  title: string;
  parentSessionId: string | null;
  children: Session[];
}

// ─── Store ───────────────────────────────────────────

interface TAgentStore {
  // Theme
  theme: 'dark' | 'light';
  toggleTheme: () => void;

  // Sidebar
  sidebarOpen: boolean;
  toggleSidebar: () => void;

  // Agents
  agents: Agent[];
  fetchAgents: () => Promise<void>;

  // Workspaces
  workspaces: Workspace[];
  activeWsId: string | null;
  setActiveWsId: (id: string) => void;
  fetchWorkspaces: () => Promise<void>;

  // Sessions
  sessions: Session[];
  activeSessionId: string | null;
  setActiveSessionId: (id: string | null) => void;
  fetchSessions: (wsId: string) => Promise<void>;

  // Governance
  governanceTemplate: 'standard' | 'strict_cost' | 'quality_first';
  setGovernanceTemplate: (t: 'standard' | 'strict_cost' | 'quality_first') => void;
}

export const useTAgentStore = create<TAgentStore>((set, get) => ({
  // Theme
  theme: 'dark',
  toggleTheme: () => set(s => {
    const next = s.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    return { theme: next as 'dark' | 'light' };
  }),

  // Sidebar
  sidebarOpen: true,
  toggleSidebar: () => set(s => ({ sidebarOpen: !s.sidebarOpen })),

  // Agents
  agents: [],
  fetchAgents: async () => {
    try {
      const res = await fetch(`${API}/api/agents`);
      const data = await res.json();
      set({ agents: data.agents || [] });
    } catch { /* server not ready */ }
  },

  // Workspaces
  workspaces: [],
  activeWsId: null,
  setActiveWsId: (id) => set({ activeWsId: id }),
  fetchWorkspaces: async () => {
    try {
      const res = await fetch(`${API}/api/workspaces`);
      const data = await res.json();
      set({ workspaces: data.workspaces || [] });
      if (!get().activeWsId && data.workspaces?.length > 0) {
        set({ activeWsId: data.workspaces[0].id });
      }
    } catch { /* server not ready */ }
  },

  // Sessions
  sessions: [],
  activeSessionId: null,
  setActiveSessionId: (id) => set({ activeSessionId: id }),
  fetchSessions: async (wsId) => {
    try {
      const res = await fetch(`${API}/api/workspaces/${wsId}/sessions`);
      const data = await res.json();
      set({ sessions: data.sessions || [] });
    } catch { /* server not ready */ }
  },

  // Governance
  governanceTemplate: 'standard',
  setGovernanceTemplate: (t) => set({ governanceTemplate: t }),
}));
