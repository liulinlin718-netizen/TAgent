import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LLMProvider, LLMResponse } from '@tagent/ai';
import { mkdtemp, readFile, mkdir, rename, rm, readdir, writeFile } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { createSkillPackageDraft, DEFAULT_RESIDENT_SKILLS, SkillsRegistry, type SkillInput } from '../skills-registry.js';
import { createSkillFileTool } from '../tools/skill-file.js';
import { formatSkillForPrompt, runOrchestrator } from '../orchestrator.js';
import { AgentPool } from '../agent-pool.js';

vi.mock('../trace.js', () => ({ TraceWriter: class { write() {} getPath() { return 'fixture-trace'; } } }));

const roots: string[] = [];
async function temporary() { const dir = await mkdtemp(join(tmpdir(), 'tagent-skill-package-')); roots.push(dir); return dir; }
afterEach(async () => { vi.restoreAllMocks(); for (const dir of roots.splice(0)) { const rel = relative(tmpdir(), dir); if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('unsafe cleanup'); await rm(dir, { recursive: true, force: true }); } });
function input(): SkillInput {
  const skill = { name: '中文办公技能', description: '真实资源', category: 'office', body: '按需读取 references/source.md，不编造来源。' };
  const pkg = createSkillPackageDraft(skill);
  pkg.source = { kind: 'github', url: 'https://github.com/demo/skill', commit: '1'.repeat(40), root: 'skill', complete: true };
  pkg.files = [{ path: 'references/source.md', url: 'https://example.com/source', content: '专属参考资料：日期 2026-09-12，emoji ✅。', size: 80, encoding: 'utf8', status: 'included' }];
  return { ...skill, package: pkg };
}

