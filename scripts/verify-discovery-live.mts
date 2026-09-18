import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { publicFetch } from '../packages/tagent-core/dist/index.js';
import { GitHubClient, GitHubRequestError } from '../packages/tagent-server/src/github-client.js';
import { runDiscoverySearch } from '../packages/tagent-server/src/discovery.js';
import { previewSkillImport } from '../packages/tagent-server/src/skill-import.js';
import { previewMCPImport } from '../packages/tagent-server/src/mcp-import.js';

// Explicit read-only acceptance against public metadata. Never loads model keys or runs external packages.
const paths = ['.tagent/mcp.json', '.tagent/skills.json', '.tagent/data/workspaces.json'].map(path => resolve(path));
const snapshot = async () => {
  const files: Array<Buffer | null> = [];
  for (const path of paths) files.push(await readFile(path).catch(() => null));
  return files;
};
const before = await snapshot();
let calls = 0;
const github = new GitHubClient(async (input, options) => { calls++; return publicFetch(input, options); });
const results: unknown[] = [];
try {
  try {
    const first = await github.get('/repos/anthropics/skills');
    const second = await github.get('/repos/anthropics/skills');
    assert.equal(second.cache, 'memory');
    assert.equal(second.fetchedAt, first.fetchedAt);
    assert.equal(calls, 1);
    results.push({ check: 'public-github-cache', networkRequests: calls, cache: second.cache });
  } catch (error) {
    if (!(error instanceof GitHubRequestError)) throw error;
    results.push({ check: 'public-github-cache', unavailable: error.code, retryAt: error.retryAt });
  }

  const registries = { skillsRegistry: { getSkills: async () => [] }, mcpRegistry: { getServers: async () => [] } };
  for (const [domain, query] of [['mcp', 'filesystem'], ['skill', 'last30days agent research']] as const) {
    const result = await runDiscoverySearch({ domain, query, ...registries } as Parameters<typeof runDiscoverySearch>[0]);
    for (const candidate of result.candidates) {
      for (const field of ['draft', 'body', 'package', 'command', 'env']) assert.ok(!(field in candidate));
    }
    const remote = result.candidates.filter(candidate => ['npm', 'github-repo', 'github-code', 'mcp-registry'].includes(candidate.providerId));
    assert.ok(remote.length, `${domain}: no verified remote search responses: ${result.errors.join('; ')}`);
    results.push({ check: `${domain}-discovery`, remote: remote.map(item => ({ provider: item.providerId, name: item.name })),
      providers: result.providerStatuses.map(item => ({ id: item.id, state: item.state, cache: item.cache, errorCode: item.errorCode, retryAt: item.retryAt })) });
  }

  const skill = await previewSkillImport({ source: 'https://github.com/anthropics/skills/tree/main/skills/internal-comms' });
  assert.equal(skill.status, 'ready');
  assert.equal(skill.willExecute, false); assert.equal(skill.willWrite, false); assert.equal(skill.requiresConfirmation, true);
  if (skill.status === 'ready') results.push({ check: 'real-skill-package', name: skill.candidate.name, commit: skill.source.commit,
    complete: skill.source.complete, files: skill.candidate.package?.files?.length });

  const mcp = await previewMCPImport({ source: '@modelcontextprotocol/server-filesystem' });
  assert.equal(mcp.willExecute, false); assert.equal(mcp.willWrite, false); assert.equal(mcp.requiresConfirmation, true);
  results.push({ check: 'real-npm-preview', status: mcp.status, version: mcp.source.version });
  console.log(JSON.stringify({ status: 'passed', results, modelCalls: 0, configurationWrites: 0, externalCommands: 0 }, null, 2));
} finally {
  assert.deepEqual(await snapshot(), before, 'acceptance must not change user configuration or conversations');
}
