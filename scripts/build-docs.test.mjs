import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build, loadNav, slugify, stale } from './build-docs.mjs';

test('the committed docs site matches its Markdown (run `npm run docs`)', () => {
  assert.deepEqual(stale(), []);
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
