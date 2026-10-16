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
  const win = new BrowserWindow({ width: 1280, height: 860, useContentSize: true, show: false, focusable: false, skipTaskbar: true,
    x: Math.min(...b.map((x) => x.x)) - 1800, y: Math.min(...b.map((x) => x.y)) - 1800,
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  const report = { kind, checks: {}, errors: [] };
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) report.errors.push(String(message).slice(0, 300)); });
  const run = (s) => win.webContents.executeJavaScript(s, true);
  const shot = async (name, rect) => { await sleep(350); fs.writeFileSync(path.join(dir, `${name}.png`), (await win.capturePage(rect, { stayHidden: true })).toPNG()); };
  const route = async (r) => { await run(`evidence.route(${JSON.stringify(r)})`); await sleep(700); };
  const hero = async (id) => { await run(`evidence.hero(${JSON.stringify(id)})`); await sleep(900); };
  const click = async (sel) => { const r = await run(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({block:'center'}); const r = e.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`); if (!r) return false; win.webContents.sendInputEvent({ type: 'mouseMove', x: r.x, y: r.y }); await sleep(60); win.webContents.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'left', clickCount: 1 }); win.webContents.sendInputEvent({ type: 'mouseUp', x: r.x, y: r.y, button: 'left', clickCount: 1 }); await sleep(400); return true; };
  const composerRect = () => run(`(() => { const c = document.querySelector('[data-wall-composer]'); if (!c) return null; const r = c.getBoundingClientRect(); return { x: Math.max(0, Math.round(r.x) - 8), y: Math.max(0, Math.round(r.y) - 260), width: Math.round(r.width) + 16, height: Math.round(r.height) + 268 }; })()`);
  const openPlus = async () => click('[data-wall-composer] button[aria-label^="Add a photo"]');
  const menuState = () => run(`({ open: !!document.querySelector('[data-wall-composer] [role=menu]'), items: [...document.querySelectorAll('[data-wall-composer] [role=menu] [role=menuitem]')].map(e => ({ text: e.textContent.trim(), disabled: e.getAttribute('aria-disabled') === 'true', icon: !!e.querySelector('svg') })), note: document.querySelector('[data-composer-media-note]')?.textContent ?? null, accept: document.querySelector('[data-wall-composer] input[type=file]')?.accept ?? null })`);
  const paste = (files) => run(`(() => { const d = new DataTransfer(); for (const f of ${JSON.stringify(files)}) { const bytes = f.b64 ? Uint8Array.from(atob(f.b64), c => c.charCodeAt(0)) : new TextEncoder().encode(f.text ?? 'x'); const file = new File([bytes], f.name, { type: f.type }); if (f.path) Object.defineProperty(file, '__path', { value: f.path }); d.items.add(file); } document.querySelector('[data-wall-composer] [contenteditable]').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: d })); })()`);
  const strip = () => run(`({ images: document.querySelectorAll('[data-composer-attachments] img').length, videos: document.querySelectorAll('[data-composer-attachments] video').length, files: [...document.querySelectorAll('[data-composer-file]')].map(e => ({ text: e.textContent.trim(), title: e.title })) })`);
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=';
  try {
    await win.loadFile(path.join(dir, 'index.html')); win.showInactive(); await sleep(1200);
    for (const theme of ['dark', 'light']) {
      await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      // 1. The + menu for a text-only local model, a sighted cloud model, and a video-capable one.
      for (const [id, label] of [['local', 'text-only'], ['cloud', 'photos-only'], ['gemini', 'photos-video']]) {
        await route('wall'); await hero(id);
        const opened = await openPlus();
        report.checks[`menu-${label}-${theme}`] = { opened, ...(await menuState()) };
        await shot(`menu-${label}-${theme}`, await composerRect());
        await run(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`); await sleep(200);
      }
      // 2. Paste a photo, a video, a PDF and a markdown file into the composer of the sighted chat.
      await hero('gemini'); await sleep(300);
      await paste([
        { name: 'shot.png', type: 'image/png', b64: PNG },
        { name: 'clip.mp4', type: 'video/mp4', b64: PNG },
        { name: 'paper.pdf', type: 'application/pdf', text: '%PDF-1.4' },
        { name: 'notes.md', type: 'text/markdown', text: '# notes', path: 'C:/code/nekko-agent/notes.md' },
      ]);
      await sleep(1200);
      report.checks[`strip-${theme}`] = await strip();
      await shot(`strip-${theme}`, await composerRect());
      // 3. The reply: diagram, table, code; then the diagram expanded.
      await route('reply'); await sleep(2500);
      report.checks[`reply-${theme}`] = await run(`({ diagram: !!document.querySelector('[data-mermaid-diagram] iframe'), expand: !!document.querySelector('[data-mermaid-expand]'), table: !!document.querySelector('[data-reply] table'), code: document.querySelectorAll('[data-reply] pre').length, video: !!document.querySelector('[data-reply] video') })`);
      await shot(`reply-${theme}`, { x: 0, y: 0, width: 800, height: 860 });
      if (await run(`!!document.querySelector('[data-mermaid-expand]')`)) {
        await run(`document.querySelector('[data-mermaid-expand]').click()`); await sleep(900);
        report.checks[`expanded-${theme}`] = await run(`({ overlay: !!document.querySelector('[data-mermaid-fullscreen]'), frame: !!document.querySelector('[data-zoom-frame] iframe'), sandbox: document.querySelector('[data-zoom-frame] iframe')?.getAttribute('sandbox') })`);
        await shot(`expanded-${theme}`);
        await run(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`); await sleep(300);
        report.checks[`expanded-${theme}`].closedByEscape = await run(`!document.querySelector('[data-mermaid-fullscreen]')`);
      } else await shot(`expanded-${theme}`);
    }
  } catch (e) { report.errors.push(String(e && e.stack || e)); }
  report.focused = win.isFocused();
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  win.destroy(); app.exit(0);
});
