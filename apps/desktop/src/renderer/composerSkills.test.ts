import { describe, expect, it } from 'vitest';
import { SKILLS, type SkillDef } from '@nekko-agent/shared';
import { draftAfterPromptSelection, draftAfterSkillSelection, slashTrigger } from './composerSkills.js';

const plan = SKILLS.find((skill) => skill.name === 'plan')!;
const goal = SKILLS.find((skill) => skill.kind === 'goal')!;

describe('composer skill selection', () => {
  it.each(['Write an implementation plan', '# Prompt\n\n- Keep my text\n- café 🐱\n  ', '', '   ', '/goal investigate'])
    ('preserves the exact draft when adding Plan: %j', (draft) => {
      expect(plan).toBeDefined();
      expect(draftAfterSkillSelection(draft, plan)).toBe(draft);
    });

  it('preserves text when replacing Plan with another or an installed skill', () => {
    const installed: SkillDef = { ...plan, id: 'installed', name: 'custom-plan' };
    const draft = 'Do not replace this prompt.\n';
    for (const skill of [...SKILLS.filter((sk) => sk.kind !== 'goal'), installed]) {
      expect(draftAfterSkillSelection(draftAfterSkillSelection(draft, plan), skill)).toBe(draft);
    }
  });

  it.each(['/', '/p', '/plan', '/review'])('consumes a lone slash query instead of sending it: %j', (draft) => {
    expect(draftAfterSkillSelection(draft, plan)).toBe('');
  });

  it.each(['New prompt typed after the menu opened', '/plan investigate checkout', '/plan\nKeep these details'])
    ('does not erase unrelated text on a stale slash-menu selection: %j', (draft) => {
      expect(draftAfterSkillSelection(draft, plan)).toBe(draft);
    });

  it('keeps the entire draft as the goal condition', () => {
    const draft = 'Fix checkout\n\nKeep investigating until tests pass.  ';
    expect(draftAfterSkillSelection(draft, goal)).toBe(`/goal ${draft}`);
  });

  it.each(['/goal Fix checkout', '/GOAL\nFix checkout'])('does not duplicate a goal prefix: %j', (draft) => {
    expect(draftAfterSkillSelection(draft, goal)).toBe(draft);
  });

  it.each(['', '/go', '/goal', '/GOAL'])('leaves a ready goal prefix for an empty draft or slash query: %j', (draft) => {
    expect(draftAfterSkillSelection(draft, goal)).toBe('/goal ');
  });

  it('does not mistake a similarly named word for the goal command', () => {
    expect(draftAfterSkillSelection('/goals matter', goal)).toBe('/goal /goals matter');
  });

  it.each([
    ['Help me with this /', 'Help me with this '],
    ['Help me with this /pl', 'Help me with this '],
    ['# Notes\n\n- café 🐱\n/plan', '# Notes\n\n- café 🐱\n'],
  ])('consumes only a slash query typed after the draft: %j', (draft, kept) => {
    expect(draftAfterSkillSelection(draft, plan)).toBe(kept);
  });

  it('keeps the draft before a trailing slash query as the goal condition', () => {
    expect(draftAfterSkillSelection('Fix checkout /go', goal)).toBe('/goal Fix checkout ');
  });
});

describe('composer slash trigger', () => {
  it.each([
    ['/', ''],
    ['/pl', 'pl'],
    ['/my prompt', 'my prompt'],
  ])('opens on a draft that starts with a slash: %j', (draft, query) => {
    expect(slashTrigger(draft)).toEqual({ query, start: 0 });
  });

  it.each([
    ['Help me with this /', '', 18],
    ['Help me with this /pl', 'pl', 18],
    ['First line\n/', '', 11],
    ['/plan first\nthen /re', 're', 17],
  ])('opens on a slash typed after existing text: %j', (draft, query, start) => {
    expect(slashTrigger(draft)).toEqual({ query, start });
  });

  it.each(['', 'Help me with this', 'see a/b', 'https://example.com/', 'Help me /plan now', 'Help me / now'])
    ('stays shut without a trailing slash token: %j', (draft) => {
      expect(slashTrigger(draft)).toBeNull();
    });

  it('swaps only the slash query for a saved prompt', () => {
    expect(draftAfterPromptSelection('/rev', 'Review this.')).toBe('Review this.');
    expect(draftAfterPromptSelection('Context first /rev', 'Review this.')).toBe('Context first Review this.');
  });
});
