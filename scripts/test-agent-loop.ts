/**
 * 通水测试 Step 2: Agent Loop 端到端
 * 验证: LLM 调用 → 工具选择 → 执行 → 多轮迭代 → 输出
 */

import * as fs from 'fs';
import * as path from 'path';

// 加载 .env
const envPath = path.resolve(process.cwd(), 'packages/tagent-server/.env');
try {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      process.env[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
    }
  }
  console.log('✅ 已加载 .env');
} catch {
  console.log('⚠️  未找到 .env');
}

import { AnthropicProvider } from '../packages/tagent-ai/src/providers/anthropic.js';
import { CostTracker } from '../packages/tagent-ai/src/cost-tracker.js';
import { runAgentLoop } from '../packages/tagent-core/src/agent-loop.js';
import { ToolRegistry } from '../packages/tagent-core/src/tools/registry.js';
import { TraceWriter } from '../packages/tagent-core/src/trace.js';
import { createWebSearchTool } from '../packages/tagent-core/src/tools/web-search.js';
import { createUrlReaderTool } from '../packages/tagent-core/src/tools/url-reader.js';

async function main() {
  console.log('\n=== Step 2: Agent Loop 端到端测试 ===\n');

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) { console.log('❌ DEEPSEEK_API_KEY 未设置'); process.exit(1); }

  const provider = new AnthropicProvider({
    apiKey,
    baseURL: 'https://api.deepseek.com/anthropic',
    name: 'deepseek',
  });
  console.log('✅ Provider: DeepSeek');

  const tools = new ToolRegistry();
  tools.register(createWebSearchTool());
  tools.register(createUrlReaderTool());
  console.log(`✅ 工具: ${tools.list().map(t => t.name).join(', ')}`);

  const traceDir = path.resolve(process.cwd(), '.tagent/traces');
  const traceWriter = new TraceWriter(traceDir);

  const costTracker = new CostTracker();

  // ── 测试 1: 简单回答（不用工具） ──
  console.log('\n━━━ 测试 1: 简单回答（无工具调用）━━━');
  const task1 = '什么是 AI Agent？用中文一句话回答。';
  console.log(`📝 "${task1}"`);

  try {
    const r1 = await runAgentLoop(
      {
        id: 'test-simple',
        name: '简单测试',
        systemPrompt: '你是一个简洁的AI助手。一句话回答问题。',
        provider, model: 'deepseek-chat',
        tools, traceWriter, costTracker,
        maxIterations: 2, maxCostPerTask: 0.1,
      },
      task1,
      {
        onIteration: (i) => console.log(`  迭代 #${i}`),
        onTextDelta: (t) => process.stdout.write(t),
        onToolCall: (tool) => console.log(`  🔧 ${tool}`),
        onGovernance: (e) => console.log(`  🛡️ [${e.severity}] ${e.message}`),
      }
    );

    console.log(`\n  ✅ 成功 | 迭代=${r1.iterations} | $${r1.totalCost.toFixed(4)} | tokens=${r1.totalTokens.input}+${r1.totalTokens.output}`);
  } catch (err) {
    console.error(`\n  ❌ 失败:`, (err as Error).message);
    console.error((err as Error).stack);
  }

  // ── 测试 2: 需要搜索的任务 ──
  console.log('\n━━━ 测试 2: 搜索任务（应调用 web_search）━━━');
  const task2 = '搜索一下"Claude 4 发布日期"，告诉我结果。';
  console.log(`📝 "${task2}"`);

  try {
    const r2 = await runAgentLoop(
      {
        id: 'test-search',
        name: '搜索测试',
        systemPrompt: '你是一个研究助手。需要搜索时使用 web_search 工具。用中文回答。',
        provider, model: 'deepseek-chat',
        tools, traceWriter, costTracker,
        maxIterations: 5, maxCostPerTask: 0.5,
      },
      task2,
      {
        onIteration: (i) => console.log(`  迭代 #${i}`),
        onTextDelta: (t) => process.stdout.write(t),
        onToolCall: (tool, args) => console.log(`  🔧 ${tool}(${JSON.stringify(args).slice(0, 60)})`),
        onToolResult: (tool, result) => console.log(`  📦 ${tool}: ${result.length} 字符`),
        onGovernance: (e) => console.log(`  🛡️ [${e.severity}] ${e.message}`),
      }
    );

    console.log(`\n  ✅ 成功 | 迭代=${r2.iterations} | $${r2.totalCost.toFixed(4)} | tokens=${r2.totalTokens.input}+${r2.totalTokens.output}`);
  } catch (err) {
    console.error(`\n  ❌ 失败:`, (err as Error).message);
    console.error((err as Error).stack);
  }

  console.log('\n=== Agent Loop 测试完成 ===');
}

main().catch(console.error);
