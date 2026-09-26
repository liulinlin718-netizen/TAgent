import * as fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { WorkflowEvent, WorkflowTracePage, WorkflowTraceScope } from '@tagent/core';
import type { WorkflowSource } from './workflow-catalog.js';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const identity = (scope: WorkflowTraceScope) => hash(JSON.stringify([scope.workspaceId, scope.sessionId, scope.runId]));
const MAX_EVENT = 512 * 1024, MAX_EVENTS = 50000, MAX_FILE = 128 * 1024 * 1024, MAX_PAGE = 1024 * 1024;
interface Offset { id: string; offset: number; length: number; hash: string; agentId?: string; type: string }
interface Index { version: 1; scope: WorkflowTraceScope; generation: string; bytes: number; entries: Offset[] }
interface State { index: Index; ids: Map<string, Offset>; source?: WorkflowEvent[]; sourceLength?: number; rebuilt: boolean }
export class WorkflowIndexError extends Error {
  constructor(message: string, readonly status: 400 | 409 | 413 | 503 = 503) { super(message); }
}

/** Derived index: saved messages/checkpoints remain authoritative. Committed JSONL prefixes never change. */
export class WorkflowIndex {
  private states = new Map<string, State>();
  private queues = new Map<string, Promise<unknown>>();
  private invalid = new Set<string>();
  private readonly dir: string;
  constructor(private readonly root: string) { this.dir = join(root, '.tagent', 'workflow-index'); }
  private serial<T>(scope: WorkflowTraceScope, operation: () => Promise<T>): Promise<T> {
    const key = identity(scope), previous = this.queues.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.queues.set(key, current);
    void current.finally(() => { if (this.queues.get(key) === current) this.queues.delete(key); }).catch(() => {});
    return current;
  }
  private async directory() {
    for (const directory of [this.root, join(this.root, '.tagent'), this.dir]) {
      const info = await fs.lstat(directory).catch(error => { if (error.code !== 'ENOENT') throw error; return undefined; });
      if (info) { if (!info.isDirectory() || info.isSymbolicLink()) throw new WorkflowIndexError('Trace 索引目录不是受信本地目录。'); }
      else {
        await fs.mkdir(directory).catch(error => { if (error.code !== 'EEXIST') throw error; });
        const created = await fs.lstat(directory);
        if (!created.isDirectory() || created.isSymbolicLink()) throw new WorkflowIndexError('Trace 索引目录不是受信本地目录。');
      }
    }
  }
  private async checkFile(file: string) {
    const info = await fs.lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; return undefined; });
    if (info && (!info.isFile() || info.isSymbolicLink())) throw new WorkflowIndexError('Trace 索引文件类型不正确。');
    return info;
  }
  private metadata(scope: WorkflowTraceScope) { return join(this.dir, identity(scope) + '.index.json'); }
  private data(index: Index) { return join(this.dir, identity(index.scope) + '.' + index.generation + '.jsonl'); }
  private fresh(scope: WorkflowTraceScope, rebuilt: boolean): State {
    return { index: { version: 1, scope: { workspaceId: scope.workspaceId, sessionId: scope.sessionId, runId: scope.runId }, generation: randomUUID(), bytes: 0, entries: [] }, ids: new Map(), rebuilt };
  }
  private async load(scope: WorkflowTraceScope): Promise<State> {
    if (this.invalid.has(identity(scope))) return this.fresh(scope, true);
    const cached = this.states.get(identity(scope)); if (cached) return cached;
    await this.directory();
    const info = await this.checkFile(this.metadata(scope));
    if (!info) return this.fresh(scope, false);
    if (info.size > 16 * 1024 * 1024) throw new WorkflowIndexError('Trace 索引元数据超出大小限制。', 413);
    try {
      const index: Index = JSON.parse(await fs.readFile(this.metadata(scope), 'utf8'));
      if (!index || index.version !== 1 || identity(index.scope) !== identity(scope) || !/^[a-f0-9-]{36}$/.test(index.generation)
        || !Array.isArray(index.entries) || index.entries.length > MAX_EVENTS || !Number.isSafeInteger(index.bytes) || index.bytes < 0 || index.bytes > MAX_FILE) throw new Error('Invalid index');
      let offset = 0; const ids = new Map<string, Offset>();
      for (const entry of index.entries) {
        if (!entry || typeof entry.id !== 'string' || ids.has(entry.id) || entry.offset !== offset || !Number.isSafeInteger(entry.length)
          || entry.length < 2 || entry.length > MAX_EVENT || !/^[a-f0-9]{64}$/.test(entry.hash) || typeof entry.type !== 'string'
          || (entry.agentId !== undefined && typeof entry.agentId !== 'string')) throw new Error('Invalid offset');
        ids.set(entry.id, entry); offset += entry.length;
      }
      if (offset !== index.bytes) throw new Error('Invalid length');
      const data = await this.checkFile(this.data(index));
      if (!data || data.size < index.bytes || data.size > MAX_FILE) throw new Error('Incomplete index');
      // A crash can leave an uncommitted tail after the last atomically saved offset.
      if (data.size > index.bytes) {
        const file = await fs.open(this.data(index), 'r+');
        try { await file.truncate(index.bytes); await file.sync(); } finally { await file.close(); }
      }
      return { index, ids, rebuilt: false };
    } catch (error) {
      if (error instanceof WorkflowIndexError) throw error;
      if (error && typeof error === 'object' && 'code' in error && !['ENOENT'].includes(String(error.code))) throw error;
      return this.fresh(scope, true);
    }
  }
  private line(scope: WorkflowTraceScope, event: WorkflowEvent) {
    if (!event || !event.eventId || event.runId !== scope.runId || event.sessionId !== scope.sessionId || !Number.isFinite(event.timestamp)
      || typeof event.type !== 'string' || typeof event.summary !== 'string') throw new WorkflowIndexError('Trace 事件归属或格式不正确。', 409);
    const bytes = Buffer.from(JSON.stringify(event) + '\n', 'utf8');
    if (bytes.length > MAX_EVENT) throw new WorkflowIndexError('单条 Trace 事件超过512 KiB查看上限。', 413);
    return bytes;
  }
  private async commit(state: State, buffers: Buffer[], entries: Offset[]) {
    const { index } = state, next = { ...index, entries: [...index.entries, ...entries], bytes: index.bytes + buffers.reduce((sum, buffer) => sum + buffer.length, 0) };
    if (next.entries.length > MAX_EVENTS || next.bytes > MAX_FILE) throw new WorkflowIndexError('本任务 Trace 超过索引查看上限。', 413);
    await this.directory(); await this.checkFile(this.data(index)); await this.checkFile(this.metadata(index.scope));
    const file = await fs.open(this.data(index), 'a+');
    try {
      const info = await file.stat();
      if (info.size < index.bytes) throw new WorkflowIndexError('Trace 数据文件不完整，请刷新以重建索引。');
      if (info.size > index.bytes) await file.truncate(index.bytes);
      for (const buffer of buffers) await file.writeFile(buffer);
      await file.sync();
    } finally { await file.close(); }
    const temporary = this.metadata(index.scope) + '.' + randomUUID() + '.tmp';
    try {
      await fs.writeFile(temporary, JSON.stringify(next), { encoding: 'utf8', flag: 'wx', flush: true });
      await fs.rename(temporary, this.metadata(index.scope));
    } finally { await fs.rm(temporary, { force: true }); }
    const changed = this.states.get(identity(index.scope))?.index.generation !== index.generation;
    state.index = next; entries.forEach(entry => state.ids.set(entry.id, entry));
    this.states.set(identity(index.scope), state);
    while (this.states.size > 64) this.states.delete(this.states.keys().next().value!);
    this.invalid.delete(identity(index.scope));
    if (changed) await this.prune(index.scope, index.generation);
  }
  private async prune(scope: WorkflowTraceScope, keep?: string) {
    const key = identity(scope);
    const names = await fs.readdir(this.dir).catch(error => { if (error.code !== 'ENOENT') throw error; return [] as string[]; });
    for (const name of names) {
      const dataFile = new RegExp('^' + key + '\\.[a-f0-9-]{36}\\.jsonl$').test(name);
      const temporary = new RegExp('^' + key + '\\.index\\.json\\.[a-f0-9-]{36}\\.tmp$').test(name);
      if ((!dataFile && !temporary) || name === key + '.' + keep + '.jsonl') continue;
      await this.checkFile(join(this.dir, name)); await fs.rm(join(this.dir, name), { force: true });
    }
    if (!keep) { await this.checkFile(this.metadata(scope)); await fs.rm(this.metadata(scope), { force: true }); }
  }
  async remove(scope: WorkflowTraceScope) {
    return this.serial(scope, async () => {
      const present = await fs.lstat(this.dir).catch(error => { if (error.code !== 'ENOENT') throw error; return undefined; });
      if (present) { await this.directory(); await this.prune(scope); }
      this.states.delete(identity(scope)); this.invalid.delete(identity(scope));
    });
  }
  private async sync(source: WorkflowSource) {
    let state = await this.load(source);
    if (source.persisted && state.source === source.traces && state.sourceLength === source.traces.length) return state;
    if (source.traces.length > MAX_EVENTS) throw new WorkflowIndexError('本任务 Trace 超过50000条查看上限。', 413);
    const unique = new Map<string, WorkflowEvent>();
    for (const event of source.traces) {
      const previous = unique.get(event.eventId);
      if (previous && JSON.stringify(previous) !== JSON.stringify(event)) throw new WorkflowIndexError('来源中存在冲突的 Trace 事件。', 409);
      unique.set(event.eventId, event);
    }
    const events = [...unique.values()];
    if (!source.persisted && state.index.entries.length > events.length) throw new WorkflowIndexError('该任务尚未完成保存，请稍后核对恢复记录。');
    const lines = events.map(event => this.line(source, event));
    const prefix = state.index.entries.every((entry, i) => lines[i] && hash(lines[i]) === entry.hash && events[i].eventId === entry.id);
    if (!prefix) state = this.fresh(source, true);
    const buffers = lines.slice(state.index.entries.length); let offset = state.index.bytes;
    const entries = buffers.map((buffer, i) => {
      const event = events[state.index.entries.length + i];
      const entry: Offset = { id: event.eventId, offset, length: buffer.length, hash: hash(buffer), type: event.type, agentId: event.agentId };
      offset += buffer.length; return entry;
    });
    if (buffers.length || this.states.get(identity(source)) !== state) await this.commit(state, buffers, entries);
    state.source = source.traces; state.sourceLength = source.traces.length;
    return state;
  }
  async append(scope: WorkflowTraceScope, event: WorkflowEvent) {
    return this.appendMany(scope, [event]);
  }
  async appendMany(scope: WorkflowTraceScope, events: WorkflowEvent[]) {
    const snapshots = structuredClone(events);
    return this.serial(scope, async () => {
      const state = await this.load(scope), buffers: Buffer[] = [], entries: Offset[] = [];
      const known = new Map(state.ids);
      let offset = state.index.bytes;
      for (const snapshot of snapshots) {
        const buffer = this.line(scope, snapshot), digest = hash(buffer), previous = known.get(snapshot.eventId);
        if (previous) {
          if (previous.hash !== digest) throw new WorkflowIndexError('同一 Trace 事件不能被改写。', 409);
          continue;
        }
        const entry: Offset = { id: snapshot.eventId, offset, length: buffer.length, hash: digest, type: snapshot.type, agentId: snapshot.agentId };
        known.set(entry.id, entry); entries.push(entry); buffers.push(buffer); offset += buffer.length;
      }
      if (buffers.length) await this.commit(state, buffers, entries);
    }).catch(error => { this.states.delete(identity(scope)); throw error; });
  }
  async query(source: WorkflowSource, filter: { agentId?: string; type?: string; limit?: number; cursor?: string } = {}): Promise<WorkflowTracePage> {
    if ((filter.limit !== undefined && (!Number.isInteger(filter.limit) || filter.limit < 1 || filter.limit > 100))
      || (filter.cursor?.length || 0) > 1024 || (filter.agentId?.length || 0) > 200 || (filter.type?.length || 0) > 100) throw new WorkflowIndexError('Trace 查询参数不正确。', 400);
    return this.serial(source, async () => {
      const state = await this.sync(source), { index } = state;
      const fingerprint = hash(JSON.stringify([identity(source), filter.agentId || '', filter.type || '']));
      let after = -1, upper = index.entries.length;
      if (filter.cursor) {
        let cursor: unknown;
        try { cursor = JSON.parse(Buffer.from(filter.cursor, 'base64url').toString('utf8')); } catch { throw new WorkflowIndexError('Trace 游标无效，请刷新记录。', 400); }
        if (!Array.isArray(cursor) || cursor.length !== 4 || cursor[0] !== fingerprint || !Number.isSafeInteger(cursor[2]) || !Number.isSafeInteger(cursor[3])
          || cursor[2] < -1 || cursor[3] < 0 || cursor[2] >= cursor[3]) throw new WorkflowIndexError('Trace 游标不属于当前筛选。', 400);
        if (cursor[1] !== index.generation || cursor[3] > index.entries.length) throw new WorkflowIndexError('Trace 索引已更新，请刷新记录。', 409);
        after = cursor[2]; upper = cursor[3];
      }
      const matching = index.entries.map((entry, position) => ({ entry, position })).slice(0, upper)
        .filter(({ entry }) => (!filter.agentId || entry.agentId === filter.agentId) && (!filter.type || entry.type === filter.type));
      const remaining = matching.filter(item => item.position > after);
      const selected: typeof remaining = []; let size = 0;
      for (const item of remaining) { if (selected.length >= (filter.limit || 40) || size + item.entry.length > MAX_PAGE) break; selected.push(item); size += item.entry.length; }
      await this.checkFile(this.data(index));
      const file = await fs.open(this.data(index), 'r'), events: WorkflowEvent[] = [];
      try {
        for (const { entry } of selected) {
          const buffer = Buffer.alloc(entry.length); let read = 0;
          while (read < buffer.length) { const part = await file.read(buffer, read, buffer.length - read, entry.offset + read); if (!part.bytesRead) break; read += part.bytesRead; }
          if (read !== entry.length || hash(buffer) !== entry.hash) { this.states.delete(identity(source)); this.invalid.add(identity(source)); throw new WorkflowIndexError('Trace 数据校验失败，请刷新记录以核对存储。'); }
          const event: WorkflowEvent = JSON.parse(buffer.toString('utf8'));
          if (event.eventId !== entry.id || event.runId !== source.runId || event.sessionId !== source.sessionId) throw new WorkflowIndexError('Trace 数据归属校验失败。');
          events.push(event);
        }
      } finally { await file.close(); }
      const last = selected.at(-1)?.position;
      return { workspaceId: source.workspaceId, sessionId: source.sessionId, runId: source.runId, events, total: matching.length,
        available: index.entries.length, agents: [...new Set(index.entries.flatMap(entry => entry.agentId ? [entry.agentId] : []))],
        types: [...new Set(index.entries.map(entry => entry.type))], persisted: source.persisted, rebuilt: state.rebuilt,
        nextCursor: remaining.length > selected.length && last !== undefined ? Buffer.from(JSON.stringify([fingerprint, index.generation, last, upper])).toString('base64url') : null };
    }).catch(error => {
      if (error instanceof WorkflowIndexError) throw error;
      this.states.delete(identity(source)); throw new WorkflowIndexError('Trace 索引暂不可用；任务原始记录没有被修改。');
    });
  }
}

