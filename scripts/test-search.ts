import assert from 'node:assert/strict';
import { createWebSearchTool } from '../packages/tagent-core/src/tools/web-search.js';
import { closeSharedBrowser } from '../packages/tagent-core/src/tools/browser-pool.js';
import { loadServerEnvironment } from '../packages/tagent-server/src/config.js';
import { fileURLToPath } from 'node:url';

loadServerEnvironment(fileURLToPath(new URL('../', import.meta.url)));
const freeOnly = process.argv.includes('--free-only');
if (freeOnly) {
  process.env.TAGENT_SEARCH_PROVIDER = 'auto';
  for (const key of ['TAVILY_API_KEY', 'JINA_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN']) process.env[key] = '';
}
const queries = process.argv.slice(2).filter(value => value !== '--free-only');
if (!queries.length) queries.push('近 30 天 AI Agent 最新进展', '支付 agent 现状');

async function main() {
  const failures: string[] = [];
  try {
    for (const query of queries) {
      const started = Date.now();
      const output = await createWebSearchTool({ topic: query }).execute({ query, maxResults: 5 });
      const urls = [...output.matchAll(/^- URL: (https?:\/\/\S+)/gm)].map(match => match[1]);
      console.log(JSON.stringify({ query, elapsedMs: Date.now() - started, candidateCount: urls.length }));
      console.log(output);
      if (!urls.length) failures.push(query);
      assert.equal(new Set(urls).size, urls.length, 'Search candidates must be deduplicated');
    }
    assert.equal(failures.length, 0, `No actual candidate URLs for: ${failures.join('; ')}`);
  } finally {
    await closeSharedBrowser();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
