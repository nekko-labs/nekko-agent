// The model selector's Subagents row (#2487): real ModelPicker and
// SubagentModelControl, synthetic bridge, hidden isolated Electron window that
// never takes focus or reaches the network.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Run through layout-evidence-integration.cjs');
const before = process.env.NEKKO_TEST_LABEL === 'before';
const profile = path.join(out, 'profile');
app.setPath('userData', profile);
app.setPath('sessionData', profile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((r, done) => done({ cancel: !/^(file:|data:|blob:)/.test(r.url) }));
  session.defaultSession.setPermissionRequestHandler((_c, _p, done) => done(false));
  const win = new BrowserWindow({ width: 900, height: 820, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -12000, y: -12000, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  const report = { checks: [], errors: [] };
  win.on('focus', () => report.errors.push('Unexpected window focus'));
  win.webContents.on('console-message', (e) => { if (e.level === 'error') report.errors.push(e.message); });
  const run = (code) => win.webContents.executeJavaScript(code, true);
  const check = (name, passed) => { report.checks.push({ name, passed: !!passed }); if (!passed) throw Error(name); };
  const shot = async (name) => { win.webContents.invalidate(); await sleep(200); fs.writeFileSync(path.join(out, name + '.png'), (await win.capturePage(undefined, { stayHidden: true })).toPNG()); };
  const click = (sel) => run('document.querySelector(' + JSON.stringify(sel) + ').click()');
  const text = (sel) => run('document.querySelector(' + JSON.stringify(sel) + ')?.textContent');
  try {
    await win.loadFile(path.join(out, 'index.html'), before ? { search: 'before' } : undefined);
    await sleep(1200);
    for (const [label, width] of [['desktop', 900], ['phone', 380]]) {
      win.setContentSize(width, 820);
      await sleep(350);
      check(label + ': no horizontal overflow', await run('document.documentElement.scrollWidth <= innerWidth'));
      await shot('selector-' + label);
    }
    if (!before) {
      win.setContentSize(900, 820);
      await sleep(300);
      check('row names Auto by default', (await text('[data-subagent-model-label]')) === 'Auto');
      await click('[data-subagent-model-control] button[aria-expanded]');
      await sleep(500);
      check('Auto selected among the choices', await run('document.querySelector("[data-subagent-choice=auto]")?.getAttribute("aria-selected") === "true" && ["auto-same-provider", "auto-local", "inherit"].every((c) => document.querySelector("[data-subagent-choice=" + c + "]"))'));
      check('cloud and local models listed', await run('!!document.querySelector("[data-subagent-model=\'anthropic::claude-sonnet-5-5\']") && !!document.querySelector("[data-subagent-model=\'server::qwen3-32b\']")'));
      check('selector stays open', await run('!!document.querySelector("[data-model-picker]")'));
      await shot('subagents-open-desktop');
      win.setContentSize(380, 820);
      await sleep(350);
      check('phone: no horizontal overflow when open', await run('document.documentElement.scrollWidth <= innerWidth'));
      await shot('subagents-open-phone');
      win.setContentSize(900, 820);
      await sleep(300);
      await win.webContents.debugger.attach('1.3');
      await run('document.querySelector("[aria-label=\'Filter subagent models\']").focus()');
      await win.webContents.debugger.sendCommand('Input.insertText', { text: 'qwen' });
      await sleep(300);
      check('search narrows to the match', await run('document.querySelectorAll("[data-subagent-model]").length === 1'));
      await shot('subagents-search-desktop');
      win.webContents.debugger.detach();
      await click('[data-subagent-model="server::qwen3-32b"]');
      await sleep(300);
      check('a model saves the route', await run('JSON.stringify(window.integration.saved.at(-1).orchestration.delegationRoute) === JSON.stringify({ providerId: "server", modelId: "qwen3-32b" })'));
      check('row names the model', (await text('[data-subagent-model-label]')) === 'Qwen3 32B');
      await click('[data-subagent-model-control] button[aria-expanded]');
      await sleep(300);
      await click('[data-subagent-choice="auto-local"]');
      await sleep(300);
      check('an auto choice clears the route', await run('(() => { const o = window.integration.saved.at(-1).orchestration; return o.subagentModel === "auto-local" && !o.delegationRoute; })()'));
      check('row names the choice', (await text('[data-subagent-model-label]')) === 'Auto · prefer local');
      await shot('subagents-after-pick-desktop');
    }
  } catch (e) {
    report.errors.push(String((e && e.stack) || e));
  } finally {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    win.destroy();
    app.exit(report.errors.length ? 1 : 0);
  }
});
