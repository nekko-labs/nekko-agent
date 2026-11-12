// Full-App Library journey for designs from every source: a Claude Code chat (Write calls, one file named
// in code formatting and one not named), a native chat, and a project's nekko-designs/ folder. Synthetic bridge, isolated
// profile, no network or OS input. NEKKO_LIBRARY_BASELINE=1 captures the same data on an unchanged
// checkout (via NEKKO_TEST_SOURCE) without the checks.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const baseline = process.env.NEKKO_LIBRARY_BASELINE === '1';
// Escape characters JSON.stringify leaves raw before splicing into evaluated code.
const js = (v) => JSON.stringify(v).replace(/[<>/\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { checks: {}, errors: [], captures: [], listed: [] };

// What the project's designs folder holds: one design a chat also wrote, three nobody's chat mentions, and two files that are not designs.
const FOLDER = {
  '/work/nekko-designs': [
    { name: 'settings', path: '/work/nekko-designs/settings', dir: true },
    { name: 'hero.svg', path: '/work/nekko-designs/hero.svg', dir: false },
    { name: 'login.html', path: '/work/nekko-designs/login.html', dir: false },
    { name: 'notes.md', path: '/work/nekko-designs/notes.md', dir: false },
    { name: 'onboarding.html', path: '/work/nekko-designs/onboarding.html', dir: false },
  ],
  '/work/nekko-designs/settings': [
    { name: 'index.html', path: '/work/nekko-designs/settings/index.html', dir: false },
    { name: 'tokens.json', path: '/work/nekko-designs/settings/tokens.json', dir: false },
  ],
};
const write = (name, key, file) => ({ id: file, name, input: { [key]: file, content: '<!doctype html>' }, ...(name === 'Write' ? { executedBy: 'claude-code' } : {}) });
const CHATS = [
  { title: 'Checkout redesign', messages: [
    { role: 'user', content: 'Design the new checkout.' },
    // As Claude Code chats record it: Write with file_path. One design is named in code formatting, the other is not named at all.
    { role: 'assistant', content: 'Design mock is done (`reports/checkout-design.html`), with a rougher first pass saved beside it.', toolCalls: [write('Write', 'file_path', '/work/reports/checkout-design.html'), write('Write', 'file_path', '/work/.scratch/pricing-mockup.html'), write('Write', 'file_path', '/work/apps/web/src/Checkout.tsx'), write('Write', 'file_path', '/Users/me/.claude/projects/-work/memory/checkout.md')] },
  ] },
  { title: 'Pricing page', messages: [
    { role: 'user', content: 'Draft the pricing page.' },
    { role: 'assistant', content: 'See the [Pricing page draft](/work/site/pricing.html) and the [Status dashboard](/work/site/status.html).', toolCalls: [write('write_file', 'path', 'nekko-designs/login.html')] },
  ] },
  { title: 'Launch checklist', messages: [
    { role: 'user', content: 'What is left for launch?' },
    { role: 'assistant', content: 'Written up in [Beta readiness](/work/reports/beta-readiness.md), with the [Budget](/work/office/budget.xlsx).' },
  ] },
];

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  win.on('focus', () => report.errors.push('Window took focus'));
  const run = source => win.webContents.executeJavaScript(source);
  const check = async (source, label) => { if (baseline) return; const ok = await run(source); report.checks[label] = ok; if (!ok) throw Error(label); };
  const shot = async name => { const file = path.join(out, `${name}.png`); fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(file); };
  const radio = (group, name) => run(`(() => { const g = [...document.querySelectorAll('[role="radiogroup"]')].find(g => g.getAttribute('aria-label') === ${js(group)}); const b = [...g.querySelectorAll('[role="radio"]')].find(b => (b.getAttribute('aria-label') || b.textContent).trim().startsWith(${js(name)})); if (!b) throw Error('Missing control'); b.click(); })()`);
  // The list row whose title is exactly this.
  const row = title => `[...document.querySelectorAll('[data-artifact-row]')].find(r => r.querySelector('span span').textContent === ${js(title)})`;
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 80 && !await run('!!window.layoutFixture'); i++) await sleep(100);
    await sleep(500);
    await run(`(() => {
      document.querySelector('.zones-intro button[aria-label="Close"]')?.click();
      localStorage.setItem('nekko.libraryIntroSeen', '1');
      localStorage.removeItem('nekko.libraryLayout'); localStorage.removeItem('nekko.libraryCollapsed');
      const f = layoutFixture, chats = ${js(CHATS)}, folder = ${js(FOLDER)}, now = Date.now();
      f.records.slice(0, 3).forEach((s, n) => {
        s.title = chats[n].title; s.workspaceId = 'w1';
        s.messages = chats[n].messages.map((m, i) => ({ id: s.id + i, createdAt: now - 86400000 * n - 60000 * (9 - i), ...m }));
        s.updatedAt = now - n; f.putCachedSession(s);
      });
      f.listed = [];
      f.bridge.listDir = async (p) => { f.listed.push(p); return folder[p] ?? []; };
      f.bridge.listComments = async () => [];
      f.bridge.readFile = async (p) => { f.read = (f.read ?? []).concat(p); return { content: '<!doctype html><title>' + p.split('/').pop() + '</title><body style="font:16px system-ui;padding:32px">Synthetic design for Library verification.</body>', truncated: false, binary: false }; };
      f.bridge.openPath = async p => { f.lastOpenPath = p; };
      f.store.setState({ settings: { ...f.store.getState().settings, theme: 'dark', workProfile: 'designer', workspaces: [{ id: 'w1', name: 'Shop', path: '/work', addedAt: now }] } }); f.store.getState().applyTheme();
      f.store.getState().refreshSessions();
      f.store.getState().setView('artifacts');
    })()`);
    await sleep(1200);
    win.setContentSize(1440, 900); await sleep(300);
    await shot('desktop-large');
    report.listed = await run(`layoutFixture.listed`);
    const designs = `[...document.querySelectorAll('[data-artifact-kind="design"] [data-artifact-row]')].map(r => r.querySelector('span span').textContent)`;
    await check(`JSON.stringify(${designs}) === ${js(JSON.stringify(['Checkout design', 'Pricing mockup', 'Login', 'Hero', 'Onboarding', 'Settings']))}`, 'designs-from-claude-code-native-chats-and-the-folder');
    await check(`document.querySelectorAll('[data-artifact-row]').length === 10`, 'source-files-agent-notes-and-non-designs-stay-out');
    await check(`document.querySelector('[data-library-group]').dataset.libraryGroup === 'design'`, 'designer-leads-with-designs');
    await check(`${row('Onboarding')}.textContent.includes('Shop designs folder') && ${row('Login')}.textContent.includes('Pricing page') && ${row('Checkout design')}.textContent.includes('Checkout redesign')`, 'each-design-names-its-chat-or-its-folder');
    await check(`!(layoutFixture.read ?? []).length && JSON.stringify([...new Set(layoutFixture.listed)]) === ${js(JSON.stringify(['/work/nekko-designs', '/work/nekko-designs/settings']))}`, 'folder-is-listed-not-read');
    await radio('Layout', 'Full cards'); await sleep(600);
    await shot('desktop-cards');
    await check(`(() => { const tile = t => [...document.querySelectorAll('[data-library-tile]')].find(e => e.querySelector('.library-tile-title').textContent === t); return !/Open chat/.test(tile('Hero').textContent) && /Open file/.test(tile('Hero').textContent) && /Open chat/.test(tile('Checkout design').textContent); })()`, 'folder-card-has-no-chat-to-open');
    await radio('Layout', 'List'); await sleep(600);
    await shot('desktop-list');
    await radio('Layout', 'Large icons'); await sleep(600);
    if (!baseline) {
    await run(`${row('Onboarding')}.click()`); await sleep(700);
    await shot('desktop-folder-design-preview');
    await check(`(() => { const bar = document.querySelector('[aria-label="Close preview"]').parentElement; const open = [...bar.querySelectorAll('button')].find(b => b.textContent.trim() === 'Open file'); return !/Open chat/.test(bar.textContent) && open.classList.contains('btn-primary'); })()`, 'folder-design-preview-leads-with-open-file');
    await run(`${row('Checkout design')}.click()`); await sleep(700);
    await shot('desktop-claude-design-preview');
    await check(`(() => { const bar = document.querySelector('[aria-label="Close preview"]').parentElement; return /Open chat/.test(bar.textContent) && bar.textContent.includes('/work/reports/checkout-design.html'); })()`, 'claude-code-design-opens-its-chat');
    await run(`document.querySelector('[aria-label="Close preview"]').click()`); await sleep(300);
    }
    win.setContentSize(430, 932); await sleep(400);
    await shot('narrow-default');
    await check(`!!${row('Onboarding')}`, 'narrow-lists-folder-designs');
    if (report.errors.length) throw Error('Renderer errors: ' + report.errors.join('; '));
    report.background = { visible: win.isVisible(), focusable: win.isFocusable(), bounds: win.getBounds() };
    if (report.background.visible || report.background.focusable) throw Error('Unsafe fixture window');
  } catch (error) { report.failure = String(error.stack || error); process.exitCode = 1; }
  finally { fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); win.destroy(); app.exit(process.exitCode || 0); }
});
