import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { expect, it } from 'vitest';
import { decideRequestFromTool } from '@nekko-agent/core';
import type { DecisionRequest } from '@nekko-agent/shared';
import { checkDecisionRequest } from './engine/decisions.js';

/**
 * The `decide` tool's request as the TS host builds and checks it, which the
 * engine daemon's port (crates/nekko-turn `decide`) must reproduce, key order
 * included (it is the decision model's input). Writes
 * crates/nekko-turn/tests/golden/decide.json; fails if it is stale (rewrite
 * with UPDATE_GOLDEN=1).
 */
const golden = join(__dirname, '..', '..', '..', 'crates', 'nekko-turn', 'tests', 'golden', 'decide.json');

const INPUTS: unknown[] = [
  { state: 'A user asks for a refund after 40 days.', questions: [{ id: 'refund', type: 'choice', instructions: 'Grant it?', options: ['yes', 'no'] }] },
  { state: { cart: [1, 2], user: { tier: 'gold' } }, questions: [{ id: ' tier ', type: 'score', instructions: 'Loyalty', options: ['low', 'mid', 'high'] }, { type: 'noul', instructions: 'The user is angry', options: ['x'] }] },
  { state: 'pick', questions: [{ id: 'team', type: 'choice', question: 'Which team?', options: [{ label: 'Core', description: 'Engine work' }, { name: 'Web' }, { value: 'Ops', description: 5 }, 'Data', null, ''] }] },
  { state: 'numbers', questions: [{ id: '2', type: 'choice', instructions: 'b', options: [{ label: '10', description: 'ten' }, { label: '2', description: 'two' }, { label: 'x' }] }, { id: '1', type: 'choice', instructions: 'a', criteria: ['p', 'q'] }] },
  { state: 'dup', questions: [{ id: 'a', type: 'choice', instructions: 'first', options: ['x'] }, { id: 'a', type: 'score', instructions: 'second', options: ['y'] }, { id: '', type: 'weird', instructions: 7 }] },
  { state: 'obj options', questions: [{ id: 'o', type: 'choice', instructions: 'i', options: [{ label: 'A', description: 'd' }, { label: 'A', description: 'e' }, { label: '', description: 'f' }] }] },
  { state: '   ', questions: [{ id: 'q', type: 'noul', instructions: 'x' }] },
  { state: 'ok', questions: [] },
  { state: 'ok', questions: 'nope' },
  { questions: [{ id: 'q', type: 'noul', instructions: 'no state' }] },
  { state: null, questions: [{ id: 'q', type: 'noul', instructions: 'null state' }] },
  { state: 'x'.repeat(50_001), questions: [{ id: 'q', type: 'noul', instructions: 'long' }] },
  { state: '😀'.repeat(25_000), questions: [{ id: 'q', type: 'noul', instructions: 'exactly at the limit in UTF-16' }] },
  { state: 'many', questions: Array.from({ length: 65 }, (_, i) => ({ id: `q${i}`, type: 'noul', instructions: 'x' })) },
  { state: 'items', questions: [null, 'text', 5, [1, 2], { id: 'z', type: 'choice', instructions: 'i', options: [[1], true, 3] }] },
  null,
  'just a string',
  {},
];

it('the decide tool request matches the daemon golden set', () => {
  const out = INPUTS.map((input) => {
    const request = decideRequestFromTool(input);
    const problem = checkDecisionRequest(request as DecisionRequest);
    // Long states are recorded by length, to keep the file small.
    const shown = (v: unknown) => (typeof v === 'string' && v.length > 200 ? { long: v.length, head: v.slice(0, 20) } : v);
    return {
      input: input && typeof input === 'object' && 'state' in input ? { ...input, state: shown((input as { state: unknown }).state) } : input ?? null,
      request: JSON.stringify({ ...request, state: shown(request.state) }),
      problem,
    };
  });
  if (process.env.UPDATE_GOLDEN) {
    mkdirSync(join(golden, '..'), { recursive: true });
    writeFileSync(golden, `${JSON.stringify(out, null, 1)}\n`);
  }
  expect(JSON.parse(readFileSync(golden, 'utf8'))).toEqual(out);
});
