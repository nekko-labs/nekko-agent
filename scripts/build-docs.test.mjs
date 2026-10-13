import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build, loadNav, slugify } from './build-docs.mjs';

// Staleness itself is not a test: the Docs site workflow regenerates the pages
// and commits them to the PR, so failing CI on the author's commit would only
// add a red run before the fix lands. It does need to run for every source.
test('the Docs site workflow runs for every page source', () => {
  const workflow = readFileSync(new URL('../.github/workflows/docs-site.yml', import.meta.url), 'utf8');
  const block = workflow.split(/\n  push:/)[0].split(/\n    paths:\n/)[1];
  const paths = [...block.matchAll(/^\s+- '([^']+)'$/gm)].map((m) => m[1]);
  const covered = (file) => paths.some((p) => (p.endsWith('/**') ? file.startsWith(p.slice(0, -2)) : file === p));
  const missing = loadNav().pages.map((p) => p.source).filter((s) => !covered(s));
  assert.deepEqual(missing, [], 'add these to the paths in .github/workflows/docs-site.yml');
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
