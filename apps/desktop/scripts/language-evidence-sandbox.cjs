// Runs against the real onboarding and Settings renderer through the shared
// layout launcher, with a disposable Electron profile and no real host.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Use layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const base = process.env.NEKKO_LANGUAGE_BASE === '1';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest(({ url }, done) => done({ cancel: !/^(file:|data:|blob:)/.test(url) }));
  session.defaultSession.setPermissionRequestHandler((_win, _permission, done) => done(false));
  const win = new BrowserWindow({ width: 1200, height: 800, useContentSize: true, show: false, focusable: false, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const report = { base, errors: [], captures: [], checks: {} };
  win.on('show', () => report.errors.push('Window was shown'));
  win.on('focus', () => report.errors.push('Window took focus'));
  const run = async code => {
    const result = await win.webContents.executeJavaScript(`(() => { try { const v = (${code}); return { value: typeof v === "boolean" ? v : null }; } catch (e) { return { error: String(e) }; } })()`, true);
    if (result.error) throw Error(`${result.error}: ${code}`);
    return result.value;
  };
  const check = async (label, code) => {
    const result = await run(code);
    report.checks[label] = result;
    if (!result) throw Error(`Failed: ${label}`);
  };
  const wait = async code => {
    for (let i = 0; i < 80; i++) { if (await run(code)) return; await sleep(100); }
    throw Error(`Timed out: ${code}`);
  };
  const shot = async name => {
    await sleep(300); // let the hidden compositor commit the new frame
    const image = await win.capturePage(undefined, { stayHidden: true });
    if (image.isEmpty()) throw Error(`Empty capture: ${name}`);
    fs.writeFileSync(path.join(out, name + '.png'), image.toPNG());
    report.captures.push(name);
  };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    win.webContents.debugger.attach();
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await wait('!!document.querySelector("[aria-current=step]")');
    await check('welcome visible', `document.querySelector('[role=dialog] h1').textContent.includes('Nekko')`);
    await shot('welcome');
    await run(`document.querySelectorAll('[role=dialog] [role=group] button')[1].click()`);
    await wait('!!document.querySelector("#setup-name")');
    await shot('name');
    if (!base) {
      await run(`document.querySelector('#setup-language').click()`);
      await wait('document.querySelector("#setup-language-options").matches(":popover-open")');
      await check('menu inside viewport', `(() => { const box = document.querySelector('#setup-language-options').getBoundingClientRect(); return box.x >= 0 && box.y >= 0 && box.bottom <= innerHeight && box.right <= innerWidth && box.height > 0; })()`);
      await shot('name-options');
      await run(`document.querySelector('#setup-language-options button').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
      await check('Escape closes only the picker', `!document.querySelector('#setup-language-options').matches(':popover-open') && !!document.querySelector('#setup-name')`);
      await run(`document.querySelector('#setup-language').click()`);
      await run(`document.querySelector('#setup-language-options [lang=ja]').closest('button').click()`);
      await wait(`document.documentElement.lang === 'ja'`);
      await check('name heading switches', `document.querySelector('label[for=setup-name]').textContent.includes('お名前')`);
      await shot('name-japanese');
      await run(`document.querySelector('#setup-language').click()`);
      await run(`document.querySelector('#setup-language-options [data-language=""]').click()`);
      await wait(`document.documentElement.lang === 'en'`);
    }
    await run(`document.querySelector('[role=dialog] > div:first-child > div:last-child > button').click()`);
    await wait('!document.querySelector("[aria-current=step]")');
    await run(`onboardingFixture.openSettings()`);
    await wait('!!document.querySelector("#settings-language")');
    await run(`document.querySelector('#language-and-help').scrollIntoView({ block: 'center', behavior: 'instant' })`);
    await shot('settings');
    if (!base) {
      await run(`document.querySelector('#settings-language').click()`);
      await wait('document.querySelector("#settings-language-options").matches(":popover-open")');
      await shot('settings-options');
      await run(`document.querySelector('#settings-language-options [lang=fr]').closest('button').click()`);
      await wait(`document.documentElement.lang === 'fr'`);
      await check('language persisted', `onboardingFixture.settings.language === 'fr'`);
      await run(`document.querySelector('#settings-language').click()`);
      await run(`document.querySelector('#settings-language-options [data-language=""]').click()`);
      await wait(`document.documentElement.lang === 'en'`);
      await check('system default persisted', `onboardingFixture.settings.language === ''`);
    }
    if (!base) {
      await win.loadFile(path.join(out, 'index.html'), { query: { system: 'es' } });
      await wait('!!document.querySelector("[aria-current=step]")');
      await check('first run honors next supported system preference', `document.documentElement.lang === 'es' && document.querySelector('[role=dialog] h1').textContent.includes('Hola')`);
      await shot('welcome-system-spanish');
    }
    await check('hidden viewport', 'innerWidth === 1200 && innerHeight === 800');
    if (win.isVisible() || win.isFocused()) throw Error('Not hidden');
  } catch (error) { report.errors.push(String(error.stack || error)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  win.destroy();
  app.exit(report.errors.length ? 1 : 0);
});
