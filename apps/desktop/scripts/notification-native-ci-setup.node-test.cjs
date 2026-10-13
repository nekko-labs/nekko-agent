const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

// Execute only the sandbox orchestration with fake Electron/files/processes.
// Never load Electron or execute PowerShell, UIA, screenshots, or OS input.
async function probe(setup, setupExit = 0) {
  const actions = [];
  let constructed = false, result, exitCode;
  let finished;
  const done = new Promise(resolve => { finished = resolve; });
  class FakeNotification {
    static isSupported() { return true; }
    constructor() { constructed = true; throw Error('Test stops before sending any notification'); }
  }
  class FakeWindow {
    async loadURL() {}
    isDestroyed() { return false; }
    destroy() {}
  }
  const modules = {
    './notification-native-ci.cjs': { assertDisposableDesktop() {} },
    electron: { app: { setPath() {}, disableHardwareAcceleration() {}, setAppUserModelId() {}, on() {}, async whenReady() {}, exit(code) { exitCode = code; finished(); } }, BrowserWindow: FakeWindow, Notification: FakeNotification },
    'node:fs': { readFileSync() { return '\uFEFF' + JSON.stringify(setup); }, writeFileSync(_file, data) { result = JSON.parse(data); } },
    'node:path': path,
    'node:assert/strict': assert,
    'node:child_process': { spawn(_command, args) {
      const action = args[args.indexOf('-Action') + 1];
      actions.push(action);
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      queueMicrotask(() => child.emit('close', action === 'setup' ? setupExit : 0));
      return child;
    } },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'notification-native-ci-sandbox.cjs'), 'utf8'), {
    require(name) { assert.ok(name in modules, name); return modules[name]; },
    __dirname, process: { env: { NEKKO_NATIVE_NOTIFICATION_OUT: 'fake', NEKKO_NATIVE_NOTIFICATION_PROFILE: 'fake' } },
    console: { log() {}, error() {} }, setTimeout,
  });
  await done;
  return { actions, constructed, result, exitCode };
}

test('Setup failure or non-off DND prevents notification construction', async () => {
  for (const [state, code] of [[{ dnd: 'Off', deliveryAllowed: true }, 1], [{ dnd: 'On', deliveryAllowed: true }, 0], [{ dnd: 'Indeterminate', deliveryAllowed: false }, 0], [{ dnd: 'Off', deliveryAllowed: false }, 0], [{}, 0]]) {
    const run = await probe(state, code);
    assert.deepEqual(run.actions, ['baseline', 'setup']);
    assert.equal(run.constructed, false);
    assert.equal(run.exitCode, 1);
    assert.equal(run.result.osDelivery, false);
  }
});
test('Successful explicit setup is recorded before notification construction', async () => {
  const run = await probe({ dnd: 'Off', deliveryAllowed: true });
  assert.deepEqual(run.actions, ['baseline', 'setup']);
  assert.equal(run.constructed, true);
  assert.equal(run.result.setup.dnd, 'Off');
  assert.equal(run.result.osDelivery, false); // Setup never counts as actual delivery.
});
