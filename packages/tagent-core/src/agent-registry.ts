import * as fs from 'fs/promises';
import * as path from 'path';

export interface AgentOverride {
  id: string;
  skills?: string[];
  mcpServers?: string[];
}

export class AgentRegistry {
  private configFile: string;
  private configCache: Record<string, AgentOverride> | null = null;

  constructor(workspaceRoot: string) {
    const dotTagentDir = path.join(workspaceRoot, '.tagent');
    this.configFile = path.join(dotTagentDir, 'agents.json');
  }

  private async ensureDir(): Promise<void> {
    const dir = path.dirname(this.configFile);
    try {
      await fs.access(dir);
    } catch {
      await fs.mkdir(dir, { recursive: true });
    }
  }

  private async load(): Promise<Record<string, AgentOverride>> {
    if (this.configCache) return this.configCache;
    try {
      await this.ensureDir();
      const data = await fs.readFile(this.configFile, 'utf-8');
      this.configCache = JSON.parse(data) as Record<string, AgentOverride>;
    } catch (e: any) {
      if (e.code === 'ENOENT') {
        this.configCache = {};
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

  async getOverrides(): Promise<Record<string, AgentOverride>> {
    return { ...(await this.load()) };
  }

  async getOverride(id: string): Promise<AgentOverride | undefined> {
    const overrides = await this.load();
    return overrides[id];
  }

  async updateOverride(id: string, updates: Partial<Omit<AgentOverride, 'id'>>): Promise<AgentOverride> {
    const overrides = await this.load();
    const current = overrides[id] || { id, skills: [], mcpServers: [] };
    
    if (updates.skills !== undefined) current.skills = updates.skills;
    if (updates.mcpServers !== undefined) current.mcpServers = updates.mcpServers;
    
    overrides[id] = current;
    await this.save();
    return current;
  }
}
