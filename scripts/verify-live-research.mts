import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createWebResearchTool } from '../packages/tagent-core/src/tools/web-research.js';
import { closeSharedBrowser } from '../packages/tagent-core/src/tools/browser-pool.js';
import { assessResearchSources, type ResearchSource } from '../packages/tagent-core/src/research-evidence.js';
import { loadServerEnvironment } from '../packages/tagent-server/src/config.js';

// Manual public-network acceptance. No model API calls, no MCP/Skill configuration writes.
loadServerEnvironment(fileURLToPath(new URL('../', import.meta.url)));
const freeOnly = process.argv.includes('--free-only');
if (freeOnly) {
  process.env.TAGENT_SEARCH_PROVIDER = 'auto';
  for (const key of ['TAVILY_API_KEY', 'JINA_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN']) process.env[key] = '';
}
const queries = process.argv.slice(2).filter(value => value !== '--free-only');
if (!queries.length) queries.push('近 30 天 AI Agent 最新进展', '调研支付 agent 的现状');
await mkdir(new URL('../output/', import.meta.url), { recursive: true });
try {
  for (const query of queries) {
    const started = Date.now();
    const sources: ResearchSource[] = [];
    const output = await createWebResearchTool({ topic: query, searchSessionId: randomUUID(), onSources: items => sources.push(...items) })
      .execute({ query, maxResults: 8, maxPages: 4 });
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
    const assessment = assessResearchSources(sources, date, query);
    const artifact = new URL(`../output/live-research-${started}.json`, import.meta.url);
    await writeFile(artifact, JSON.stringify({ query, searchProvider: process.env.TAGENT_SEARCH_PROVIDER || 'auto', elapsedMs: Date.now() - started,
      output, sources, assessment }, null, 2), 'utf8');
    console.log(JSON.stringify({ query, elapsedMs: Date.now() - started, assessment, artifact: fileURLToPath(artifact),
      sources: sources.map(source => ({ url: source.url, title: source.title, readable: source.readable, relevant: source.relevant, publication: source.publication })) }));
    try {
      assert.ok(sources.filter(source => source.readable && source.relevant).length >= 2, 'Expected at least two readable relevant pages, not search snippets');
      assert.equal(assessment.status, 'sufficient_evidence', 'Material availability failed; this is not report/claim verification');
    } catch (error) { console.error((error as Error).message); process.exitCode = 1; }
  }
} finally { await closeSharedBrowser(); }
