import { describe, expect, it } from 'vitest';
import { readSkillArchive } from '../skill-archive.js';

// Stored-entry ZIP fixture builder, also permits corrupt sizes and modes for negative tests.
function zipFixture(items: Array<{ path: string; text: string; mode?: number; size?: number }>) {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const item of items) {
    const name = Buffer.from(item.path), data = Buffer.from(item.text);
    let crc = 0xffffffff;
    for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(item.size ?? data.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(0x314, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8);
    directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(item.size ?? data.length, 24); directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(((item.mode ?? 0x81a4) << 16) >>> 0, 38); directory.writeUInt32LE(offset, 42);
    central.push(directory, name); offset += header.length + name.length + data.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(items.length, 8); end.writeUInt16LE(items.length, 10);
  end.writeUInt32LE(Buffer.concat(central).length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}
const signal = () => new AbortController().signal;
describe('bounded in-memory Skill archive', () => {
  it('reads only selected files without unpacking unrelated content', async () => {
    const files = await readSkillArchive(zipFixture([{ path: 'repo/skill/guide.md', text: '你好' }, { path: 'repo/other.bin', text: 'x'.repeat(200_000) }]), new Map([['skill/guide.md', 6]]), signal());
    expect([...files.keys()]).toEqual(['skill/guide.md']);
    expect(files.get('skill/guide.md')?.toString('utf8')).toBe('你好');
  });
  it.each([
    [{ path: 'repo/../guide.md', text: 'x' }],
    [{ path: 'repo/guide.md', text: 'x', mode: 0xa1ff }],
    [{ path: 'repo/guide.md', text: 'x' }, { path: 'repo/guide.md', text: 'x' }],
    [{ path: 'repo/guide.md', text: 'x'.repeat(500), size: 1 }],
    [{ path: 'repo/other.md', text: 'x' }],
  ])('rejects unsafe, duplicate, truncated or missing resources %#', async (...items) => {
    await expect(readSkillArchive(zipFixture(items), new Map([['guide.md', 1]]), signal())).rejects.toThrow();
  });
  it('honors cancellation and refuses oversize archives before parsing', async () => {
    await expect(readSkillArchive(Buffer.alloc(8_000_001), new Map(), signal())).rejects.toThrow('大小');
    await expect(readSkillArchive(zipFixture([]), new Map(), AbortSignal.abort())).rejects.toThrow();
  });
});
