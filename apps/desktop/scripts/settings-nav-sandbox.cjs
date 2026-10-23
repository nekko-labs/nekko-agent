// Synthetic Settings evidence: the section nav and where the phone pairing QR lives.
// Launch: NEKKO_LAYOUT_SANDBOX=settings-nav-sandbox.cjs node layout-evidence-integration.cjs
// (NEKKO_TEST_SOURCE=<main checkout> for "before"). Stub bridge only: no host, relay or web.
// Hidden, non-focusable, off-screen window; clicks are DOM events, no OS input.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
app.setPath('sessionData', path.join(out, 'profile'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.on('window-all-closed', () => {});

const remote = `Object.assign(window.nekko, {
  getRemoteStatus: async () => ({ enabled: true, online: true, relayUrl: 'wss://nekko-agent-relay.fly.dev', room: 'r-fixture', devices: [], connected: [] }),
  startRemotePairing: async () => ({ code: 'fixture-code', expiresAt: Date.now() + 300e3 }),
  getRemotePairing: async () => ({ relayUrl: 'wss://nekko-agent-relay.fly.dev', room: 'r-fixture', key: 'fixture-key' }),
}), 0`;

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((r, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(r.url) }));
  session.defaultSession.setPermissionRequestHandler((_c, _p, done) => done(false));
  const left = Math.min(...screen.getAllDisplays().map((d) => d.bounds.x));
  const report = { checks: [], errors: [], measures: {} };
  const check = (name, ok) => report.checks.push({ name, passed: !!ok });
  let win;
  const run = (source) => win.webContents.executeJavaScript(source, true);
  const capture = async (name) => {
    await sleep(500);
    fs.writeFileSync(path.join(out, name + '.png'), (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG());
  };
  try {
    for (const width of [1280, 640]) {
      if (win) win.destroy();
      win = new BrowserWindow({
        width, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: left - 3000, y: -2000,
        webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
      });
      win.on('focus', () => report.errors.push('Fixture took focus'));
      await win.loadFile(path.join(out, 'index.html'));
      win.showInactive();
      await sleep(1500);
      await run(remote);
      await run(`layoutFixture.store.getState().setView('settings')`);
      await sleep(1500);
      await capture(`settings-top-${width}`);
      const nav = await run(`!!document.querySelector('nav[aria-label="Settings sections"]')`);
      if (nav) {
        // The jump animates: part way there one frame-batch in, landed on the section top within 400ms.
        const jump = await run(`new Promise((done) => {
          const s = document.querySelector('nav[aria-label="Settings sections"]').closest('.overflow-y-auto');
          const samples = [];
          const t0 = performance.now();
          [...document.querySelectorAll('.settings-nav-item')].find((b) => b.textContent.includes('System')).click();
          const tick = () => { samples.push([Math.round(performance.now() - t0), Math.round(s.scrollTop)]); if (performance.now() - t0 < 400) requestAnimationFrame(tick); else done({ samples, target: Math.round(document.getElementById('settings-system').getBoundingClientRect().top - s.getBoundingClientRect().top) }); };
          requestAnimationFrame(tick);
        })`);
        report.measures[`jump-${width}`] = jump;
        const end = jump.samples.at(-1)[1];
        check(`System jump animates through intermediate positions (${width})`, jump.samples.some(([, y]) => y > 0 && y < end));
        check(`System jump lands on the section within 400ms (${width})`, Math.abs(jump.target) <= 2 || end === (await run(`(() => { const s = document.querySelector('nav[aria-label="Settings sections"]').closest('.overflow-y-auto'); return s.scrollHeight - s.clientHeight; })()`)));
        check(`System stays highlighted after the jump (${width})`, await run(`document.querySelector('.settings-nav-item[aria-current]')?.textContent.includes('System')`));
        await run(`[...document.querySelectorAll('.settings-nav-item')].find((b) => b.textContent.includes('Phone pairing')).click()`);
        await sleep(1200);
        check(`Phone pairing nav item is current after clicking it (${width})`, await run(`document.querySelector('.settings-nav-item[aria-current]')?.textContent.includes('Phone pairing')`));
      } else {
        await run(`[...document.querySelectorAll('h2')].find((h) => h.textContent.trim() === 'Remote access')?.scrollIntoView({ block: 'start' })`);
        await sleep(600);
      }
      await run(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Pair a device')).click()`);
      await sleep(1500);
      const qr = await run(`(() => { const r = document.querySelector('img[alt="Pairing QR"]')?.getBoundingClientRect(); return r ? { top: r.top, bottom: r.bottom } : null; })()`);
      check(`pairing QR is fully on screen right after Pair a device (${width})`, qr && qr.top >= 0 && qr.bottom <= 900);
      check(`no horizontal overflow (${width})`, !(await run('document.documentElement.scrollWidth > innerWidth')));
      await capture(`settings-phone-${width}`);
    }
  } catch (e) {
    report.errors.push(String(e && e.stack || e));
  }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(0);
});
