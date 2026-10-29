import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  groupByPurpose, isGuidancePath, purposeHeadline, summarizePurposes, toolGoal, toolPurpose,
  type PurposeCall, type ToolPurpose,
} from './tool-purpose.js';

interface Fixture {
  purposes: Array<{ name: string; input: unknown; purpose: ToolPurpose }>;
  goals: Array<{ name: string; input: unknown; goal: string }>;
  headlines: Array<{ purpose: ToolPurpose; running: boolean; calls: PurposeCall[]; headline: string; detail: string }>;
}

// The fixture Swift (NekkoProtocol) and Kotlin (protocol) run too.
const fixture = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'tool-purpose.json'), 'utf8')) as Fixture;

describe('tool-purpose fixture', () => {
  it('holds at least 60 purpose cases covering every purpose', () => {
    expect(fixture.purposes.length).toBeGreaterThanOrEqual(60);
    const seen = new Set(fixture.purposes.map((c) => c.purpose));
    for (const p of ['guidance', 'explore', 'edit', 'check', 'run', 'git', 'web', 'plan', 'delegate', 'other']) expect(seen).toContain(p);
  });

  it.each(fixture.purposes.map((c) => [`${c.name} ${JSON.stringify(c.input)}`, c] as const))('purpose of %s', (_, c) => {
    expect(toolPurpose(c)).toBe(c.purpose);
  });

  it.each(fixture.goals.map((c) => [`${c.name} ${JSON.stringify(c.input)}`, c] as const))('goal of %s', (_, c) => {
    expect(toolGoal(c)).toBe(c.goal);
  });

  it.each(fixture.headlines.map((c, i) => [`${i} ${c.purpose}`, c] as const))('headline %s', (_, c) => {
    const h = purposeHeadline(c.purpose, c.calls, c.running);
    expect({ headline: h.headline, detail: h.detail }).toEqual({ headline: c.headline, detail: c.detail });
  });
});

describe('isGuidancePath', () => {
  it('reads Windows and POSIX separators alike', () => {
    expect(isGuidancePath('C:\\repo\\docs\\runbooks\\x.md')).toBe(true);
    expect(isGuidancePath('/repo/docs/runbooks/x.md')).toBe(true);
    expect(isGuidancePath('/repo/docs/runbooks/x.ts')).toBe(false);
  });
});

describe('summarizePurposes', () => {
  it('lists each purpose once, in the order it first appears', () => {
    const calls: PurposeCall[] = [
      { name: 'read_file', input: { path: 'AGENTS.md' } },
      { name: 'read_file', input: { path: 'src/a.ts' } },
      { name: 'grep', input: { pattern: 'x' } },
      { name: 'edit_file', input: { path: 'src/a.ts' } },
      { name: 'edit_file', input: { path: 'src/b.ts' } },
      { name: 'read_file', input: { path: 'src/c.ts' } },
      { name: 'edit_file', input: { path: 'src/c.ts' } },
    ];
    expect(summarizePurposes(calls)).toBe('Read guidance, looked through the code, edited 3 files');
  });

  it('leaves stated goals to the rows', () => {
    expect(summarizePurposes([{ name: 'Bash', input: { command: 'npm test', description: 'Run the desktop tests' } }])).toBe('Ran the tests');
  });

  it('caps a long run at three purposes and a count', () => {
    const calls: PurposeCall[] = [
      { name: 'read_file', input: { path: 'AGENTS.md' } },
      { name: 'read_file', input: { path: 'a.ts' } },
      { name: 'edit_file', input: { path: 'a.ts' } },
      { name: 'bash', input: { command: 'npm test' } },
      { name: 'bash', input: { command: 'git push' } },
    ];
    expect(summarizePurposes(calls)).toBe("Read guidance, looked through the code, edited 1 file, and 2 more");
  });
});

describe('groupByPurpose', () => {
  type Item = { id: string; call?: PurposeCall & { standalone?: boolean } };
  const call = (id: string, name: string, input: unknown, extra: Partial<PurposeCall & { standalone: boolean }> = {}): Item => ({ id, call: { name, input, ...extra } });
  const thought = (id: string): Item => ({ id });
  const shape = (items: Item[]) => groupByPurpose(items, (it) => it.call).map((r) => (r.kind === 'group' ? `${r.purpose}[${r.items.map((i) => i.id).join(',')}]` : r.item.id));

  it('groups only adjacent calls of one purpose', () => {
    expect(shape([
      call('a', 'read_file', { path: 'AGENTS.md' }),
      call('b', 'read_file', { path: 'CLAUDE.md' }),
      call('c', 'read_file', { path: 'src/x.ts' }),
      call('d', 'grep', { pattern: 'y' }),
      call('e', 'read_file', { path: 'README.md' }),
    ])).toEqual(['guidance[a,b]', 'explore[c,d]', 'e']);
  });

  it('keeps a thought between same-purpose calls inside the group, and outside otherwise', () => {
    expect(shape([
      call('a', 'read_file', { path: 'a.ts' }), thought('t1'), call('b', 'read_file', { path: 'b.ts' }),
      thought('t2'), call('c', 'edit_file', { path: 'b.ts' }), thought('t3'),
    ])).toEqual(['explore[a,t1,b]', 't2', 'c', 't3']);
  });

  it('never folds a question or a standalone call, and a lone call is a plain row', () => {
    expect(shape([
      call('a', 'read_file', { path: 'a.ts' }),
      call('q', 'ask_user', { questions: [] }),
      call('b', 'read_file', { path: 'b.ts' }),
      call('p', 'read_file', { path: 'c.ts' }, { standalone: true }),
      call('c', 'read_file', { path: 'd.ts' }),
    ])).toEqual(['a', 'q', 'b', 'p', 'c']);
  });

  it('keeps a failed call in its group and counts it', () => {
    const runs = groupByPurpose([
      call('a', 'bash', { command: 'npm test' }),
      call('b', 'bash', { command: 'npm run lint' }, { failed: true }),
    ], (it) => it.call);
    expect(runs).toHaveLength(1);
    const g = runs[0];
    expect(g.kind === 'group' && purposeHeadline(g.purpose, g.calls).detail).toBe('1 failed');
  });
});
