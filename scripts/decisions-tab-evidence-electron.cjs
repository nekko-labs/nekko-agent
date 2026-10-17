const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const dir = process.env.NEKKO_EVIDENCE_DIR, kind = process.env.NEKKO_EVIDENCE_KIND;
app.commandLine.appendSwitch('force-device-scale-factor', '1');
const profile = fs.mkdtempSync(path.join(dir, 'profile-'));
app.setPath('userData', profile);
app.setPath('sessionData', profile);
const report = { kind, captures: [], errors: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// What a reader of the PNG would check, read from the DOM: each card's heading and controls,
// anything wider than its box or past the panel's edge, and the contrast of every text run.
const LAYOUT = `(() => {
  const panel = document.querySelector('main > div').getBoundingClientRect();
  const rgb = (c) => (c.match(/[\\d.]+/g) || []).slice(0, 4).map(Number);
  const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const bg = (el) => { for (let e = el; e; e = e.parentElement) { const c = rgb(getComputedStyle(e).backgroundColor); if (c.length === 3 || (c.length === 4 && c[3] > 0.5)) return c; } return [255, 255, 255]; };
  const cards = [...document.querySelectorAll('main > div > div > div')].map((card) => ({
    heading: (card.querySelector('.font-semibold') || {}).textContent || '',
    buttons: [...card.querySelectorAll('button')].map((b) => b.textContent.trim()),
    selects: [...card.querySelectorAll('select')].map((s) => [...s.options].map((o) => o.value).join('|')),
    inputs: [...card.querySelectorAll('input, textarea')].map((i) => i.getAttribute('aria-label') || i.placeholder || i.tagName),
  }));
  const problems = [];
  for (const el of document.querySelectorAll('main *')) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (r.right > panel.right + 1 || r.left < panel.left - 1) problems.push('outside panel: ' + el.tagName + ' ' + (el.textContent || '').trim().slice(0, 40));
    const cs = getComputedStyle(el);
    if (el.scrollWidth > el.clientWidth + 1 && cs.overflowX === 'visible' && el.children.length === 0) problems.push('text overflows: ' + (el.textContent || '').trim().slice(0, 40));
  }
  let worst = { ratio: 99, text: '' };
  for (const el of document.querySelectorAll('main *')) {
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const r = el.getBoundingClientRect();
    if (!r.width) continue;
    const fg = rgb(getComputedStyle(el).color), b = bg(el);
    const [hi, lo] = [lum(fg), lum(b)].sort((x, y) => y - x);
    const ratio = (hi + 0.05) / (lo + 0.05);
    if (ratio < worst.ratio) worst = { ratio: Math.round(ratio * 100) / 100, text: el.textContent.trim().slice(0, 50) };
  }
  return { cards, problems: [...new Set(problems)].slice(0, 20), lowestContrast: worst, bodyText: document.body.innerText.length };
})()`;
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((r, done) => done({ cancel: !/^(file:|data:|blob:)/.test(r.url) }));
  session.defaultSession.setPermissionRequestHandler((w, p, d) => d(false));
  const left = Math.min(...screen.getAllDisplays().map((d) => d.bounds.x));
  const win = new BrowserWindow({ width: 1000, height: 1400, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: left - 5000, y: -3000, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  win.webContents.on('console-message', (e) => { if (e.level === 'error') report.errors.push(e.message); });
  const run = (s) => win.webContents.executeJavaScript(s, true);
  try {
    await win.loadFile(path.join(dir, 'index.html'));
    win.showInactive();
    for (const theme of ['light', 'dark']) {
      await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      await run('document.fonts.ready');
      await sleep(600);
      const h = await run('Math.ceil(document.querySelector("main > div").getBoundingClientRect().bottom + 24)');
      win.setContentSize(1000, Math.min(Math.max(h, 600), 4000));
      await sleep(400);
      const img = await win.capturePage(undefined, { stayHidden: true, stayAwake: true });
      if (img.isEmpty()) throw Error('Empty screenshot');
      fs.writeFileSync(path.join(dir, `decisions-${kind}-${theme}.png`), img.toPNG());
      report.captures.push({ theme, size: img.getSize(), cards: await run('document.querySelectorAll("[data-decision-model]").length'), layout: await run(LAYOUT) });
    }
  } catch (e) {
    report.errors.push(String(e));
  } finally {
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ kind, captures: report.captures.map((c) => ({ theme: c.theme, size: c.size, cards: c.cards })), errors: report.errors }));
    win.destroy();
    app.exit(report.errors.length ? 1 : 0);
  }
});
