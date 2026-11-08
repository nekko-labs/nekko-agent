const assert = require('node:assert/strict');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');
const { selectWallView } = require('./wall-view-navigation.cjs');
const { readFileSync } = require('node:fs');
const path = require('node:path');

function fixture(options = {}) {
  const state = { open: !!options.open, mode: 'grid', checked: 'grid', clicks: [], settles: 0 };
  const document = {
    querySelector(selector) {
      if (selector === '[data-wall-view-toggle]') return options.missingToggle ? null : {
        getAttribute: () => String(state.open),
        click: () => { state.clicks.push('View'); state.open = !state.open; },
      };
      if (selector === '[data-wall-view-menu]') return state.open ? {} : null;
      const radio = selector.match(/^\[data-wall-view-menu\] input\[data-view-mode="(focus|grid)"\]$/);
      if (radio) return !state.open || options.missingRadio ? null : {
        disabled: !!options.disabledRadio,
        checked: state.checked === radio[1],
        click: () => {
          state.clicks.push(radio[1]);
          if (!options.unchecked) state.checked = radio[1];
          if (!options.staleLayout) state.mode = radio[1];
        },
      };
      const layout = selector.match(/^\[data-wall-layout="(focus|grid)"\]$/);
      if (layout) return state.mode === layout[1] ? {} : null;
      throw Error('Unexpected selector: ' + selector);
    },
    dispatchEvent(event) {
      assert.equal(event.type, 'keydown');
      assert.equal(event.key, 'Escape');
      state.clicks.push('Escape');
      if (!options.stuckMenu) state.open = false;
    },
  };
  return {
    state,
    run: async source => runInNewContext(source, { document, KeyboardEvent: class { constructor(type, init) { Object.assign(this, { type }, init); } } }),
    settle: async () => { state.settles++; },
  };
}

test('View navigation opens the menu, selects the radio, checks layout and dismisses', async () => {
  const f = fixture();
  await selectWallView(f.run, 'focus', f.settle);
  assert.deepEqual(f.state.clicks, ['View', 'focus', 'Escape']);
  assert.equal(f.state.mode, 'focus');
  assert.equal(f.state.open, false);
  assert.equal(f.state.settles, 3);
  await selectWallView(f.run, 'grid', f.settle);
  assert.equal(f.state.mode, 'grid');
});

test('an already-open View menu is not toggled closed before selection', async () => {
  const f = fixture({ open: true });
  await selectWallView(f.run, 'focus', f.settle);
  assert.deepEqual(f.state.clicks, ['focus', 'Escape']);
});

for (const [option, message] of [
  ['missingToggle', /Missing View toggle/],
  ['missingRadio', /Missing enabled View radio/],
  ['disabledRadio', /Missing enabled View radio/],
  ['unchecked', /View selection did not apply/],
  ['staleLayout', /View selection did not apply/],
  ['stuckMenu', /Escape did not dismiss/],
]) test(`View navigation fails on ${option} rather than silently continuing`, async () => {
  const f = fixture({ [option]: true });
  await assert.rejects(selectWallView(f.run, 'focus', f.settle), message);
});

test('unknown modes fail before executing renderer code', async () => {
  await assert.rejects(selectWallView(() => assert.fail('must not execute'), 'legacy', () => {}), /Unknown wall view/);
});

test('archived baseline fixture and its sibling both resolve the archived renderer', async () => {
  const source = readFileSync(path.join(__dirname, 'wall-controls-integration.cjs'), 'utf8');
  const written = new Map();
  let bundled = false;
  await runInNewContext(source, {
    __dirname,
    require(id) {
      if (id === 'node:fs') return { mkdirSync() {}, readFileSync, writeFileSync(file, text) { written.set(path.basename(file), text); } };
      if (id === 'node:path') return path;
      if (id === 'node:child_process') return { execFileSync() {} };
      if (id.endsWith('esbuild')) return { async build(options) {
        bundled = true;
        assert.equal(path.basename(options.entryPoints[0]), 'base-fixture.tsx');
        for (const file of ['base-fixture.tsx', 'store-sidebar.tsx']) {
          const content = written.get(file);
          assert.ok(content, `${file} is prepared before bundling`);
          assert.ok(content.includes('/base-source/apps/desktop/src/renderer/'), `${file} imports archived renderer`);
          assert.ok(!content.includes("'../src/renderer/"), `${file} never imports current renderer`);
        }
        throw Error('stop before Electron launch');
      } };
      throw Error(`unexpected dependency ${id}`);
    },
    process: { env: { NEKKO_TEST_REVISION: 'synthetic-base' }, argv: [], platform: 'win32' },
    console: { error(error) { assert.equal(error.message, 'stop before Electron launch'); } },
  });
  assert.ok(bundled);
});

test('wall controls sandbox propagates a failed journey to its parent', async () => {
  const source = readFileSync(path.join(__dirname, 'wall-controls-sandbox.cjs'), 'utf8');
  let pending, report, status;
  const app = {
    setPath() {},
    whenReady: () => ({ then(fn) { pending = fn(); } }),
    exit(code) { status = code; },
    quit() { status = 0; },
  };
  class BrowserWindow {
    webContents = { on() {} };
    on() {}
    async loadFile() { throw Error('injected navigation failure'); }
    destroy() {}
  }
  const session = { defaultSession: { webRequest: { onBeforeRequest() {} }, setPermissionRequestHandler() {} } };
  runInNewContext(source, {
    require(id) {
      if (id === 'electron') return { app, BrowserWindow, session, screen: { getAllDisplays: () => [{ bounds: { x: 0, y: 0 } }] } };
      if (id === 'node:fs') return { mkdirSync() {}, writeFileSync(file, text) { if (file.endsWith('status.json')) report = JSON.parse(text); } };
      if (id === 'node:path') return path;
      if (id === './wall-view-navigation.cjs') return { selectWallView };
      throw Error(`unexpected dependency ${id}`);
    },
    process: { env: { NEKKO_INTEGRATION_OUT: 'synthetic-output', NEKKO_GRID_BUGS: '1' } },
    console: { log() {} }, setTimeout,
  });
  await pending;
  assert.equal(report.success, false);
  assert.match(report.errors[0], /injected navigation failure/);
  assert.equal(status, 1, 'Electron must not swallow a failing journey');
});
