// Drafts a release line's entry in docs/hub/whats-new.json from the pull
// requests merged in it (spec/brand/whats-new-page.md). It fills what GitHub
// knows (date, tag, contributors) and lists the candidates for highlights; a
// person writes the intro and picks the highlights. The empty fields fail the
// site build (parseWhatsNew), so a half-written entry cannot merge.
//
// A line runs from the newest release of an earlier line to the line's newest
// release, or to HEAD before its first one: the range of its GitHub release
// notes, where the hand-written entries took their contributors from.
//
// Usage:
//   node scripts/draft-whats-new.mjs --line 0.11            # print the entry and candidates
//   node scripts/draft-whats-new.mjs --line 0.11 --write    # also add the entry to the file
//   node scripts/draft-whats-new.mjs --line 0.10 --to v0.10.1004
//
// Reads GitHub with GH_TOKEN or GITHUB_TOKEN (read-only use). Needs the release
// tags locally (git fetch --tags; actions/checkout fetch-depth: 0).

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { canonicalReleaseTag, parseReleaseTag } from './nightly-version.mjs';

const FILE = new URL('../docs/hub/whats-new.json', import.meta.url);

// Candidates are grouped by the first of these labels a pull request carries.
const GROUPS =['feature', 'enhancement', 'UI', 'bug', 'Security', 'documentation'];
const REST = 'The rest';

/** `0.11` -> { major, minor }; anything release.yml would refuse throws. */
export function checkLine(line) {
  if (!/^\d+\.\d+$/.test(line)) throw new Error(`--line ${JSON.stringify(line)}: a release line is MAJOR.MINOR, like 0.11.`);

  canonicalReleaseTag(`v${line}`);

  const [major, minor] = line.split('.').map(Number);
  return { major, minor };
}

// Release tags in version order; the short `v0.10` sorts as `v0.10.1000`.
const releases = (tags) =>
  tags
    .map((name) => ({ name, r: parseReleaseTag(name) }))
    .filter((t) => t.r)
    .map(({ name, r }) => ({ name, major: r.major, minor: r.minor, build: Number(canonicalReleaseTag(name).split('.')[2]) }))
    .sort((a, b) => a.major - b.major || a.minor - b.minor || a.build - b.build || a.name.length - b.name.length);

/** The git range of a line and the tag its entry names. */
export function lineRange(tags, line, to) {
  const { major, minor } = checkLine(line);
  const all = releases(tags);

  const earlier = all.filter((t) => t.major < major || (t.major === major && t.minor < minor));
  if (!earlier.length) throw new Error(`There is no release before ${line} to start from.`);
  const from = earlier.at(-1).name;

  const own = all.filter((t) => t.major === major && t.minor === minor);
  if (to !== undefined && !own.some((t) => t.name === to)) throw new Error(`--to ${to} is not a ${line} release tag.`);

  const end = to ?? own.at(-1)?.name;
  if (!end) return { from, to: 'HEAD', tag: canonicalReleaseTag(`v${line}`) };
  return { from, to: end, tag: canonicalReleaseTag(end) };
}

const isBot = (p) => p.bot || /\[bot\]$/i.test(p.author);

/** The people's pull requests whose merge commit is in the line, oldest first. */
export function linePulls(pulls, shas) {
  return pulls.filter((p) => shas.has(p.mergeSha) && !isBot(p)).sort((a, b) => a.mergedAt.localeCompare(b.mergedAt));
}

/** Everyone who merged a pull request, once each (logins ignore case), most first. */
export function contributors(pulls) {
  const people = new Map();
  for (const p of pulls) {
    const key = p.author.toLowerCase();
    const person = people.get(key) ?? { login: p.author, count: 0 };
    person.count += 1;
    people.set(key, person);
  }

  return [...people.entries()].sort(([a, x], [b, y]) => y.count - x.count || a.localeCompare(b)).map(([, p]) => p.login);
}

/** [{ name, pulls }] in GROUPS order, then the rest; empty groups left out. */
export function groupCandidates(pulls) {
  const groups = [...GROUPS, REST].map((name) => ({ name, pulls: [] }));
  for (const p of pulls) {
    const i = GROUPS.findIndex((label) => p.labels.includes(label));
    groups[i === -1 ? GROUPS.length : i].pulls.push(p);
  }

  return groups.filter((g) => g.pulls.length);
}

/** The entry before a person edits it: intro and highlights stay empty. */
export function draftEntry({ tag, date, contributors }) {
  return { date, tag, intro: '', contributors, highlights: [] };
}

