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
  assert.match(page.body, /2\.5 s vs 13\.9 s in our whole-file rename benchmark/);
  assert.match(page.body, /Time to complete reply · lower is better/);
  assert.match(page.body, /Ollama 0\.40\.11/);
  assert.match(page.body, /cool-chip medians, 8 requests per server/);
  assert.match(page.body, /inference replies, not a complete agent workflow/);
  assert.match(page.body, /href="\/docs\/benchmarks"/);
  // Broader comparisons follow (rather than replace) the primary latency claim.
  const broader = page.body.indexOf('More comparisons · NVIDIA RTX 5090');
  assert.ok(broader > page.body.indexOf('Time to complete reply · lower is better'));
  const comparison = page.body.slice(broader, page.body.indexOf('</article>', broader));
  assert.match(comparison, /Plain decode/);
  assert.match(comparison, /Code edit/);
  assert.match(comparison, /Four requests at once/);
  assert.ok(comparison.includes('154 tokens/s'));
  assert.ok(comparison.includes('534 tokens/s'));
  assert.ok(comparison.includes('256 tokens/s'));
  assert.match(comparison, /LM Studio 2.46.0/);
  assert.match(comparison, /30 September 2026/);
  assert.match(comparison, /Ollama starts a fresh long chat faster/);
  assert.match(page.body, /aria-describedby="bench-nvidia-note"/);
  assert.doesNotMatch(page.body, /Maybe the fastest|data-demo="fast"/);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.match((await get('/styles.css?v=5')).headers['content-type'], /text\/css/);
  const styles = (await get('/styles.css')).body;
  assert.ok(styles.includes('.bench { grid-column: 1 / -1; min-width: 0;'));
  assert.ok(styles.includes('.bench-legend { display: inline-flex; flex-wrap: wrap;'));
  assert.ok(styles.includes('.panel-fast .panel-copy { order: 0; min-width: 0; }'));
  assert.ok(styles.includes('.panel-fast .speed-proof { order: 1; min-width: 0; }'));
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
