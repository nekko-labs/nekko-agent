import { describe, expect, it } from 'vitest';
import { collectPrLifecycle, collectSessionPrUrls } from './pr.js';

const pr = 'https://github.com/o/r/pull/9';
const run = (name: string, command: string, output = pr) => [
  { role: 'assistant', toolCalls: [{ id: 'c', name, input: { command } }] },
  { role: 'tool', toolResult: { toolCallId: 'c', output } },
];

describe('collectSessionPrUrls', () => {
  it("takes a PR Claude Code opened with its Bash tool and a heredoc body", () => {
    const body = `gh pr create --title "Fix" --body "$(cat <<'EOF'\n## Summary\n- one; two | three\nEOF\n)"`;
    expect(collectSessionPrUrls(run('Bash', body))).toEqual([pr]);
    expect(collectSessionPrUrls(run('bash', 'gh pr create --fill'))).toEqual([pr]);
  });

  it('takes one leading cd into a worktree, as Claude Code runs it', () => {
    const body = `cd C:/Users/me/code/app/.worktrees/fix && gh pr create --title "Fix" --body "$(cat <<'EOF'\nCloses #1.\nEOF\n)"`;
    expect(collectSessionPrUrls(run('Bash', body))).toEqual([pr]);
    expect(collectSessionPrUrls(run('Bash', 'cd "/tmp/my repo" && gh pr create --fill'))).toEqual([pr]);
    expect(collectSessionPrUrls(run('Bash', 'cd a && cd b && gh pr create --fill'))).toEqual([]);
    expect(collectSessionPrUrls(run('Bash', 'cd $(mktemp -d) && gh pr create --fill'))).toEqual([]);
    expect(collectSessionPrUrls(run('Bash', 'cd a && gh pr create --fill && gh pr merge --auto'))).toEqual([]);
  });

  it('reads past a trailing output trim and gh warnings', () => {
    const withTrim = `cd /w && gh pr create --title "Fix" --body "$(cat <<'EOF'\nx\nEOF\n)" 2>&1 | tail -5`;
    expect(collectSessionPrUrls(run('Bash', withTrim, `Warning: 1 uncommitted change\n${pr}`))).toEqual([pr]);
    expect(collectSessionPrUrls(run('Bash', 'gh pr create --fill | grep http'))).toEqual([]);
    expect(collectSessionPrUrls(run('Bash', 'gh pr create --fill', `${pr}\nsomething else`))).toEqual([]);
  });

  it('still refuses a batch around the heredoc, and other tools', () => {
    const chained = `gh pr create --body "$(cat <<'EOF'\nx\nEOF\n)" && gh pr merge --auto`;
    expect(collectSessionPrUrls(run('Bash', chained))).toEqual([]);
    expect(collectSessionPrUrls(run('Bash', 'gh pr view 9'))).toEqual([]);
    expect(collectSessionPrUrls(run('Read', 'gh pr create --fill'))).toEqual([]);
  });
});

