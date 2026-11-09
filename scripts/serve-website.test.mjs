import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createWebsiteServer } from './serve-website.mjs';
import { write } from './build-docs.mjs';

test('marketing preview serves only static website files and read requests', async (t) => {
  write(); // the docs pages are gitignored build output
  const server = createWebsiteServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const get = (path, method = 'GET') => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
  const page = await get('/');
  assert.equal(page.status, 200);
  assert.match(page.body, /Nekko Agent/);
  // The launch claim must retain its workload, timing direction and method link.
  assert.match(page.body, /Local code edits\. 5× faster than Ollama\./);
  // The hero's proof is the speed replay under the headline: one video per look,
  // end-frame posters, the claim as its label and caption, and the method link beside it.
  const replay = page.body.slice(page.body.indexOf('<figure class="hero-replay'), page.body.indexOf('</figure>', page.body.indexOf('<figure class="hero-replay')));
  assert.ok(page.body.indexOf('class="tagline') < page.body.indexOf('<figure class="hero-replay'));
  assert.match(replay, /<video[^>]*\bautoplay muted loop playsinline\b/);
  assert.match(replay, /data-src-dark="media\/hero-v2\.mp4"/);
  assert.match(replay, /data-src-light="media\/hero-v2-light\.mp4"/);
  assert.match(replay, /data-poster-dark="media\/hero-v2-poster\.webp"/);
  assert.match(replay, /aria-label="Meet Nekko\. Built in Rust\. It’s fast\. Like, really fast\. Local code edits\. 5× faster than Ollama\. 2\.5 s vs 13\.9 s, whole-file rename benchmark\."/);
  assert.match(replay, /<figcaption[^>]*><strong>Local code edits\. 5× faster than Ollama\.<\/strong> 2\.5 s vs 13\.9 s, whole-file rename benchmark\./);
  assert.match(replay, /href="\/docs\/benchmarks"/);
  assert.doesNotMatch(page.body, /class="hero-proof/);
  for (const f of ['hero-v2.mp4', 'hero-v2-light.mp4', 'hero-v2-poster.webp', 'hero-v2-light-poster.webp']) assert.equal((await get(`/media/${f}`)).status, 200, f);
  assert.doesNotMatch(page.body, /Time to complete reply/);
  // Why Nekko is the five-pillar tour: a vertical tablist beside one demo, the
  // speed pillar titled without a superlative it cannot prove.
  assert.match(page.body, /data-pillar-tour/);
  assert.equal((page.body.match(/role="tab"/g) ?? []).length, 5);
  assert.match(page.body, /Fast\. Really fast\./);
  for (const id of ['local', 'speed', 'privacy', 'fleet', 'anywhere']) {
    for (const f of [`pillar-${id}.mp4`, `pillar-${id}-light.mp4`, `pillar-${id}-poster.jpg`, `pillar-${id}-light-poster.jpg`]) {
      assert.equal((await get(`/media/${f}`)).status, 200, f);
    }
  }
  // The benchmark summary keeps the result, its conditions, the measured losses
  // and the link to the full method, so the headline never hides them.
  const bench = page.body.slice(page.body.indexOf('id="benchmarks"'), page.body.indexOf('panels-foot', page.body.indexOf('id="benchmarks"')));
  assert.ok(bench.length > 200, 'benchmark summary present');
  assert.match(bench, /Whole-file rename benchmark/);
  assert.match(bench, /Ollama 0\.40\.11/);
  assert.match(bench, /cool-chip medians, 8 requests per server/);
  assert.match(bench, /534/);
  assert.match(bench, /256/);
  assert.match(bench, /LM Studio 2\.46\.0/);
  assert.match(bench, /30 September 2026/);
  assert.match(bench, /Where we are not ahead: MLX decodes plain text faster/);
  assert.match(bench, /Ollama starts a fresh long chat faster/);
  assert.match(bench, /inference replies, not a complete agent workflow/);
  assert.match(bench, /href="\/docs\/benchmarks"/);
  assert.doesNotMatch(page.body, /Maybe the fastest|data-demo="fast"/);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.match((await get('/styles.css?v=5')).headers['content-type'], /text\/css/);
  const styles = (await get('/styles.css')).body;
  assert.ok(styles.includes('.bench { grid-column: 1 / -1; min-width: 0;'));
  assert.ok(styles.includes('.bench-legend { display: inline-flex; flex-wrap: wrap;'));
  assert.ok(styles.includes('.panel-fast .panel-copy { order: 0; min-width: 0; }'));
  assert.ok(styles.includes(":root[data-theme='dark'] .media .why-video-dark { display: block; }"));
  assert.equal((await get('/site.js')).status, 200);
  // Clean URLs, as vercel.json serves them.
  assert.match((await get('/docs')).body, /<html/i);
  assert.match((await get('/docs/')).body, /<html/i);
  assert.equal((await get('/docs/cli')).status, 200);
  assert.equal((await get('/docs/index.md')).status, 200);
  assert.equal((await get('/missing')).status, 404);
  assert.equal((await get('/docs/missing')).status, 404);
  assert.equal((await get('/%2e%2e%2fpackage.json')).status, 403);
  assert.equal((await get('/%2e%2e%2fpackage')).status, 403);
  assert.equal((await get('/%')).status, 400);
  assert.equal((await get('/', 'POST')).status, 405);
  const head = await get('/', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
});
