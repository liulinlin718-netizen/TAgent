/**
 * Redis 缓存层 — Plan §5.2
 *
 * 使用 `ioredis` 连接 Redis，为高频读取数据提供缓存。
 * 支持 TTL 管理和自动失效。
 */

import Redis from 'ioredis';

export class RedisCache {
  private client: Redis;
  private prefix: string;

  constructor(
    connectionString: string = 'redis://localhost:6379',
    prefix: string = 'tagent:',
  ) {
    this.client = new Redis(connectionString, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => Math.min(times * 200, 2000),
      lazyConnect: true,
    });
    this.prefix = prefix;
  }

  /** 连接 Redis */
  async connect(): Promise<void> {
    try {
      await this.client.connect();
    } catch {
      // 已连接时忽略错误
    }
  }

  /** 获取缓存数据 */
  async get<T>(key: string): Promise<T | null> {
    try {
      const data = await this.client.get(this.prefix + key);
      if (!data) return null;
      return JSON.parse(data) as T;
    } catch {
      return null;
    }
  }

  /** 设置缓存数据 */
  async set<T>(key: string, value: T, ttlSeconds: number = 300): Promise<void> {
    try {
      const serialized = JSON.stringify(value);
      if (ttlSeconds > 0) {
        await this.client.setex(this.prefix + key, ttlSeconds, serialized);
      } else {
        await this.client.set(this.prefix + key, serialized);
      }
    } catch {
      // 缓存写入失败不应阻断主流程
    }
  }

  /** 删除缓存 */
  async del(key: string): Promise<void> {
    try {
      await this.client.del(this.prefix + key);
    } catch {
      // 静默
    }
  }

  /** 按前缀批量清除 */
  async invalidatePattern(pattern: string): Promise<void> {
    try {
      const keys = await this.client.keys(this.prefix + pattern);
      if (keys.length > 0) {
        await this.client.del(...keys);
      }
    } catch {
      // 静默
    }
  }

  /** 检查连接是否健康 */
  async ping(): Promise<boolean> {
    try {
      const result = await this.client.ping();
      return result === 'PONG';
    } catch {
      return false;
    }
  }

  /** 关闭连接 */
  async close(): Promise<void> {
    await this.client.quit();
  }
}
