import { describe, expect, it } from 'vitest';
import { collectSessionPrInteractions, collectSessionPrUrls, isPrInteractionCall, type PrEvent } from './pr.js';

const pr = 'https://github.com/o/r/pull/9';
const other = 'https://github.com/other/repo/pull/9';
const call = (id: string, command: string, name = 'bash') =>
  ({ role: 'assistant', toolCalls: [{ id, name, input: { command } }] });
const result = (id: string, output = '', isError = false) =>
  ({ role: 'tool', toolResult: { toolCallId: id, output, isError } });
const run = (name: string, command: string, output = pr) => [call('c', command, name), result('c', output)];
const event = (value: PrEvent, url = pr, toolCallId = 'c') => ({ toolCallId, url, event: value });

// These tests intentionally require no live PR snapshot or poller state.
describe('collectSessionPrUrls', () => {
  it('takes a PR Claude Code opened with its Bash tool and a heredoc body', () => {
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

  it('refuses batches around a heredoc and other tools, preserving the existing creation-only session collector', () => {
    const chained = `gh pr create --body "$(cat <<'EOF'\nx\nEOF\n)" && gh pr merge --auto`;
    expect(collectSessionPrUrls(run('Bash', chained))).toEqual([]);
    expect(collectSessionPrUrls(run('Bash', 'gh pr view 9'))).toEqual([]);
    expect(collectSessionPrUrls(run('Read', 'gh pr create --fill'))).toEqual([]);
  });

  it('dedupes URLs, not the underlying repeated lifecycle interactions', () => {
    const messages = [
      call('create', 'gh pr create --fill'), result('create', pr),
      call('read', 'gh pr view 9'), result('read'),
      call('edit', 'gh pr edit 9 --title "New title"'), result('edit'),
      call('again', 'gh pr view 9'), result('again'),
    ];
    expect(collectSessionPrUrls(messages)).toEqual([pr]);
    expect(collectSessionPrInteractions(messages)).toEqual([
      event('created', pr, 'create'), event('viewed', pr, 'read'),
      event('updated', pr, 'edit'), event('viewed', pr, 'again'),
    ]);
  });
});

describe('collectSessionPrInteractions', () => {
  it.each([
    ['create --fill', pr, 'created'],
    [`view ${pr}`, '', 'viewed'],
    [`view ${pr} --json url,state,isDraft`, JSON.stringify({ url: pr, state: 'OPEN', isDraft: true }), 'viewed'],
    [`checks ${pr}`, '', 'viewed'],
    [`diff ${pr}`, 'diff --git a/a b/a', 'viewed'],
    [`ready ${pr}`, '', 'ready'],
    [`ready --undo ${pr}`, '', 'draft'],
    [`close ${pr}`, '', 'closed'],
    [`reopen ${pr}`, '', 'reopened'],
    [`edit ${pr} --title "New title"`, '', 'updated'],
    [`review ${pr} --approve`, '', 'reviewed'],
    [`merge ${pr} --disable-auto`, '', 'updated'],
  ] as const)('maps gh pr %s to %s', (command, output, expected) => {
    expect(collectSessionPrInteractions(run('bash', `gh pr ${command}`, output))).toEqual([event(expected)]);
  });

  it.each([
    'gh pr view 9 --repo o/r',
    'gh pr view --repo o/r 9',
    'gh pr --repo o/r view 9',
    'gh --repo o/r pr view 9',
    'gh pr view --repo=o/r 9',
    'gh pr view 9 -R o/r',
    'gh pr view -R "o/r" 9',
    "gh -R 'o/r' pr view '9'",
    'gh pr -Ro/r view 9',
    'gh pr view 9 -R=o/r',
    'gh pr view --json url,state --repo github.com/o/r 9',
    'gh pr view --repo o/r --json=url,state 9 --jq .url',
    'gh pr review -R o/r --body "Review 123" 9 --approve',
    'gh pr review -a -R o/r 9',
    'gh pr review 9 -r -R o/r',
  ])('resolves numeric targets and repo flags in %s', command => {
    expect(collectSessionPrInteractions(run('Bash', command, ''))).toEqual([
      event(command.includes('review') ? 'reviewed' : 'viewed'),
    ]);
  });

  it.each([
    'gh pr view 9 | tail -5',
    'gh pr view 9 2>&1 | tail -n 5',
    'gh pr view 9 | head -n 10',
    'gh pr view 9 2>&1',
    'cd /worktree && gh pr view 9 | head -10',
  ])('allows existing output-only trims: %s', command => {
    expect(collectSessionPrInteractions(run('bash', command, pr))).toEqual([event('viewed')]);
  });

  it.each([
    ['--auto', '', 'merge-requested'],
    ['', '', 'merge-requested'],
    ['--auto', '✓ Auto-merge enabled for pull request o/r#9', 'auto-merge'],
    ['--auto', '✓ Added pull request o/r#9 to the merge queue', 'queued'],
    ['', 'Added pull request #9 to merge queue', 'queued'],
    ['', '✓ Merged pull request o/r#9 (Fix)', 'merged'],
    ['--auto', '✓ Squashed and merged pull request o/r#9 (Fix)', 'merged'],
    ['', '✓ Rebased and merged pull request o/r#9 (Fix)', 'merged'],
    ['', 'Successfully merged pull request o/r#9', 'merged'],
    ['--auto', JSON.stringify({ url: pr, number: 9, state: 'MERGED' }), 'merged'],
    ['', JSON.stringify({ url: pr, state: 'OPEN' }), 'merge-requested'],
    ['', JSON.stringify({ url: pr, state: 'closed', merged_at: '2026-01-01T00:00:00Z' }), 'merged'],
  ] as const)('separates terminal merge from requests and queues (%s, %s)', (flags, output, expected) => {
    expect(collectSessionPrInteractions(run('bash', `gh pr merge ${pr} ${flags}`, output))).toEqual([event(expected)]);
  });

  it('does not turn a read into creation or a terminal merge event', () => {
    expect(collectSessionPrInteractions(run('bash', 'gh pr view 9', JSON.stringify({ url: pr, state: 'MERGED' })))).toEqual([event('viewed')]);
    expect(collectSessionPrInteractions(run('bash', `gh pr diff ${pr}`, '+merged pull request #9'))).toEqual([event('viewed')]);
  });

  it('accepts existing API creation, including a validated REST response', () => {
    for (const command of [
      'gh api repos/o/r/pulls -X POST --jq .html_url',
      'gh api --method POST repos/o/r/pulls -f title="Fix" -f body="text"',
      'gh api o/r/pulls --method=POST',
    ]) {
      expect(collectSessionPrInteractions(run('Bash', command))).toEqual([event('created')]);
    }
    expect(collectSessionPrInteractions(run('bash', 'gh api repos/o/r/pulls -X POST', JSON.stringify({
      url: 'https://api.github.com/repos/o/r/pulls/9', html_url: pr, number: 9, state: 'open',
    })))).toEqual([event('created')]);
    expect(collectSessionPrInteractions(run('bash', 'gh api repos/o/r/pulls'))).toEqual([]);
    expect(collectSessionPrInteractions(run('bash', 'gh api repos/o/r/pulls/9 -X PATCH'))).toEqual([]);
    expect(collectSessionPrInteractions(run('bash', 'gh api repos/o/r/pulls -X POST', other))).toEqual([]);
  });

  it('uses the explicit result identity without needing a snapshot', () => {
    expect(collectSessionPrInteractions(run('bash', 'gh pr view 9 --json url,number', JSON.stringify({ url: pr, number: 9 })))).toEqual([event('viewed')]);
    expect(collectSessionPrInteractions(run('bash', 'gh pr view', `View this pull request on GitHub: ${pr}`))).toEqual([event('viewed')]);
    expect(collectSessionPrInteractions(run('bash', 'gh pr view', `url:\t${pr}`))).toEqual([event('viewed')]);
    expect(collectSessionPrInteractions(run('bash', 'gh pr view', JSON.stringify({ url: pr, number: 10 })))).toEqual([]);
    expect(collectSessionPrInteractions(run('bash', 'gh pr view 10', pr))).toEqual([]);
    expect(collectSessionPrInteractions(run('bash', `gh pr view ${pr} -R other/repo`, ''))).toEqual([]);
    expect(collectSessionPrInteractions(run('bash', `gh pr view ${pr}`, other))).toEqual([]);
  });

  it('uses only a unique known numeric identity, never an inferred repository', () => {
    expect(collectSessionPrInteractions(run('bash', 'gh pr ready 9', ''))).toEqual([]);
    expect(collectSessionPrInteractions(run('bash', 'gh pr ready 9', ''), [pr])).toEqual([event('ready')]);
    expect(collectSessionPrInteractions(run('bash', 'gh pr ready 9', ''), [pr, pr])).toEqual([event('ready')]);
    expect(collectSessionPrInteractions(run('bash', 'gh pr ready 9', ''), [pr, other])).toEqual([]);
    expect(collectSessionPrInteractions(run('bash', 'gh pr ready 10', ''), [pr])).toEqual([]);
    expect(collectSessionPrInteractions(run('bash', 'gh pr ready main', pr), [pr])).toEqual([]);
    expect(collectSessionPrInteractions(run('bash', 'gh pr ready 9', other), [pr, other])).toEqual([event('ready', other)]);
    expect(collectSessionPrInteractions(run('bash', 'gh pr ready 9 -R other/repo', ''), [pr])).toEqual([event('ready', other)]);
    // Known URLs seed resolution only. They do not themselves emit interactions.
    expect(collectSessionPrInteractions([], [pr])).toEqual([]);
  });

  it('does not disambiguate two proven repositories sharing a PR number', () => {
    const messages = [
      call('one', `gh pr view ${pr}`), result('one'),
      call('two', `gh pr view ${other}`), result('two'),
      call('ambiguous', 'gh pr close 9'), result('ambiguous'),
      call('resolved', 'gh pr close 9 -R o/r'), result('resolved'),
    ];
    expect(collectSessionPrInteractions(messages)).toEqual([
      event('viewed', pr, 'one'), event('viewed', other, 'two'), event('closed', pr, 'resolved'),
    ]);
  });

  it('does not extract a different PR identity from success-line titles', () => {
    expect(collectSessionPrInteractions(run('bash', `gh pr merge ${pr}`, `✓ Merged pull request o/r#9 (Related: ${other}, closes #10)`))).toEqual([event('merged')]);
    expect(collectSessionPrInteractions(run('bash', `gh pr merge ${pr}`, `✓ Merged pull request ${pr} (Related: ${other}, closes #10)`))).toEqual([event('merged')]);
    expect(collectSessionPrInteractions(run('bash', 'gh pr view 9', `url: ${pr}wrong`))).toEqual([]);
    expect(collectSessionPrInteractions(run('bash', 'gh pr merge 9', `✓ Merged pull request o/r#9 (Related: ${other})`))).toEqual([event('merged')]);
  });

  it('normalizes URL suffixes and does not treat body/title URLs as targets', () => {
    expect(collectSessionPrInteractions(run('bash', `gh pr view "${pr}/files?x=1#diff"`, ''))).toEqual([event('viewed')]);
    expect(collectSessionPrInteractions(run('bash', `gh pr edit 9 -R o/r --body '${other}' --title "gh pr merge ${other}; gh pr close 9"`, ''))).toEqual([event('updated')]);
    expect(collectSessionPrInteractions(run('bash', `gh pr edit --body '${pr}'`, ''))).toEqual([]);
    expect(collectSessionPrInteractions(run('bash', `gh pr create --title '${pr}' --body '${other}'`, ''))).toEqual([]);
    expect(collectSessionPrInteractions(run('bash', `gh pr view --json body`, JSON.stringify({ body: pr })))).toEqual([]);
    expect(collectSessionPrInteractions(run('bash', `gh pr close --comment '9'`, ''), [pr])).toEqual([]);
    expect(collectSessionPrInteractions(run('bash', `gh pr close 9 --comment '${other}' -R o/r`, ''))).toEqual([event('closed')]);
    expect(collectSessionPrInteractions(run('bash', 'gh pr diff', `+${pr}`))).toEqual([]);
  });

  it('does not trust formatted fixtures as output identity or terminal state', () => {
    expect(collectSessionPrInteractions(run('bash', `gh pr view 9 --template '${pr}'`, pr))).toEqual([]);
    expect(collectSessionPrInteractions(run('bash', `gh pr view 9 --json body --jq '"${pr}"'`, pr))).toEqual([]);
    expect(collectSessionPrInteractions(run('bash', `gh api repos/o/r/pulls -X POST --template '${pr}'`, pr))).toEqual([]);
    expect(collectSessionPrInteractions(run('bash', `gh pr view ${pr} --template '${other}'`, other))).toEqual([event('viewed')]);
  });

  it('rejects stale or contradictory result identities and invalid merged state', () => {
    for (const output of [
      '✓ Merged pull request other/repo#9 (Old)',
      'Successfully merged pull request other/repo#9 (Old)',
      '✓ Merged pull request o/r#10 (Old)',
      '✓ Merged pull request #10 (Old)',
      JSON.stringify({ number: 10, state: 'MERGED' }),
      JSON.stringify({ url: other, state: 'MERGED' }),
      JSON.stringify({ url: pr, number: 10, state: 'MERGED' }),
    ]) {
      expect(collectSessionPrInteractions(run('bash', `gh pr merge ${pr}`, output))).toEqual([]);
    }
    expect(collectSessionPrInteractions(run('bash', `gh pr merge ${pr}`, JSON.stringify({
      url: pr, state: 'closed', merged_at: 'not a timestamp',
    })))).toEqual([event('merge-requested')]);
  });

  it('keeps repeated events with their originating tool call in call chronology', () => {
    const messages = [
      call('first', `gh pr view ${pr}`), call('second', `gh pr close ${pr}`),
      result('second'), result('first'),
      call('third', 'gh pr reopen 9'), result('third'),
    ];
    expect(collectSessionPrInteractions(messages)).toEqual([
      event('viewed', pr, 'first'), event('closed', pr, 'second'), event('reopened', pr, 'third'),
    ]);
  });

  it('will not use future calls, future proofs, or stale/replayed results', () => {
    expect(collectSessionPrInteractions([result('c', pr), call('c', 'gh pr create --fill')])).toEqual([]);
    expect(collectSessionPrInteractions([
      call('read', 'gh pr ready 9'), call('create', 'gh pr create --fill'),
      result('create', pr), result('read'),
    ])).toEqual([event('created', pr, 'create')]);
    expect(collectSessionPrInteractions([
      call('c', `gh pr close ${pr}`), result('c', 'denied', true), result('c', ''),
    ])).toEqual([]);
    expect(collectSessionPrInteractions([
      call('c', 'gh pr create --fill'), call('c', `gh pr close ${other}`), result('c', pr),
    ])).toEqual([]);
    expect(collectSessionPrInteractions([
      call('c', 'gh pr create --fill'), result('c', pr), result('c', pr),
      call('c', `gh pr close ${pr}`), result('c'),
    ])).toEqual([event('created')]);
  });

  it('does not learn URLs from failed calls or arbitrary transcript mentions', () => {
    const messages = [
      { role: 'user', content: pr }, { role: 'assistant', content: pr },
      call('file', '/tmp/fixture.txt', 'read_file'), result('file', pr),
      call('bad', 'gh pr create --fill'), result('bad', pr, true),
      call('read', 'gh pr ready 9'), result('read'),
    ];
    expect(collectSessionPrInteractions(messages)).toEqual([]);
  });

  it('rejects pending, failed, orphan and non-bash results', () => {
    expect(collectSessionPrInteractions([call('c', `gh pr close ${pr}`)])).toEqual([]);
    expect(collectSessionPrInteractions([result('c', pr)])).toEqual([]);
    expect(collectSessionPrInteractions([call('c', `gh pr close ${pr}`), result('c', pr, true)])).toEqual([]);
    for (const name of ['read_file', 'Read', 'fetch_url', 'start_process', 'bash_script']) {
      expect(collectSessionPrInteractions(run(name, `gh pr close ${pr}`))).toEqual([]);
    }
  });

  it.each([
    'error: failed to merge',
    'GraphQL: Resource not accessible by integration',
    'HTTP 403: Forbidden',
    'fatal: not a git repository',
    '✓ Merged pull request o/r#9\nError: permission denied',
    'Pull request o/r#9 is not mergeable',
    'Merge is blocked by branch protection',
    'Merge denied',
    'Merge request was denied',
    'Pull request cannot be merged',
    'Permission denied',
    'Not Found',
    JSON.stringify({ message: 'Not Found', status: '404' }),
    JSON.stringify({ errors: [{ message: 'Denied' }] }),
    'Pull request merge cannot be performed',
    'Auto-merge is not enabled for this repository',
    'Process exited with code 1',
    'Exit code: 2',
    'exit_code=1',
    'Command timed out',
    'Process is still running',
  ])('does not manufacture success from output errors: %s', output => {
    expect(collectSessionPrInteractions(run('bash', `gh pr merge ${pr} --auto | tail -5`, output))).toEqual([]);
  });

  it.each([
    `echo '${pr}'`,
    `cat fixture.json`,
    `node -e 'console.log("gh pr close ${pr}")'`,
    `bash -c 'gh pr close ${pr}'`,
    `echo 'gh pr close ${pr}'`,
    `gh pr close ${pr}; echo done`,
    `gh pr close ${pr}\ngh pr view ${pr}`,
    `gh pr close ${pr} && gh pr view ${pr}`,
    `gh pr close ${pr} || true`,
    `gh pr close ${pr} &`,
    `gh pr close ${pr} | cat`,
    `gh pr close ${pr} > /tmp/log`,
    `gh pr close $(echo ${pr})`,
    'gh pr close 9 -R "$REPO"',
    'gh pr close 9 -R `repo`',
    `gh pr close ${pr} --help`,
    `gh pr create --dry-run`,
    `gh pr list --json url`,
    `gh pr view main`,
    `gh pr view 9 -R o/r -R other/repo`,
  ])('fails closed on unproven commands: %s', command => {
    expect(collectSessionPrInteractions(run('bash', command))).toEqual([]);
  });
});


describe('numeric gh status identities', () => {
  it.each([
    ['gh pr ready 9 --undo', '✓ Pull request o/r#9 is now marked as draft', 'draft'],
    ['gh pr merge 9 --auto', '✓ Added pull request o/r#9 to the merge queue', 'queued'],
    ['gh pr merge 9', '✓ Merged pull request o/r#9', 'merged'],
  ])('uses the attributable status identity for %s', (command, output, event) => {
    expect(collectSessionPrInteractions(run('bash', command, output))).toEqual([{ toolCallId: 'c', url: pr, event }]);
  });
  it('recognizes only parsed PR tool calls for live retention', () => {
    expect(isPrInteractionCall({ name: 'bash', input: { command: 'gh pr ready 9 --undo' } })).toBe(true);
    expect(isPrInteractionCall({ name: 'read_file', input: { command: 'gh pr create' } })).toBe(false);
    expect(isPrInteractionCall({ name: 'bash', input: { command: 'node -e "gh pr merge 9"' } })).toBe(false);
  });
});

// Adapt the earlier stack's index-based assertions without adding a second production parser.
const collectPrLifecycle = (messages: Parameters<typeof collectSessionPrInteractions>[0], known: string[] = []) =>
  collectSessionPrInteractions(messages, known).map(hit => ({ ...hit, index: messages.findIndex(m => m.toolResult?.toolCallId === hit.toolCallId) }));

describe('reconciled lifecycle regression vectors from #1816', () => {
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
    expect(events(steps(['gh pr merge 9 --auto', '✓ Pull request o/r#9 will be added to the merge queue for main when ready']))).toEqual([[1, 'queued', pr]]);
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
    // Consolidated API also records successful updates; disabling auto-merge is not a merge.
    expect(events(steps(['gh pr merge 9 --disable-auto', '']), [pr])).toEqual([[1, 'updated', pr]]);
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


describe('consolidated confirmation safeguards', () => {
  it('rejects multiple confirmations rather than selecting a convenient state', () => {
    expect(collectSessionPrInteractions(run('bash', `gh pr merge ${pr}`, '✓ Merged pull request o/r#9 (Fix)\n✓ Closed pull request o/r#9 (Fix)'))).toEqual([]);
    expect(collectSessionPrInteractions(run('bash', `gh pr ready ${pr}`, '✓ Pull request o/r#9 is marked as "ready for review"\n✓ Pull request o/r#9 is converted to "draft"'))).toEqual([]);
    expect(collectSessionPrInteractions(run('bash', `gh pr merge ${pr} --disable-auto`, '✓ Merged pull request o/r#9 (Fix)'))).toEqual([]);
  });
  it('never changes creation-only ownership for imported lifecycle events', () => {
    const messages = run('bash', 'gh pr ready fix-branch', '✓ Pull request o/r#9 is marked as "ready for review"');
    expect(collectSessionPrInteractions(messages)).toEqual([event('ready')]);
    expect(collectSessionPrUrls(messages)).toEqual([]);
  });
});
