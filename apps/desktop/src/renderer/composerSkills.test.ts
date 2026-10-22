import { describe, expect, it } from 'vitest';
import { SKILLS, type SkillDef } from '@nekko-agent/shared';
import { atTrigger, draftAfterSkillSelection, fileSelectionEdit, promptSelectionEdit, skillSelectionEdit, slashTrigger } from './composerSkills.js';

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
    expect(slashTrigger(draft)).toEqual({ query, start: 0, end: draft.length });
  });

  it.each([
    ['Help me with this /', '', 18],
    ['Help me with this /pl', 'pl', 18],
    ['First line\n/', '', 11],
    ['/plan first\nthen /re', 're', 17],
  ])('opens on a slash typed after existing text: %j', (draft, query, start) => {
    expect(slashTrigger(draft)).toEqual({ query, start, end: draft.length });
  });

  it.each(['', 'Help me with this', 'see a/b', 'https://example.com/', 'Help me /plan now', 'Help me / now'])
    ('stays shut without a trailing slash token: %j', (draft) => {
      expect(slashTrigger(draft)).toBeNull();
    });

  it('swaps only the slash query for a saved prompt', () => {
    expect(promptSelectionEdit('/rev', 'Review this.')).toEqual({ text: 'Review this.', caret: 12 });
    expect(promptSelectionEdit('Context first /rev', 'Review this.')).toEqual({ text: 'Context first Review this.', caret: 26 });
  });
});

describe('composer triggers at the caret', () => {
  // `|` marks the caret in each case.
  const at = (marked: string) => ({ draft: marked.replace(/\|/g, ''), caret: marked.indexOf('|') });

  it.each([
    ['Fix /| this', '', 4],
    ['Fix /pl| this', 'pl', 4],
    ['/pl| and more', 'pl', 0],
    ['first\n/re|\nlast', 're', 6],
  ])('opens on a slash word ending at the caret: %j', (marked, query, start) => {
    const { draft, caret } = at(marked);
    expect(slashTrigger(draft, caret)).toEqual({ query, start, end: caret });
  });

  it.each(['Fix /p|l this', 'Fix a/|b', 'Fix| /pl', 'Fix |/pl'])
    ('stays shut when the caret is not at the end of a slash word: %j', (marked) => {
      const { draft, caret } = at(marked);
      expect(slashTrigger(draft, caret)).toBeNull();
    });

  it('opens neither menu while a range is selected', () => {
    expect(slashTrigger('Fix /', -1)).toBeNull();
    expect(atTrigger('Fix @', -1)).toBeNull();
  });

  it('searches a leading slash line only with the caret at its end', () => {
    expect(slashTrigger('/my prompt', 10)).toEqual({ query: 'my prompt', start: 0, end: 10 });
    expect(slashTrigger('/my prompt', 3)).toEqual({ query: 'my', start: 0, end: 3 });
  });

  it('removes a mid-draft slash query and one of its spaces when picking a skill', () => {
    const { draft, caret } = at('Fix /pl| this');
    expect(skillSelectionEdit(draft, plan, caret)).toEqual({ text: 'Fix this', caret: 4 });
  });

  it('keeps a mid-draft goal condition intact around the removed query', () => {
    const { draft, caret } = at('Fix /go| checkout');
    expect(skillSelectionEdit(draft, goal, caret)).toEqual({ text: '/goal Fix checkout', caret: 10 });
  });

  it('puts a saved prompt where the slash query was', () => {
    const { draft, caret } = at('Before /rev| after');
    expect(promptSelectionEdit(draft, 'Review this.', caret)).toEqual({ text: 'Before Review this. after', caret: 19 });
  });

  it.each([
    ['Look at @ch|', { query: 'ch', start: 8, end: 11 }],
    ['Look at @ch| and fix', { query: 'ch', start: 8, end: 11 }],
    ['@| first', { query: '', start: 0, end: 1 }],
  ])('opens the file menu on an @ word ending at the caret: %j', (marked, trigger) => {
    const { draft, caret } = at(marked);
    expect(atTrigger(draft, caret)).toEqual(trigger);
  });

  it.each(['mail me@ex|', 'Look at @c|h'])('keeps the file menu shut otherwise: %j', (marked) => {
    const { draft, caret } = at(marked);
    expect(atTrigger(draft, caret)).toBeNull();
  });

  it('inserts a file mention at the caret with one space after it', () => {
    expect(fileSelectionEdit('Look at @ch', 'src/checkout.ts')).toEqual({ text: 'Look at @src/checkout.ts ', caret: 25 });
    const { draft, caret } = at('Look at @ch| and fix');
    expect(fileSelectionEdit(draft, 'src/checkout.ts', caret)).toEqual({ text: 'Look at @src/checkout.ts and fix', caret: 25 });
  });
});
