/**
 * TAgent CLI Runner — 快速验证 Agent Loop
 *
 * 用法：
 *   npx tsx packages/tagent-core/src/cli.ts "帮我调研支付 agent 的现状"
 *
 * 环境变量（优先级从高到低）：
 *   DEEPSEEK_API_KEY — DeepSeek API key (Anthropic兼容)
 *   ANTHROPIC_API_KEY — Claude API key
 *   OPENAI_API_KEY — OpenAI API key
 *   TAVILY_API_KEY — Tavily 搜索 API key (可选)
 */

import { AnthropicProvider, OpenAIProvider, CostTracker } from '@tagent/ai';
import type { LLMProvider } from '@tagent/ai';
import { runAgentLoop, ToolRegistry, TraceWriter, createWebSearchTool, createUrlReaderTool } from './index.js';

function selectProvider(): { provider: LLMProvider; model: string } {
  // DeepSeek (Anthropic-compatible API) — 优先
  if (process.env.DEEPSEEK_API_KEY) {
    return {
      provider: new AnthropicProvider({
        apiKey: process.env.DEEPSEEK_API_KEY,
        baseURL: 'https://api.deepseek.com/anthropic',
        name: 'deepseek',
      }),
      model: 'deepseek-chat',
    };
  }

  // Anthropic Claude
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      provider: new AnthropicProvider(),
      model: 'claude-sonnet-4-20250514',
    };
  }

  // OpenAI GPT
  if (process.env.OPENAI_API_KEY) {
    return {
      provider: new OpenAIProvider(),
      model: 'gpt-4o',
    };
  }

  console.error('❌ 请设置 DEEPSEEK_API_KEY、ANTHROPIC_API_KEY 或 OPENAI_API_KEY');
  process.exit(1);
}

async function main() {
  const userMessage = process.argv[2] || '帮我调研支付 agent 的现状';

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🤖 TAgent — AI 办公协作助手');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📝 任务: ${userMessage}`);
  console.log('');

  const { provider, model } = selectProvider();
  console.log(`🔧 Provider: ${provider.name} (${model})`);

  // Setup tools
  const tools = new ToolRegistry();
  tools.register(createWebSearchTool());
  tools.register(createUrlReaderTool());
  console.log(`🛠️  工具: ${tools.list().join(', ')}`);
  console.log('');

  // Setup trace & cost
  const traceWriter = new TraceWriter('./traces/trace.jsonl');
  const costTracker = new CostTracker();

  // Run!
  console.log('🚀 开始执行...');
  console.log('─────────────────────────────────────────────');

  const result = await runAgentLoop(
    {
      id: 'research-agent',
      name: 'Research Agent',
      systemPrompt: `你是 TAgent 的研究助手。你的任务是帮助用户进行调研和信息收集。

你有以下工具可用：
- web_search: 搜索互联网获取信息
- read_url: 读取网页的详细内容

工作流程：
1. 先用 web_search 搜索相关信息
2. 找到有价值的链接后，用 read_url 深入阅读
3. 综合所有信息，生成结构化的调研报告

报告格式要求：
- 使用清晰的中文标题和子标题
- 列出关键发现
- 标注信息来源
- 给出总结和建议

重要：每次只调用一个工具，等结果返回后再决定下一步。`,
      provider,
      model,
      tools,
      traceWriter,
      costTracker,
      maxIterations: 10,
      maxCostPerTask: 0.5,
    },
    userMessage,
    {
      onIteration: (i) => console.log(`\n📍 迭代 #${i}`),
      onToolCall: (tool, args) => console.log(`  🔧 调用工具: ${tool}(${JSON.stringify(args).slice(0, 100)})`),
      onToolResult: (tool, result) => console.log(`  ✅ ${tool} 返回 ${result.length} 字符`),
      onGovernance: (event) => console.log(`  🛡️ 治理: ${event.message}`),
      onTextDelta: () => {},
      onComplete: () => {},
    },
  );

  console.log('─────────────────────────────────────────────');
  console.log('');

  if (result.success) {
    console.log('📊 调研报告:');
    console.log('═════════════════════════════════════════════');
    console.log(result.output);
    console.log('═════════════════════════════════════════════');
  } else {
    console.log('❌ 任务未完成:', result.output);
  }

  console.log('');
  console.log('📈 执行统计:');
  console.log(`  迭代次数: ${result.iterations}`);
  console.log(`  Token 消耗: ${result.totalTokens.input} input + ${result.totalTokens.output} output`);
  console.log(`  总费用: $${result.totalCost.toFixed(4)}`);
  console.log(`  Trace 文件: ${result.traceFile}`);
}

main().catch(console.error);
