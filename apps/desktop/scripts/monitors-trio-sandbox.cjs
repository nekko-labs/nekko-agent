// Hidden, non-focusable, off-screen window with its own profile and no network.
// Launched by monitors-trio-integration.cjs.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT, shots = process.env.NEKKO_SHOTS_OUT, base = !!process.env.NEKKO_TEST_REVISION;
if (!out) throw Error('Launch through monitors-trio-integration.cjs');
const tag = base ? 'before' : 'after';
app.setPath('userData', path.join(out, 'profile')); app.setPath('sessionData', path.join(out, 'profile'));
// JSON.stringify leaves <, >, / and U+2028/2029 raw; escape them before splicing into evaluated code.
const js = (v) => JSON.stringify(v).replace(/[<>/\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((r, done) => done({ cancel: !/^(file:|data:|blob:)/.test(r.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const left = Math.min(...screen.getAllDisplays().map((d) => d.bounds.x));
  const win = new BrowserWindow({ width: 1440, height: 960, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: left - 4000, y: -3000, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  const report = { tag, checks: {}, captures: [], errors: [] };
  win.on('focus', () => report.errors.push('Fixture took focus'));
  win.webContents.on('console-message', (e) => { if (e.level === 'error') report.errors.push(String(e.message).slice(0, 300)); });
  const run = (s) => win.webContents.executeJavaScript(s, true);
  const rect = (sel) => run(`(()=>{const e=document.querySelector(${js(sel)});if(!e)return null;const b=e.getBoundingClientRect();return {x:Math.floor(b.left),y:Math.floor(b.top),width:Math.ceil(b.width),height:Math.ceil(b.height)}})()`);
  const shot = async (name, sel, pad = 0) => {
    const r = await rect(sel);
    if (!r) { report.errors.push(`missing ${sel}`); return; }
    const area = { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.width + pad * 2, height: r.height + pad * 2 };
    const f = path.join(shots, `${name}-${tag}.png`);
    fs.writeFileSync(f, (await win.capturePage(area, { stayHidden: true })).toPNG());
    report.captures.push(f);
  };
  try {
    for (const source of ['repo', 'linear']) {
      for (const theme of ['dark', 'light']) {
        await win.loadFile(path.join(out, 'index.html'), { query: { source } }); win.showInactive();
        await run(`document.documentElement.dataset.theme='${theme}'`);
        await sleep(1200);
        report.checks[`${source}-${theme}`] = await run(`(()=>({
          project: document.querySelector('[data-monitor-project]')?.getAttribute('data-project-source') ?? null,
          tasks: document.querySelector('[data-monitor-tasks]') ? 'old Tasks section' : null,
          rows: [...document.querySelectorAll('.monitors-dock__meter')].map(m => (m.querySelector('strong')?.textContent ?? '') + ' | ' + (m.querySelector('.monitors-dock__temp')?.textContent ?? '-')),
          screensButton: !!document.querySelector('[data-screens-button]'),
        }))()`);
        await shot(`agent-monitor-${source}-${theme}`, '[data-shot="monitor"]');
        if (source === 'repo') {
          await shot(`hardware-${theme}`, '.monitors-dock__monitor[data-monitor="hardware"]', 2);
          await shot(`toolbar-${theme}`, '[data-wall-toolbar]', 4);
          // Hover the Screens button: dispatched DOM events, never OS input.
          const opened = await run(`(()=>{const c=document.querySelector('.screens-control');if(!c)return false;c.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));return true})()`);
          if (opened) {
            await sleep(300);
            report.checks[`screens-${theme}`] = await run(`(()=>({ tiles: [...document.querySelectorAll('.screens-tile')].map(t=>t.getAttribute('aria-label')), options: [...document.querySelectorAll('.screens-option strong')].map(s=>s.textContent) }))()`);
            const t = await rect('[data-wall-toolbar]'), p = await rect('.screens-picker');
            const area = { x: Math.max(0, Math.min(t.x, p.x) - 4), y: Math.max(0, t.y - 10), width: Math.max(t.x + t.width, p.x + p.width) - Math.min(t.x, p.x) + 8, height: p.y + p.height - t.y + 14 };
            const f = path.join(shots, `screens-dropdown-${theme}-${tag}.png`);
            fs.writeFileSync(f, (await win.capturePage(area, { stayHidden: true })).toPNG());
            report.captures.push(f);
          }
        }
      }
    }
    report.background = { focused: win.isFocused(), bounds: win.getBounds() };
  } catch (e) { report.errors.push(String(e && e.stack || e)); }
  finally {
    fs.writeFileSync(path.join(out, 'status.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    win.destroy(); app.exit(report.captures.length ? 0 : 1);
  }
});
