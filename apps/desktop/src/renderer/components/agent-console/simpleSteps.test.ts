import { describe, expect, it } from 'vitest';
import { simpleStepsSummary } from './ActivityGroup.js';

const tool = { kind: 'tool', call: { id: 'c', name: 'read_file', args: {} } } as never;
const thought = { kind: 'reasoning', text: 'Hmm' } as never;

describe("Simple's one line for a turn's steps", () => {
  it('counts tool steps once the turn is done', () => {
    expect(simpleStepsSummary([thought, tool, tool, tool, tool], false)).toBe('Took 4 steps');
    expect(simpleStepsSummary([tool], false)).toBe('Took 1 step');
    expect(simpleStepsSummary([thought], false)).toBe('Thought it through');
  });
  it('says the turn is still working', () => {
    expect(simpleStepsSummary([tool, tool], true)).toBe('Working · 2 steps so far');
    expect(simpleStepsSummary([thought], true)).toBe('Working');
  });
});
