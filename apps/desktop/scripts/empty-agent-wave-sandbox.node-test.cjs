const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

const source = readFileSync(path.join(__dirname, 'empty-agent-wave-sandbox.cjs'), 'utf8');
// Run the actual journey's orchestration and failure propagation without a GUI.
// This is not DOM/rendering evidence: the isolated Electron journey supplies that.
async function journey(failExpression) {
  let pending, report, status, options, filter, permission;
  const expressions = [], views = [];
  const app = {
    setPath() {},
    whenReady: () => ({ then(fn) { pending = fn(); } }),
    exit(code) { status = code; },
  };
  const image = { toPNG: () => Buffer.alloc(0), resize() { return this; } };
  class BrowserWindow {
    constructor(value) { options = value; }
    webContents = {
      on() {}, isOffscreen: () => true,
      async executeJavaScript(code) { expressions.push(code); return code === failExpression ? false : true; },
      debugger: { attach() {}, async sendCommand() {} },
    };
    on() {}
    async loadFile() {}
    async capturePage(_rect, capture) { assert.equal(capture.stayHidden, true); return image; }
    getBounds() { return { width: 1440, height: 900 }; }
    isVisible() { return false; }
    isFocused() { return false; }
  }
  const session = { defaultSession: {
    webRequest: { onBeforeRequest(fn) { filter = fn; } },
    setPermissionRequestHandler(fn) { permission = fn; },
  } };
  runInNewContext(source, {
    require(id) {
      if (id === 'electron') return { app, BrowserWindow, session };
      if (id === 'node:fs') return {
        mkdirSync() {},
        writeFileSync(file, value) { if (file.endsWith('report.json')) report = JSON.parse(value); },
      };
      if (id === 'node:path') return path;
      if (id === './wall-view-navigation.cjs') return { async selectWallView(_run, mode) { views.push(mode); } };
      throw Error(`unexpected dependency ${id}`);
    },
    process: { env: { NEKKO_INTEGRATION_OUT: 'synthetic-output', NEKKO_EXPECT_WAVE_NEW: '1', NEKKO_WAVE_SKIP_CPU: '1' } },
    setTimeout(fn) { fn(); }, console: { log() {} },
  });
  await pending;
  return { report, status, options, expressions, views, filter, permission };
}

test('wave journey keeps isolation and explicitly selects both shipped views', async () => {
  const r = await journey();
  assert.equal(r.status, 0);
  assert.deepEqual(r.report.errors, []);
  assert.deepEqual(r.views, ['focus', 'grid']);
  assert.equal(r.options.show, false);
  assert.equal(r.options.focusable, false);
  assert.equal(r.options.webPreferences.offscreen, true);
  assert.equal(r.options.webPreferences.sandbox, true);
  assert.equal(r.options.webPreferences.contextIsolation, true);
  for (const url of ['https://example.test', 'http://127.0.0.1:1234']) r.filter({ url }, value => assert.equal(value.cancel, true));
  r.permission(null, 'microphone', value => assert.equal(value, false));
  assert.ok(r.expressions.some(e => e.includes("localStorage.setItem('fixture.pending'") && e.includes("question:'Which synthetic task?'")));
  assert.ok(r.expressions.some(e => e.includes("localStorage.removeItem('fixture.pending')") && e.includes("type:'question_resolved'")));
  assert.doesNotMatch(source, /pixel-mascot|mascotPose|button\[title\^="Dynamic/);
});

for (const [label, expression] of [
  ['board-uncovered', `!document.querySelector('[role="dialog"]')`],
  ['send-marks-chat-cat-working-before-token', `document.querySelector('[data-session-id="a"] [data-chat-mascot]')?.dataset.chatMascot === 'working'`],
  ['working-cat-no-motion', `document.querySelector('[data-session-id="a"] [data-chat-mascot] svg')?.getAnimations({subtree:true}).length === 0`],
  ['background-agent-keeps-own-indicator-working', `document.querySelector('[data-grid-cell="chat:b"] [data-wall-mascot]')?.dataset.wallMascot === 'working'`],
  ['finished-chat-cat-idle-while-background-agent-works', `document.querySelector('[data-session-id="a"] [data-chat-mascot]')?.dataset.chatMascot === 'idle'`],
  ['waiting-agent-indicator', `document.querySelector('[data-grid-cell="chat:b"] [data-wall-mascot]')?.dataset.wallMascot === 'input'`],
  ['single-agent-view-selected', `!!document.querySelector('[data-wall-layout="focus"]')`],
  ['multi-agent-view-selected', `!!document.querySelector('[data-wall-layout="grid"]')`],
]) {
  test(`wave journey fails closed when ${label} fails`, async () => {
    const r = await journey(expression);
    assert.equal(r.report.checks[label], false);
    assert.equal(r.status, 1);
    assert.match(r.report.errors[0], new RegExp(label));
  });
}
