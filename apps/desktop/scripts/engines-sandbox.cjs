// Captures the Models page's Engines block and checks what each kind of
// computer is offered. Real Electron renderer, hidden and off-screen, isolated
// from the user profile, engine and network.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
const baseline = process.env.NEKKO_TEST_LABEL === 'engines-before';
app.setPath('userData', fs.mkdtempSync(path.join(out, 'profile-')));
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Escapes a value for splicing into page script, as the other sandboxes do.
const UNSAFE = new RegExp('[<>/' + String.fromCharCode(0x2028, 0x2029) + ']', 'g');
const js = (v) => JSON.stringify(v).replace(UNSAFE, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const ENGINES = "document.querySelector('[data-models-section=engines]')";
const row = id => `document.querySelector('[data-engine=${id}]')`;
app.whenReady().then(async () => {
  const report = { captures: [], checks: [], errors: [], window: null };
  session.defaultSession.webRequest.onBeforeRequest((req, done) => done({ cancel: !/^(file:|data:|blob:)/.test(req.url) }));
  session.defaultSession.setPermissionRequestHandler((_c, _p, done) => done(false));
  const x = Math.min(...screen.getAllDisplays().map(d => d.bounds.x));
  const y = Math.min(...screen.getAllDisplays().map(d => d.bounds.y));
  const win = new BrowserWindow({ width: 1280, height: 1100, useContentSize: true, show: false, paintWhenInitiallyHidden: true, focusable: false, skipTaskbar: true, x: x - 3000, y: y - 1600, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const run = source => win.webContents.executeJavaScript(source);
  const wait = async (source) => { for (let i = 0; i < 80; i++) { if (await run(source)) return; await sleep(100); } throw Error(`Timed out: ${source}`); };
  const capture = async (name, width, height, theme, section = 'local') => {
    win.setContentSize(width, height);
    await run(`fixture.theme(${js(theme)})`);
    await sleep(900);
    await run(`(() => { const w = document.querySelector('.models-workspace'); const t = document.querySelector('[data-models-section=' + ${js(section)} + ']'); w.scrollTo({ top: w.scrollTop + t.getBoundingClientRect().top - w.getBoundingClientRect().top, behavior: 'instant' }); })()`);
    await sleep(450);
    // A hidden window can hand back the frame from before the scroll: ask for one, then take the next.
    await win.capturePage(undefined, { stayHidden: true });
    await sleep(150);
    const file = path.join(out, `${name}.png`);
    fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG());
    report.captures.push(file);
  };
  const check = async (name, source) => { await wait(source); report.checks.push(name); };
  const machine = async (name) => {
    await run(`fixture.machine(${js(name)})`);
    await wait("!!document.querySelector('[data-model-server]')");
    if (!baseline) { await run(`${ENGINES}.open = true`); await wait(`!!${row('llama')}`); }
  };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    await wait("!!document.querySelector('[data-model-server]')");
    await capture('mac-folded-dark', 1280, 1100, 'dark');
    await capture('mac-folded-narrow-dark', 390, 1100, 'dark');
    // Configure, where the MLX and image runtime cards used to be.
    await run("document.querySelector('[data-model-server-configure]').click()");
    await sleep(500);
    await capture('mac-configure-dark', 1280, 1100, 'dark');
    await run("document.querySelector('[data-model-server-configure]').click()");
    if (!baseline) {
      await check('Engines sits above System models and starts folded', `!${ENGINES}.open && ${ENGINES}.compareDocumentPosition(document.querySelector('[data-models-section=system]')) & Node.DOCUMENT_POSITION_FOLLOWING`);
      await check('Folded, it names the engine in use', "document.querySelector('[data-engine-in-use]').textContent === 'MLX in use'");
      await check('Configure no longer lists runtimes', "!document.querySelector('[data-model-server-config]').innerText.includes('Runtimes')");
      await run("[...document.querySelectorAll('.models-navigation button')].find(b => b.textContent === 'Engines').click()");
      await check('The side menu opens Engines', `${ENGINES}.open`);
      await wait(`!!${row('squid5090')}`);
      await check('Every engine is listed on a Mac, usable ones first', `[...document.querySelectorAll('[data-engine-group=chat] [data-engine]')].map(e => e.dataset.engine).join() === 'mlx,llama,omlx,basalt,squid5090'`);
      await check('MLX is in use and marked Fastest and Most stable', `${row('mlx')}.dataset.engineState === 'in-use' && ${row('mlx')}.innerText.includes('Fastest') && ${row('mlx')}.innerText.includes('Most stable')`);
      await check('An engine this Mac cannot run is disabled with the reason and no button', `${row('squid5090')}.getAttribute('aria-disabled') === 'true' && ${row('squid5090')}.innerText.includes('NVIDIA RTX 5090 only') && !${row('squid5090')}.querySelector('button') && ${row('basalt')}.innerText.includes('NVIDIA RTX 50 series only')`);
      await check('Image models have their own group', "document.querySelector('[data-engine-group=image] [data-engine=diffusion]').innerText.includes('stable-diffusion.cpp')");
      await sleep(600);
      await capture('mac-open-dark', 1280, 1100, 'dark');
      await capture('mac-open-narrow-dark', 390, 1100, 'dark', 'engines');
      // Light: the page is mounted again in the theme, since a hidden window leaves colour transitions half way.
      const themed = async (theme) => { await run(`fixture.theme(${js(theme)}); fixture.remount()`); await wait(`!!${ENGINES} && !${ENGINES}.open`); await run(`${ENGINES}.open = true`); await wait(`!!${row('squid5090')}`); };
      await themed('light');
      await capture('mac-open-light', 1280, 1100, 'light');
      await capture('mac-open-narrow-light', 390, 1100, 'light', 'engines');
      await themed('dark');
      // Choosing another installed engine.
      await run(`[...${row('llama')}.querySelectorAll('button')].find(b => b.textContent === 'Use').click()`);
      await check('Use puts llama.cpp in use and saves the choice', `${row('llama')}.dataset.engineState === 'in-use' && ${row('mlx')}.dataset.engineState === 'installed' && JSON.stringify(fixture.saves()) === '[{"chatEngine":"llama"}]'`);
      await capture('mac-llama-in-use-dark', 1280, 1100, 'dark');
      await machine('mac-no-mlx');
      await check('The fastest engine not yet installed carries the primary Install and its size', `${row('mlx')}.querySelector('button.btn-primary').textContent === 'Install' && ${row('mlx')}.querySelector('[data-engine-meta]').textContent.includes('420')`);
      await capture('mac-install-dark', 1280, 1100, 'dark');
      await machine('linux5090');
      await check('Linux with an RTX 5090 says the Mac engines are macOS only', `${row('mlx')}.innerText.includes('macOS only') && ${row('omlx')}.innerText.includes('macOS only') && ${row('llama')}.dataset.engineState === 'in-use'`);
      await check('One usable engine carries no Fastest or Most stable', `!${ENGINES}.innerText.includes('Fastest') && !${ENGINES}.innerText.includes('Most stable')`);
      await capture('linux5090-open-dark', 1280, 1100, 'dark');
      await machine('windows5090');
      await check('Windows with an RTX 5090 says squid5090 is Linux only', `${row('squid5090')}.innerText.includes('Linux only')`);
      await capture('windows5090-open-dark', 1280, 1100, 'dark');
      await machine('pc');
      await check('A PC without an RTX 50 series card says so', `${row('basalt')}.innerText.includes('NVIDIA RTX 50 series only') && ${row('squid5090')}.innerText.includes('NVIDIA RTX 5090 only')`);
      await capture('pc-open-dark', 1280, 1100, 'dark');
    }
    report.window = { bounds: win.getBounds(), visible: win.isVisible(), focused: win.isFocused() };
  } catch (error) {
    report.errors.push(error.stack || String(error));
  }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.errors.length ? 1 : 0);
});
