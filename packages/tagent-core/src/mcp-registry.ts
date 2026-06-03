import * as fs from 'fs/promises';
import * as path from 'path';

export type MCPTransportType = 'stdio' | 'sse' | 'http';

export interface MCPServerConfig {
  id: string;
  name: string;
  type: MCPTransportType;
  
  // For stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  
  // For sse / http
  url?: string;
}

export class MCPRegistry {
  private configFile: string;
  private configCache: MCPServerConfig[] | null = null;

  constructor(workspaceRoot: string) {
    const dotTagentDir = path.join(workspaceRoot, '.tagent');
    this.configFile = path.join(dotTagentDir, 'mcp.json');
  }

  private async ensureDir(): Promise<void> {
    const dir = path.dirname(this.configFile);
    try {
      await fs.access(dir);
    } catch {
      await fs.mkdir(dir, { recursive: true });
    }
  }

  private async load(): Promise<MCPServerConfig[]> {
    if (this.configCache) return this.configCache;
    try {
      await this.ensureDir();
      const data = await fs.readFile(this.configFile, 'utf-8');
      this.configCache = JSON.parse(data) as MCPServerConfig[];
    } catch (e: any) {
      if (e.code === 'ENOENT') {
        this.configCache = [];
      } else {
        throw e;
      }
    }
    return this.configCache;
  }

  private async save(): Promise<void> {
    if (!this.configCache) return;
    await this.ensureDir();
    await fs.writeFile(this.configFile, JSON.stringify(this.configCache, null, 2), 'utf-8');
  }

  async getServers(): Promise<MCPServerConfig[]> {
    return [...(await this.load())];
  }

  async getServer(id: string): Promise<MCPServerConfig | undefined> {
    const servers = await this.load();
    return servers.find(s => s.id === id);
  }

  async addServer(server: Omit<MCPServerConfig, 'id'>): Promise<MCPServerConfig> {
    const servers = await this.load();
    const newServer: MCPServerConfig = {
      ...server,
      id: `mcp-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    };
    servers.push(newServer);
    await this.save();
    return newServer;
  }

  async updateServer(id: string, updates: Partial<Omit<MCPServerConfig, 'id'>>): Promise<MCPServerConfig> {
    const servers = await this.load();
    const idx = servers.findIndex(s => s.id === id);
    if (idx === -1) throw new Error(`MCP Server ${id} not found`);
    
    const updated = { ...servers[idx], ...updates };
    servers[idx] = updated;
    await this.save();
    return updated;
  }

  async deleteServer(id: string): Promise<void> {
    const servers = await this.load();
    const idx = servers.findIndex(s => s.id === id);
    if (idx !== -1) {
      servers.splice(idx, 1);
      await this.save();
    }
  }
}