// Written in the file's own style, so the diff is the new entry only.
function formatEntry(line, entry) {
  const list = (items) => `[${items.map((s) => JSON.stringify(s)).join(', ')}]`;
  return [
    `  ${JSON.stringify(line)}: {`,
    `    "date": ${JSON.stringify(entry.date)},`,
    `    "tag": ${JSON.stringify(entry.tag)},`,
    `    "intro": ${JSON.stringify(entry.intro)},`,
    `    "contributors": ${list(entry.contributors)},`,
    `    "highlights": ${list(entry.highlights)}`,
    '  },',
    '',
  ].join('\n');
}

/** The file's text with the entry added as its first line; an existing line throws. */
export function insertEntry(text, line, entry) {
  if (Object.hasOwn(JSON.parse(text), line)) throw new Error(`${line} is already in docs/hub/whats-new.json; edit that entry by hand.`);

  const at = text.search(/^ {2}"\d+\.\d+": \{$/m);
  if (at === -1) throw new Error('docs/hub/whats-new.json has no release line to put the entry before.');

  return text.slice(0, at) + formatEntry(line, entry) + text.slice(at);
}

/** The Markdown a person works from: the entry, then the candidates. */
export function render({ line, range, entry, groups }) {
  const count = groups.reduce((n, g) => n + g.pulls.length, 0);
  const out = [
    `## What's new draft: ${line}`,
    '',
    `\`${range.from}..${range.to}\`: ${count} pull requests from ${entry.contributors.length} people, bots left out.`,
    '',
    `Add this entry at the top of \`docs/hub/whats-new.json\` (\`node scripts/draft-whats-new.mjs --line ${line} --write\` does it), then write the intro and pick the highlights from the candidates below. The site build fails until both are filled.`,
    '',
    '```json',
    formatEntry(line, entry).trimEnd(),
    '```',
    '',
    '### Candidates',
  ];

  for (const g of groups) {
    out.push('', `#### ${g.name} (${g.pulls.length})`, '');
    for (const p of g.pulls) out.push(`- ${p.title} · @${p.author} · [#${p.number}](${p.url})`);
  }

  return `${out.join('\n')}\n`;
}

/**
 * Merged pull requests into main, newest update first, paged until a page ends
 * before `since` (a pull request merged after it was updated after it too).
 */
export async function fetchPulls({ repo, since, token, fetchImpl = fetch }) {
  const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'draft-whats-new' };
  if (token) headers.authorization = `Bearer ${token}`;

  const pulls = [];
  for (let page = 1; ; page++) {
    const url = `https://api.github.com/repos/${repo}/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100&page=${page}`;
    const res = await fetchImpl(url, { headers });
    if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${url}`);

    const items = await res.json();
    for (const p of items) {
      if (!p.merged_at) continue;
      pulls.push({
        number: p.number,
        title: p.title,
        url: p.html_url,
        author: p.user.login,
        bot: p.user.type === 'Bot',
        labels: p.labels.map((l) => l.name),
        mergedAt: p.merged_at,
        mergeSha: p.merge_commit_sha,
      });
    }

    if (!items.length || Date.parse(items.at(-1).updated_at) < Date.parse(since)) return pulls;
  }
}

function parseArgs(argv) {
  const o = { write: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--line') o.line = argv[++i];
    else if (a === '--to') o.to = argv[++i];
    else if (a === '--write') o.write = true;
    else throw new Error(`Unknown argument ${a}`);
  }

  if (o.line === undefined) throw new Error('Usage: node scripts/draft-whats-new.mjs --line MAJOR.MINOR [--to TAG] [--write]');
  return o;
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const utcDay = (iso) => new Date(iso).toISOString().slice(0, 10);

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const range = lineRange(git('tag', '-l').split('\n'), o.line, o.to);

  const shas = new Set(git('rev-list', `${range.from}..${range.to}`).split('\n').filter(Boolean));
  const since = git('log', '-1', '--format=%cI', range.from);
  const repo = process.env.GITHUB_REPOSITORY || 'nekko-labs/nekko-agent';
  const pulls = linePulls(await fetchPulls({ repo, since, token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN }), shas);

  const date = range.to === 'HEAD' ? utcDay(Date.now()) : utcDay(git('for-each-ref', '--format=%(creatordate:iso-strict)', `refs/tags/${range.to}`));
  const entry = draftEntry({ tag: range.tag, date, contributors: contributors(pulls) });
  console.error(`${o.line}: ${shas.size} commits in ${range.from}..${range.to}, ${pulls.length} pull requests by people.`);

  if (o.write) {
    writeFileSync(FILE, insertEntry(readFileSync(FILE, 'utf8'), o.line, entry));
    console.error(`Added ${o.line} to docs/hub/whats-new.json.`);
  }

  process.stdout.write(render({ line: o.line, range, entry, groups: groupCandidates(pulls) }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
