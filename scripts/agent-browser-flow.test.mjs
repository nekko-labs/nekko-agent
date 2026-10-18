import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRefs, percentile, runFlow, summarize } from './agent-browser-flow.mjs';

const CONTROLS = JSON.stringify([
  { tag: 'input', id: 'email', name: 'email', type: 'email', label: 'Email' },
  { tag: 'input', id: 'name', name: 'name', type: 'text', label: 'Name' },
  { tag: 'button', id: '', name: '', type: 'submit', label: 'Subscribe' },
]);
const PNG = Buffer.alloc(100, 1).toString('base64');
const SNAPSHOT = 'Signup fixture\n- link "Article 0" [ref=e1]\n- textbox "Email" [required, ref=e41]\n- textbox "Name" [ref=e42]\n- checkbox "Weekly digest" [checked=true, ref=e43]\n- button "Subscribe" [ref=e45]';

/** A fake bridge: the form appears after `formAfter` looks, the result after `resultAfter` waits. */
function fakeBridge({ formAfter = 0, resultAfter = 0 } = {}) {
  const calls = [];
  let looks = 0, waits = 0;
  const reply = (body, ok = true) => ({ ok, body, bytes: Buffer.byteLength(JSON.stringify(body)) });
  const post = async (input) => {
    calls.push(input);
    switch (input.action) {
      case 'navigate': return reply({ output: 'Signup fixture\nLoading form...' });
      case 'evaluate': return reply({ output: looks++ < formAfter ? '[]' : CONTROLS });
      case 'wait':
        if (input.selector === '#result' && waits++ < resultAfter) return reply({ error: 'Timed out' }, false);
        return reply({ output: 'visible' });
      case 'fill': return reply({ output: 'Field filled.' });
      case 'click': return reply({ output: 'Signup fixture\nSubscribing...' });
      case 'extract': return reply({ output: 'Thanks, Ann! Check ann@x.test.' });
      case 'screenshot': return reply({ output: 'Screenshot', image: { data: PNG, mime: 'image/png' } });
      case 'snapshot': return reply({ output: looks++ < formAfter ? 'Signup fixture\nNo interactive elements.' : SNAPSHOT });
      default: return reply({ error: 'unexpected' }, false);
    }
  };
  return { post, calls };
}

test('the selector flow runs navigate, locate, fill, submit, verify and capture', async () => {
  const { post, calls } = fakeBridge();
  const row = await runFlow(post, { url: 'http://x/', name: 'Ann', email: 'ann@x.test' });
  assert.equal(row.ok, true);
  assert.deepEqual(calls.map((c) => c.action), ['navigate', 'evaluate', 'fill', 'fill', 'click', 'wait', 'extract', 'screenshot']);
  assert.deepEqual(calls.filter((c) => c.action === 'fill').map((c) => [c.selector, c.value]), [['#email', 'ann@x.test'], ['#name', 'Ann']]);
  assert.equal(row.calls, 8);
  assert.equal(row.retries, 0);
  assert.equal(row.imageBytes, 100);
  assert.ok(row.textBytes > 0 && row.replyBytes > row.textBytes);
});

test('a form that is not rendered yet and a slow result count as retries', async () => {
  const { post, calls } = fakeBridge({ formAfter: 1, resultAfter: 1 });
  const row = await runFlow(post, { url: 'http://x/', name: 'Ann', email: 'ann@x.test' });
  assert.equal(row.ok, true);
  assert.equal(row.retries, 2);
  assert.equal(row.failedCalls, 1);
  assert.equal(calls.filter((c) => c.action === 'evaluate').length, 2);
  assert.equal(calls.filter((c) => c.action === 'wait').length, 3);
});

test('a form that never renders fails after the retry limit', async () => {
  const { post } = fakeBridge({ formAfter: 99 });
  const row = await runFlow(post, { url: 'http://x/', name: 'Ann', email: 'ann@x.test', maxRetries: 2 });
  assert.equal(row.ok, false);
  assert.match(row.error, /no form/);
  assert.equal(row.retries, 2);
});

test('the snapshot flow locates by snapshot and acts on refs', async () => {
  const { post, calls } = fakeBridge({ formAfter: 1 });
  const row = await runFlow(post, { url: 'http://x/', strategy: 'snapshot', name: 'Ann', email: 'ann@x.test' });
  assert.equal(row.ok, true);
  assert.equal(row.retries, 1);
  assert.deepEqual(calls.map((c) => c.action), ['navigate', 'snapshot', 'wait', 'snapshot', 'fill', 'fill', 'click', 'wait', 'extract', 'screenshot']);
  assert.deepEqual(calls.filter((c) => c.action === 'fill' || c.action === 'click').map((c) => c.selector), ['@e41', '@e42', '@e45']);
});

test('the scoped snapshot flow passes its scope, and request bytes count what the model writes', async () => {
  const { post, calls } = fakeBridge();
  const scoped = await runFlow(post, { url: 'http://x/', strategy: 'snapshot-scoped', name: 'Ann', email: 'ann@x.test' });
  assert.equal(scoped.ok, true);
  assert.deepEqual(calls.find((c) => c.action === 'snapshot'), { action: 'snapshot', selector: 'main' });
  const selectors = await runFlow(fakeBridge().post, { url: 'http://x/', name: 'Ann', email: 'ann@x.test' });
  assert.ok(selectors.requestBytes > scoped.requestBytes, 'listing controls means writing a script');
  assert.equal(scoped.requestBytes, scoped.steps.reduce((n, s) => n + s.requestBytes, 0));
});

test('parseRefs reads role, quoted name and ref from snapshot lines', () => {
  assert.deepEqual(parseRefs(SNAPSHOT), { link: { 'Article 0': '@e1' }, textbox: { Email: '@e41', Name: '@e42' }, checkbox: { 'Weekly digest': '@e43' }, button: { Subscribe: '@e45' } });
  assert.deepEqual(parseRefs('- button "Say \\"hi\\"" [ref=e2]\n- button "Say \\"hi\\"" [ref=e3]'), { button: { 'Say "hi"': '@e2' } });
  assert.deepEqual(parseRefs('No interactive elements.'), {});
});

test('percentile is nearest-rank', () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  assert.equal(percentile([], 50), null);
});

test('summarize groups by driver, scenario and strategy and skips warmups', () => {
  const flow = (driver, scenario, ms, extra = {}) => ({ driver, scenario, strategy: 'selectors', ok: true, totalMs: ms, calls: 8, retries: 0, textBytes: 10, imageBytes: 5, served: { total: 4, assets: 2 }, steps: [{ step: 'navigate', ms }], timings: [{ action: 'navigate', phases: [{ phase: 'spawn', ms: 2 }] }], ...extra });
  const s = summarize([flow('native', 'warmup', 999), flow('native', 'fresh-chat', 10), flow('native', 'fresh-chat', 20), flow('native', 'process-first', 50, { firstInProcess: true })]);
  assert.deepEqual(Object.keys(s), ['native/fresh-chat/selectors', 'native/process-first/selectors/first-driver']);
  assert.equal(s['native/fresh-chat/selectors'].totalMs.p50, 10);
  assert.equal(s['native/fresh-chat/selectors'].navigatePhasesMs.spawn.n, 2);
  assert.equal(s['native/fresh-chat/selectors'].cachedAssetRequests.p50, 2);
});
