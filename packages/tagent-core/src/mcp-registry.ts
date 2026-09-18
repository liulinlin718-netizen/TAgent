import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isMCPRecord, MCPConfigError, MCP_REDACTED, restoreMCPUpdate, validateMCPConfig, type MCPServerConfig } from './mcp-config.js';
export * from './mcp-config.js';

export class MCPRegistry {
  private readonly configFile: string;
  private cache: MCPServerConfig[] | undefined;
  private loading?: Promise<MCPServerConfig[]>;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(root: string) { this.configFile = path.join(root, '.tagent', 'mcp.json'); }

  private async load(): Promise<MCPServerConfig[]> {
    if (this.cache) return this.cache;
    if (!this.loading) this.loading = (async () => {
      let data: unknown;
      try { data = JSON.parse(await fs.readFile(this.configFile, 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') data = []; else throw new MCPConfigError('MCP 存储无法读取或已损坏，未覆盖原文件。', 503); }
      if (!Array.isArray(data) || data.some(item => !isMCPRecord(item) || typeof item.id !== 'string' || typeof item.name !== 'string' || !['stdio', 'http', 'sse'].includes(String(item.type))) || new Set(data.map(item => item.id)).size !== data.length) throw new MCPConfigError('MCP 存储格式无效，未覆盖原文件。', 503);
      this.cache = data as MCPServerConfig[];
      return this.cache;
    })().finally(() => { this.loading = undefined; });
    return this.loading;
  }

  private mutate<T>(change: (servers: MCPServerConfig[]) => T): Promise<T> {
    const operation = this.queue.then(async () => {
      const next = structuredClone(await this.load());
      const result = change(next);
      const temporary = `${this.configFile}.${randomUUID()}.tmp`;
      try {
        await fs.mkdir(path.dirname(this.configFile), { recursive: true });
        await fs.writeFile(temporary, JSON.stringify(next, null, 2), { encoding: 'utf8', flag: 'wx', flush: true, mode: 0o600 });
        await fs.rename(temporary, this.configFile);
      } catch { await fs.rm(temporary, { force: true }).catch(() => {}); throw new MCPConfigError('MCP 保存失败，配置未生效，请保留当前编辑内容。', 503); }
      this.cache = next;
      return structuredClone(result);
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  async getServers(): Promise<MCPServerConfig[]> { return structuredClone(await this.load()); }
  async getServer(id: string): Promise<MCPServerConfig | undefined> { return structuredClone((await this.load()).find(server => server.id === id)); }

  async addServer(input: unknown): Promise<MCPServerConfig> {
    const config = validateMCPConfig(input);
    if (JSON.stringify(config).includes(MCP_REDACTED)) throw new MCPConfigError('新配置不能使用已保存凭据占位符，请输入实际值。');
    return this.mutate(servers => {
      const server = { ...config, id: `mcp-${randomUUID()}`, revision: 1, executionApproved: false };
      servers.push(server); return server;
    });
  }

  async updateServer(id: string, updates: unknown): Promise<MCPServerConfig> {
    if (!isMCPRecord(updates)) throw new MCPConfigError('MCP 配置必须为对象。');
    return this.mutate(servers => {
      const index = servers.findIndex(server => server.id === id);
      if (index < 0) throw new MCPConfigError('MCP Server 不存在。', 404);
      const previous = servers[index];
      if (updates.revision !== (previous.revision || 0)) throw new MCPConfigError('配置已改变，请刷新后重新编辑。', 409);
      servers[index] = { ...restoreMCPUpdate(updates, previous), id, revision: (previous.revision || 0) + 1, executionApproved: false };
      return servers[index];
    });
  }

  async setExecutionApproval(id: string, revision: unknown, confirmed: unknown): Promise<MCPServerConfig> {
    if (typeof confirmed !== 'boolean') throw new MCPConfigError('执行授权必须明确确认或撤销。');
    return this.mutate(servers => {
      const server = servers.find(item => item.id === id);
      if (!server) throw new MCPConfigError('MCP Server 不存在。', 404);
      if (revision !== (server.revision || 0)) throw new MCPConfigError('配置已改变，请重新核对命令后确认。', 409);
      validateMCPConfig(server);
      server.executionApproved = confirmed;
      server.revision = (server.revision || 0) + 1;
      return server;
    });
  }

  async deleteServer(id: string): Promise<void> { await this.mutate(servers => { const index = servers.findIndex(s => s.id === id); if (index < 0) throw new MCPConfigError('MCP Server 不存在。', 404); servers.splice(index, 1); }); }
}
