/**
 * PostgreSQL 持久化适配器 — Plan §5.2
 *
 * 使用 `postgres` (porsager/postgres) 轻量 driver。
 * 实现 PersistenceAdapter 接口，数据存储在 kv_store 表 (JSONB)。
 *
 * Schema 自动创建（首次连接时 CREATE TABLE IF NOT EXISTS）。
 */

import postgres from 'postgres';
import type { PersistenceAdapter } from './persistence.js';

export class PostgresPersistence implements PersistenceAdapter {
  private sql: ReturnType<typeof postgres>;
  private initialized = false;

  constructor(connectionString: string) {
    this.sql = postgres(connectionString, {
      max: 10,
      idle_timeout: 20,
      connect_timeout: 10,
    });
  }

  private async ensureSchema(): Promise<void> {
    if (this.initialized) return;
    await this.sql`
      CREATE TABLE IF NOT EXISTS kv_store (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL DEFAULT '{}',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    // Trace 索引表 (plan §5.2: JSONL append-only 文件 + PostgreSQL 索引)
    await this.sql`
      CREATE TABLE IF NOT EXISTS trace_index (
        id SERIAL PRIMARY KEY,
        trace_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        span_type TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await this.sql`
      CREATE INDEX IF NOT EXISTS idx_trace_session ON trace_index(session_id)
    `;
    await this.sql`
      CREATE INDEX IF NOT EXISTS idx_trace_agent ON trace_index(agent_id)
    `;
    this.initialized = true;
  }

  async load<T>(key: string, fallback: T): Promise<T> {
    await this.ensureSchema();
    const rows = await this.sql`
      SELECT value FROM kv_store WHERE key = ${key}
    `;
    if (rows.length === 0) return fallback;
    return rows[0].value as T;
  }

  async save<T>(key: string, data: T): Promise<void> {
    await this.ensureSchema();
    await this.sql`
      INSERT INTO kv_store (key, value, updated_at)
      VALUES (${key}, ${JSON.stringify(data)}::jsonb, NOW())
      ON CONFLICT (key)
      DO UPDATE SET value = ${JSON.stringify(data)}::jsonb, updated_at = NOW()
    `;
  }

  /** 关闭连接池 */
  async close(): Promise<void> {
    await this.sql.end();
  }
}
