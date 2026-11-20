import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { avatarsFrom, build, loadNav, loadWhatsNew, parseWhatsNew, releaseInfo, slugify, whatsNewPage } from './build-docs.mjs';

// Staleness itself is not a test: the pages are built on deploy, and the Docs
// site workflow commits the regenerated llms.txt and sitemap.xml to the PR, so failing CI on the author's commit would only
// add a red run before the fix lands. It does need to run for every source.
test('the Docs site workflow runs for every page source', () => {
  const workflow = readFileSync(new URL('../.github/workflows/docs-site.yml', import.meta.url), 'utf8');
  const block = workflow.split(/\n  push:/)[0].split(/\n    paths:\n/)[1];
  const paths = [...block.matchAll(/^\s+- '([^']+)'$/gm)].map((m) => m[1]);
  const covered = (file) => paths.some((p) => (p.endsWith('/**') ? file.startsWith(p.slice(0, -2)) : file === p));
  const missing = loadNav().pages.map((p) => p.source).filter((s) => !covered(s));
  assert.deepEqual(missing, [], 'add these to the paths in .github/workflows/docs-site.yml');
});

// Vercel skips a commit that touches none of these, so a missed path is a site change that never deploys.
test('Vercel builds for every path the Docs site workflow watches', () => {
  const workflow = readFileSync(new URL('../.github/workflows/docs-site.yml', import.meta.url), 'utf8');
  const block = workflow.split(/\n  push:/)[0].split(/\n    paths:\n/)[1];
  const watched = [...block.matchAll(/^\s+- '([^']+)'$/gm)].map((m) => m[1].replace(/\/\*\*$/, ''));
  const ignore = readFileSync(new URL('./vercel-ignore.sh', import.meta.url), 'utf8');
  const paths = [...ignore.matchAll(/^ {2}([^\s\\]+)(?: \\)?$/gm)].map((m) => m[1]);
  assert.ok(paths.includes('apps/website'));
  const missing = watched.filter((w) => !paths.some((p) => w === p || w.startsWith(`${p}/`)));
  assert.deepEqual(missing, [], 'add these to the paths in scripts/vercel-ignore.sh');
});

test('every nav page has a unique slug and its own output page', () => {
  const { pages } = loadNav();
  const slugs = pages.map((p) => p.slug);
  assert.equal(new Set(slugs).size, slugs.length);
  assert.equal(slugs[0], '', 'the first page is the /docs landing page');
  const files = build();
  for (const slug of slugs) {
    const name = slug || 'index';
    assert.ok(files.has(`docs/${name}.html`), `docs/${name}.html`);
    assert.ok(files.has(`docs/${name}.md`), `docs/${name}.md`);
  }
});

test('repo-relative links become hub links or GitHub links', () => {
  const files = build();
  const agents = files.get('docs/for-agents.html');
  assert.match(agents, /href="https:\/\/github\.com\/nekko-labs\/nekko-agent\/blob\/main\/AGENTS\.md"/);
  assert.match(files.get('docs/for-agents.md'), /\(https:\/\/nekkoagent\.com\/docs\/cli\)/);
  assert.match(files.get('llms.txt'), /<!-- docs:start -->[\s\S]*\/docs\/index\.md[\s\S]*<!-- docs:end -->/);
});

