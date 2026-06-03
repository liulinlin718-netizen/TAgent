import * as fs from 'fs/promises';
import * as path from 'path';

export interface Skill {
  id: string;
  name: string;
  description: string;
  category: string;
  trigger?: string;
  body: string; // The markdown SOP
  createdAt: number;
}

export class SkillsRegistry {
  private skillsFile: string;
  private skillsCache: Skill[] | null = null;

  constructor(workspaceRoot: string) {
    const dotTagentDir = path.join(workspaceRoot, '.tagent');
    this.skillsFile = path.join(dotTagentDir, 'skills.json');
  }

  private async ensureDir(): Promise<void> {
    const dir = path.dirname(this.skillsFile);
    try {
      await fs.access(dir);
    } catch {
      await fs.mkdir(dir, { recursive: true });
    }
  }

  private async load(): Promise<Skill[]> {
    if (this.skillsCache) return this.skillsCache;
    try {
      await this.ensureDir();
      const data = await fs.readFile(this.skillsFile, 'utf-8');
      this.skillsCache = JSON.parse(data) as Skill[];
    } catch (e: any) {
      if (e.code === 'ENOENT') {
        this.skillsCache = [];
      } else {
        throw e;
      }
    }
    return this.skillsCache;
  }

  private async save(): Promise<void> {
    if (!this.skillsCache) return;
    await this.ensureDir();
    await fs.writeFile(this.skillsFile, JSON.stringify(this.skillsCache, null, 2), 'utf-8');
  }

  async getSkills(): Promise<Skill[]> {
    return [...(await this.load())];
  }

  async getSkill(id: string): Promise<Skill | undefined> {
    const skills = await this.load();
    return skills.find(s => s.id === id);
  }

  async addSkill(skill: Omit<Skill, 'id' | 'createdAt'>): Promise<Skill> {
    const skills = await this.load();
    const newSkill: Skill = {
      ...skill,
      id: `sk-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      createdAt: Date.now(),
    };
    skills.push(newSkill);
    await this.save();
    return newSkill;
  }

  async updateSkill(id: string, updates: Partial<Omit<Skill, 'id' | 'createdAt'>>): Promise<Skill> {
    const skills = await this.load();
    const idx = skills.findIndex(s => s.id === id);
    if (idx === -1) throw new Error(`Skill ${id} not found`);
    
    const updated = { ...skills[idx], ...updates };
    skills[idx] = updated;
    await this.save();
    return updated;
  }

  async deleteSkill(id: string): Promise<void> {
    const skills = await this.load();
    const idx = skills.findIndex(s => s.id === id);
    if (idx !== -1) {
      skills.splice(idx, 1);
      await this.save();
    }
  }
}
