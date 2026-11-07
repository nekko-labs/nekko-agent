import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build, loadNav, releaseInfo, slugify } from './build-docs.mjs';

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