test('a page title with an apostrophe or an ampersand is escaped once, not twice', () => {
  const files = build();
  const page = files.get('docs/whats-new.html');
  assert.match(page, /<h1>What&#39;s new<\/h1>/);
  assert.match(page, /<title>What&#39;s new · Nekko Agent docs<\/title>/);
  assert.match(page, /"headline":"What's new"/);
  for (const [path, html] of files) if (path.endsWith('.html')) assert.doesNotMatch(html, /&amp;(?:#\d+|amp|lt|gt|quot);/, path);
});

test('every link to a docs page, and to a heading on one, resolves', () => {
  const files = build();
  const ids = new Map();
  for (const [path, content] of files) {
    if (!path.endsWith('.html')) continue;
    const url = path === 'docs/index.html' ? '/docs' : `/${path.replace(/\.html$/, '')}`;
    ids.set(url, new Set([...content.matchAll(/ id="([^"]+)"/g)].map((m) => m[1])));
  }
  const broken = [];
  for (const [path, content] of files) {
    if (!path.endsWith('.html')) continue;
    const self = path === 'docs/index.html' ? '/docs' : `/${path.replace(/\.html$/, '')}`;
    for (const [, href] of content.matchAll(/href="((?:\/docs[^"]*)|(?:#[^"]*))"/g)) {
      const [page, hash] = href.startsWith('#') ? [self, href.slice(1)] : href.split('#');
      if (/\.(md|json|css|js)(\?|$)/.test(page) || page.startsWith('/docs/media/')) continue;
      if (!ids.has(page)) broken.push(`${path}: ${href}`);
      else if (hash && !ids.get(page).has(hash)) broken.push(`${path}: ${href}`);
    }
  }
  assert.deepEqual(broken, []);
});

test('heading slugs match GitHub-style anchors', () => {
  assert.equal(slugify('5. Guardrails & sandbox'), '5-guardrails--sandbox');
  assert.equal(slugify('Run it from `source`'), 'run-it-from-source');
});

// The download buttons read this at runtime instead of asking api.github.com, so
// no visitor's browser talks to GitHub just by opening the page.
test('release info keeps only the tag and each asset name and URL', () => {
  const rel = { tag_name: 'v1.2.3', author: { login: 'x' }, assets: [{ name: 'Nekko-x64.exe', browser_download_url: 'https://github.com/a.exe', size: 9 }] };
  assert.deepEqual(releaseInfo(rel), { version: 'v1.2.3', assets: { 'Nekko-x64.exe': 'https://github.com/a.exe' } });
  assert.deepEqual(releaseInfo({}), { version: '', assets: {} });
});

test('no page loads fonts or release info from a third party', () => {
  const pages = [...build().entries()].filter(([path]) => path.endsWith('.html')).map(([, html]) => html);
  for (const file of ['index.html', 'privacy.html', 'site.js', 'pixelwave.js']) pages.push(readFileSync(new URL(`../apps/website/${file}`, import.meta.url), 'utf8'));
  for (const html of pages) assert.doesNotMatch(html, /fonts\.googleapis\.com|fonts\.gstatic\.com|api\.github\.com/);
});

test('feature guides ship consistent crawlable HTML and agent-readable discovery surfaces', () => {
  const files = build();
  const { pages } = loadNav();
  const full = files.get('llms-full.txt');
  const llms = files.get('llms.txt');
  const sitemap = files.get('sitemap.xml');
  for (const slug of ['features', 'file-recovery', 'context-memory-safety']) {
    const page = pages.find((p) => p.slug === slug);
    assert.ok(page, slug);
    const html = files.get(`docs/${slug}.html`);
    const md = files.get(`docs/${slug}.md`);
    const url = `https://nekkoagent.com/docs/${slug}`;
    const headline = md.split('\n').find((line) => line.startsWith('# ')).slice(2);
    assert.equal((html.match(/<h1>/g) ?? []).length, 1);
    assert.ok(html.includes(`<link rel="canonical" href="${url}"`));
    assert.ok(html.includes('content="index,follow,max-image-preview:large,max-snippet:-1"'));
    assert.ok(html.includes(`type="text/markdown" href="/docs/${slug}.md"`));
    assert.ok(html.includes(`<meta name="description" content="${page.description}"`));
    const data = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
    assert.equal(data['@type'], 'TechArticle');
    assert.equal(data.headline, headline);
    assert.equal(data.description, page.description);
    assert.equal(data.url, url);
    assert.ok(full.includes(md.trim()), `full Markdown includes ${slug}`);
    assert.ok(llms.includes(url), `llms links ${slug}`);
    assert.ok(sitemap.includes(`<loc>${url}</loc>`), `sitemap includes ${slug}`);
    assert.ok(files.get('docs/index.html').includes(`href="/docs/${slug}"`));
    assert.ok(files.get('docs/for-agents.html').includes(`href="/docs/${slug}"`));
  }
});

test('task queries find canonical guides, including facts beyond the old 600-character cutoff', () => {
  const files = build();
  const index = JSON.parse(files.get('docs/search.json'));
  const queries = [
    ['persistent memory', '/docs/context-memory-safety'],
    ['prompt injection', '/docs/context-memory-safety'],
    ['batch replacements', '/docs/file-recovery'],
    ['restart originals', '/docs/file-recovery'],
    ['offline shell', '/docs/context-memory-safety'],
    ['tool loops', '/docs/features'],
    ['folding phone', '/docs/features'],
    ['editable prototypes', '/docs/features'],
    ['reusable skills', '/docs/features'],
    ['sub-agents', '/docs/features'],
    ['local-first', '/docs/features'],
    ['MCP server', '/docs/cli'],
    ['scheduled tasks', '/docs/workflows'],
  ];
  for (const [query, target] of queries) {
    const words = query.toLowerCase().split(/\s+/);
    assert.ok(index.some((s) => s.url.split('#')[0] === target && words.every((w) => `${s.page} ${s.heading} ${s.text}`.toLowerCase().includes(w))), query);
  }
  const table = index.find((s) => s.url === '/docs/features#what-can-nekko-agent-help-me-do');
  assert.ok(table.text.indexOf('Check inference speed') > 600, 'late table rows are searchable, not lost after a preview');
  assert.match(files.get('docs/file-recovery.md'), /not assert that every published installer contains it/);
  assert.match(files.get('docs/features.md'), /not an operating-system firewall/);
  assert.match(files.get('docs/context-memory-safety.md'), /Workspace file reads do not currently/);
});

// The What's new page (spec/brand/whats-new-page.md) and its highlights file.
const line = (over = {}) => {
  const l = {
    date: '2026-11-16',
    tag: 'v0.10.1004',
    intro: 'One sentence.',
    highlights: [{ title: 'A thing', detail: 'What it does.', pr: 12, authors: ['octo-cat'] }],
    ...over,
  };
  // Unless a test says otherwise, the release's contributors are its highlights' authors.
  l.contributors ??= [...new Set(l.highlights.flatMap((h) => h.authors ?? []))];
  return l;
};

test('every highlight in the shipped file has a title, a pull request and an author', () => {
  const lines = loadWhatsNew();
  assert.ok(lines.length >= 1);
  for (const l of lines) {
    assert.match(l.line, /^\d+\.\d+$/);
    assert.ok(l.tag.startsWith(`v${l.line}.`));
    assert.ok(l.highlights.length >= 1);
    for (const h of l.highlights) {
      assert.ok(h.title && h.detail);
      assert.ok(Number.isInteger(h.pr) && h.pr > 0);
      assert.ok(h.authors.length >= 1);
    }
  }
});

test('the highlights file is refused when an entry is incomplete or unsafe', () => {
  assert.equal(parseWhatsNew({ $comment: 'x', '0.10': line() }).length, 1);
  const bad = [
    { '0.10.1': line() },
    { '0.10': line({ date: 'November' }) },
    { '0.10': line({ tag: 'v0.11.1000' }) },
    { '0.10': line({ intro: '' }) },
    { '0.10': line({ highlights: [] }) },
    { '0.10': line({ highlights: [{ detail: 'd', pr: 1, authors: ['a'] }] }) },
    { '0.10': line({ highlights: [{ title: 't', detail: 'd', authors: ['a'] }] }) },
    { '0.10': line({ highlights: [{ title: 't', detail: 'd', pr: 1, authors: [] }] }) },
    { '0.10': line({ highlights: [{ title: 't', detail: 'd', pr: 1, authors: ['a/../b'] }] }) },
    { '0.10': { ...line(), contributors: undefined } },
    { '0.10': line({ contributors: [] }) },
    { '0.10': line({ contributors: ['octo-cat', 'a b'] }) },
    { '0.10': line({ contributors: ['octo-cat', 'Octo-Cat'] }) },
    // A highlight's author is one of the release's contributors.
    { '0.10': line({ contributors: ['someone-else'] }) },
  ];
  for (const data of bad) assert.throws(() => parseWhatsNew(data), JSON.stringify(data));
});

test('a highlight may be marked major and tagged with a kind, and nothing else', () => {
  const h = (over) => ({ title: 't', detail: 'd', pr: 1, authors: ['a'], ...over });
  const ok = [{ major: true }, { major: false }, { kind: 'improvement' }, { kind: 'performance' }, { kind: 'fix' }, { major: false, kind: 'fix' }];
  for (const over of ok) assert.equal(parseWhatsNew({ '0.10': line({ highlights: [h(over)] }) }).length, 1, JSON.stringify(over));

  const bad = [{ major: 'yes' }, { major: 1 }, { major: null }, { kind: 'feature' }, { kind: '' }, { kind: 3 }, { kind: 'Fix' }];
  for (const over of bad) assert.throws(() => parseWhatsNew({ '0.10': line({ highlights: [h(over)] }) }), JSON.stringify(over));
});

test('release lines are listed newest first', () => {
  const lines = parseWhatsNew({ '0.10': line(), '1.10': line({ tag: 'v1.10.1000' }), '0.11': line({ tag: 'v0.11.1000' }) });
  assert.deepEqual(lines.map((l) => l.line), ['1.10', '0.11', '0.10']);
});

test('the What\'s new page is built with every highlight, its author and its pull request', () => {
  const html = build().get('whatsnew.html');
  assert.ok(html, 'whatsnew.html');
  assert.equal((html.match(/<h1>/g) ?? []).length, 1);
  assert.ok(html.includes('<link rel="canonical" href="https://nekkoagent.com/whatsnew"'));
  for (const l of loadWhatsNew()) {
    assert.ok(html.includes(`<section id="${l.line}"`));
    assert.ok(html.includes(`href="https://github.com/nekko-labs/nekko-agent/releases/tag/${l.tag}"`));
    for (const h of l.highlights) {
      assert.ok(html.includes(`href="https://github.com/nekko-labs/nekko-agent/pull/${h.pr}"`), `#${h.pr}`);
      for (const login of h.authors) assert.ok(html.includes(`href="https://github.com/${login}"`), login);
    }
  }
  assert.ok(html.includes('href="https://github.com/nekko-labs/nekko-agent/releases"'), 'earlier releases');
  const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, 'anchors are unique');
  assert.doesNotMatch(html, /<script[^>]+src="(?!\/)/, 'no third-party script');
  assert.doesNotMatch(html, /<img[^>]+src="(?!\/)/, 'no third-party image');
});

test('the shipped history runs from 0.7 to today, across three months or more', () => {
  const lines = loadWhatsNew();
  assert.equal(lines.at(-1).line, '0.7', 'history starts at 0.7, the first release under the Nekko name');
  assert.ok(lines.length >= 4);
  assert.ok(new Set(lines.map((l) => l.date.slice(0, 7))).size >= 3, 'three months or more');
  // A line's date never runs ahead of a newer line's.
  for (let i = 1; i < lines.length; i++) assert.ok(lines[i].date <= lines[i - 1].date, lines[i].line);
  const html = build().get('whatsnew.html');
  assert.doesNotMatch(html, /<nav class="rail"[^>]*data-solo/);
  for (const l of lines) assert.ok(html.includes(`class="rail-link" href="#${l.line}"`), l.line);
});

test('the release rail lists every release under its year, newest first, and marks the first', () => {
  const one = whatsNewPage(parseWhatsNew({ '0.10': line() }));
  assert.match(one, /<nav class="rail" aria-label="Releases" data-solo>/);
  assert.equal((one.match(/class="rail-link"/g) ?? []).length, 1);

  const lines = parseWhatsNew({ '0.9': line({ date: '2025-12-02', tag: 'v0.9.1000' }), '0.10': line({ date: '2026-11-16' }), '0.11': line({ date: '2026-12-01', tag: 'v0.11.1000' }) });
  const html = whatsNewPage(lines);
  const rail = html.slice(html.indexOf('<nav class="rail"'), html.indexOf('</nav>', html.indexOf('<nav class="rail"')));
  assert.doesNotMatch(rail, /data-solo/);
  assert.deepEqual([...rail.matchAll(/class="rail-year">(\d+)</g)].map((m) => m[1]), ['2026', '2025']);
  assert.deepEqual([...rail.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]), ['0.11', '0.10', '0.9']);
  assert.match(rail, /href="#0\.11" aria-current="location">December <span class="rail-v">0\.11<\/span>/);
  assert.equal((rail.match(/aria-current/g) ?? []).length, 1);
  // Every rail link has a section to land on.
  for (const [, id] of rail.matchAll(/href="#([^"]+)"/g)) assert.ok(html.includes(`<section id="${id}"`), id);
});

test('every release names everyone who shipped it, in an order no one is always first in', () => {
  const people = ['ada', 'bob', 'cy', 'dee', 'eve'];
  const lines = parseWhatsNew({ '0.10': line({ contributors: [...people, 'octo-cat'] }) });
  const row = (html) => {
    const from = html.indexOf('<ul class="everyone"');
    return [...html.slice(from, html.indexOf('</ul>', from)).matchAll(/href="https:\/\/github\.com\/([^"]+)"/g)].map((m) => m[1]);
  };

  // The order comes from the dice passed in: the same roll gives the same row, another gives another.
  const first = row(whatsNewPage(lines, new Map(), () => 0));
  const last = row(whatsNewPage(lines, new Map(), () => 0.999));
  assert.deepEqual(row(whatsNewPage(lines, new Map(), () => 0)), first);
  assert.notDeepEqual(first, last);
  assert.notEqual(first[0], last[0]);
  for (const order of [first, last]) assert.deepEqual([...order].sort(), [...people, 'octo-cat'].sort());

  const html = whatsNewPage(lines, new Map(), () => 0);
  assert.ok(html.includes('Everyone who shipped 0.10'));
  assert.equal((html.match(/class="everyone-who"/g) ?? []).length, 1);

  // The shipped page: every release has its row, and no bot is in one.
  const shipped = build().get('whatsnew.html');
  for (const l of loadWhatsNew()) {
    assert.ok(shipped.includes(`Everyone who shipped ${l.line}`), l.line);
    for (const login of l.contributors) assert.doesNotMatch(login, /\[bot\]|-bot$/);
    for (const h of l.highlights) for (const login of h.authors) assert.ok(l.contributors.includes(login), `${l.line}: ${login}`);
  }
});

test('highlights sit in two columns when there is room', () => {
  const html = build().get('whatsnew.html');
  assert.match(html, /@media \(min-width: 900px\) \{[^}]*\.highlights \{[^}]*grid-template-columns: 1fr 1fr;/);
});

test('a release with no major highlight renders as it did before headliners', () => {
  const lines = parseWhatsNew({
    '0.9': line({
      date: '2026-11-08',
      tag: 'v0.9.5',
      contributors: ['octo-cat', 'ada'],
      highlights: [
        { title: 'A thing', detail: 'What it does.', pr: 12, authors: ['octo-cat'] },
        { title: 'B', detail: 'D.', pr: 13, authors: ['ada'], major: false, kind: 'fix' },
      ],
    }),
  });
  const html = whatsNewPage(lines, new Map(), () => 0);
  const from = html.indexOf('      <section id="0.9"');
  // Captured from the page before headliners existed: a major-free line keeps every byte.
  assert.equal(
    html.slice(from, html.indexOf('</section>', from) + 10),
    '      <section id="0.9" aria-labelledby="release-0.9">\n        <header class="release-head">\n          <h2 id="release-0.9">0.9</h2>\n          <time datetime="2026-11-08">November 2026</time>\n        </header>\n        <p class="release-intro">One sentence.</p>\n        <ul class="highlights">\n          <li>\n            <h3>A thing</h3>\n            <p>What it does.</p>\n            <p class="shipped"><span class="by-faces"><span class="by-avatar" aria-hidden="true">OC</span></span><span>Shipped by <a class="by" href="https://github.com/octo-cat" rel="noopener">octo-cat</a> <span aria-hidden="true">·</span> <a href="https://github.com/nekko-labs/nekko-agent/pull/12" rel="noopener">#12</a></span></p>\n          </li>\n          <li>\n            <h3>B</h3>\n            <p>D.</p>\n            <p class="shipped"><span class="by-faces"><span class="by-avatar" aria-hidden="true">AD</span></span><span>Shipped by <a class="by" href="https://github.com/ada" rel="noopener">ada</a> <span aria-hidden="true">·</span> <a href="https://github.com/nekko-labs/nekko-agent/pull/13" rel="noopener">#13</a></span></p>\n          </li>\n        </ul>\n        <p class="everyone-who">Everyone who shipped 0.9</p>\n        <ul class="everyone">\n          <li><a class="by" href="https://github.com/ada" rel="noopener"><span class="by-avatar" aria-hidden="true">AD</span>ada</a></li>\n          <li><a class="by" href="https://github.com/octo-cat" rel="noopener"><span class="by-avatar" aria-hidden="true">OC</span>octo-cat</a></li>\n        </ul>\n        <p class="release-all"><a href="https://github.com/nekko-labs/nekko-agent/releases/tag/v0.9.5" rel="noopener">See every change in 0.9 on GitHub ↗</a></p>\n      </section>',
  );
  assert.doesNotMatch(html, /class="headliners"|More in 0\.9/);
});

test('a release with major highlights puts its people first, then the headliners, then the rest as one-liners', () => {
  const lines = parseWhatsNew({
    '0.10': line({
      contributors: ['ada', 'bob'],
      highlights: [
        { title: 'Small one', detail: 'd', pr: 1, authors: ['ada'], kind: 'improvement' },
        { title: 'Big one', detail: 'Big detail.', pr: 2, authors: ['bob'], major: true },
        { title: 'Faster', detail: 'd', pr: 3, authors: ['ada'], kind: 'performance' },
        { title: 'Second big', detail: 'd', pr: 4, authors: ['ada'], major: true },
        { title: 'Untagged', detail: 'd', pr: 5, authors: ['bob'] },
      ],
    }),
  });
  const html = whatsNewPage(lines, new Map(), () => 0);
  const section = html.slice(html.indexOf('<section id="0.10"'), html.indexOf('</section>'));
  const at = (s) => {
    const i = section.indexOf(s);
    assert.ok(i >= 0, s);
    return i;
  };

  // Intro, everyone who shipped, the headliners card, "More in", the GitHub link.
  const order = ['class="release-intro"', 'class="everyone-who"', 'class="headliners"', 'More in 0.10', 'class="release-all"'].map(at);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.doesNotMatch(section, /<ul class="highlights">/);

  // The card: the pixel Nekko and the HEADLINERS pill, then the major highlights in file order, the first one leading.
  const card = section.slice(at('class="headliners"'), at('More in 0.10'));
  assert.match(card, /<svg class="headliners-nekko"[^>]*aria-hidden="true"/);
  assert.match(card, /<span class="headliners-pill">.*>Headliners<\/span>/);
  assert.deepEqual([...card.matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1]), ['Big one', 'Second big']);
  assert.ok(card.indexOf('class="headliner-lead"') < card.indexOf('Big one'));
  assert.ok(card.includes('Big detail.'));
  assert.ok(card.includes('href="https://github.com/bob"') && card.includes('/pull/2"'));

  // The rest, in file order: tag (when it has one), title, pull request link.
  const more = section.slice(at('More in 0.10'), at('class="release-all"'));
  assert.deepEqual([...more.matchAll(/<span class="more-title">([^<]+)<\/span>/g)].map((m) => m[1]), ['Small one', 'Faster', 'Untagged']);
  assert.deepEqual([...more.matchAll(/<span class="more-kind">([^<]+)<\/span>/g)].map((m) => m[1]), ['Improvement', 'Performance']);
  for (const pr of [1, 3, 5]) assert.ok(more.includes(`href="https://github.com/nekko-labs/nekko-agent/pull/${pr}"`), `#${pr}`);
  assert.doesNotMatch(more, /Big one|Second big/);

  // All major: no "More in" list.
  const allMajor = whatsNewPage(parseWhatsNew({ '0.10': line({ highlights: [{ title: 't', detail: 'd', pr: 1, authors: ['a'], major: true }] }) }));
  assert.match(allMajor, /class="headliners"/);
  assert.doesNotMatch(allMajor, /More in 0\.10/);
});

test('the headliners card is the site\'s sticker, in tokens, and holds still', () => {
  const html = build().get('whatsnew.html');
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  const rule = (sel) => {
    const at = css.indexOf(`${sel} {`);
    return at === -1 ? '' : css.slice(at, css.indexOf('}', at));
  };
  assert.match(rule('.headliners'), /border: 2px solid var\(--sticker\);/);
  assert.match(rule('.headliners'), /box-shadow: 5px 5px 0 var\(--lavender\);/);
  const added = css.slice(css.indexOf('.headliners'));
  assert.doesNotMatch(added, /#[0-9a-f]{3,8}\b/i, 'tokens only');
  assert.doesNotMatch(added, /animation|transition/, 'no motion');
  // The shipped 0.10 has headliners and one-liners; the older lines have neither.
  for (const l of loadWhatsNew()) {
    const majors = l.highlights.filter((h) => h.major).length;
    if (l.line === '0.10') assert.ok(majors >= 1 && majors < l.highlights.length, '0.10');
    else assert.equal(majors, 0, l.line);
  }
});

test('each credit leads with the avatars, then says who shipped it', () => {
  const html = whatsNewPage(parseWhatsNew({ '0.10': line({ highlights: [{ title: 't', detail: 'd', pr: 1, authors: ['one', 'two'] }] }) }));
  const credit = html.slice(html.indexOf('<p class="shipped">'), html.indexOf('</p>', html.indexOf('<p class="shipped">')));
  const faces = [...credit.matchAll(/class="by-avatar"/g)].map((m) => m.index);
  assert.equal(faces.length, 2);
  assert.ok(faces.every((at) => at < credit.indexOf('Shipped by')), 'avatars come first');
  assert.ok(credit.indexOf('Shipped by') < credit.indexOf('href="https://github.com/one"'));
  assert.match(html, /\.by-avatar \{[^}]*width: 28px; height: 28px;/);
});

test('the What\'s new page carries the home page\'s dot wave, from one shared first-party script', () => {
  const html = build().get('whatsnew.html');
  assert.match(html, /<canvas id="pixelwave" aria-hidden="true"><\/canvas>/);
  assert.match(html, /<script src="\/pixelwave\.js\?v=\d+" defer><\/script>/);

  const site = (file) => readFileSync(new URL(`../apps/website/${file}`, import.meta.url), 'utf8');
  const wave = site('pixelwave.js');
  assert.match(wave, /getElementById\('pixelwave'\)/);
  assert.match(wave, /prefers-reduced-motion: reduce/);
  assert.doesNotMatch(wave, /https?:\/\//, 'no request leaves the site');
  // One copy: the home page loads the same file and site.js no longer draws the wave.
  assert.match(site('index.html'), /<script src="pixelwave\.js\?v=\d+"/);
  assert.doesNotMatch(site('site.js'), /pixelwave/);
});

test('the What\'s new page speaks in the home page\'s type: heavy title, LED release heading, retro mono dates', () => {
  const html = build().get('whatsnew.html');
  assert.match(html, /\.legal h1 \{[^}]*font-weight: 800;/);
  assert.match(html, /\.legal h2 \{[^}]*font-family: var\(--led\);/);
  assert.match(html, /\.release-head time \{[^}]*var\(--retro-mono\)/);
  assert.match(html, /\.rail \{[^}]*var\(--retro-mono\)/);
});

test('avatars come only from the contributor cache, with initials when one is missing', () => {
  const avatars = avatarsFrom({
    available: true,
    contributors: [
      { login: 'Octo-Cat', avatar: '/contributors/Octo-Cat-0123456789abcdef.png' },
      { login: 'remote', avatar: 'https://avatars.githubusercontent.com/u/1' },
      { login: 'other', avatar: '/contributors/octo-cat-0123456789abcdef.png' },
      { login: 'none' },
    ],
  });
  assert.deepEqual([...avatars], [['octo-cat', '/contributors/Octo-Cat-0123456789abcdef.png']]);
  assert.equal(avatarsFrom({ available: false, contributors: [] }).size, 0);
  assert.equal(avatarsFrom(null).size, 0);

  const lines = parseWhatsNew({ '0.10': line({ highlights: [{ title: 't', detail: 'd', pr: 1, authors: ['octo-cat', 'none'] }] }) });
  const html = whatsNewPage(lines, avatars);
  // Once in the highlight's credit, once in the release's row of everyone.
  assert.equal((html.match(/<img class="by-img"/g) ?? []).length, 2);
  assert.ok(html.includes('src="/contributors/Octo-Cat-0123456789abcdef.png"'));
  assert.ok(html.includes('>OC<') && html.includes('>NO<'), 'initials stay under the image and stand in when it is missing');
  assert.doesNotMatch(whatsNewPage(lines), /<img class="by-img"/);
});

test('text from the highlights file is escaped on the page', () => {
  const html = whatsNewPage(parseWhatsNew({ '0.10': line({ intro: 'a <b> & c', highlights: [{ title: '<script>x</script>', detail: 'd', pr: 1, authors: ['a'] }] }) }));
  assert.ok(html.includes('a &lt;b&gt; &amp; c'));
  assert.doesNotMatch(html, /<script>x<\/script>/);
});

test('every site page links to the What\'s new page, and the sitemap and llms.txt list it', () => {
  const read = (file) => readFileSync(new URL(`../apps/website/${file}`, import.meta.url), 'utf8');
  for (const file of ['index.html', 'status.html', 'privacy.html', 'beta.html', 'pricing.html']) {
    assert.ok((read(file).match(/href="\/whatsnew"/g) ?? []).length === 2, file);
  }
  const files = build();
  assert.ok(files.get('sitemap.xml').includes('<loc>https://nekkoagent.com/whatsnew</loc>'));
  const llmsLinks = [...files.get('llms.txt').matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]);
  assert.ok(llmsLinks.some((link) => link === 'https://nekkoagent.com/whatsnew'), 'llms.txt links the page');
  assert.ok(files.get('docs/whats-new.html').includes('href="/whatsnew"'));
});
