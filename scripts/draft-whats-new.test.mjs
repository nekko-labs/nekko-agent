import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseWhatsNew } from './build-docs.mjs';
import { checkLine, contributors, draftEntry, fetchPulls, groupCandidates, insertEntry, linePulls, lineRange, render } from './draft-whats-new.mjs';

const pull = (number, over = {}) => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/nekko-labs/nekko-agent/pull/${number}`,
  author: 'ermish',
  bot: false,
  labels: [],
  mergedAt: `2026-11-${String(10 + (number % 10)).padStart(2, '0')}T00:00:00Z`,
  mergeSha: `sha${number}`,
  ...over,
});

const FILE = `{
  "$comment": "highlights",
  "0.10": {
    "date": "2026-11-16",
    "tag": "v0.10.1004",
    "intro": "Billing moves.",
    "contributors": ["ermish"],
    "highlights": [
      { "title": "Search", "detail": "Find things.", "pr": 2389, "authors": ["ermish"] }
    ]
  }
}
`;

test('--line takes MAJOR.MINOR that release.yml would accept', () => {
  assert.deepEqual(checkLine('0.11'), { major: 0, minor: 11 });
  assert.deepEqual(checkLine('1.10'), { major: 1, minor: 10 });
  for (const bad of ['', '0', 'v0.11', '0.11.1000', '0.11 ', '1.0', '0.100', 'x.y']) {
    assert.throws(() => checkLine(bad), JSON.stringify(bad));
  }
});

const TAGS = ['v0.9.0', 'v0.9.1', 'v0.9.5', 'v0.10.1000', 'v0.10.1004', 'v0.10.1011', 'v0.10', 'nightly/ios/v0.10.1020', 'pr-media-8', 'v0.11.0-rc1'];

test('a new line runs from the newest earlier release to HEAD and is tagged .1000', () => {
  assert.deepEqual(lineRange(TAGS, '0.11'), { from: 'v0.10.1011', to: 'HEAD', tag: 'v0.11.1000' });
});

test('a released line runs to its newest release, or to --to', () => {
  assert.deepEqual(lineRange(TAGS, '0.10'), { from: 'v0.9.5', to: 'v0.10.1011', tag: 'v0.10.1011' });
  assert.deepEqual(lineRange(TAGS, '0.10', 'v0.10.1004'), { from: 'v0.9.5', to: 'v0.10.1004', tag: 'v0.10.1004' });
  assert.deepEqual(lineRange(['v0.9.5', 'v0.10'], '0.10'), { from: 'v0.9.5', to: 'v0.10', tag: 'v0.10.1000' });
});

test('a line with no earlier release has no range', () => {
  assert.throws(() => lineRange(['v0.10.1000'], '0.10'), /no release before 0.10/);
  assert.throws(() => lineRange(TAGS, '0.11', 'v0.10.1004'), /--to v0.10.1004 is not a 0.11 release/);
});

test('only pull requests merged in the range count, oldest first, bots left out', () => {
  const pulls = [
    pull(3, { mergedAt: '2026-11-13T00:00:00Z' }),
    pull(1, { mergedAt: '2026-11-11T00:00:00Z' }),
    pull(2, { mergeSha: 'elsewhere' }),
    pull(4, { author: 'agent-nekko-runtime-updates[bot]', bot: true }),
    pull(5, { author: 'vercel[bot]' }),
  ];
  assert.deepEqual(
    linePulls(pulls, new Set(['sha1', 'sha3', 'sha4', 'sha5'])).map((p) => p.number),
    [1, 3],
  );
});

test('contributors: each person once, whatever the case, most pull requests first', () => {
  const pulls = [
    pull(1, { author: 'Ghezz9' }),
    pull(2, { author: 'ermish' }),
    pull(3, { author: 'ghezz9' }),
    pull(4, { author: 'BobbyRobBob' }),
    pull(5, { author: 'austinermish' }),
    pull(6, { author: 'Ermish' }),
    pull(7, { author: 'ermish' }),
  ];
  assert.deepEqual(contributors(pulls), ['ermish', 'Ghezz9', 'austinermish', 'BobbyRobBob']);
});

test('candidates group by label in a fixed order, then the rest', () => {
  const pulls = [
    pull(1, { labels: ['deploy:ios'] }),
    pull(2, { labels: ['bug'] }),
    pull(3, { labels: ['UI', 'feature'] }),
    pull(4),
    pull(5, { labels: ['UI'] }),
    pull(6, { labels: ['enhancement', 'needs-human'] }),
  ];
  const groups = groupCandidates(pulls).map((g) => [g.name, g.pulls.map((p) => p.number)]);
  assert.deepEqual(groups, [
    ['feature', [3]],
    ['enhancement', [6]],
    ['UI', [5]],
    ['bug', [2]],
    ['The rest', [1, 4]],
  ]);
});

test('the written entry fails the site build until a person writes the words', () => {
  const entry = draftEntry({ tag: 'v0.11.1000', date: '2026-11-23', contributors: ['ermish', 'Ghezz9'] });
  assert.deepEqual(entry, { date: '2026-11-23', tag: 'v0.11.1000', intro: '', contributors: ['ermish', 'Ghezz9'], highlights: [] });

  const data = JSON.parse(insertEntry(FILE, '0.11', entry));
  assert.deepEqual(data['0.11'], entry);
  assert.throws(() => parseWhatsNew(data), /0\.11: intro is missing/);

  data['0.11'].intro = 'Faster chats.';
  assert.throws(() => parseWhatsNew(data), /0\.11: highlights are missing/);

  data['0.11'].highlights = [{ title: 'Quicker replies', detail: '', pr: 3000, authors: ['Ghezz9'] }];
  assert.throws(() => parseWhatsNew(data), /Quicker replies: no detail/);

  data['0.11'].highlights[0].detail = 'Half the wait.';
  assert.deepEqual(parseWhatsNew(data).map((l) => [l.line, l.tag]), [['0.11', 'v0.11.1000'], ['0.10', 'v0.10.1004']]);
});

test('the entry goes first and every other byte of the file stays', () => {
  const entry = draftEntry({ tag: 'v0.11.1000', date: '2026-11-23', contributors: ['ermish', 'Ghezz9'] });
  const out = insertEntry(FILE, '0.11', entry);
  const added = `  "0.11": {
    "date": "2026-11-23",
    "tag": "v0.11.1000",
    "intro": "",
    "contributors": ["ermish", "Ghezz9"],
    "highlights": []
  },
