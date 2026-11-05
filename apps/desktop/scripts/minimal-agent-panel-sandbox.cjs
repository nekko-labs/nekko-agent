// Synthetic renderer evidence only; no host, user profile or external network.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through agent-window-controls-integration.cjs');
app.setPath('userData', path.join(out, 'minimal-profile'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  let win;
  const run = s => win.webContents.executeJavaScript(s, true);
  const report = { checks: [], isolation: null };
  try {
    for (const width of [1400, 640]) {
      const previous = win;
      win = new BrowserWindow({ width, height: 900, useContentSize: true, show: false, focusable: false, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
      if (previous) previous.destroy();
      await win.loadFile(path.join(out, 'index.html'));
      for (let i = 0; i < 80; i++) {
        if (await run("!!document.querySelector('.agent-changes-pending') && !!document.querySelector('[data-agent-group]')")) break;
        await sleep(100);
      }
      await sleep(700);
      await run("window.integration.theme({ theme: 'dark' })");
      await sleep(800);
      const facts = await run(`(() => {
        const b = document.querySelector('.agent-changes-pending');
        if (!b) throw Error('Missing Changes button');
        const s = getComputedStyle(b);
        return { text: b.textContent, background: s.backgroundColor, border: s.borderTopWidth, shadow: s.boxShadow, placeholders: [...document.querySelectorAll('[data-group-cards] p')].map(p => ({ text: p.querySelector('[aria-hidden]')?.textContent ?? p.textContent, label: p.querySelector('.sr-only')?.textContent ?? null })) };
      })()`);
      if (!facts.text.includes('files changed')) throw Error('Change counts missing');
      if (!process.env.NEKKO_MINIMAL_BASELINE) {
        if (facts.background !== 'rgba(0, 0, 0, 0)' || facts.border !== '0px' || facts.shadow !== 'none') throw Error('Changes still boxed: ' + JSON.stringify(facts));
        if (!facts.placeholders.length || facts.placeholders.some(p => p.text !== '–' || p.label !== 'No active agents')) throw Error('Empty groups lack accessible dash');
      }
      fs.writeFileSync(path.join(out, `minimal-${width}.png`), (await win.capturePage(undefined, { stayHidden: true })).toPNG());
      await run("document.querySelector('[data-agent-companion=diff]').click()");
      await sleep(350);
      const opened = await run("document.querySelector('[data-agent-companion=diff]').getAttribute('aria-expanded') === 'true'");
      if (!opened) throw Error('Changes drawer did not open');
      await run("document.querySelector('[data-agent-companion=diff]').click()");
      await sleep(350);
      if (!await run("document.querySelector('[data-agent-companion=diff]').getAttribute('aria-expanded') === 'false'")) throw Error('Changes drawer did not close');
      report.checks.push({ width, facts, opened });
    }
    report.isolation = { visible: win.isVisible(), focusable: win.isFocusable(), focused: win.isFocused(), bounds: win.getBounds() };
    if (report.isolation.visible || report.isolation.focusable || report.isolation.focused) throw Error('Unsafe fixture isolation');
  } catch (e) { report.error = e.stack; process.exitCode = 1; }
  finally {
    fs.writeFileSync(path.join(out, 'minimal-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    win.destroy();
    await session.defaultSession.closeAllConnections();
    app.exit(process.exitCode || 0);
  }
});
