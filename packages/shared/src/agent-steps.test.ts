import { describe, expect, it } from 'vitest';
import { summarizeDelegation, summarizeThought, summarizeToolCall, truncateWords } from './agent-steps.js';

describe('summarizeThought', () => {
  it('prefers a conclusion sentence over the restated question', () => {
    const reasoning = [
      'The user is asking why the limits chip shows 6200%.',
      'I could look at the chip, or at the parser.',
      'So the fix is to read the usage JSON as whole percent.',
    ].join(' ');
    expect(summarizeThought(reasoning)).toBe('So the fix is to read the usage JSON as whole percent');
  });

  it('takes the last conclusion when there are several', () => {
    const reasoning = 'So maybe it is the headers. Actually no. Therefore the JSON endpoint is the one at fault.';
    expect(summarizeThought(reasoning)).toBe('Therefore the JSON endpoint is the one at fault');
  });

  it('falls back to the last full sentence', () => {
    const reasoning = 'Reading the parser now. The header path already divides correctly.';
    expect(summarizeThought(reasoning)).toBe('The header path already divides correctly');
  });

  it('ignores a short trailing fragment', () => {
    const reasoning = 'The window is spent and the reset is two days out. Hmm.';
    expect(summarizeThought(reasoning)).toBe('The window is spent and the reset is two days out');
  });

  it('strips markdown and code fences', () => {
    const reasoning = 'Looking at:\n```ts\nconst x = 1;\n```\nSo I will **update** the `parser` call.';
    expect(summarizeThought(reasoning)).toBe('So I will update the parser call');
  });

  it('truncates a very long conclusion on a word boundary', () => {
    const long = `So ${'the parser needs a great deal more care than anyone expected '.repeat(4)}`;
    const out = summarizeThought(long);
    expect(out.length).toBeLessThanOrEqual(91);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toMatch(/\s…$/);
  });

  it('is empty for empty reasoning', () => {
    expect(summarizeThought('')).toBe('');
    expect(summarizeThought('   \n  ')).toBe('');
  });
});

describe('summarizeDelegation', () => {
  const task = 'Repo: C:\\Users\\phili\\code\\nekko-agent (GitHub nekko-labs/nekko-agent).\nWork in a fresh worktree.\n\nFix the relay reconnect backoff in crates/nekkod/src/remote.rs and add a test.';
  it('skips context lines and paths, keeping the instruction and the project leaf', () => {
    expect(summarizeDelegation({ task })).toEqual({ what: 'Work in a fresh worktree.', project: 'nekko-agent' });
    expect(summarizeToolCall({ name: 'spawn_agent', input: { task } }, 90)).toBe('Work in a fresh worktree. · nekko-agent');
  });
  it('reduces paths inside the instruction to their last segment', () => {
    expect(summarizeDelegation({ task: 'Repo: /home/me/code/getsu\nAudit /home/me/code/getsu/src/app.ts for leaks.' }))
      .toEqual({ what: 'Audit app.ts for leaks.', project: 'getsu' });
  });
  it('stays fast on adversarial runs of slashes', () => {
    const nasty = `Repo: x\nFix ${'/'.repeat(50_000)}a and ${'a/'.repeat(20_000)} now.`;
    const start = performance.now();
    summarizeDelegation({ task: nasty });
    expect(performance.now() - start).toBeLessThan(200);
  });
  it('falls back to the title, then the project alone', () => {
    expect(summarizeDelegation({ title: 'Spec sweep', task: 'Repo: C:\\code\\nekko-agent' })).toEqual({ what: 'Spec sweep', project: 'nekko-agent' });
    expect(summarizeToolCall({ name: 'spawn_agent', input: { task: 'Repo: C:\\code\\nekko-agent' } })).toBe('nekko-agent');
  });
});

describe('summarizeToolCall', () => {
  it('shows the command a shell call runs', () => {
    expect(summarizeToolCall({ name: 'bash', input: { command: 'npm run typecheck' } })).toBe('npm run typecheck');
  });

  it('shows the path a file tool touched', () => {
    expect(summarizeToolCall({ name: 'read_file', input: { path: 'packages/host/src/limits.ts' } }))
      .toBe('packages/host/src/limits.ts');
  });

  it('prefers the pattern for a search', () => {
    expect(summarizeToolCall({ name: 'grep', input: { pattern: 'usedPercent', path: '.' } })).toBe('usedPercent');
  });

  it('falls back to the first string argument of an unknown tool', () => {
    expect(summarizeToolCall({ name: 'mcp__thing__do', input: { whatever: 'the subject' } })).toBe('the subject');
  });

  it('is empty when there is nothing worth showing', () => {
    expect(summarizeToolCall({ name: 'list_dir', input: {} })).toBe('');
    expect(summarizeToolCall({ name: 'list_dir' })).toBe('');
    expect(summarizeToolCall({ name: 'x', input: { count: 3 } })).toBe('');
  });
});

describe('truncateWords', () => {
  it('leaves short text alone', () => {
    expect(truncateWords('short', 20)).toBe('short');
  });

  it('cuts on a word boundary', () => {
    expect(truncateWords('one two three four five', 12)).toBe('one two…');
  });
});

describe('summarizeToolCall for ask_user', () => {
  it('shows the question rather than a fragment of the first option', () => {
    expect(
      summarizeToolCall({
        name: 'ask_user',
        input: {
          questions: [
            { header: 'Scope', question: 'How far should this go?', options: [{ label: 'Parser' }] },
            { header: 'Tests', question: 'Which tests?', options: [{ label: 'Unit' }] },
          ],
        },
      }),
    ).toBe('How far should this go? (+1 more)');
  });

  it('says nothing for a call with no question in it', () => {
    expect(summarizeToolCall({ name: 'ask_user', input: { questions: [] } })).toBe('');
  });
});