describe('saved Skill package resources', () => {
  it('updates built-in project guidance without replacing a saved Skill or writing during reads', async () => {
    const risk = DEFAULT_RESIDENT_SKILLS.find(skill => skill.id === 'risk-tracking')!;
    expect(risk.package?.instructions).toContain('未评估');
    expect(risk.package?.instructions).toContain('不能把已知依赖条件当作高概率证据');
    const root = await temporary();
    await mkdir(join(root, '.tagent'));
    const saved = { ...structuredClone(risk), body: '用户自定义风险方法', package: createSkillPackageDraft({ name: risk.name, body: '用户自定义风险方法' }) };
    const file = join(root, '.tagent', 'skills.json'), content = JSON.stringify([saved]);
    await writeFile(file, content, 'utf8');
    const restored = await new SkillsRegistry(root).getSkill(risk.id);
    expect(restored?.body).toBe('用户自定义风险方法');
    expect(restored?.package?.instructions).toBe('用户自定义风险方法');
    expect(await readFile(file, 'utf8')).toBe(content);
    expect(formatSkillForPrompt(restored!)).toContain('模板字段不是材料事实');
  });
  it.each([true, false])('uses the bound package in the real Orchestrator loop, respecting permissions (allowed=%s)', async allowed => {
    const root = await temporary();
    const registry = new SkillsRegistry(root);
    const saved = await registry.addSkill(input());
    const pool = new AgentPool();
    const card = pool.getAgent('research-agent')!;
    card.capabilities.skills = [saved.id];
    card.constraints.allowedTools = allowed ? ['read_skill_file'] : [];
    vi.spyOn(pool, 'findBestAgentForTask').mockReturnValue(card);
    const answer = (content: string): LLMResponse => ({ content, model: 'fixture', stopReason: 'end', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, cost: 0 } });
    let index = 0;
    const replies: string[] = [];
    const call = vi.fn<LLMProvider['call']>(async params => {
      if (index++ === 0) return answer('[]');
      if (index === 2) {
        expect(params.tools?.map(tool => tool.name) || []).toEqual(allowed ? ['read_skill_file'] : []);
        expect(params.messages[0].content).toContain(saved.id);
        expect(params.messages[0].content).not.toContain('专属参考资料');
        return { ...answer(''), stopReason: 'tool_use', toolCalls: [{ id: 'resource-read', name: 'read_skill_file', arguments: JSON.stringify({ skillId: saved.id, path: 'references/source.md' }) }] };
      }
      replies.push(...params.messages.filter(message => message.role === 'tool').map(message => message.content));
      return answer('已整理给定资料。');
    });
    await runOrchestrator({ agentPool: pool, skillsRegistry: registry, model: 'fixture', provider: { name: 'fixture', call, stream: async function* () {} } }, '整理给定资料，不联网');
    expect(replies.length).toBeGreaterThan(0);
    expect(replies.some(value => value.includes('专属参考资料'))).toBe(allowed);
    expect(card.constraints.allowedTools).toEqual(allowed ? ['read_skill_file'] : []);
  });
  it('does not write during reads; preserves resources, UTF-8 and provenance after updates and restart', async () => {
    const root = await temporary();
    const registry = new SkillsRegistry(root);
    await registry.getSkills();
    expect(await readdir(root)).toEqual([]);
    const saved = await registry.addSkill(input());
    await registry.updateSkill(saved.id, { name: '调整后的名称' });
    const restored = await new SkillsRegistry(root).getSkill(saved.id);
    expect(restored?.package?.files).toEqual(input().package?.files);
    expect(restored?.package?.source).toEqual(saved.package?.source);
    expect(restored?.package?.manifest.name).toBe('调整后的名称');
    const text = await readFile(join(root, '.tagent', 'skills.json'), 'utf8');
    expect(text).toContain('emoji ✅');
    await registry.deleteSkill(saved.id);
    expect(await new SkillsRegistry(root).getSkill(saved.id)).toBeUndefined();
  });

  it('serializes concurrent saves and returns isolated snapshots', async () => {
    const root = await temporary();
    const registry = new SkillsRegistry(root);
    const values = await Promise.all(Array.from({ length: 8 }, (_, index) => registry.addSkill({ ...input(), name: `skill-${index}` })));
    const first = (await registry.getSkill(values[0].id))!;
    first.package!.files![0].content = 'tampered';
    expect((await registry.getSkill(first.id))?.package?.files?.[0].content).not.toBe('tampered');
    const restored = await new SkillsRegistry(root).getSkills();
    expect(values.every(value => restored.some(skill => skill.id === value.id))).toBe(true);
  });

  it('does not publish a failed disk save; the mutation queue recovers', async () => {
    const root = await temporary();
    const registry = new SkillsRegistry(root);
    const saved = await registry.addSkill(input());
    const file = join(root, '.tagent', 'skills.json');
    await rename(file, `${file}.backup`);
    await mkdir(file);
    await expect(registry.updateSkill(saved.id, { name: 'not saved' })).rejects.toThrow();
    expect((await registry.getSkill(saved.id))?.name).toBe(saved.name);
    expect((await readdir(join(root, '.tagent'))).some(name => name.endsWith('.tmp'))).toBe(false);
    await rm(file, { recursive: true });
    await rename(`${file}.backup`, file);
    await registry.updateSkill(saved.id, { name: 'retry saved' });
    expect((await new SkillsRegistry(root).getSkill(saved.id))?.name).toBe('retry saved');
  });

  it('does not overwrite a corrupt store', async () => {
    const root = await temporary();
    await mkdir(join(root, '.tagent'));
    const file = join(root, '.tagent', 'skills.json');
    await writeFile(file, '{bad', 'utf8');
    await expect(new SkillsRegistry(root).addSkill(input())).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe('{bad');
  });

  it('reads only bound resources, paginates, and never inlines the whole resource into the prompt', async () => {
    const root = await temporary();
    const saved = await new SkillsRegistry(root).addSkill(input());
    const tool = createSkillFileTool([saved]);
    saved.package!.files![0].content = 'changed later';
    const result = JSON.parse(await tool.execute({ skillId: saved.id, path: 'references/source.md', limit: 4 }));
    expect(result).toMatchObject({ content: '专属参考', nextOffset: 4, executed: false });
    await expect(tool.execute({ skillId: 'other', path: 'references/source.md' })).rejects.toThrow('bound');
    await expect(tool.execute({ skillId: saved.id, path: '../../.env' })).rejects.toThrow('bound');
    await expect(tool.execute({ skillId: saved.id, path: 'references/source.md', limit: 99999 })).rejects.toThrow('range');
    const prompt = formatSkillForPrompt(saved);
    expect(prompt).toContain('read_skill_file');
    expect(prompt).toContain(saved.id);
    expect(prompt).not.toContain('changed later');
  });
});
