// Hidden full-App evidence for PR link chips, link pointers and the highlighted
// file editor with its save status. Launch through layout-evidence-integration.cjs
// with NEKKO_LAYOUT_SANDBOX=link-chips-file-editor-sandbox.cjs. No host, network
// or user profile: file and PR reads are stubbed in the page. NEKKO_TEST_BASELINE=1
// captures the same screens without asserting the new behaviour (for a run against main).
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Use layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'link-chips-profile'));
const baseline = process.env.NEKKO_TEST_BASELINE === '1';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
// JSON for splicing into executeJavaScript, with markup-significant characters escaped.
const js = (v) => JSON.stringify(v).replace(/[<>/\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const report = { baseline, assertions: [], metrics: {}, captures: [], errors: [] };

const file = 'C:/demo/repo/apps/desktop/src/renderer/completionExit.ts';
const source = [
  "import { EASE_OUT } from './easing.js';",
  '',
  '/** The row folds shut toward its left edge. */',
  'export const ROW_CLOSE_MS = 260;',
  'export const ROW_COLLAPSE_MS = 220;',
  '',
  'export async function completeWithExit(row: HTMLElement | null, complete: () => Promise<boolean>): Promise<void> {',
  "  if (!row || row.dataset.completing || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {",
  '    if (!row?.dataset.completing) await complete();',
  '    return;',
  '  }',
  "  row.dataset.completing = 'true';",
  '  // Kick the engine work off immediately; the animation plays over it.',
  '  const completion = complete();',
  '  const close = row.animate([{ opacity: 1 }, { opacity: 0.6 }], { duration: ROW_CLOSE_MS, easing: EASE_OUT });',
  '  await close.finished;',
  '  const done = await completion;',
  "  if (!done) row.style.pointerEvents = '';",
  '}',
  '',
].join('\n');
const pr = (number, title, state, isDraft = false) => ({ url: `https://github.com/nekko-labs/nekko-agent/pull/${number}`, owner: 'nekko-labs', repo: 'nekko-agent', number, title, state, isDraft, additions: 10, deletions: 2, changedFiles: 2, checks: 'passing', source: 'gh' });
const prs = [pr(1663, 'Flow the empty-agent dot wave like water again', 'merged'), pr(1662, 'Close a chat as soon as the X is clicked', 'open'), pr(1670, 'Draft: tune the save flash', 'open', true), pr(1601, 'Superseded wave experiment', 'closed')];
const reply = [
  'Both fixes are in. [#1663](https://github.com/nekko-labs/nekko-agent/pull/1663) restores the flowing wave and [#1662](https://github.com/nekko-labs/nekko-agent/pull/1662) starts the close straight away.',
  '',
  'Still open: https://github.com/nekko-labs/nekko-agent/pull/1670 (draft) replaces [#1601](https://github.com/nekko-labs/nekko-agent/pull/1601).',
  '',
  `The change is in [completionExit.ts](${file}), and the commit is [0ba502665](https://github.com/nekko-labs/nekko-agent/commit/0ba502665).`,
].join('\n');

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:|about:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const displays = screen.getAllDisplays();
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: Math.min(...displays.map(d => d.bounds.x)) - 1700, y: Math.min(...displays.map(d => d.bounds.y)) - 1200, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const run = code => win.webContents.executeJavaScript(code, true);
  win.on('focus', () => report.errors.push('Window received focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.metrics.consoleErrors = [...(report.metrics.consoleErrors || []), e.message.slice(0, 200)]; });
  const check = async (name, expr) => {
    if (baseline) return;
    const passed = !!await run(expr);
    report.assertions.push({ name, passed });
    if (!passed) throw Error(`Failed: ${name}`);
  };
  const capture = async name => {
    if (win.isVisible() || win.isFocused()) report.errors.push(`${name}: window visible or focused`);
    win.webContents.invalidate();
    await wait(400);
    const shot = path.join(out, `${name}.png`);
    fs.writeFileSync(shot, (await win.capturePage(undefined, { stayHidden: true })).toPNG());
    report.captures.push(shot);
  };
  const press = (keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  };
  // React owns the textarea's value: write through the native setter, then announce it.
  const type = text => run(`(() => {
    const ta = document.querySelector('textarea[aria-label^="Edit "]') || document.querySelector('.font-mono.resize-none');
    ta.focus();
    const at = ta.value.indexOf('// Kick');
    const next = ta.value.slice(0, at) + ${js(text)} + ta.value.slice(at);
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, next);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return ta.value.length;
  })()`);
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 80 && !await run('!!window.layoutFixture && !!document.querySelector("[data-command-wall]")'); i++) await wait(100);
    await wait(500);
    await run(`(() => {
      const f = window.layoutFixture;
      const prs = ${js(prs)};
      window.__writes = [];
      window.__keys = [];
      window.addEventListener('keydown', e => window.__keys.push({ key: e.key, ctrl: e.ctrlKey, meta: e.metaKey, target: e.target.tagName, prevented: e.defaultPrevented }), true);
      f.bridge.getPrInfo = async url => { await new Promise(r => setTimeout(r, 150)); return prs.find(p => p.url === url) || null; };
      f.bridge.readFile = async p => p === ${js(file)} ? { content: ${js(source)}, binary: false, truncated: false } : Promise.reject(new Error('missing'));
      f.bridge.writeFile = async (p, text) => { await new Promise(r => setTimeout(r, 250)); window.__writes.push({ p, n: text.length }); };
      f.bridge.listComments = async () => [];
      const s = f.records[0];
      s.messages = [
        { id: 'u1', role: 'user', content: 'Where did the two fixes land?', createdAt: Date.now() - 60000 },
        { id: 'a1', role: 'assistant', content: ${js(reply)}, createdAt: Date.now() - 30000 },
      ];
      f.putCachedSession(s);
      f.store.getState().openChatPane(s.id);
      const st = f.store.getState();
      f.store.setState({ settings: { ...st.settings, commandWall: { ...(st.settings.commandWall || {}), dock: { ...((st.settings.commandWall || {}).dock || {}), show: false } } } });
    })()`);
    await wait(500);
    report.metrics.picked = await run(`(() => {
      const hit = [...document.querySelectorAll('button,[role="button"],a,[tabindex]')].find(e => e.textContent.includes('Persist quota history') || e.textContent.includes('Persist qu'));
      if (hit) hit.click();
      return !!hit;
    })()`);
    for (let i = 0; i < 50 && !await run(`!!document.querySelector('a[href*="/pull/1663"]')`); i++) await wait(100);
    await wait(1500);
    // The first-run zones tour would cover the board.
    await run(`document.querySelector('.zones-intro button[aria-label="Close"]')?.click()`);
    await wait(300);
    await win.webContents.insertCSS('*,*::before,*::after{animation:none!important;transition:none!important}');
    await wait(300);
    await win.capturePage(undefined, { stayHidden: true });

    await check('four PR links are chips', `document.querySelectorAll('a.pr-link-chip').length === 4`);
    await check('chips show each PR state', `['merged','open','draft','closed'].every(s => document.querySelector('a.pr-link-chip[data-pr-status="' + s + '"]'))`);
    await check('a bare PR URL reads as repo#number', `[...document.querySelectorAll('a.pr-link-chip')].some(a => a.textContent.startsWith('nekko-agent#1670'))`);
    await check('PR links have no Preview button', `![...document.querySelectorAll('button')].some(b => b.textContent === 'Preview' && b.previousElementSibling?.matches('a[href*="/pull/"]'))`);
    await check('other web links keep Preview', `[...document.querySelectorAll('button')].some(b => b.textContent === 'Preview' && b.previousElementSibling?.matches('a[href*="/commit/"]'))`);
    report.metrics.cursors = await run(`(() => {
      const file = [...document.querySelectorAll('button')].find(b => b.textContent === 'completionExit.ts');
      const chip = document.querySelector('a.pr-link-chip') || document.querySelector('a[href*="/pull/1663"]');
      const link = document.querySelector('a[href*="/commit/"]');
      return { file: file && getComputedStyle(file).cursor, chip: chip && getComputedStyle(chip).cursor, link: link && getComputedStyle(link).cursor };
    })()`);
    if (!baseline) {
      const c = report.metrics.cursors;
      const ok = c.file === 'pointer' && c.chip === 'pointer' && c.link === 'pointer';
      report.assertions.push({ name: 'pointer cursor on file, chip and web links', passed: ok });
      if (!ok) throw Error('Failed: pointer cursor');
    }
    // Hover the first chip so its hover fill shows in the capture (renderer input, not OS input).
    const chipAt = await run(`(() => { const r = (document.querySelector('a.pr-link-chip') || document.querySelector('a[href*="/pull/1663"]')).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: chipAt.x, y: chipAt.y });
    await wait(300);
    await capture('chat-links');

    // Open the file link the way a click does (DOM click, not OS input).
    await run(`[...document.querySelectorAll('button')].find(b => b.textContent === 'completionExit.ts').click()`);
    for (let i = 0; i < 60 && !await run(`!!document.querySelector('textarea.font-mono')`); i++) await wait(100);
    await wait(1200);
    await check('code is highlighted', `!!document.querySelector('.code-paint .hljs-keyword')`);
    await check('the language is detected', `document.querySelector('[title="Detected language"]')?.textContent === 'TypeScript'`);
    await check('the editing surface lines up with the paint', `(() => { const ta = document.querySelector('textarea.code-paint-input'); const pre = document.querySelector('pre.code-paint'); const a = ta.getBoundingClientRect(), b = pre.getBoundingClientRect(); const s = getComputedStyle(ta), p = getComputedStyle(pre); return Math.abs(a.left - b.left) < 1 && Math.abs(a.top - b.top) < 1 && s.paddingLeft === p.paddingLeft && s.paddingTop === p.paddingTop && s.lineHeight === p.lineHeight && s.fontFamily === p.fontFamily && s.fontSize === p.fontSize; })()`);
    await check('the paint follows the editor when it scrolls', `(() => {
      const ta = document.querySelector('textarea.code-paint-input');
      ta.style.height = '120px';
      ta.scrollTop = 60; ta.scrollLeft = 40;
      ta.dispatchEvent(new Event('scroll'));
      const t = document.querySelector('pre.code-paint > code').style.transform;
      const ok = t === 'translate(' + -ta.scrollLeft + 'px, ' + -ta.scrollTop + 'px)' && ta.scrollTop > 0;
      ta.style.height = ''; ta.scrollTop = 0; ta.scrollLeft = 0; ta.dispatchEvent(new Event('scroll'));
      return ok;
    })()`);
    report.metrics.editorText =await run(`getComputedStyle(document.querySelector('textarea.font-mono')).color`);
    await capture('file-editor');

    // An edit, then the idle pause: auto-save writes and says so.
    await type('// Tuned while reviewing.\n  ');
    await wait(150);
    await capture('file-editor-unsaved');
    for (let i = 0; i < 40 && !await run(`document.querySelector('[data-save-state]')?.dataset.saveState === 'auto'`); i++) await wait(100);
    await check('auto-save reports itself', `(() => { const s = document.querySelector('[data-save-state]'); return s.dataset.saveState === 'auto' && /^Auto-saved\\sat\\s/.test(s.textContent) && window.__writes.length === 1; })()`);
    await capture('file-editor-auto-saved');

    // Another edit saved at once with Ctrl+S, before auto-save would fire.
    await type('// Saved by hand.\n  ');
    press('S', [process.platform === 'darwin' ? 'meta' : 'control']);
    await wait(80);
    report.metrics.keys = await run(`window.__keys`);
    report.metrics.active = await run(`document.activeElement && (document.activeElement.tagName + '.' + document.activeElement.className.slice(0, 60))`);
    report.metrics.savingLabel =await run(`(document.querySelector('[data-save-state]') || {}).textContent || null`);
    for (let i = 0; i < 30 && !await run(`document.querySelector('[data-save-state]')?.dataset.saveState === 'manual'`); i++) await wait(100);
    await check('Ctrl+S saves and says Saved', `(() => { const s = document.querySelector('[data-save-state]'); return s.dataset.saveState === 'manual' && /^Saved\\sat\\s/.test(s.textContent) && window.__writes.length === 2; })()`);
    await capture('file-editor-saved-shortcut');
    press('S', [process.platform === 'darwin' ? 'meta' : 'control']);
    await wait(200);
    await check('Ctrl+S on a clean file still answers', `/All changes saved/.test(document.querySelector('[data-save-state]')?.textContent || '') && window.__writes.length === 2`);
    // A wide window has room for the language and the save time.
    win.setContentSize(2560, 900);
    await wait(600);
    await type('// One more.\n  ');
    press('S', [process.platform === 'darwin' ? 'meta' : 'control']);
    for (let i = 0; i < 30 && !await run(`document.querySelector('[data-save-state]')?.dataset.saveState === 'manual'`); i++) await wait(100);
    report.metrics.wide = await run(`(() => { const l = document.querySelector('[title="Detected language"]'); const s = document.querySelector('[data-save-state]'); return { toolbar: Math.round(l.parentElement.getBoundingClientRect().width), lang: Math.round(l.getBoundingClientRect().width), status: s.innerText, kind: s.dataset.saveState, window: window.innerWidth }; })()`);
    await capture('file-editor-wide-saved');
    await check('a wide window shows the language and save time',`(() => { const l = document.querySelector('[title="Detected language"]'); const s = document.querySelector('[data-save-state]'); return l.getBoundingClientRect().width > 0 && /Saved\\sat\\s\\d/.test(s.innerText); })()`);
    await capture('file-editor-wide-saved');
    report.metrics.writes = await run('window.__writes');
    report.bounds = win.getBounds();
    report.hidden = !win.isVisible();
  } catch (e) { report.errors.push(String(e && e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ assertions: report.assertions, metrics: report.metrics, errors: report.errors, hidden: report.hidden }, null, 2));
  win.destroy();
  app.exit(report.errors.length ? 1 : 0);
});
