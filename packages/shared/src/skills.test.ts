import { describe, expect, it } from 'vitest';
import { SKILLS, runnableSkills, skillTurnText, type SkillDef } from './skills.js';

const def = (name: string, extra: Partial<SkillDef> = {}): SkillDef => ({
  id: name,
  name,
  description: `${name} skill`,
  template: `Do ${name}.`,
  category: 'Imported',
  workflow: { nodes: [], edges: [] },
  ...extra,
});

describe('runnable skills', () => {
  it('lists built-ins, then marketplace, then imported skills; the first of a name wins', () => {
    const list = runnableSkills(
      [def('review', { category: 'Code quality' })],
      [def('review'), def('deploy')],
      [def('deploy'), def('tidy', { origin: { tool: 'claude', scope: 'user', dir: '/x' } }), def('misc')],
    );
    expect(list.map((s) => [s.name, s.source])).toEqual([
      ['review', 'builtin'],
      ['deploy', 'marketplace'],
      ['tidy', 'claude'],
      ['misc', 'agents'],
    ]);
    expect(list[0]).toMatchObject({ category: 'Code quality', template: 'Do review.' });
  });

  it('leaves out goal skills, which start a background task', () => {
    const names = runnableSkills(SKILLS, [], []).map((s) => s.name);
    expect(names).not.toContain('goal');
    expect(names.length).toBe(SKILLS.length - 1);
  });

  it('joins the template and the input as the desktop composer does', () => {
    expect(skillTurnText('Template.\n\n', '  input ')).toBe('Template.\n\ninput');
    expect(skillTurnText('Template.', '')).toBe('Template.');
  });
});
