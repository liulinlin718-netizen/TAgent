import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { AnthropicProvider, OpenAIProvider } from '../packages/tagent-ai/dist/index.js';
import { AgentPool, DEFAULT_RESIDENT_SKILLS, FilePersistence, executeOfficeBenchmark, getOfficeBenchmarkTasks, previewOfficeBenchmark } from '../packages/tagent-core/dist/index.js';
import { OFFICE_ANSWERS, OFFICE_ROLE_ANSWERS } from '../packages/tagent-core/src/__tests__/fixtures/office-benchmark-answers.js';

// SDK/protocol acceptance only. The deterministic answers below are not model capability evidence.
const root = await mkdtemp(join(tmpdir(), 'tagent-office-benchmark-http-'));
const persistence = new FilePersistence(root);
let providerName = 'openai', calls = 0, mode = 'success', tasks = getOfficeBenchmarkTasks(new AgentPool().getAgent('document-agent')!);
let answers: unknown[] = [], fixtureError: unknown;
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.method, 'POST'); assert.equal(request.url, providerName === 'anthropic' ? '/v1/messages' : '/v1/chat/completions');
    let raw = ''; for await (const part of request) { raw += part; assert.ok(raw.length < 200000); }
    const input = JSON.parse(raw); calls++;
    assert.ok(input.max_tokens <= 1024);
    if (mode === 'error') { response.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { type: 'authentication_error', message: 'private-fixture-body' } })); return; }
    const first = input.messages.find((message: { role: string }) => message.role === 'user');
    const prompt = typeof first.content === 'string' ? first.content : first.content.filter((block: { type: string }) => block.type === 'text').map((block: { text: string }) => block.text).join('');
    const index = tasks.findIndex(task => task.prompt === prompt); assert.ok(index >= 0);
    const hasResult = input.messages.some((message: { role: string; content: unknown }) => message.role === 'tool'
      || Array.isArray(message.content) && message.content.some((block: { type: string }) => block.type === 'tool_result'));
    const url = Object.keys(tasks[index]!.resources)[0], tool = url && !hasResult;
    const content = JSON.stringify(answers[index]);
    if (providerName === 'anthropic') {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: `msg-${calls}`, type: 'message', role: 'assistant', model: 'deepseek-chat',
        content: tool ? [{ type: 'tool_use', id: `tool-${calls}`, name: 'read_url', input: { url } }] : [{ type: 'text', text: content }],
        stop_reason: tool ? 'tool_use' : 'end_turn', usage: { input_tokens: 100, output_tokens: 20 } }));
    } else {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: `chat-${calls}`, object: 'chat.completion', model: 'deepseek-chat',
        choices: [{ index: 0, message: { role: 'assistant', content: tool ? '' : content,
          ...(tool ? { tool_calls: [{ id: `tool-${calls}`, type: 'function', function: { name: 'read_url', arguments: JSON.stringify({ url }) } }] } : {}) }, finish_reason: tool ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
    }
  } catch (error) { fixtureError = error; response.writeHead(500).end(); }
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const port = (server.address() as { port: number }).port;
const results: object[] = [];
try {
  for (providerName of ['openai', 'anthropic']) {
    const options = { apiKey: 'local-sdk-fixture-only', baseURL: `http://127.0.0.1:${port}${providerName === 'anthropic' ? '' : '/v1'}`, timeout: 3000, maxRetries: 0 };
    const provider = providerName === 'anthropic' ? new AnthropicProvider(options) : new OpenAIProvider(options);
    for (const role of Object.keys(OFFICE_ROLE_ANSWERS)) {
      mode = 'success';
      const agent = structuredClone(new AgentPool().getAgent(`${role}-agent`)!);
      tasks = getOfficeBenchmarkTasks(agent); answers = [...OFFICE_ANSWERS, OFFICE_ROLE_ANSWERS[role]];
      const before = calls;
      const preview = previewOfficeBenchmark(agent, DEFAULT_RESIDENT_SKILLS, 'deepseek-chat', provider.name);
      assert.equal(calls, before, 'Preview never calls the provider');
      const run = await executeOfficeBenchmark({ agent, skills: DEFAULT_RESIDENT_SKILLS, provider, model: 'deepseek-chat', traceDirectory: join(root, 'traces'),
        confirmation: { confirmed: true, preview }, checkpoint: value => persistence.save(value.id, value) });
      assert.ifError(fixtureError); assert.equal(run.status, 'completed'); assert.equal(run.results.length, 8);
      assert.equal(run.score!.totalScore, 100, 'Known fixture outputs match deterministic rules, not a real model score');
      assert.equal(calls - before, 11); assert.equal(run.modelCalls, 11); assert.equal(run.usage.unsettledRequests, 0);
      assert.deepEqual(await new FilePersistence(root).load(run.id, null), run, 'Committed UTF-8 results survive adapter recreation');
      results.push({ provider: providerName, role, tasks: run.results.length, sdkCalls: run.modelCalls });
    }
    mode = 'error'; const before = calls, agent = new AgentPool().getAgent('document-agent')!;
    const run = await executeOfficeBenchmark({ agent, skills: DEFAULT_RESIDENT_SKILLS, provider, model: 'deepseek-chat', traceDirectory: join(root, 'traces'),
      confirmation: { confirmed: true, preview: previewOfficeBenchmark(agent, DEFAULT_RESIDENT_SKILLS, 'deepseek-chat', provider.name) },
      checkpoint: value => persistence.save(value.id, value) });
    assert.equal(calls - before, 1); assert.equal(run.status, 'failed'); assert.equal(run.score, undefined);
    assert.equal(run.usage.unsettledRequests, 1); assert.ok(!JSON.stringify(run).includes('private-fixture-body'));
  }
  console.log(JSON.stringify({ status: 'passed', protocols: 2, fixtureSuites: results.length, localRequests: calls,
    paidRequests: 0, realModelQualityVerified: false, userWrites: 0, results }));
} finally {
  server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
  const safe = relative(tmpdir(), root); assert.ok(safe && !safe.startsWith('..') && !isAbsolute(safe));
  await rm(root, { recursive: true, force: true });
}
