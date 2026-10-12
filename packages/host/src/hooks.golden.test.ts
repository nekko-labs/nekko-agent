import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { expect, it } from 'vitest';
import type { HookRule } from '@nekko-agent/shared';
import { decisionOf, hasToolHooks, label, matchingHooks, type HookOutcome } from './hooks.js';

/**
 * Tool hooks' pure half as the TS host runs it, which the engine daemon's
 * port (crates/nekko-tools `hooks`) must reproduce: which rules match an
 * event and a tool, whether any wants tool calls, a hook's label, and the
 * block a hook's exit code or stdout verdict means. Writes
 * crates/nekko-tools/tests/golden/hooks.json; fails if it is stale (rewrite
 * with UPDATE_GOLDEN=1).
 */
const golden = join(__dirname, '..', '..', '..', 'crates', 'nekko-tools', 'tests', 'golden', 'hooks.json');

const RULES = [
  { id: 'a', event: 'PreToolUse', matcher: 'bash|write_file', command: 'x' },
  { id: 'b', event: 'PreToolUse', matcher: '', command: 'y' },
  { id: 'c', event: 'PreToolUse', matcher: '(bad', command: 'z' },
  { id: 'd', event: 'PreToolUse', command: '  ', matcher: '' },
  { id: 'e', event: 'PreToolUse', command: 'w', enabled: false },
  { id: 'f', event: 'PostToolUse', command: 'v' },
  { id: 'g', event: 'PreToolUse', matcher: '(bad, read_file  mcp__x', command: 'u' },
  { id: 'h', event: 'PreToolUse', matcher: 'BASH', command: 't' },
  { id: 'i', event: 'PostToolUse', matcher: '^mcp__', command: 's', enabled: true },
  { id: 'j', event: 'TurnEnd', matcher: 'bash', command: 'r' },
  { id: 'k', event: 'PreToolUse', matcher: '  ', command: 'q' },
  { id: 'l', event: 'PreToolUse', matcher: 'ſ', command: 'p' },
] as HookRule[];

const MATCH: Array<[string, string | undefined]> = [
  ['PreToolUse', 'bash'], ['PreToolUse', 'read_file'], ['PreToolUse', '(bad'], ['PreToolUse', undefined], ['PreToolUse', ''],
  ['PostToolUse', 'mcp__x__y'], ['PostToolUse', 'bash'], ['TurnEnd', undefined], ['TurnEnd', 'bash'], ['PreToolUse', 'mcp__x'], ['PreToolUse', 'S'],
];

const OUTCOMES: Array<Omit<HookOutcome, 'rule' | 'timedOut'>> = [
  { code: 0, stdout: ' {"decision":"block","reason":" no "}', stderr: '' },
  { code: 0, stdout: '{"decision":"deny"}', stderr: '' },
  { code: 0, stdout: '{"decision":"deny","reason":5}', stderr: '' },
  { code: 2, stdout: '{"decision":"deny","reason":5}', stderr: '' },
  { code: 0, stdout: '{"decision":"allow","reason":"fine"}', stderr: '' },
  { code: 2, stdout: 'out', stderr: '  err  ' },
  { code: 2, stdout: '  ', stderr: '' },
  { code: 1, stdout: '{nope', stderr: 'x' },
  { code: null, stdout: '', stderr: 'spawn failed' },
  { code: 2, stdout: '', stderr: 'e'.repeat(2_100) },
  { code: 0, stdout: '{"decision":"block","reason":""}', stderr: '' },
  { code: 0, stdout: '{"decision":"block","reason":null}', stderr: '' },
  { code: 2, stdout: '[1]', stderr: '' },
];

const LABELS = [
  { command: '  lint  --fix' }, { name: ' Linter ', command: 'x' }, { name: '  ', command: '\tnpm\ttest' }, { command: '   ' }, { name: '', command: 'a b c' },
] as HookRule[];

it('tool hooks match the daemon golden set', () => {
  const out = {
    rules: RULES,
    matching: MATCH.map(([event, tool]) => ({ event, tool: tool ?? null, ids: matchingHooks({ hooks: RULES }, event as never, tool).map((r) => r.id) })),
    hasToolHooks: [
      { hooks: RULES, has: hasToolHooks({ hooks: RULES }) },
      { hooks: [RULES[9]], has: hasToolHooks({ hooks: [RULES[9]] }) },
      { hooks: [RULES[3], RULES[4]], has: hasToolHooks({ hooks: [RULES[3], RULES[4]] }) },
    ],
    decisions: OUTCOMES.map((o) => ({ outcome: o, decision: decisionOf({ ...o, rule: RULES[0], timedOut: false }) })),
    labels: LABELS.map((rule) => ({ rule, label: label(rule) })),
  };
  if (process.env.UPDATE_GOLDEN) {
    mkdirSync(join(golden, '..'), { recursive: true });
    writeFileSync(golden, `${JSON.stringify(out, null, 1)}\n`);
  }
  expect(JSON.parse(readFileSync(golden, 'utf8'))).toEqual(JSON.parse(JSON.stringify(out)));
});
