// Renderer-only sandbox. No real engines, user profile, network, or desktop input.
const { app, BrowserWindow, screen, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
assert(out, 'Launch with layout-evidence-integration.cjs');
const profile = fs.mkdtempSync(path.join(out, 'profile-'));
app.setPath('userData', profile);
app.setPath('sessionData', profile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const minX = Math.min(...screen.getAllDisplays().map(d => d.bounds.x));
  const minY = Math.min(...screen.getAllDisplays().map(d => d.bounds.y));
  const report = { checks: [], errors: [] };
  session.defaultSession.webRequest.onBeforeRequest((r, done) => done({ cancel: !/^(file:|data:|blob:)/.test(r.url) }));
  session.defaultSession.setPermissionRequestHandler((_c, _p, done) => done(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  const win = new BrowserWindow({ width: 1280, height: 1000, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: minX - 4000, y: minY - 3000, title: 'Isolated model card verification', webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('Fixture took focus'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const run = source => win.webContents.executeJavaScript(source);
  const row = `document.querySelector('[data-library-row="qwen"]')`;
  const toggle = `${row}.querySelector('[data-model-row-toggle]')`;
  const verify = async (name, js) => { assert(await run(js), name); report.checks.push(name); };
  const capture = async name => {
    const image = await win.capturePage(undefined, { stayHidden: true, stayAwake: false });
    assert(!image.isEmpty());
    fs.writeFileSync(path.join(out, name + '.png'), image.toPNG());
  };
  try {
    const bounds = win.getBounds();
    assert(!win.isVisible() && !win.isFocused() && !win.isFocusable() && bounds.x + bounds.width < minX && bounds.y + bounds.height < minY);
    await win.loadFile(path.join(out, 'index.html'));
    await verify('renderer stylesheet loaded', `getComputedStyle(document.querySelector('[data-quiet-row]')).display === 'flex' && !!getComputedStyle(document.documentElement).getPropertyValue('--surface').trim()`);
    for (const width of [1280, 390]) {
      win.setContentSize(width, 1000);
      await sleep(450);
      await verify(`visible rows at width ${width}`, `innerWidth === ${width} && ${row}.getBoundingClientRect().width > 0`);
      await capture(`models-${width}-collapsed`);
      await run(`${toggle}.click()`);
      await run(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
        const reveal = ${row}.querySelector('.model-library-card__reveal');
        Promise.allSettled(reveal.getAnimations().map(a => a.finished)).then(resolve);
      })))`);
      await sleep(200);
      await verify(`settings visible at width ${width}`, `!!${row}.querySelector('[data-engine-load-drawer]')`);
      await capture(`models-${width}-expanded`);
      await run(`${toggle}.click()`);
      await sleep(450);
    }
    if (process.env.NEKKO_CARD_CHECK) {
      const reveal = `${row}.querySelector('.model-library-card__reveal')`;
      const start = `${row}.querySelector('[role=switch]')`;
      const drawer = `${row}.querySelector('[data-engine-load-drawer]')`;
      const load = `${row}.querySelector('button.btn-primary')`;
      await verify('memory preview under the name with disk and estimated states', `
        ${row}.querySelector('[data-model-memory-preview]').innerText.includes('weights on disk') &&
        document.querySelector('[data-library-row="gemma"] [data-model-memory-preview]').innerText.includes('estimated load') &&
        ${row}.querySelector('[data-model-memory-preview]').getBoundingClientRect().top > ${toggle}.firstElementChild.firstElementChild.getBoundingClientRect().top`);
      await verify('no horizontal overflow at narrow width', `document.querySelector('main').scrollWidth === document.querySelector('main').clientWidth`);
      await verify('Load is the trailing header action', `${load} === ${row}.querySelector('[data-quiet-row] > div > button:last-child') && !${start}`);
      await run(`${load}.click()`);
      await sleep(80);
      await verify('Load uses saved settings without opening the drawer', `cardFixture.calls.at(-1)[0] === 'load' && cardFixture.calls.at(-1)[2] === 'qwen' && cardFixture.calls.at(-1)[3].contextTokens === 16384 && ${reveal}.inert`);
      await run(`${toggle}.click()`);
      await sleep(360);
      await verify('settings have no duplicate model title and no outer border', `!${drawer}.innerText.includes('Qwen3.8-27B-MLX-8bit') && getComputedStyle(${drawer}).borderTopWidth === '0px' && getComputedStyle(${reveal}.querySelector('.model-library-card__details')).boxShadow.includes('inset')`);
      await run(`${start}.click()`);
      await sleep(80);
      await verify('startup switch calls the right model and displays the saved on state', `cardFixture.calls.at(-1).join(',') === 'start,qwen,true' && ${start}.getAttribute('aria-checked') === 'true'`);
      await run(`Array.from(${drawer}.querySelectorAll('button')).find(b=>b.textContent.trim()==='Close').click()`);
      await verify('closing makes settings inert and restores focus to the row', `${reveal}.inert && document.activeElement === ${toggle}`);
      await sleep(380);
      await verify('after exit the settings are unmounted', `!${drawer} && ${reveal}.getBoundingClientRect().height === 0`);
      await run(`${toggle}.click()`);
      await sleep(320);
      await verify('startup state persists on reopening', `${start}.getAttribute('aria-checked') === 'true'`);
      await run(`${start}.click(); ${toggle}.click()`);
      await sleep(320);
      await verify('startup setting can be turned off', `cardFixture.calls.at(-1).join(',') === 'start,qwen,false'`);

      await verify('format and capabilities appear as chips', `['Format:', 'MLX', 'Supports:', 'Vision', 'Chat'].every(label => ${row}.querySelector('[data-model-chips]').innerText.includes(label))`);
      await run(`${toggle}.click()`);
      await sleep(350);
      await verify('missing estimates get a dashed track with no invented bytes', `!!${row}.querySelector('[data-allocation-unknown]') && !${row}.querySelector('[role=meter]')`);
      await run(`${toggle}.click()`);
      await sleep(350);
      const known = `document.querySelector('[data-library-row="gemma"]')`;
      const slider = `${known}.querySelector('[data-context-control] input')`;
      const contextSegment = `${known}.querySelector('[data-allocation-bar] [data-segment=context]')`;
      await run(`${known}.querySelector('[data-model-row-toggle]').click()`);
      await sleep(470);
      await verify('one allocation bar sits immediately above the context slider', `${known}.querySelectorAll('[role=meter]').length === 1 && ${known}.querySelector('[data-allocation-bar]').nextElementSibling.matches('[data-context-control]')`);
      const widthBefore = await run(`parseFloat(${contextSegment}.style.width)`);
      const sliderFrames = [];
      const sliderFrame = async () => sliderFrames.push((await win.capturePage({ x: 0, y: 190, width: 390, height: 440 }, { stayHidden: true })).resize({ width: 390 }).toPNG());
      await run(`${slider}.focus()`);
      await sliderFrame();
      await sliderFrame();
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' });
      for (let i = 0; i < 8; i++) { await sliderFrame(); await sleep(55); }
      await verify('native keyboard slider increases the context allocation', `parseFloat(${contextSegment}.style.width) > ${widthBefore} && ${slider}.getAttribute('aria-valuetext').includes('16k')`);
      require('./evidence-gif.cjs')(path.join(out, 'models-context-change.gif'), sliderFrames, 11);
      await capture('models-390-live-context');
      win.setContentSize(1280, 1000);
      await sleep(260);
      await capture('models-1280-live-context');
      await run(`${known}.querySelector('[data-model-row-toggle]').click()`);
      win.setContentSize(390, 1000);
      await sleep(350);

      const frames = [];
      const sample = async (count) => {
        // Sampling geometry inside Chromium avoids missing a short transition
        // when the main process waits for a screenshot/compositor frame.
        const geometry = run(`new Promise(resolve => {
          const heights = [];
          const start = performance.now();
          const tick = () => {
            heights.push(${reveal}.getBoundingClientRect().height);
            if (performance.now() - start >= 360) resolve(heights);
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        })`);
        for (let i = 0; i < count; i++) {
          const img = await win.capturePage({ x: 0, y: 0, width: 390, height: 680 }, { stayHidden: true });
          frames.push(img.resize({ width: 390 }).toPNG());
          await sleep(24);
        }
        return geometry;
      };
      await sample(6);
      await run(`${toggle}.click()`);
      const opening = await sample(22);
      await run(`${toggle}.click()`);
      const closing = await sample(13);
      assert(opening.some(h => h > 0 && h < opening.at(-1)), `Missing opening interpolation: ${opening}`);
      assert(closing.at(-1) === 0 && closing.some(h => h > 0 && h < opening.at(-1)), `Missing closing interpolation: ${closing}`);
      report.checks.push('reveal interpolates height in both directions');
      require('./evidence-gif.cjs')(path.join(out, 'models-expand-collapse.gif'), frames, 5);
    }

  } catch (error) { report.errors.push(String(error.stack || error)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  app.exit(report.errors.length ? 1 : 0);
});
