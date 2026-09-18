import { fromBuffer, type Entry, type ZipFile } from 'yauzl';
import type { Readable } from 'node:stream';

/** Read only explicitly selected regular files, in memory. Never extract archive paths to disk. */
export async function readSkillArchive(bytes: Buffer, wanted: Map<string, number>, signal: AbortSignal): Promise<Map<string, Buffer>> {
  signal.throwIfAborted();
  if (bytes.length > 8_000_000 || wanted.size > 256) throw new Error('Skill 归档超过大小限制。');
  const zip = await new Promise<ZipFile>((resolve, reject) => fromBuffer(bytes, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, value) => error ? reject(error) : resolve(value)));
  return new Promise((resolve, reject) => {
    const files = new Map<string, Buffer>();
    let total = 0, count = 0, done = false;
    let active: Readable | undefined;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', abort);
      active?.destroy();
      zip.close();
      if (error) reject(error);
      else if (files.size !== wanted.size) reject(new Error('固定版本归档缺少选定文件，未生成不完整草稿。'));
      else resolve(files);
    };
    const abort = () => finish(new Error('Skill 归档读取已取消或超时。'));
    zip.on('error', finish);
    zip.once('end', () => finish());
    signal.addEventListener('abort', abort, { once: true });
    const read = async (entry: Entry) => {
      signal.throwIfAborted();
      if (++count > 20_000) throw new Error('归档目录过大，请选择独立 Skill 仓库。');
      const path = entry.fileName.split('/').slice(1).join('/');
      if (!wanted.has(path)) return;
      const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
      if (mode && mode !== 0x8000) throw new Error('Skill 归档资源不是普通文件。');
      if (files.has(path)) throw new Error('Skill 归档包含重复文件路径。');
      if (entry.uncompressedSize !== wanted.get(path) || entry.uncompressedSize > 120_000 || entry.uncompressedSize < 0) throw new Error('Skill 归档文件大小不匹配。');
      active = await new Promise<Readable>((resolve, reject) => zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream)));
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of active) {
        signal.throwIfAborted();
        size += chunk.length;
        total += chunk.length;
        if (size > entry.uncompressedSize || total > 1_000_000) throw new Error('Skill 归档解压大小超过限制。');
        chunks.push(Buffer.from(chunk));
      }
      if (size !== entry.uncompressedSize) throw new Error('Skill 归档文件不完整。');
      files.set(path, Buffer.concat(chunks));
      active = undefined;
    };
    zip.on('entry', entry => { void read(entry).then(() => { if (!done) zip.readEntry(); }).catch(finish); });
    if (signal.aborted) abort();
    else zip.readEntry();
  });
}