`;
  assert.equal(out, FILE.replace('  "0.10": {', `${added}  "0.10": {`));
  assert.deepEqual(Object.keys(JSON.parse(out)), ['$comment', '0.11', '0.10']);
});

test('a line already in the file is never overwritten', () => {
  const entry = draftEntry({ tag: 'v0.10.1011', date: '2026-11-22', contributors: ['ermish'] });
  assert.throws(() => insertEntry(FILE, '0.10', entry), /0\.10 is already in docs\/hub\/whats-new\.json/);
});

test('the summary shows the entry and each candidate with title, author and link', () => {
  const pulls = [pull(7, { title: 'Quicker replies', author: 'Ghezz9', labels: ['UI'] }), pull(8, { title: 'Bump CI cache' })];
  const md = render({
    line: '0.11',
    range: { from: 'v0.10.1011', to: 'HEAD', tag: 'v0.11.1000' },
    entry: draftEntry({ tag: 'v0.11.1000', date: '2026-11-23', contributors: ['ermish', 'Ghezz9'] }),
    groups: groupCandidates(pulls),
  });
  assert.match(md, /`v0\.10\.1011\.\.HEAD`: 2 pull requests from 2 people/);
  assert.ok(md.includes('  "0.11": {\n    "date": "2026-11-23",\n    "tag": "v0.11.1000",'));
  assert.ok(md.includes('#### UI (1)\n\n- Quicker replies · @Ghezz9 · [#7](https://github.com/nekko-labs/nekko-agent/pull/7)\n'));
  assert.ok(md.includes('#### The rest (1)\n\n- Bump CI cache · @ermish · [#8](https://github.com/nekko-labs/nekko-agent/pull/8)\n'));
  assert.ok(md.indexOf('#### UI') < md.indexOf('#### The rest'));
});

test('GitHub is paged newest first until pull requests are older than the range', async () => {
  const raw = (number, updated, merged = updated) => ({
    number,
    title: `PR ${number}`,
    html_url: `https://github.com/nekko-labs/nekko-agent/pull/${number}`,
    user: { login: number === 12 ? 'vercel[bot]' : 'ermish', type: number === 12 ? 'Bot' : 'User' },
    labels: [{ name: 'UI' }],
    merged_at: merged,
    merge_commit_sha: `sha${number}`,
    updated_at: updated,
  });
  const pages = [
    [raw(10, '2026-11-20T00:00:00Z'), raw(11, '2026-11-19T00:00:00Z', null), raw(12, '2026-11-18T00:00:00Z')],
    [raw(13, '2026-11-15T00:00:00Z'), raw(14, '2026-11-01T00:00:00Z')],
    [raw(15, '2026-10-01T00:00:00Z')],
  ];
  const urls = [];
  const fetchImpl = async (url, init) => {
    urls.push(url);
    assert.equal(init.headers.authorization, 'Bearer t0ken');
    const page = Number(new URL(url).searchParams.get('page'));
    return { ok: true, json: async () => pages[page - 1] ?? [] };
  };
  const pulls = await fetchPulls({ repo: 'nekko-labs/nekko-agent', since: '2026-11-08T13:00:00Z', token: 't0ken', fetchImpl });
  assert.deepEqual(urls, [
    'https://api.github.com/repos/nekko-labs/nekko-agent/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100&page=1',
    'https://api.github.com/repos/nekko-labs/nekko-agent/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100&page=2',
  ]);
  assert.deepEqual(pulls.map((p) => [p.number, p.author, p.bot, p.mergeSha]), [
    [10, 'ermish', false, 'sha10'],
    [12, 'vercel[bot]', true, 'sha12'],
    [13, 'ermish', false, 'sha13'],
    [14, 'ermish', false, 'sha14'],
  ]);
  assert.deepEqual(pulls[0].labels, ['UI']);
  assert.equal(pulls[0].url, 'https://github.com/nekko-labs/nekko-agent/pull/10');
});

