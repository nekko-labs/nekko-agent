const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');
const { transformSync } = require('esbuild');

// Execute the real bridge setup without mounting App or importing its styles.
// The bootstrap boundary is asserted so moving it cannot silently skip the test.
function fixtureBridge() {
  const source = readFileSync(path.join(__dirname, 'layout-evidence-fixture.tsx'), 'utf8');
  const bootstrap = source.indexOf("import('@nekko-agent/shared').then(");
  assert.ok(bootstrap > 0, 'fixture bootstrap boundary');
  const { code } = transformSync(source.slice(0, bootstrap), { loader: 'tsx', format: 'cjs' });
  const window = {};
  runInNewContext(code, { window, localStorage: { getItem: () => null } });
  return window.nekko;
}

test('layout fixture supplies an empty CI-runner list, not the null fallback', async () => {
  const bridge = fixtureBridge();
  const runners = await bridge.listRunners();
  assert.ok(Array.isArray(runners), 'listRunners must return RunnerView[]');
  assert.equal(runners.length, 0);
  assert.equal(runners.some(() => true), false, 'the real CI panel can derive running state');
  runners.push({ config: { id: 'test-only' } });
  assert.equal((await bridge.listRunners()).length, 0, 'each read gets a fresh empty list');
});

test('runner fixture does not turn every unknown response into a successful list', async () => {
  const bridge = fixtureBridge();
  assert.equal(await bridge.unknownFixtureMethod(), null);
  assert.equal(typeof bridge.onRunnersChanged(() => {}), 'function');
});
