import { mkdtemp, readFile, readdir, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MCPRegistry, MCP_REDACTED, redactMCPConfig, redactMCPText } from '../mcp-registry.js';

const roots: string[] = [];
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'tagent-mcp-test-')); roots.push(root); return { root, registry: new MCPRegistry(root) }; }
afterEach(async () => { for (const root of roots.splice(0)) { if (!resolve(root).startsWith(resolve(tmpdir()) + '\\tagent-mcp-test-') && !resolve(root).startsWith(resolve(tmpdir()) + '/tagent-mcp-test-')) throw new Error('Unsafe cleanup path'); await rm(root, { recursive: true, force: true }); } });
const config = { name: '文件协作 🙂', type: 'stdio' as const, command: 'node', args: ['C:\\My Tools\\server.mjs', '--token', 'secret-value'], env: { OFFICE_KEY: 'private-value' } };

describe('MCP config persistence and secret boundary', () => {
  it('blocks unresolved import requirements, then preserves provenance across save and restart', async () => {
    const { registry, root } = await fixture();
    const candidate = { name: 'Imported', type: 'stdio', command: 'node', args: ['<directory>'], source: { kind: 'github', url: 'https://github.com/demo/tools/blob/abc/mcp.json', fetchedAt: '2026-09-12T00:00:00Z', commit: 'a'.repeat(40) },
      requirements: [{ location: 'arg', key: '0', description: 'Allowed directory', required: true, placeholder: '<directory>' }] };
    await expect(registry.addServer(candidate)).rejects.toThrow('请先填写');
    expect(await readdir(root)).toEqual([]);
    const saved = await registry.addServer({ ...candidate, args: ['C:/Office Files'] });
    expect((await new MCPRegistry(root).getServer(saved.id))?.source).toEqual(candidate.source);
    expect(saved.executionApproved).toBe(false);
  });
  it('does not create storage on read; saves UTF-8 and argument boundaries atomically', async () => {
    const { registry, root } = await fixture();
    expect(await registry.getServers()).toEqual([]);
    expect(await readdir(root)).toEqual([]);
    const server = await registry.addServer({ ...config, executionApproved: true });
    expect(server.executionApproved).toBe(false);
    expect(await new MCPRegistry(root).getServer(server.id)).toEqual(server);
    expect(server.args![0]).toBe('C:\\My Tools\\server.mjs');
    server.env!.OFFICE_KEY = 'mutated';
    expect((await registry.getServer(server.id))?.env?.OFFICE_KEY).toBe('private-value');
  });
  it('serializes concurrent writes and publishes nothing when the filesystem commit fails', async () => {
    const { registry, root } = await fixture();
    const saved = await Promise.all(Array.from({ length: 8 }, (_, index) => registry.addServer({ ...config, name: `Agent ${index}` })));
    expect(await new MCPRegistry(root).getServers()).toHaveLength(8);
    const file = join(root, '.tagent', 'mcp.json');
    await rename(file, `${file}.backup`); await mkdir(file);
    await expect(registry.updateServer(saved[0].id, { name: 'changed', revision: 1 })).rejects.toMatchObject({ status: 503 });
    expect((await registry.getServer(saved[0].id))?.name).toBe('Agent 0');
    expect((await readdir(join(root, '.tagent'))).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });
  it('never overwrites corrupt storage with an empty library', async () => {
    const { root, registry } = await fixture();
    await mkdir(join(root, '.tagent'));
    await writeFile(join(root, '.tagent', 'mcp.json'), '{bad');
    await expect(registry.addServer(config)).rejects.toMatchObject({ status: 503 });
    expect(await readFile(join(root, '.tagent', 'mcp.json'), 'utf8')).toBe('{bad');
  });
  it('fully masks env and secret arguments; unchanged edit preserves values and revokes approval', async () => {
    const { registry } = await fixture();
    const server = await registry.addServer(config);
    const approved = await registry.setExecutionApproval(server.id, 1, true);
    const dto = redactMCPConfig(approved);
    expect(JSON.stringify(dto)).not.toContain('secret-value');
    expect(JSON.stringify(dto)).not.toContain('private-value');
    expect(dto.env!.OFFICE_KEY).toBe(MCP_REDACTED);
    const edited = await registry.updateServer(server.id, { ...dto, name: '文档服务' });
    expect(edited.env).toEqual(config.env);
    expect(edited.args).toEqual(config.args);
    expect(edited.executionApproved).toBe(false);
    await expect(registry.setExecutionApproval(server.id, 1, true)).rejects.toMatchObject({ status: 409 });
    await expect(registry.updateServer(server.id, { name: 'stale', revision: 1 })).rejects.toMatchObject({ status: 409 });
    await expect(registry.addServer(dto)).rejects.toThrow('占位符');
  });
  it('does not restore masked credentials to a different command or HTTP destination', async () => {
    const { registry } = await fixture();
    const stdio = await registry.addServer(config);
    await expect(registry.updateServer(stdio.id, { ...redactMCPConfig(stdio), command: 'evil' })).rejects.toThrow('重新输入');
    const http = await registry.addServer({ name: 'Remote', type: 'http', url: 'https://mcp.example/run?token=foo-secret', headers: { Authorization: 'Bearer bar-secret' } });
    const safe = redactMCPConfig(http);
    expect(JSON.stringify(safe)).not.toContain('foo-secret');
    expect(JSON.stringify(safe)).not.toContain('bar-secret');
    await expect(registry.updateServer(http.id, { ...safe, url: 'https://evil.example/mcp' })).rejects.toThrow('重新输入');
    await expect(registry.updateServer(http.id, { revision: 1, url: 'https://evil.example/mcp' })).rejects.toThrow('重新输入');
    const edited = await registry.updateServer(http.id, { ...safe, name: 'Renamed' });
    expect(edited.url).toBe(http.url);
    expect(redactMCPText('Bearer bar-secret foo-secret', http)).not.toContain('secret');
  });
  it('requires explicit boolean approval and restores legacy configurations without auto-approval', async () => {
    const { root, registry } = await fixture();
    await mkdir(join(root, '.tagent'));
    await writeFile(join(root, '.tagent', 'mcp.json'), JSON.stringify([{ ...config, id: 'legacy' }]));
    expect((await registry.getServer('legacy'))?.executionApproved).toBeUndefined();
    await expect(registry.setExecutionApproval('legacy', 0, 'yes')).rejects.toMatchObject({ status: 400 });
    expect((await registry.setExecutionApproval('legacy', 0, true)).executionApproved).toBe(true);
  });
  it.each([
    { ...config, args: '-y tool' }, { ...config, env: { KEY: 123 } }, { ...config, env: [] },
    { name: 'Local', type: 'http', url: 'http://127.0.0.1:9999' },
    { name: 'Header injection', type: 'http', url: 'https://mcp.example', headers: { Authorization: 'token\r\nCookie: bad' } },
    { name: 'Plaintext credential', type: 'http', url: 'http://mcp.example', headers: { Authorization: 'secret' } },
  ])('rejects invalid configuration without writing', async input => {
    const { registry, root } = await fixture();
    await expect(registry.addServer(input)).rejects.toMatchObject({ status: 400 });
    expect(await readdir(root)).toEqual([]);
  });
});
