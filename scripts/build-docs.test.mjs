import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { avatarsFrom, build, changelogPage, loadNav, loadWhatsNew, parseWhatsNew, releaseInfo, slugify } from './build-docs.mjs';

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
  for (const file of ['index.html', 'privacy.html', 'site.js']) pages.push(readFileSync(new URL(`../apps/website/${file}`, import.meta.url), 'utf8'));
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

// The changelog page (spec/brand/changelog-page.md) and its highlights file.
const line = (over = {}) => ({
  date: '2026-11-16',
  tag: 'v0.10.1004',
  intro: 'One sentence.',
  highlights: [{ title: 'A thing', detail: 'What it does.', pr: 12, authors: ['octo-cat'] }],
  ...over,
});

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
  ];
  for (const data of bad) assert.throws(() => parseWhatsNew(data), JSON.stringify(data));
});

test('release lines are listed newest first', () => {
  const lines = parseWhatsNew({ '0.10': line(), '1.10': line({ tag: 'v1.10.1000' }), '0.11': line({ tag: 'v0.11.1000' }) });
  assert.deepEqual(lines.map((l) => l.line), ['1.10', '0.11', '0.10']);
});

test('the changelog page is built with every highlight, its author and its pull request', () => {
  const html = build().get('changelog.html');
  assert.ok(html, 'changelog.html');
  assert.equal((html.match(/<h1>/g) ?? []).length, 1);
  assert.ok(html.includes('<link rel="canonical" href="https://nekkoagent.com/changelog"'));
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

test('jump links appear only when there are two or more release lines', () => {
  const one = changelogPage(parseWhatsNew({ '0.10': line() }));
  assert.doesNotMatch(one, /class="jump"/);
  const two = changelogPage(parseWhatsNew({ '0.10': line(), '0.11': line({ tag: 'v0.11.1000' }) }));
  assert.match(two, /class="jump"[\s\S]*href="#0\.11"[\s\S]*href="#0\.10"/);
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
  const html = changelogPage(lines, avatars);
  assert.equal((html.match(/<img class="by-img"/g) ?? []).length, 1);
  assert.ok(html.includes('src="/contributors/Octo-Cat-0123456789abcdef.png"'));
  assert.ok(html.includes('>OC<') && html.includes('>NO<'), 'initials stay under the image and stand in when it is missing');
  assert.doesNotMatch(changelogPage(lines), /<img class="by-img"/);
});

test('text from the highlights file is escaped on the page', () => {
  const html = changelogPage(parseWhatsNew({ '0.10': line({ intro: 'a <b> & c', highlights: [{ title: '<script>x</script>', detail: 'd', pr: 1, authors: ['a'] }] }) }));
  assert.ok(html.includes('a &lt;b&gt; &amp; c'));
  assert.doesNotMatch(html, /<script>x<\/script>/);
});

test('every site page links to the changelog, and the sitemap and llms.txt list it', () => {
  const read = (file) => readFileSync(new URL(`../apps/website/${file}`, import.meta.url), 'utf8');
  for (const file of ['index.html', 'status.html', 'privacy.html', 'beta.html', 'pricing.html']) {
    assert.ok((read(file).match(/href="\/changelog"/g) ?? []).length === 2, file);
  }
  const files = build();
  assert.ok(files.get('sitemap.xml').includes('<loc>https://nekkoagent.com/changelog</loc>'));
  const llmsLinks = [...files.get('llms.txt').matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]);
  assert.ok(llmsLinks.some((link) => link === 'https://nekkoagent.com/changelog'), 'llms.txt links the changelog');
  assert.ok(files.get('docs/whats-new.html').includes('href="/changelog"'));
});
