// Real Chromium/Electron renderer, isolated from the user profile, engine and network.
const { app, BrowserWindow, session, screen } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
const baseline = process.env.NEKKO_TEST_LABEL === 'model-rows-before';
app.setPath('userData', fs.mkdtempSync(path.join(out, 'profile-')));
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  const report = { captures: [], checks: [], errors: [] };
  session.defaultSession.webRequest.onBeforeRequest((req, done) => done({ cancel: !/^(file:|data:|blob:)/.test(req.url) }));
  session.defaultSession.setPermissionRequestHandler((_c, _p, done) => done(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  const x = Math.min(...screen.getAllDisplays().map(d => d.bounds.x));
  const y = Math.min(...screen.getAllDisplays().map(d => d.bounds.y));
  const win = new BrowserWindow({ width: 1280, height: 980, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: x - 3000, y: y - 1600, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('Fixture took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const run = source => win.webContents.executeJavaScript(source);
  const wait = async (source) => { for (let i = 0; i < 80; i++) { if (await run(source)) return; await sleep(100); } throw Error(`Timed out: ${source}`); };
  const click = (label) => run(`[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===${JSON.stringify(label)} || b.textContent.trim()===${JSON.stringify(label)}).click()`);
  const jump = section => run(`(() => { const workspace = document.querySelector('.models-workspace'); const target = document.querySelector('[data-models-section=${section}]'); workspace.scrollTo({ top: workspace.scrollTop + target.getBoundingClientRect().top - workspace.getBoundingClientRect().top, behavior: 'instant' }); })()`);
  const capture = async (name, width, height, theme, section = 'local') => {
    win.setContentSize(width, height);
    await run(`fixture.theme('${theme}')`);
    await sleep(450);
    await jump(section);
    await sleep(450);
    const img = await win.capturePage(undefined, { stayHidden: true });
    assert(!img.isEmpty(), 'Empty capture');
    const file = path.join(out, `${name}.png`);
    fs.writeFileSync(file, img.toPNG());
    report.captures.push({ file, size: img.getSize() });
  };
  const check = async (name, source) => { await wait(source); report.checks.push(name); };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    await wait("!!document.querySelector('[data-model-family=gemma4e4b]')");
    assert(await run("getComputedStyle(document.querySelector('.models-workspace')).overflowY === 'auto'"), 'Renderer stylesheet must be active');
    if (baseline) await run("document.querySelector('details[aria-label=\"System models\"]').open=true");
    await run("document.querySelector('[data-model-family=gemma4e4b]').click()");
    await wait("document.body.innerText.includes('Apple speech')");
    for (const [name, w, h, theme] of [['desktop-light', 1280, 1050, 'light'], ['desktop-dark', 1280, 1050, 'dark'], ['narrow-dark', 390, 1050, 'dark']]) await capture(name, w, h, theme);
    if (!baseline) {
      await check('System models precedes the general library', "!!(document.querySelector('[data-models-section=system]').compareDocumentPosition(document.querySelector('[data-models-section=library]')) & Node.DOCUMENT_POSITION_FOLLOWING)");
      await check('No page overflow at narrow width', 'document.documentElement.scrollWidth===innerWidth && document.querySelector(".models-workspace").scrollWidth===document.querySelector(".models-workspace").clientWidth');
      await check('Installed facts use effective parameters, disk size, and type', `document.querySelector('[data-model-family=gemma4e4b] [data-model-facts]').innerText.replace(/\\s/g,' ')==='Vision · 4B effective parameters · 5.0 GB'`);
      await click('Favorite Gemma-4-E4B');
      await check('Favorite uses the shared provider/model key without changing existing favorites', `fixture.saved().favoriteModels.join(',')==='cloud::other,nekko-engine::gemma'`);
      await click('Set Gemma-4-E4B as default');
      await check('Default saves the provider/model together and marks the row', `fixture.saved().defaultProviderId==='nekko-engine' && fixture.saved().defaultModelId==='gemma' && document.querySelector('[data-model-family=gemma4e4b]').innerText.includes('Default')`);
      await capture('narrow-actions', 390, 900, 'dark', 'library');
      if (process.env.NEKKO_MODELS_RECORD) {
        const { GifFrame, GifUtil } = require('gifwrap');
        const { PNG } = require('pngjs');
        const frames = [];
        const framesFor = async (count) => {
          for (let i = 0; i < count; i++) {
            const image = (await win.capturePage(undefined, { stayHidden: true })).resize({ width: 390 });
            const frame = new GifFrame(PNG.sync.read(image.toPNG()), { delayCentisecs: 9 });
            GifUtil.quantizeDekker(frame, 96);
            frames.push(frame);
            await sleep(65);
          }
        };
        await framesFor(5); await click('System models'); await framesFor(13);
        await click('Models'); await framesFor(13);
        await GifUtil.write(path.join(out, 'models-section-navigation.gif'), frames);
      }
      await click('Delete Gemma-4-E4B');
      await check('Delete waits for a decision', `!!document.querySelector('[role=dialog]') && fixture.deleted.length===0`);
      await click('Cancel');
      await check('Cancel preserves the file', `!document.querySelector('[role=dialog]') && fixture.deleted.length===0`);
      await click('Delete Gemma-4-E4B');
      await click('Delete');
      await check('Confirm deletes only the selected model and refreshes the library', `fixture.deleted.join(',')==='gemma' && !document.querySelector('[data-model-family=gemma4e4b]')`);
      await check('Deletion resets only the removed model’s favorite and default', `fixture.saved().favoriteModels.join(',')==='cloud::other' && fixture.saved().defaultModelId!=='gemma'`);
      await check('Borrowed files cannot be deleted; non-chat models cannot be chat defaults', `!document.querySelector('[aria-label="Delete BGE-Small"]') && !document.querySelector('[aria-label="Set BGE-Small as default"]')`);
      await run(`document.querySelector('[data-model-family="qwen359b"]').click()`);
      await check('Multi-variant families offer exact-file actions on the variant rows', `!!document.querySelector('[data-library-row=qwen-f16] [aria-label="Delete Qwen3.5-9B-F16"]') && !document.querySelector('[aria-label="Delete Qwen3.5-9B"]')`);
      await run('fixture.mount(true)');
      await check('System models stays visible without any local download', `!!document.querySelector('[data-models-section=system]') && document.body.innerText.includes('Apple speech') && !document.querySelector('[data-models-section=library]')`);
    }
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  win.destroy(); app.exit(report.errors.length ? 1 : 0);
});