describe('collectPrLifecycle', () => {
  const steps = (...runs: Array<[command: string, output: string, isError?: boolean]>) => runs.flatMap(([command, output, isError], i) => [
    { role: 'assistant', toolCalls: [{ id: `c${i}`, name: 'Bash', input: { command } }] },
    { role: 'tool', toolResult: { toolCallId: `c${i}`, output, isError } },
  ]);
  const events = (messages: ReturnType<typeof steps>, known: string[] = []) =>
    collectPrLifecycle(messages, known).map((h) => [h.index, h.event, h.url]);

  it('reads the whole draft to merge sequence, each at its own tool result', () => {
    const m = steps(
      ['gh pr create --draft --fill', pr],
      ['gh pr ready 9', '✓ Pull request o/r#9 is marked as "ready for review"'],
      ['gh pr ready 9 --undo', '✓ Pull request o/r#9 is converted to "draft"'],
      ['gh pr ready https://github.com/o/r/pull/9', '✓ Pull request o/r#9 is marked as "ready for review"'],
      ['gh pr merge 9 --auto', '(no output)'],
    );
    expect(events(m)).toEqual([[1, 'created-draft', pr], [3, 'ready', pr], [5, 'draft', pr], [7, 'ready', pr], [9, 'merge-requested', pr]]);
  });

  it('labels what gh said it did: queued, auto-merge, merged, closed, reopened', () => {
    expect(events(steps(['gh pr merge 9 --auto', '✓ Pull request o/r#9 will be added to the merge queue for main when ready']))).toEqual([[1, 'merge-queued', pr]]);
    expect(events(steps(['gh pr merge 9 --auto --squash', '✓ Pull request o/r#9 will be automatically merged via squash when all requirements are met']))).toEqual([[1, 'auto-merge', pr]]);
    expect(events(steps(['gh pr merge 9 --squash', '✓ Squashed and merged pull request o/r#9 (Fix it)\n✓ Deleted local branch fix']))).toEqual([[1, 'merged', pr]]);
    expect(events(steps(['gh pr close 9 -c "superseded"', '✓ Closed pull request o/r#9 (Fix it)']))).toEqual([[1, 'closed', pr]]);
    expect(events(steps(['gh pr reopen 9', '✓ Reopened pull request o/r#9 (Fix it)']))).toEqual([[1, 'reopened', pr]]);
  });

  it('finds the PR without a URL: from the confirmation line or a known number', () => {
    // A branch selector: gh's own confirmation names the PR.
    expect(events(steps(['cd /w && gh pr ready fix-branch', '✓ Pull request o/r#9 is marked as "ready for review"']))).toEqual([[1, 'ready', pr]]);
    // A silent merge: the number matches the one PR this chat knows.
    expect(events(steps(['gh pr merge 9 --auto', '']), [pr])).toEqual([[1, 'merge-requested', pr]]);
    expect(events(steps(['gh pr merge 9 --auto -R o/r', '']))).toEqual([[1, 'merge-requested', pr]]);
    expect(events(steps(['gh pr merge --repo=o/r "#9" --auto', '(no output)']))).toEqual([[1, 'merge-requested', pr]]);
    // Keeps the spelling the chat already uses for the URL.
    expect(events(steps(['gh pr close 9', '✓ Closed pull request O/R#9 (Fix)']), ['https://github.com/O/R/pull/9'])).toEqual([[1, 'closed', 'https://github.com/O/R/pull/9']]);
  });

  it('a silent merge stays "requested", never "merged"', () => {
    const hits = collectPrLifecycle(steps(['gh pr merge 9', '(no output)']), [pr]);
    expect(hits.map((h) => h.event)).toEqual(['merge-requested']);
    expect(events(steps(['gh pr merge 9 --auto', '(Bash completed with no output)']), [pr])).toEqual([[1, 'merge-requested', pr]]);
    expect(events(steps(['gh pr merge 9 --auto', '[stderr]\n! The merge strategy for main is set by the merge queue']), [pr])).toEqual([[1, 'merge-requested', pr]]);
  });

  it('rejects failed, ambiguous and contradicting results', () => {
    // A failed run.
    expect(events(steps(['gh pr merge 9 --auto', 'GraphQL: Pull request is in clean status', true]), [pr])).toEqual([]);
    // gh warnings that change nothing.
    expect(events(steps(['gh pr ready 9', '! Pull request o/r#9 is already "ready for review"']))).toEqual([]);
    expect(events(steps(['gh pr merge 9', '! Pull request o/r#9 was already merged']), [pr])).toEqual([]);
    expect(events(steps(['gh pr merge 9 --auto', '! Pull request o/r#9 is already queued to merge']), [pr])).toEqual([]);
    expect(events(steps(['gh pr close 9', '! Pull request o/r#9 (Fix) is already closed']))).toEqual([]);
    // The wrong confirmation for the command, or for the selector.
    expect(events(steps(['gh pr ready 9 --undo', '✓ Pull request o/r#9 is marked as "ready for review"']))).toEqual([]);
    expect(events(steps(['gh pr ready 8', '✓ Pull request o/r#9 is marked as "ready for review"']))).toEqual([]);
    expect(events(steps(['gh pr ready 9 -R x/y', '✓ Pull request o/r#9 is marked as "ready for review"']))).toEqual([]);
    // A second PR in the output.
    expect(events(steps(['gh pr close 9', '✓ Closed pull request o/r#9 (Fix)\nsee o/r#10']))).toEqual([]);
    // A silent merge whose PR cannot be named.
    expect(events(steps(['gh pr merge 9 --auto', '']))).toEqual([]);
    expect(events(steps(['gh pr merge --auto', '']), [pr])).toEqual([]);
    expect(events(steps(['gh pr merge 9 --auto', '']), [pr, 'https://github.com/x/y/pull/9'])).toEqual([]);
    expect(events(steps(['gh pr merge 9 --auto', 'something unexpected']), [pr])).toEqual([]);
    expect(events(steps(['gh pr merge 9 --disable-auto', '']), [pr])).toEqual([]);
    // Batches, pipes and other tools.
    expect(events(steps(['gh pr ready 9 && gh pr merge 9 --auto', '✓ Pull request o/r#9 is marked as "ready for review"']))).toEqual([]);
    expect(events(steps(['echo "✓ Pull request o/r#9 is marked as \\"ready for review\\""', '✓ Pull request o/r#9 is marked as "ready for review"']))).toEqual([]);
    expect(collectPrLifecycle([
      { role: 'assistant', toolCalls: [{ id: 'r', name: 'read_file', input: { command: 'gh pr ready 9' } }] },
      { role: 'tool', toolResult: { toolCallId: 'r', output: '✓ Pull request o/r#9 is marked as "ready for review"' } },
    ])).toEqual([]);
  });

  it('the body of a merge commit is not read as its selector', () => {
    expect(events(steps(['gh pr merge 9 --squash --body "fixes 12" -t "Title"', '']), [pr])).toEqual([[1, 'merge-requested', pr]]);
    expect(events(steps([`gh pr merge 9 --squash --body "$(cat <<'EOF'\nline\nEOF\n)"`, '']), [pr])).toEqual([[1, 'merge-requested', pr]]);
  });
});
