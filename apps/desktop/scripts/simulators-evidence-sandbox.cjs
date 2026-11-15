// Hidden, non-focusable, off-screen window with its own profile and no network.
// On macOS the window is never shown (a shown window is moved back onto a
// display); capturePage({ stayHidden: true }) paints it anyway.
// Launched by simulators-evidence-integration.cjs.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT, shots = process.env.NEKKO_SHOTS_OUT, base = !!process.env.NEKKO_TEST_REVISION;
if (!out) throw Error('Launch through simulators-evidence-integration.cjs');
const tag = base ? 'before' : 'after';
app.setPath('userData', path.join(out, 'profile')); app.setPath('sessionData', path.join(out, 'profile'));
const js = (v) => JSON.stringify(v).replace(/[<>/\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shotFile = process.env.NEKKO_SIM_SHOT;
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((r, done) => done({ cancel: !/^(file:|data:|blob:)/.test(r.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const left = Math.min(...screen.getAllDisplays().map((d) => d.bounds.x));
  const win = new BrowserWindow({ width: 1240, height: 940, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: left - 4000, y: -3000, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  const report = { tag, checks: {}, captures: [], errors: [], visuallyInspected: false };
  win.on('focus', () => report.errors.push('Fixture took focus'));
  win.webContents.on('console-message', (e) => { if (e.level === 'error') report.errors.push(String(e.message).slice(0, 300)); });
  const run = (s) => win.webContents.executeJavaScript(s, true);
  const rect = (sel) => run(`(()=>{const e=document.querySelector(${js(sel)});if(!e)return null;const b=e.getBoundingClientRect();return {x:Math.floor(b.left),y:Math.floor(b.top),width:Math.ceil(b.width),height:Math.ceil(b.height)}})()`);
  const shot = async (name, sel, pad = 0) => {
    const r = await rect(sel);
    if (!r) { report.errors.push(`missing ${sel}`); return; }
    const area = { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.width + pad * 2, height: r.height + pad * 2 };
    const f = path.join(shots, `simulators-${name}-${tag}.png`);
    fs.writeFileSync(f, (await win.capturePage(area, { stayHidden: true })).toPNG());
    report.captures.push(f);
  };
  try {
    for (const theme of ['dark', 'light']) {
      await win.loadFile(path.join(out, 'index.html'));
      await run(`document.documentElement.dataset.theme='${theme}'`);
      if (shotFile) await run(`window.__simulatorShot=${js(fs.readFileSync(shotFile).toString('base64'))}`);
      await sleep(3500);
      report.checks[theme] = await run(`(()=>({
        section: !!document.querySelector('[data-simulator-section]'),
        screen: !!document.querySelector('[data-simulator-screen] img'),
        rows: [...document.querySelectorAll('[data-simulator-row]')].map(r => r.textContent),
        status: document.querySelector('[data-simulator-status]')?.textContent ?? null,
        chip: document.querySelector('[data-simulator-chip]')?.textContent ?? null,
      }))()`);
      await shot(`agent-monitor-${theme}`, '[data-shot="monitor"]');
      await shot(`hardware-${theme}`, '.monitors-dock__monitor[data-monitor="hardware"]', 2);
      await run(`(()=>{const g=document.querySelector('[data-monitor="hardware"] [data-simulator-rows]');let e=g;while(e&&e.scrollHeight<=e.clientHeight)e=e.parentElement;if(e)e.scrollTop=e.scrollHeight})()`);
      await sleep(300);
      await shot(`hardware-simulators-${theme}`, '.monitors-dock__monitor[data-monitor="hardware"]', 2);
      // Fold the group by its header (#2826), shoot, and unfold it again for the next theme.
      const head = '[data-monitor="hardware"] [data-simulator-rows] > button[aria-expanded]';
      if (await rect(head)) {
        await run(`document.querySelector(${js(head)}).click()`);
        await sleep(300);
        report.checks[`${theme}Folded`] = await run(`(()=>({ expanded: document.querySelector(${js(head)})?.getAttribute('aria-expanded'), rows: document.querySelectorAll('[data-monitor="hardware"] [data-simulator-row]').length }))()`);
        await shot(`hardware-folded-${theme}`, '.monitors-dock__monitor[data-monitor="hardware"]', 2);
        await run(`document.querySelector(${js(head)}).click()`);
        await sleep(300);
      }
      await shot(`composer-${theme}`, '[data-shot="composer"]');
      // Hover the chip: renderer input, not OS input.
      const chip = await rect('.monitor-chip button[aria-label="Resource monitors"]');
      if (chip) {
        win.webContents.sendInputEvent({ type: 'mouseMove', x: chip.x + 10, y: chip.y + 8 });
        await sleep(400);
      }
      await shot(`chip-${theme}`, '[data-shot="chip"]');
      // Motion (after only): replay the status line's and the screen's entrance
      // and keep each frame, for a GIF.
      if (!base && theme === 'dark') {
        const frames = path.join(out, 'motion'); fs.rmSync(frames, { recursive: true, force: true }); fs.mkdirSync(frames, { recursive: true });
        const area = await rect('[data-shot="composer"]');
        const screenArea = await rect('[data-simulator-section]');
        // Re-inserting a copy restarts its CSS animation (the copy is only pixels for the GIF).
        await run(`for (const el of document.querySelectorAll('[data-simulator-status],.simulator-screen')) { el.replaceWith(el.cloneNode(true)); }`);
        for (let i = 0; i < 12; i++) {
          fs.writeFileSync(path.join(frames, `status-${String(i).padStart(3, '0')}.png`), (await win.capturePage(area, { stayHidden: true })).toPNG());
          fs.writeFileSync(path.join(frames, `screen-${String(i).padStart(3, '0')}.png`), (await win.capturePage({ ...screenArea, height: Math.min(screenArea.height, 260) }, { stayHidden: true })).toPNG());
          await sleep(25);
        }
        report.motion = frames;
      }
    }
    report.background = { focused: win.isFocused(), visible: win.isVisible(), bounds: win.getBounds() };
  } catch (e) { report.errors.push(String(e && e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  win.destroy(); app.exit(report.captures.length ? 0 : 1);
});
