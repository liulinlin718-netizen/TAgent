/**
 * 通水测试 Step 3: SSE 流式 API 测试 (模拟前端)
 * 测试 POST /api/agent/run
 */

async function main() {
  console.log('=== Step 3: Server SSE 端到端联调测试 ===\n');

  const url = 'http://localhost:3001/api/agent/run';
  const task = '请简短介绍一下什么是 MCP (Model Context Protocol)？不超过 100 字。';
  
  console.log(`🚀 发送请求至 ${url}`);
  console.log(`📝 任务: "${task}"\n`);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message: task }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`❌ HTTP Error: ${response.status} - ${text}`);
      return;
    }

    if (!response.body) {
      console.error('❌ 没有 Response body');
      return;
    }

    console.log('📡 开始接收 SSE 事件流...\n');

    // 由于 fetch body 默认不支持异步迭代直接以文本形式读取 (在一些老版本Node中)，
    // 我们可以使用一个简单的 TextDecoderStream 或者是通过 reader 来解析 SSE 格式
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      
      let newlineIdx;
      while ((newlineIdx = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 2);
        
        const lines = chunk.split('\n');
        let event = '';
        let data = '';
        
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            event = line.substring(7);
          } else if (line.startsWith('data: ')) {
            data = line.substring(6);
          }
        }
        
        if (event) {
          if (event === 'session') {
            console.log(`[Session] ${data}`);
          } else if (event === 'agent_spawn') {
            const d = JSON.parse(data);
            console.log(`[Agent Spawned] ${d.agentName} (${d.agentId}) -> ${d.objective}`);
          } else if (event === 'agent_progress') {
            const d = JSON.parse(data);
            console.log(`[Progress] Agent ${d.agentId} 正在进行迭代 #${d.iteration}`);
          } else if (event === 'agent_tool_call') {
            const d = JSON.parse(data);
            console.log(`[Tool] Agent ${d.agentId} 调用工具 ${d.tool}: ${JSON.stringify(d.args).slice(0, 100)}`);
          } else if (event === 'governance') {
            const d = JSON.parse(data);
            console.log(`[Governance] 🛡️ [${d.severity}] ${d.message}`);
          } else if (event === 'agent_complete') {
            const d = JSON.parse(data);
            console.log(`[Complete] 🏁 Agent ${d.agentId} 完成。成功: ${d.success}, 成本: $${d.cost}`);
          } else {
            console.log(`[Event: ${event}] ${data.slice(0, 200)}`);
          }
        }
      }
    }

    console.log('\n✅ SSE 连接正常结束');
    
  } catch (error) {
    console.error(`❌ 测试失败:`, error);
  }
}

main().catch(console.error);
