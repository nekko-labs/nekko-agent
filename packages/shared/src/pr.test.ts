import { describe, expect, it } from 'vitest';
import { collectSessionPrUrls } from './pr.js';

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