// git gives the committer's offset (+09:00 in Japan); GitHub gives UTC.
test('paging compares times, not strings, so an offset never stops it early', async () => {
  const raw = (number, updated) => ({
    number,
    title: `PR ${number}`,
    html_url: `https://github.com/nekko-labs/nekko-agent/pull/${number}`,
    user: { login: 'ermish', type: 'User' },
    labels: [],
    merged_at: updated,
    merge_commit_sha: `sha${number}`,
    updated_at: updated,
  });
  const pages = [[raw(20, '2026-11-08T15:00:00Z')], [raw(21, '2026-11-08T14:00:00Z')], [raw(22, '2026-11-08T12:00:00Z')]];
  const fetchImpl = async (url) => ({ ok: true, json: async () => pages[Number(new URL(url).searchParams.get('page')) - 1] ?? [] });

  // 2026-11-08T22:29:44+09:00 is 13:29:44 UTC: 20 and 21 are newer, 22 is older.
  const pulls = await fetchPulls({ repo: 'nekko-labs/nekko-agent', since: '2026-11-08T22:29:44+09:00', fetchImpl });
  assert.deepEqual(pulls.map((p) => p.number), [20, 21, 22]);
});

// A release must never wait on this job: it only reads, and only runs by hand.
test('the draft workflow runs by hand and only reads', () => {
  const workflow = readFileSync(new URL('../.github/workflows/whats-new-draft.yml', import.meta.url), 'utf8');
  const on = workflow.split(/\non:\n/)[1].split(/\n\S/)[0];
  assert.match(on, /^ {2}workflow_dispatch:/);
  assert.doesNotMatch(on, /^ {2}(push|pull_request|release|schedule|workflow_run):/m);
  assert.doesNotMatch(workflow, /: write\b/);
  assert.match(workflow, /node scripts\/draft-whats-new\.mjs --line "\$LINE"/);
});
