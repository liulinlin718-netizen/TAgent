/**
 * 持久化存储适配器 — D13 (plan §3.9 Phase 4+)
 *
 * JSON 文件存储：将内存数据持久化到 .tagent/store.json
 * 设计为可替换接口，Phase 4+ 可升级为 SQLite/PostgreSQL
 */

import * as fs from 'fs/promises';
import * as path from 'path';

export interface PersistenceAdapter {
  load<T>(key: string, fallback: T): Promise<T>;
  save<T>(key: string, data: T): Promise<void>;
}

/**
 * D13: JSON 文件持久化适配器
 * 数据存储在 .tagent/<key>.json
 */
export class FilePersistence implements PersistenceAdapter {
  private dir: string;

  constructor(workspaceRoot: string) {
    this.dir = path.join(workspaceRoot, '.tagent', 'data');
  }

  private async ensureDir(): Promise<void> {
    try {
      await fs.access(this.dir);
    } catch {
      await fs.mkdir(this.dir, { recursive: true });
    }
  }

  async load<T>(key: string, fallback: T): Promise<T> {
    try {
      await this.ensureDir();
      const filePath = path.join(this.dir, `${key}.json`);
      const data = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(data) as T;
    } catch {
      return fallback;
    }
  }

  async save<T>(key: string, data: T): Promise<void> {
    await this.ensureDir();
    const filePath = path.join(this.dir, `${key}.json`);
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }
}

/**
 * D13: 内存持久化（测试/开发用，不实际写盘）
 */
export class MemoryPersistence implements PersistenceAdapter {
  private data = new Map<string, unknown>();

  async load<T>(key: string, fallback: T): Promise<T> {
    return (this.data.get(key) as T) ?? fallback;
  }

  async save<T>(key: string, data: T): Promise<void> {
    this.data.set(key, data);
  }
}

/**
 * 工厂函数: 根据环境变量选择持久化适配器 (plan §5.2)
 *
 * - DATABASE_URL 存在 → PostgresPersistence
 * - 否则 → FilePersistence (默认)
 */
export function createPersistence(workspaceRoot: string): PersistenceAdapter {
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    // 延迟导入避免无 pg 时报错
    const { PostgresPersistence } = require('./postgres-persistence.js');
    return new PostgresPersistence(dbUrl) as PersistenceAdapter;
  }
  return new FilePersistence(workspaceRoot);
}
