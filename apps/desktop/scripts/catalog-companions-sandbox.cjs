const { app, BrowserWindow, screen, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
const before = process.env.NEKKO_TEST_LABEL === 'catalog-companions-before';
const profile = fs.mkdtempSync(path.join(out, 'profile-'));
app.setPath('userData', profile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const report = { errors: [], checks: [], captures: [] };
  session.defaultSession.webRequest.onBeforeRequest((request, done) => done({ cancel: !/^(file:|data:|blob:)/.test(request.url) }));
  session.defaultSession.setPermissionRequestHandler((_web, _perm, done) => done(false));
  const displays = screen.getAllDisplays().map(d => d.bounds);
  const x = Math.min(...displays.map(d => d.x)), y = Math.min(...displays.map(d => d.y));
  const win = new BrowserWindow({ x: x - 3000, y: y - 2000, width: 1280, height: 1000, useContentSize: true, show: false, focusable: false, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('Fixture took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const run = js => win.webContents.executeJavaScript(js);
  const wait = async js => {
    for (let i = 0; i < 80; i++) { if (await run(js)) return; await delay(50); }
    throw new Error(`Timed out: ${js}`);
  };
  const check = async (name, js) => { await wait(js); report.checks.push(name); };
  const button = text => `[...document.querySelectorAll('button')].find(b=>b.textContent.trim().startsWith(${JSON.stringify(text)}))`;
  try {
    const bounds = win.getBounds();
    report.background = { bounds, visible: win.isVisible(), focused: win.isFocused(), focusable: win.isFocusable() };
    assert(!win.isVisible() && !win.isFocused() && !win.isFocusable() && bounds.x + bounds.width < x && bounds.y + bounds.height < y);
    await win.loadFile(path.join(out, 'index.html'));
    await wait(`!!document.querySelector('h1')`);
    for (const [label, width] of [['desktop', 1280], ['narrow', 360]]) {
      win.setContentSize(width, 1000);
      await delay(240);
      assert(await run('document.documentElement.scrollWidth === innerWidth'), `Horizontal overflow: ${label}`);
      const image = await win.capturePage(undefined, { stayHidden: true });
      assert(!image.isEmpty());
      const file = path.join(out, label + '.png');
      fs.writeFileSync(file, image.toPNG());
      report.captures.push(file);
    }
    if (!before) {
      const only = button('Download draft only'), both = button('Download both');
      await check('Shows a different action and size for the pair', `!!${only} && !!${both} && ${both}.textContent.includes('GB')`);
      await check('Does not recommend standalone builds', `!document.body.innerText.includes('usual choice') && !document.body.innerText.includes('our pick')`);
      await run(`${only}.click()`);
      await check('Only requests the draft without a base', `fixture.requests[0]?.[2]?.file.endsWith('.gguf') && fixture.requests[0][2].base === undefined`);
      await run(`${both}.click()`);
      await check('Both requests the exact base and size', `fixture.requests[1]?.[2]?.base.file==='Qwen3.8-27B-Q4_K_M.gguf' && fixture.requests[1][2].base.sizeBytes===16900000000`);
      await run(`fixture.mode='installed'; fixture.render()`);
      await check('Reuses the installed base and offers draft only', `document.body.innerText.includes('My stock Qwen') && !!${only} && !${both}`);
      await run(`fixture.mode='unresolved'; fixture.render()`);
      await check('Unresolved adapter explains why and offers no download', `document.body.innerText.includes('exact base checkpoint is unknown') && ![...document.querySelectorAll('button')].some(b=>b.textContent.startsWith('Download'))`);
    }
  } catch (error) { report.errors.push(error.stack); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  win.destroy();
  fs.rmSync(profile, { recursive: true, force: true });
  app.exit(report.errors.length ? 1 : 0);
});
