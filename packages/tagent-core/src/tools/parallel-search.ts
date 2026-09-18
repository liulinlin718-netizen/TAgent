import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { assertPublicUrl, publicFetch } from '../public-network.js';

const ENDPOINT = 'https://search.parallel.ai/mcp';

export interface ParallelSearchCandidate {
  title: string;
  url: string;
  snippet: string;
  dateHint?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseParallelCandidates(payload: unknown): ParallelSearchCandidate[] {
  if (!isRecord(payload) || !Array.isArray(payload.results)) throw new Error('Invalid search response');
  const candidates: ParallelSearchCandidate[] = [];
  for (const item of payload.results.slice(0, 30)) {
    if (!isRecord(item) || typeof item.url !== 'string' || !Array.isArray(item.excerpts)) continue;
    let url: string;
    try { url = assertPublicUrl(item.url).toString(); } catch { continue; }
    const snippet = item.excerpts.filter((text): text is string => typeof text === 'string').join(' ').slice(0, 2000);
    candidates.push({
      url,
      title: typeof item.title === 'string' && item.title.trim() ? item.title.slice(0, 300) : new URL(url).hostname,
      snippet,
      // Provider dates are hints, never publication evidence from a page we read.
      dateHint: typeof item.publish_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.publish_date) ? item.publish_date : undefined,
    });
  }
  return candidates;
}

/** Explicitly selected anonymous search only. No key, installation, remote prompts or executable tools. */
export async function searchParallel(input: { objective: string; queries: string[]; sessionId: string; signal?: AbortSignal }): Promise<ParallelSearchCandidate[]> {
  input.signal?.throwIfAborted();
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(25_000), ...(input.signal ? [input.signal] : [])]);
  const client = new Client({ name: 'tagent-search', version: '0.1.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
    fetch: (url, init) => publicFetch(String(url), {
      ...init,
      allowedDomains: ['search.parallel.ai'],
      maxBytes: 256 * 1024,
      signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]),
    }),
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
  });
  try {
    await client.connect(transport, { signal, timeout: 10_000 });
    const result = await client.callTool({ name: 'web_search', arguments: {
      objective: input.objective.slice(0, 2000),
      search_queries: [...new Set(input.queries)].filter(Boolean).slice(0, 3).map(query => query.slice(0, 500)),
      session_id: input.sessionId,
    } }, undefined, { signal, timeout: 20_000 });
    if (result.isError) throw new Error('Search tool returned an error');
    // The SDK handles JSON-RPC and JSON/SSE framing. Never inject server instructions
    // or free-form tool messages into the agent's system prompt.
    const payload = result.structuredContent ?? JSON.parse(
      (result.content as Array<{ type: string; text?: string }>).find(item => item.type === 'text')?.text || 'null',
    );
    return parseParallelCandidates(payload);
  } finally {
    try { await client.close(); } finally { controller.abort(); }
  }
}
