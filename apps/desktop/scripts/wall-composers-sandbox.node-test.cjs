const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

// Exercise the actual sandbox's failure/finally path, without launching a GUI.
// Electron app.quit() ignores process.exitCode, so assert the app.exit argument.
test('wall composer evidence returns a nonzero Electron status after a failed journey', async () => {
  const source = readFileSync(path.join(__dirname, 'wall-composers-sandbox.cjs'), 'utf8');
  let pending, report, status;
  const app = {
    setPath() {}, disableHardwareAcceleration() {},
    whenReady: () => ({ then(fn) { pending = fn(); } }),
    exit(code) { status = code; },
    quit() { status = 0; },
  };
  class BrowserWindow {
    webContents = { executeJavaScript() {}, on() {} };
    on() {}
    async loadURL() { throw Error('injected navigation failure'); }
  }
  const session = { defaultSession: { webRequest: { onBeforeRequest() {} }, setPermissionRequestHandler() {} } };
  runInNewContext(source, {
    require(id) {
      if (id === 'electron') return { app, BrowserWindow, session };
      if (id === 'node:fs') return { writeFileSync(_file, text) { report = JSON.parse(text); } };
      if (id === 'node:path') return path;
      throw Error(`unexpected dependency ${id}`);
    },
    process: { env: { NEKKO_INTEGRATION_OUT: 'synthetic-output' } },
    setTimeout,
  });
  await pending;
  assert.equal(report.errors.length, 1);
  assert.match(report.errors[0], /injected navigation failure/);
  assert.equal(status, 1, 'the parent launcher must see the failure');
});
