const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_COMPONENT_OUT;
const work = process.env.NEKKO_COMPONENT_WORK;
if (!out || !work) throw Error('Use provider-layout-integration.cjs');
const base = Boolean(process.env.NEKKO_TEST_REVISION);
const tag = base ? 'before' : 'after';
const dir = path.join(out, tag);
fs.mkdirSync(dir, { recursive: true });
app.setPath('userData', path.join(work, 'profile'));
app.setPath('sessionData', path.join(work, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_wc, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1280, height: 1400, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -10000, y: -10000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const report = { checks: [], errors: [], captures: [], layout: {} };
  const run = code => win.webContents.executeJavaScript(code, true);
  win.on('show', () => report.errors.push('Window became visible'));
  win.on('focus', () => report.errors.push('Window took focus'));
  // Card tops grouped into rows: [[label, ...], ...] ordered top to bottom.
  const names = 'LM Studio|lmstudio \\(local\\)|Ollama|vLLM|Anthropic|OpenAI|OpenRouter|Google Gemini|Groq';
  const rows = `(() => { const re = /${names}/; const cards = [...document.querySelectorAll('.card')].filter(c => re.test(c.textContent) && !c.parentElement.closest('.card'));
    const m = new Map(); for (const c of cards) { const r = c.getBoundingClientRect(); const k = Math.round(r.top / 8); const name = (c.textContent.match(re) || ['?'])[0]; (m.get(k) || m.set(k, []).get(k)).push([r.left, name]); }
    return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v.sort((a, b) => a[0] - b[0]).map(x => x[1])); })()`;
  try {
    await win.loadFile(path.join(work, 'index.html')); await sleep(500);
    // 5 clouds is the nine-provider case (4 local + 5 cloud); 1600 is a large desktop window.
    for (const theme of ['dark', 'light']) for (const [width, size] of [[1600, 'xwide'], [1280, 'wide'], [900, 'medium'], [520, 'narrow']]) for (const clouds of [1, 2, 3, 5]) {
      win.setContentSize(width, clouds >= 5 ? 2000 : 1400);
      await run(`window.__fixture.show(${clouds}, '${theme}')`); await sleep(450);
      const layout = await run(rows);
      report.layout[`${theme}-${size}-${clouds}cloud`] = layout;
      const expected = clouds >= 5 ? 9 : clouds + 1;
      if (layout.flat().length !== expected) report.errors.push(`${theme}/${size}/${clouds}: expected ${expected} cards, saw ${JSON.stringify(layout)}`);
      else report.checks.push(`${theme}/${size}/${clouds}cloud renders ${expected} cards`);
      if (!base) {
        // Each group is one container that holds all of its cards.
        const groups = await run(`[...document.querySelectorAll('[data-provider-group]')].map(g => [g.dataset.providerGroup, g.querySelectorAll('.card').length - g.querySelectorAll('.card .card').length])`);
        const want = clouds >= 5 ? [['local', 4], ['cloud', 5]] : [['local', 1], ['cloud', clouds]];
        if (JSON.stringify(groups) !== JSON.stringify(want)) report.errors.push(`${theme}/${size}/${clouds}: groups ${JSON.stringify(groups)} != ${JSON.stringify(want)}`);
        else report.checks.push(`${theme}/${size}/${clouds}cloud keeps each group in one container`);
      }
      const file = path.join(dir, `providers-${theme}-${size}-${clouds}cloud.png`);
      fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG());
      report.captures.push(file);
    }
    report.background = { visible: win.isVisible(), focused: win.isFocused() };
  } catch (e) { report.errors.push(String(e)); }
  finally { fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ checks: report.checks.length, errors: report.errors, layout: report.layout, background: report.background }, null, 1)); win.destroy(); app.exit(report.errors.length ? 1 : 0); }
});
