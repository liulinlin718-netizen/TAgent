import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { publicFetch } from '../packages/tagent-core/dist/index.js';
import { previewMCPImport } from '../packages/tagent-server/src/mcp-import.js';

// Read-only public metadata acceptance: no package install, tools/call, or model request.
const store = resolve('.tagent/mcp.json');
const before = await readFile(store).catch(() => null);
const sources = [
  '@modelcontextprotocol/server-filesystem',
  'https://github.com/modelcontextprotocol/servers/blob/main/src/filesystem/README.md',
];
const response = await publicFetch('https://registry.modelcontextprotocol.io/v0.1/servers?search=filesystem&version=latest&limit=3', { maxBytes: 120000, signal: AbortSignal.timeout(15000) });
assert.equal(response.ok, true);
const registry = await response.json() as { servers: Array<{ server: { name: string; version: string } }> };
assert.ok(registry.servers.length);
const chosen = registry.servers[0].server;
sources.push(`https://registry.modelcontextprotocol.io/v0.1/servers/${encodeURIComponent(chosen.name)}/versions/${encodeURIComponent(chosen.version)}`);
for (const source of sources) {
  let result = await previewMCPImport({ source });
  assert.equal(result.willExecute, false);
  assert.equal(result.willWrite, false);
  assert.equal(result.requiresConfirmation, true);
  if (result.status === 'selection_required') {
    const choice = result.choices.find(item => item.available && !item.url && item.type === 'stdio') || result.choices.find(item => item.available);
    assert.ok(choice, JSON.stringify(result.choices));
    result = await previewMCPImport({ source: choice.url || source, choiceId: choice.url ? undefined : choice.id });
  }
  assert.ok('candidate' in result, 'expected parsed configuration after explicit selection');
  assert.notEqual(result.candidate.url, source);
  console.log(JSON.stringify({ source, status: result.status, name: result.candidate.name, type: result.candidate.type,
    version: result.source.version, commit: result.source.commit, requirements: result.candidate.requirements?.filter(item => item.required).map(item => `${item.location}:${item.key}`),
    warningCount: result.warnings.length, willExecute: result.willExecute, willWrite: result.willWrite }));
}
assert.deepEqual(await readFile(store).catch(() => null), before, 'user MCP store must remain unchanged');
console.log('Public MCP import acceptance passed; no configuration writes or external execution.');
