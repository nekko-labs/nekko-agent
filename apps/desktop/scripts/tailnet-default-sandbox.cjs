// Synthetic Settings → Remote access evidence (Tailscale or Nekko Cloud); never
// connects to the user's host, profile, relay or the web.
// Launched through tailnet-default-integration.cjs (NEKKO_TEST_REVISION=<rev> for "before").
// Hidden, non-focusable, off-screen window; clicks are DOM events, no OS input.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through tailnet-default-integration.cjs');
const base = !!process.env.NEKKO_TEST_REVISION;
const dir = path.join(out, base ? 'before' : 'after');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
app.setPath('userData', path.join(dir, 'profile'));
app.setPath('sessionData', path.join(dir, 'profile'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const blocked = [];
  session.defaultSession.webRequest.onBeforeRequest((request, done) => {
    const allow = /^(file:|data:|blob:|devtools:)/.test(request.url);
    if (!allow) blocked.push(request.url);
    done({ cancel: !allow });
  });
  session.defaultSession.setPermissionRequestHandler((_c, _p, done) => done(false));
  const left = Math.min(...screen.getAllDisplays().map((d) => d.bounds.x));
  const report = { checks: [], errors: [], measures: {} };
  const check = (name, ok) => report.checks.push({ name, passed: !!ok });
  let win;
  const open = async (width, height) => {
    if (win) { win.destroy(); await sleep(300); }
    win = new BrowserWindow({
      width, height, useContentSize: true, show: false, focusable: false, skipTaskbar: true,
      x: left - 3000, y: -2000, title: 'Synthetic remote access verification',
      webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
    });
    win.on('focus', () => report.errors.push('Fixture took focus'));
    win.webContents.on('console-message', (e) => { if (e.level === 'error' && !/ERR_BLOCKED|net::/.test(e.message)) report.errors.push('console: ' + e.message); });
    await win.loadFile(path.join(out, 'index.html'));
    win.showInactive();
    await sleep(1200);
  };
  const run = (source) => win.webContents.executeJavaScript(source, true);
  const capture = async (name) => {
    await sleep(300);
    const h = await run(`Math.ceil(document.querySelector('section.card').getBoundingClientRect().bottom + 20)`);
    const w = await run('innerWidth');
    fs.writeFileSync(path.join(dir, name + '.png'), (await win.capturePage({ x: 0, y: 0, width: w, height: Math.min(h, 900) }, { stayHidden: true, stayAwake: false })).toPNG());
  };
  const field = () => run(`[...document.querySelectorAll('section.card button')].map((b) => b.textContent.trim() + (b.disabled ? ' (off)' : '')).join(' | ')`);
  try {
    for (const width of [900, 420]) {
      await open(width, 900);
      for (const theme of width === 900 ? ['light', 'dark'] : ['dark']) {
        await run(`document.documentElement.dataset.theme='${theme}'`);
        for (const name of ['tailnet-idle', 'tailnet-running', 'no-tailscale']) {
          await run(`integration.show('${name}')`);
          await sleep(900);
          const value = await field();
          report.measures[`${name}-${theme}-${width}`] = value;
          const overflow = await run('document.documentElement.scrollWidth > innerWidth');
          if (!base) {
            const text = await run(`document.querySelector('section.card').textContent`);
            check(`offers Tailscale and Nekko Cloud, no relay host named (${name}, ${theme}, ${width})`, value.includes('Use Tailscale') && value.includes('Use Nekko Cloud') && !text.includes('fly.dev'));
            check(`Use Tailscale is ${name === 'no-tailscale' ? 'off' : 'on'} (${name}, ${theme}, ${width})`, value.includes('Use Tailscale (off)') === (name === 'no-tailscale'));
            check(`no horizontal overflow (${name}, ${theme}, ${width})`, !overflow);
          }
          await capture(`${name}-${theme}-${width}`);
        }
      }
    }
    if (!base) {
      // Use Tailscale starts the relay first, then enables on its address.
      await run(`integration.show('tailnet-idle')`);
      await sleep(900);
      await run(`[...document.querySelectorAll('section.card button')].find((b) => b.textContent.trim() === 'Use Tailscale').click()`);
      await sleep(900);
      const calls = await run('[...integration.calls]');
      report.measures.enableCalls = calls;
      check('Use Tailscale starts the relay on this computer, then enables remote access on it', JSON.stringify(calls) === JSON.stringify(['localRelay:start', 'remote:enable ws://gomi.tailfd6474.ts.net:4400']));
      check('the enabled card names the connection Tailscale', await run(`document.querySelector('section.card').textContent.includes('Connected through:Tailscale')`));
      await capture('enabled-dark-420');
    }
    check('the renderer requested nothing from the web', blocked.length === 0);
    report.success = !report.errors.length && (base || report.checks.every((c) => c.passed));
  } catch (error) {
    report.errors.push(String((error && error.stack) || error)); report.success = false;
  } finally {
    report.blocked = blocked;
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ dir, success: report.success, failed: report.checks.filter((c) => !c.passed).map((c) => c.name), passed: report.checks.filter((c) => c.passed).length, total: report.checks.length, errors: report.errors.slice(0, 6), measures: report.measures }, null, 2));
    win?.destroy(); app.exit(report.success ? 0 : 1);
  }
});