/** Index IO is derived work: bounded per run and never a precondition for model output or approval. */
export class WorkflowIndexRecorder {
  private buffer: WorkflowEvent[] = [];
  private pending?: Promise<void>;
  private inFlight = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private failed = false;
  constructor(private readonly index: WorkflowIndex, private readonly scope: WorkflowTraceScope, private readonly onFailure: () => void) {}
  record(event: WorkflowEvent) {
    if (this.failed) return;
    if (this.buffer.length + this.inFlight >= 32) { this.failed = true; this.onFailure(); return; }
    this.buffer.push(structuredClone(event));
    if (!this.pending && !this.timer) this.timer = setTimeout(() => this.start(), 20);
  }
  private start() {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (this.pending || !this.buffer.length) return;
    const batch = this.buffer.splice(0); this.inFlight = batch.length;
    const operation = this.index.appendMany(this.scope, batch).catch(() => {
      if (!this.failed) { this.failed = true; this.onFailure(); }
    }).finally(() => {
      this.pending = undefined; this.inFlight = 0;
      if (this.buffer.length && !this.failed) this.timer = setTimeout(() => this.start(), 20);
    });
    this.pending = operation;
  }
  async flush() {
    while (this.pending || this.buffer.length) {
      if (!this.pending) this.start();
      if (this.pending) await this.pending;
    }
  }
}

export async function removeWorkflowIndexes(index: WorkflowIndex, sources: WorkflowTraceScope[]): Promise<string[]> {
  let failed = false;
  for (const source of sources) {
    try { await index.remove(source); } catch { failed = true; }
  }
  return failed ? ['会话已删除，但部分本地 Trace 索引副本清理失败；接口已禁止读取，请检查数据目录的磁盘权限。'] : [];
}
