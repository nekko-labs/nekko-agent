import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { expect, it } from 'vitest';
import { parseReplySuggestions } from '@nekko-agent/shared';
import { cleanFill, fillPrompt, suggestPrompt } from './turn-plan.js';

/**
 * The side calls beside a turn: the suggested-replies request and how its
 * answer is read, and the prompt-part fill request and how its answer is
 * cleaned. The engine daemon's port (crates/nekko-turn/src/side.rs) must
 * produce the same text for the same input. Writes
 * crates/nekko-turn/tests/golden/side.json; fails if it is stale (rewrite
 * with UPDATE_GOLDEN=1).
 */
const golden = join(__dirname, '..', '..', '..', 'crates', 'nekko-turn', 'tests', 'golden', 'side.json');

let n = 0;
const msg = (role: string, content: string, extra: Record<string, unknown> = {}) => ({ id: `m${n++}`, role, content, createdAt: n, ...extra });
const long = 'x'.repeat(790) + '\u{1F63A}'.repeat(10) + ' tail';
const conversation = [
  msg('user', '  first ask  '),
  msg('assistant', 'did a thing', { toolCalls: [{ id: 't1', name: 'read_file', input: {} }, { id: 't2', name: 'bash', input: {} }, { id: 't3', name: 'read_file', input: {} }] }),
  msg('tool', 'tool output', { toolResult: { toolCallId: 't1', output: 'x' } }),
  msg('user', '   '),
  msg('user', long),
  msg('assistant', 'second', { toolCalls: [] }),
  msg('user', ' nbsp padded '),
  msg('assistant', 'third', { toolCalls: [{ id: 't4', input: {} }, { id: 't5', name: 'grep', input: {} }] }),
  msg('user', 'u4'),
  msg('user', 'u5'),
  msg('user', 'u6'),
  msg('user', 'u7'),
  msg('user', 'u8'),
  msg('user', 'u9'),
  msg('assistant', '  Here is the result.\n\nWant me to commit it?  '),
];

const SUGGEST = [
  { messages: conversation },
  { messages: conversation, taskId: 'task' },
  { messages: conversation, trainingRunId: 'run' },
  { messages: conversation, parentSessionId: 'parent' },
  { messages: [] },
  { messages: [msg('user', 'only a question')] },
  { messages: [msg('user', 'q'), msg('assistant', ' \n\t ')] },
  { messages: [msg('assistant', 'Hello! What shall we build?')] },
  { messages: [msg('user', 'make it "quoted" and `ticked`'), msg('assistant', 'done—with an em dash')] },
];

const FILL = [
  { part: 'Role', draft: 'Review this pull request for bugs.' },
  { part: 'Output format', draft: `  ${'y'.repeat(1990)}\u{1F63A}\u{1F63A}  trailing` },
  { part: 'Context', draft: '' },
  { part: 'say "hi"', draft: '　full width space　' },
];

const CLEAN = ['  "You are a careful code reviewer."  ', '```', "'`\"snippet\"`'", '', '   ', `"${'z'.repeat(400)}"`, 'inner "quotes" stay', ' padded '];

const PARSE = [
  '{"options":["Commit it","Run the tests"],"next":"Commit it and push"}',
  'Sure! {"options": [], "next": "Yes, commit it"} hope that helps',
  '{"options":[1, "  - Ship it ", null, "ship IT", "Four", "Five", "Six"],"suggestion":"from suggestion"}',
  '{"draft": "from draft", "next": 5}',
  '{"options":[],"next":null}',
  '{"options":[],"next":""}',
  '{broken json} and more',
  '- Commit it\n* Run tests\n1) Open a PR\n2. Deploy\n• bullet\n"options": [\n{\n],\nnext: skip me\n  "quoted, line",  ',
  'Line one\r\nline ONE\nLine   with\ttabs\n',
  `"${'w'.repeat(200)}"`,
  '',
  '\n\n  \n',
  '{"options":["a"],"next":"' + 'n'.repeat(300) + '"}',
  '{"next":"  multi\\n line\\tnext  "}',
  '}{',
  '12345 numbers only\n--- \n42. answer',
];

it('side-call prompts and answers match the daemon golden set', () => {
  const out = {
    suggest: SUGGEST.map((input) => ({ input, output: suggestPrompt(input as never) })),
    fill: FILL.map((input) => ({ input, output: fillPrompt(input.part, input.draft) })),
    clean: CLEAN.map((input) => ({ input, output: cleanFill(input) })),
    parse: PARSE.map((input) => ({ input, output: parseReplySuggestions(input) })),
  };
  const actual = JSON.parse(JSON.stringify(out));
  if (process.env.UPDATE_GOLDEN) writeFileSync(golden, `${JSON.stringify(actual, null, 2)}\n`);
  expect(JSON.parse(readFileSync(golden, 'utf8'))).toEqual(actual);
});
