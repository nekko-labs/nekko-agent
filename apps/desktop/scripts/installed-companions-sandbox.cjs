const { app, BrowserWindow, screen, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
const before = process.env.NEKKO_TEST_LABEL === 'installed-companions-before';
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
  const family = name => `[...document.querySelectorAll('[data-model-family]')].find(b=>b.textContent.replaceAll('-', ' ').includes(${JSON.stringify(name.replaceAll('-', ' '))}))`;
  const row = id => `document.querySelector('[data-library-row="${id}"]')`;
  const button = (selector, text) => `[...${selector}.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)})`;
  try {
    const bounds = win.getBounds();
    report.background = { bounds, visible: win.isVisible(), focused: win.isFocused(), focusable: win.isFocusable() };
    assert(!win.isVisible() && !win.isFocused() && !win.isFocusable() && bounds.x + bounds.width < x && bounds.y + bounds.height < y);
    await win.loadFile(path.join(out, 'index.html'));
    await wait(family('Qwen3.8-27B') + ' !== undefined');
    await run(`document.querySelector('[data-model-family=qwen3827b]').click()`);
    await wait(`!!${row('base')}`);
    for (const [label, width, theme] of [['desktop-dusk', 1280, 'dark'], ['narrow-dusk', 360, 'dark'], ['desktop-light', 1280, 'light'], ['narrow-light', 360, 'light']]) {
      win.setContentSize(width, 1000);
      await run(`document.documentElement.dataset.theme='${theme}'; document.querySelector('[data-library-row=base]').scrollIntoView({ block: 'nearest' })`);
      await delay(300);
      assert(await run('document.documentElement.scrollWidth === innerWidth'), `Horizontal overflow: ${label}`);
      const image = await win.capturePage(undefined, { stayHidden: true });
      assert(!image.isEmpty());
      const file = path.join(out, label + '.png');
      fs.writeFileSync(file, image.toPNG());
      report.captures.push(file);
    }
    if (!before) {
      await check('Both companions are subrows of the exact base', `!!${row('base')}.querySelector('[data-model-companion=draft]') && !!${row('base')}.querySelector('[data-model-companion=lora]')`);
      await check('Nested LoRA keeps file deletion but has no default or favorite action', `!!document.querySelector('[data-model-companion=lora] [aria-label="Delete Writing Style Adapter"]') && !document.querySelector('[data-model-companion=lora] [aria-pressed]')`);
      await check('Paired adapter is not a top-level family', `!${family('Writing Style Adapter')}`);
      await run(`${family('Qwen3.8-27B-Tuned')}.click()`);
      await check('The tuned checkpoint never inherits a companion', `!!${row('other')} && !${row('other')}.querySelector('[data-model-companion]')`);
      await run(`document.querySelector('[data-model-family=qwen3827b]').click()`);
      await wait(`!!${row('base')}`);
      for (const [id, field, otherField, index] of [['draft', 'draftModelId', 'adapterModelId', 0], ['lora', 'adapterModelId', 'draftModelId', 1]]) {
        await run(`document.querySelector('[data-model-companion=${id}] button[aria-label^="Load "]').click()`);
        await check(`Load sends the base and ${field}, never the companion alone`, `fixture.loads[${index}]?.[0]==='nekko-engine' && fixture.loads[${index}][1]==='base' && fixture.loads[${index}][2].${field}==='${id}' && !fixture.loads[${index}][2].${otherField} && fixture.loads[${index}][2].contextTokens===8192`);
      }
      await check('DFlash2 overrides a saved speculative-off choice; LoRA clears the saved draft', `fixture.loads[0][2].speculative===true && fixture.loads[1][2].speculative===false`);
      const filter = async name => {
        await run(`(() => { const input = document.querySelector('[aria-label="Filter my models"]'); input.focus(); input.select(); })()`);
        if (name) await win.webContents.insertText(name);
        else win.webContents.delete();
      };
      await filter('Writing Style Adapter');
      await check('Searching for a paired companion shows its base family', `document.querySelectorAll('[data-model-family]').length===1 && !!document.querySelector('[data-model-family=qwen3827b]')`);
      for (const [id, name, reason] of [['unknown','Unknown Source LoRA','exact base checkpoint is unknown'], ['mismatch','Wrong Checkpoint LoRA','Install the compatible GGUF base'], ['mlx-lora','MLX Style Adapter','requires GGUF']]) {
        await filter(name);
        await wait(`document.querySelectorAll('[data-model-family]').length===1 && !!${family(name)}`);
        await run(`${family(name)}.click()`);
        await check(`${id} is searchable and has no load or tuning action`, `!!${row(id)} && ${row(id)}.innerText.includes(${JSON.stringify(reason)}) && !${row(id)}.querySelector('[data-model-row-toggle]') && !${button(row(id), 'Load')}`);
      }
      await filter('');
      await wait(`!!${family('Qwen3.8-1B')}`);
      await run(`${family('Qwen3.8-1B')}.click()`);
      await wait(`!!${row('small')}`);
      await run(`${button(row('small'), 'Load')}.click()`);
      await check('The small chat model still loads on its own', `fixture.loads.length===3 && fixture.loads[2][1]==='small' && !fixture.loads[2][2].draftModelId && !fixture.loads[2][2].adapterModelId`);
    }
  } catch (error) { report.errors.push(error.stack); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  win.destroy();
  fs.rmSync(profile, { recursive: true, force: true });
  app.exit(report.errors.length ? 1 : 0);
});
