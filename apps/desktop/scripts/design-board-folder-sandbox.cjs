// Full-App Design board journey for a card that came from the project's nekko-designs/ folder
// (origin "file"), beside a prompt concept and a sketch concept. Synthetic bridge, isolated profile,
// no network or OS input. NEKKO_DESIGN_BASELINE=1 captures the same board on an unchanged checkout
// (via NEKKO_TEST_SOURCE) without the checks.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const baseline = process.env.NEKKO_DESIGN_BASELINE === '1';
// Escape characters JSON.stringify leaves raw before splicing into evaluated code.
const js = (v) => JSON.stringify(v).replace(/[<>/\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { checks: {}, errors: [], captures: [] };

const doc = (title, tint) => `<!doctype html><title>${title}</title><body style="margin:0;font:28px system-ui;background:${tint};color:#1b1b22"><header style="padding:40px 56px;font-weight:700">${title}</header><main style="display:flex;gap:32px;padding:0 56px">${[1, 2, 3].map(() => '<div style="flex:1;height:420px;border-radius:24px;background:rgba(255,255,255,.7)"></div>').join('')}</main></body>`;
const page = (id, label, origin, extra) => ({ id, label, url: '', kind: 'concept', html: doc(label, extra.tint), origin, notes: [], createdAt: 1, updatedAt: 1, ...extra.fields });
const BOARD = { workspaceId: 'w1', pages: [
  page('p1', 'Pricing page', 'prompt', { tint: '#f6e7ef', fields: { prompt: 'A pricing page', file: '/work/nekko-designs/pricing-page-a1b2c3.html' } }),
  page('p2', 'Onboarding sketch', 'sketch', { tint: '#e6eef8', fields: { prompt: '', file: '/work/nekko-designs/onboarding-sketch-d4e5f6.html' } }),
  // Saved into the folder by an agent, then edited by it once: the earlier HTML is a revision.
  page('p3', 'Checkout: three states', 'file', { tint: '#e9f4ea', fields: { file: '/work/nekko-designs/checkout-design.html', revisions: [{ id: 'r1', html: doc('Checkout: first pass', '#eee'), createdAt: 1 }] } }),
] };

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:|about:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  win.on('focus', () => report.errors.push('Window took focus'));
  const run = source => win.webContents.executeJavaScript(source);
  const check = async (source, label) => { if (baseline) return; const ok = await run(source); report.checks[label] = ok; if (!ok) throw Error(label); };
  const shot = async name => { const file = path.join(out, `${name}.png`); fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(file); };
  // The board card whose label is exactly this.
  const card = label => `[...document.querySelectorAll('.card')].find(c => [...c.querySelectorAll('div')].some(d => d.textContent === ${js(label)}))`;
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 80 && !await run('!!window.layoutFixture'); i++) await sleep(100);
    await sleep(500);
    await run(`(() => {
      document.querySelector('.zones-intro button[aria-label="Close"]')?.click();
      const f = layoutFixture, board = ${js(BOARD)};
      f.asked = [];
      f.bridge.getDesignBoard = async (id) => { f.asked.push(id); return board; };
      const settings = { ...f.store.getState().settings, theme: 'dark', experimental: { design: true }, workspaces: [{ id: 'w1', name: 'Shop', path: '/work', addedAt: 1 }] };
      f.store.setState({ settings, activeProjectId: 'w1' }); f.store.getState().applyTheme();
      f.store.getState().setView('design');
    })()`);
    await sleep(1200);
    await shot('board');
    await check(`document.querySelectorAll('iframe[title]').length === 3 && JSON.stringify(layoutFixture.asked) === '["w1"]'`, 'board-shows-three-concepts');
    await check(`${card('Checkout: three states')}.textContent.includes('from the designs folder') && !${card('Checkout: three states')}.textContent.includes('from a prompt')`, 'folder-card-says-where-it-came-from');
    await check(`${card('Pricing page')}.textContent.includes('from a prompt') && ${card('Onboarding sketch')}.textContent.includes('from a sketch')`, 'generated-cards-keep-their-origin');
    await run(`${card('Checkout: three states')}.querySelector('button').click()`); await sleep(700);
    await shot('board-folder-card-open');
    await check(`[...document.querySelectorAll('div')].some(d => d.textContent === 'concept · from the designs folder')`, 'sheet-names-the-designs-folder');
    win.setContentSize(430, 932); await sleep(500);
    await shot('board-narrow');
    if (report.errors.length) throw Error('Renderer errors: ' + report.errors.join('; '));
    report.background = { visible: win.isVisible(), focusable: win.isFocusable(), bounds: win.getBounds() };
    if (report.background.visible || report.background.focusable) throw Error('Unsafe fixture window');
  } catch (error) { report.failure = String(error.stack || error); process.exitCode = 1; }
  finally { fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); win.destroy(); app.exit(process.exitCode || 0); }
});
