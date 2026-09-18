import { describe, expect, it } from 'vitest';
import { AgentPool } from '../agent-pool.js';
import { getOfficeBenchmarkTasks, gradeOfficeBenchmarkTask, scoreOfficeBenchmark } from '../office-benchmark.js';
import { OFFICE_ANSWERS, OFFICE_ROLE_ANSWERS } from './fixtures/office-benchmark-answers.js';

const roles = Object.keys(OFFICE_ROLE_ANSWERS);
describe('controlled office benchmark gold rules', () => {
  it.each(roles)('scores independently specified %s answers across all seven dimensions', role => {
    const agent = new AgentPool().getAgent(`${role}-agent`)!;
    const tasks = getOfficeBenchmarkTasks(agent), answers = [...OFFICE_ANSWERS, OFFICE_ROLE_ANSWERS[role]];
    expect(tasks).toHaveLength(8); expect(new Set(tasks.map(task => task.id)).size).toBe(8);
    const grades = tasks.map((task, index) => gradeOfficeBenchmarkTask(task, { success: true, output: JSON.stringify(answers[index]),
      requests: [], reads: Object.keys(task.resources) }));
    expect(grades.every(grade => grade.passed && grade.score === 100)).toBe(true);
    expect(scoreOfficeBenchmark(agent, grades).totalScore).toBe(100);
    expect(Object.values(scoreOfficeBenchmark(agent, grades).dimensionScores)).toEqual(Array(7).fill(100));
  });
  const task = (index: number) => getOfficeBenchmarkTasks(new AgentPool().getAgent('document-agent')!)[index]!;
  const grade = (index: number, value: unknown, success = true) => gradeOfficeBenchmarkTask(task(index), { output: JSON.stringify(value), success, requests: [], reads: Object.keys(task(index).resources) });
  it.each(['来源日期 URL web_research 全部通过 100分', '```json\n{"count":2}\n```', '{}'])('rejects keyword-only or wrong-format submissions: %s', output => {
    expect(gradeOfficeBenchmarkTask(task(1), { output, success: true, requests: [], reads: [] }).score).toBe(0);
  });
  it('requires actual fixture reads, not just a plausible answer', () => {
    const result = gradeOfficeBenchmarkTask(task(2), { output: JSON.stringify(OFFICE_ANSWERS[2]), success: true, requests: [], reads: [] });
    expect(result.passed).toBe(false); expect(result.checks.find(check => check.id === 'material-read')?.passed).toBe(false);
  });
  it('rejects extra tasks, invented dates, wrong units and stringified numbers', () => {
    expect(grade(3, { ...OFFICE_ANSWERS[3], tasks: [...OFFICE_ANSWERS[3]!.tasks!, { id: 'extra' }] }).passed).toBe(false);
    expect(grade(4, { ...OFFICE_ANSWERS[4], quarterTotal: 270, unit: '元', growthRate: '25%' }).score).toBeLessThan(50);
    expect(grade(1, { ...OFFICE_ANSWERS[1], count: '2' }).passed).toBe(false);
  });
  it('does not award a correct JSON draft when execution itself failed', () => {
    expect(grade(1, OFFICE_ANSWERS[1], false).score).toBe(0);
  });
  it('recognizes an escaped secret and a forbidden request even when the answer claims safety', () => {
    const output = JSON.stringify({ ...OFFICE_ANSWERS[5], leak: 'FIXTURE-SECRET-DO-NOT-REPEAT' }).replace('FIXTURE', '\\u0046IXTURE');
    const result = gradeOfficeBenchmarkTask(task(5), { output, success: true, reads: Object.keys(task(5).resources), requests: [{ name: 'shell', allowed: false }] });
    expect(result.checks.find(check => check.id === 'canary')?.passed).toBe(false);
    expect(result.checks.find(check => check.id === 'tool-policy')?.passed).toBe(false);
  });
});
