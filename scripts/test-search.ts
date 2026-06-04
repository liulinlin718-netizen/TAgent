/**
 * 通水测试 Step 1: Web Search 工具
 * 验证搜索工具在当前网络环境下能否返回结果
 */

import { createWebSearchTool } from '../packages/tagent-core/src/tools/web-search.js';

async function main() {
  console.log('=== Step 1: Web Search 工具测试 ===\n');

  const searchTool = createWebSearchTool();
  
  console.log('🔍 测试搜索: "支付 agent 现状 2024"');
  console.log('─'.repeat(50));
  
  const start = Date.now();
  try {
    const result = await searchTool.execute({ query: '支付 agent 现状 2024', maxResults: 3 });
    const elapsed = Date.now() - start;
    
    if (result.includes('搜索暂时不可用')) {
      console.log(`❌ 搜索失败 (${elapsed}ms): 所有搜索源均不可用`);
      console.log(result);
    } else {
      console.log(`✅ 搜索成功 (${elapsed}ms)`);
      // 只打印前500字
      console.log(result.slice(0, 500));
      if (result.length > 500) console.log(`\n... (总共 ${result.length} 字符)`);
    }
  } catch (err) {
    console.log(`❌ 搜索异常: ${(err as Error).message}`);
  }

  console.log('\n' + '─'.repeat(50));
  console.log('🔍 测试搜索: "AI agent framework comparison"');
  console.log('─'.repeat(50));
  
  const start2 = Date.now();
  try {
    const result2 = await searchTool.execute({ query: 'AI agent framework comparison', maxResults: 3 });
    const elapsed2 = Date.now() - start2;
    
    if (result2.includes('搜索暂时不可用')) {
      console.log(`❌ 搜索失败 (${elapsed2}ms)`);
    } else {
      console.log(`✅ 搜索成功 (${elapsed2}ms)`);
      console.log(result2.slice(0, 500));
    }
  } catch (err) {
    console.log(`❌ 搜索异常: ${(err as Error).message}`);
  }
}

main().catch(console.error);
