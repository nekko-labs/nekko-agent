import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { expect, it } from 'vitest';
import type { ChatMessage } from '@nekko-agent/shared';
import { MAX_CHILD_RESUMES, canResumeChildFailure, childInterruptedMessage, subAgentAnswer, subAgentFailure } from './delegation-recovery.js';

/**
 * What a sub-agent's run comes back as, which the engine daemon's port
 * (crates/nekko-turn `delegate`) must reproduce: whether a failed child is
 * resumed, its answer, the interrupted message with its saved progress, and
 * the coded failure result. Writes crates/nekko-turn/tests/golden/delegation.json;
 * fails if it is stale (rewrite with UPDATE_GOLDEN=1).
 */
const golden = join(__dirname, '..', '..', '..', 'crates', 'nekko-turn', 'tests', 'golden', 'delegation.json');

const msg = (role: ChatMessage['role'], content: string): ChatMessage => ({ id: `m_${role}_${content.length}`, role, content, createdAt: 1 } as ChatMessage);
const long = `${'a'.repeat(1990)}😀${'b'.repeat(30)}`;
const histories: Array<ChatMessage[] | undefined> = [
  undefined,
  [],
  [msg('user', 'do it')],
  [msg('user', 'do it'), msg('assistant', 'first'), msg('tool', 'out'), msg('assistant', '   ')],
  [msg('assistant', 'only answer')],
  [msg('assistant', long)],
  [msg('assistant', `${'x'.repeat(1999)}😀tail`)],
];

const failures = [
  'Provider returned 529 overloaded', 'The engine stopped driving this reply. The steps it finished are saved.', 'The engine could not be reached.',
  'stream ended unexpectedly', 'ECONNRESET', 'fetch failed', 'Stopped', 'cancelled by user', 'HTTP 401 Unauthorized', 'model claude-x not found',
  'Rate limited (429)', 'Network Error while reading', 'terminated', 'approval timed out', 'something odd', '', 'model unavailable 500',
];

const errors = [
  'The exact model ID is not available from the target provider.', 'The selected model is not a chat model. No child was created.',
  'Could not verify the target provider model list.', 'Target provider is unknown or disabled.', 'Target provider requires a valid HTTP(S) endpoint.',
  'Delegation cancelled before creating a child.', 'Stopped with the chat.', 'A nonblank task is required for the sub-agent.', 'quote "this" \\ and \n newline',
];

it('delegation results match the daemon golden set', () => {
  const out = {
    maxChildResumes: MAX_CHILD_RESUMES,
    resume: failures.map((input) => ({ input, output: canResumeChildFailure(input) })),
    answers: histories.map((input) => ({ input: input ?? null, output: subAgentAnswer(input) })),
    interrupted: histories.flatMap((messages) => ['stream ended unexpectedly', 'x'].map((failure) => ({ input: { childId: 's_child', failure, messages: messages ?? null }, output: childInterruptedMessage('s_child', failure, messages) }))),
    failures: errors.map((input) => ({ input, output: subAgentFailure('call_1', input) })),
  };
  if (process.env.UPDATE_GOLDEN) {
    mkdirSync(join(golden, '..'), { recursive: true });
    writeFileSync(golden, `${JSON.stringify(out, null, 1)}\n`);
  }
  expect(JSON.parse(readFileSync(golden, 'utf8'))).toEqual(JSON.parse(JSON.stringify(out)));
});
