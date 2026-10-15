// Hidden, non-focusable, off-screen window; renderer input only, no OS input; network blocked.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const dir = process.env.NEKKO_EVIDENCE_DIR, kind = process.env.NEKKO_EVIDENCE_KIND;
app.setPath('userData', path.join(dir, 'profile'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((req, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(req.url) }));
  session.defaultSession.setPermissionRequestHandler((_c, _p, done) => done(false));
  const b = screen.getAllDisplays().map((d) => d.bounds);
  const win = new BrowserWindow({ width: 1280, height: 800, useContentSize: true, show: false, focusable: false, skipTaskbar: true,
    x: Math.min(...b.map((x) => x.x)) - 1800, y: Math.min(...b.map((x) => x.y)) - 1800,
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  const report = { kind, checks: {}, errors: [] };
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) report.errors.push(message.slice(0, 300)); });
  const run = (s) => win.webContents.executeJavaScript(s, true);
  const shot = async (name, rect) => { await sleep(350); fs.writeFileSync(path.join(dir, `${name}.png`), (await win.capturePage(rect, { stayHidden: true })).toPNG()); };
  const route = async (r) => { await run(`evidence.route(${JSON.stringify(r)})`); await sleep(700); };
  const click = async (sel) => { const r = await run(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({block:'center'}); const r = e.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`); if (!r) return false; win.webContents.sendInputEvent({ type: 'mouseMove', x: r.x, y: r.y }); await sleep(60); win.webContents.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'left', clickCount: 1 }); win.webContents.sendInputEvent({ type: 'mouseUp', x: r.x, y: r.y, button: 'left', clickCount: 1 }); await sleep(400); return true; };
  try {
    await win.loadFile(path.join(dir, 'index.html')); win.showInactive(); await sleep(900);
    for (const theme of ['dark', 'light']) {
      await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      // 1. Model picker
      await route('picker'); await sleep(500);
      report.checks[`picker-${theme}`] = await run(`({ names: [...document.querySelectorAll('[role=option] span.font-medium, [data-model-name]')].map(e => e.textContent), headings: [...document.querySelectorAll('[role=listbox] > p, [data-provider-heading]')].map(e => ({ text: e.textContent, color: getComputedStyle(e).color, size: getComputedStyle(e).fontSize })) })`);
      await shot(`picker-${theme}`, { x: 0, y: 0, width: 492, height: 592 });
      // 2. Tools menu, online and offline
      for (const off of [false, true]) {
        await route('tools'); await run(`evidence.setOffline(${off})`); await sleep(400);
        const opened = await click('[data-tools-anchor] button');
        report.checks[`tools-${off ? 'offline' : 'online'}-${theme}`] = await run(`({ opened: ${opened}, button: document.querySelector('[data-tools-anchor] button')?.textContent, disabled: document.querySelector('[data-tools-anchor] button')?.disabled, groups: [...document.querySelectorAll('[data-tool-category]')].map(g => g.dataset.toolCategory), enabled: [...document.querySelectorAll('[role=menuitemcheckbox]')].filter(e => !e.disabled).length, note: !!document.querySelector('[data-offline-note]') })`);
        await shot(`tools-${off ? 'offline' : 'online'}-${theme}`, { x: 0, y: 0, width: 640, height: 600 });
      }
      // 3. Wall toolbar (Focused label, accent add icons)
      await route('wall'); await sleep(900);
      report.checks[`wall-${theme}`] = await run(`({ labels: [...document.querySelectorAll('.wall-layout-segments button')].map(b => b.textContent), addColor: getComputedStyle(document.querySelector('.wall-add-icon')).color, accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() })`);
      await shot(`wall-${theme}`, { x: 0, y: 0, width: 1280, height: 140 });
      // 4. Artifacts tab
      await route('artifacts'); await sleep(1200);
      report.checks[`artifacts-${theme}`] = await run(`({ present: !!document.querySelector('[data-artifacts-view]'), groups: [...document.querySelectorAll('[data-artifact-kind]')].map(g => [g.dataset.artifactKind, g.querySelectorAll('[role=listitem]').length]) })`);
      if (await run(`!!document.querySelector('[data-artifacts-view]')`)) {
        await click('[data-artifact-kind="doc"] [role=listitem] button');
        await sleep(800);
        await shot(`artifacts-${theme}`);
      } else await shot(`artifacts-${theme}`);
    }
    // 5. Open chat goes to the wall in Focused, with that chat as the hero.
    if (kind === 'after') {
      await route('artifacts'); await sleep(1200);
      await click('[data-artifact-kind="design"] [role=listitem] button');
      await sleep(500);
      const pressed = await click('[data-artifacts-view] button.btn-primary');
      await sleep(300);
      report.checks.openChat = await run(`({ pressed: ${pressed}, view: evidence.state().view, focusRequest: evidence.state().focusRequest })`);
      await route('wall'); await sleep(1200);
      report.checks.openChatWall = await run(`({ layout: document.querySelector('[data-wall-layout]')?.dataset.wallLayout, hero: [...document.querySelectorAll('[data-wall-hero]')].map(e => e.dataset.gridCell), focusRequest: evidence.state().focusRequest })`);
      await shot('open-chat-focused-light');
    }
  } catch (e) { report.errors.push(String(e && e.stack || e)); }
  report.focused = win.isFocused();
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  win.destroy(); app.exit(0);
});
