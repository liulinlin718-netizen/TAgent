/**
 * 数据库连接验证脚本
 * 运行: npx tsx scripts/verify-db.ts
 */

import postgres from 'postgres';
import Redis from 'ioredis';

async function main() {
  console.log('=== TAgent 数据库连接验证 ===\n');

  // ── PostgreSQL ──
  console.log('1️⃣  PostgreSQL...');
  const dbUrl = 'postgres://tagent:tagent_dev@localhost:5432/tagent';
  const sql = postgres(dbUrl, { connect_timeout: 5 });
  try {
    const [row] = await sql`SELECT version()`;
    console.log('   ✅ 连接成功');
    console.log(`   📦 ${(row.version as string).split(',')[0]}`);

    // 验证 Schema 自动创建
    await sql`
      CREATE TABLE IF NOT EXISTS kv_store (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL DEFAULT '{}',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS trace_index (
        id SERIAL PRIMARY KEY,
        trace_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        span_type TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS idx_trace_session ON trace_index(session_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_trace_agent ON trace_index(agent_id)`;
    console.log('   ✅ Schema 创建成功 (kv_store + trace_index)');

    // 写入/读取测试
    await sql`
      INSERT INTO kv_store (key, value, updated_at)
      VALUES ('__test__', '{"ok": true}'::jsonb, NOW())
      ON CONFLICT (key)
      DO UPDATE SET value = '{"ok": true}'::jsonb, updated_at = NOW()
    `;
    const [check] = await sql`SELECT value FROM kv_store WHERE key = '__test__'`;
    console.log(`   ✅ 读写测试通过: ${JSON.stringify(check.value)}`);
    await sql`DELETE FROM kv_store WHERE key = '__test__'`;

    await sql.end();
  } catch (err) {
    console.log(`   ❌ 失败: ${(err as Error).message}`);
    process.exit(1);
  }

  // ── Redis ──
  console.log('\n2️⃣  Redis...');
  const redis = new Redis('redis://localhost:6379', {
    maxRetriesPerRequest: 1,
    connectTimeout: 5000,
  });
  try {
    const pong = await redis.ping();
    console.log(`   ✅ 连接成功: ${pong}`);

    // 读写测试
    await redis.setex('tagent:__test__', 10, JSON.stringify({ ok: true }));
    const val = await redis.get('tagent:__test__');
    console.log(`   ✅ 读写测试通过: ${val}`);
    await redis.del('tagent:__test__');

    await redis.quit();
  } catch (err) {
    console.log(`   ❌ 失败: ${(err as Error).message}`);
    process.exit(1);
  }

  console.log('\n🎉 所有数据库连接验证通过！');
  console.log('\n连接信息:');
  console.log('  DATABASE_URL = postgres://tagent:tagent_dev@localhost:5432/tagent');
  console.log('  REDIS_URL    = redis://localhost:6379');
}

main().catch(console.error);
