import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BUDGETS, REPORT_ONLY_PROBES } from './budgets.mjs';
import { markLoaded, rendererBuildSizes } from './lib/chunks.mjs';
import { parseProcStat, parsePsTime } from './lib/cpu.mjs';
import { streamTokens } from './lib/content.mjs';
import { LONG_REPLY_CHARS } from './lib/mock-provider.mjs';

test('report-only probes carry no budget, so they cannot gate a run', () => {
  const gated = new Set(BUDGETS.map((b) => b.id));
  assert.ok(REPORT_ONLY_PROBES.length > 0);
  for (const p of REPORT_ONLY_PROBES) {
    assert.ok(!gated.has(p.id), `${p.id} is also a budget`);
    for (const k of ['budget', 'ci', 'target']) assert.ok(!(k in p), `${p.id} has a ${k}`);
    assert.equal(typeof p.measure, 'function');
    assert.ok(['long', 'concurrent', 'startup', 'idle'].includes(p.probe));
  }
  assert.equal(new Set(REPORT_ONLY_PROBES.map((p) => p.id)).size, REPORT_ONLY_PROBES.length);
});

test('the long reply is 10-20 KB of mixed markdown with a code fence', () => {
  assert.ok(LONG_REPLY_CHARS >= 10_000 && LONG_REPLY_CHARS <= 20_000);
  const text = streamTokens(LONG_REPLY_CHARS / 4, 7).join('');
  assert.equal(text.length, LONG_REPLY_CHARS);
  assert.match(text, /```ts/);
  assert.match(text, /^- /m);
  assert.match(text, /^## /m);
});

test('ps and /proc CPU times parse', () => {
  assert.equal(parsePsTime('1:02.50'), 62.5);
  assert.equal(parsePsTime('01:02:03'), 3723);
  assert.equal(parsePsTime('1-00:00:01'), 86401);
  assert.equal(parsePsTime('nonsense'), null);
  const stat = '123 (my (odd) cmd) S 1 2 3 4 5 6 7 8 9 10 250 50 0 0 20 0 1';
  assert.equal(parseProcStat(stat, 100), 3);
});

test('renderer build sizes total the JavaScript and mark what loaded at startup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chunks-test-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'index-a.js'), 'x'.repeat(1000));
  writeFileSync(join(dir, 'assets', 'big-b.js'), 'y'.repeat(5000));
  writeFileSync(join(dir, 'assets', 'style.css'), 'z'.repeat(70));
  const sizes = rendererBuildSizes(dir);
  assert.equal(sizes.count, 2);
  assert.equal(sizes.totalBytes, 6000);
  assert.equal(sizes.cssBytes, 70);
  assert.equal(sizes.chunks[0].file, 'assets/big-b.js');
  const marked = markLoaded(sizes.chunks, ['http://127.0.0.1:4392/assets/index-a.js']);
  assert.deepEqual(marked.map((c) => c.loadedAtStartup), [false, true]);
  assert.equal(rendererBuildSizes(join(dir, 'missing')), null);
});
