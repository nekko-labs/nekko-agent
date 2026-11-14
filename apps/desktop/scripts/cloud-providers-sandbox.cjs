const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const js = v => JSON.stringify(v).replace(/[<>/\u2028\u2029]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], checks: [], errors: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  fs.cpSync(path.join(__dirname, '../src/renderer/public/providers'), path.join(out, 'providers'), { recursive: true });
  const win = new BrowserWindow({ width: 1100, height: 1000, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('Window took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 1000)); });
  const run = s => win.webContents.executeJavaScript(s, true);
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 100 && !await run('!!window.providerFixture'); i++) await sleep(100);
    const before = /before/.test(out);
    const modes = ['shortcuts', 'chooser', 'google', 'openai', 'openrouter', 'chatgpt', 'ollama', 'vertex'];
    const capture = async name => {
      const file = path.join(out, `${name}.png`);
      // A hidden window only repaints when asked; without this a capture can show an earlier frame.
      win.webContents.invalidate();
      await Promise.race([run('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))'), sleep(1000)]);
      await sleep(250);
      win.webContents.invalidate();
      fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG());
      report.captures.push(file);
    };
    for (const theme of ['dark', 'light']) {
      await run(`document.documentElement.dataset.theme = ${js(theme)}`);
      for (const width of [1100, 390]) {
        win.setContentSize(width, 1000);
        for (const mode of modes) {
          await run(`providerFixture.show(${js(mode)})`);
          await sleep(350);
          await capture(`${mode}-${theme}-${width}`);
          const metrics = await run('({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, text: document.body.innerText })');
          report.checks.push({ mode, theme, width, overflow: metrics.scrollWidth > metrics.width, text: metrics.text });
          if (!metrics.text.trim()) throw Error(`${mode} did not render`);
        }
      }
    }
    if (!before) {
      win.setContentSize(1100, 1000);
      await run("document.documentElement.dataset.theme = 'dark'");
      // A hidden window advances CSS animations only on a frame, so state captures show the settled state.
      await run("document.head.insertAdjacentHTML('beforeend', '<style>*, *::before, *::after { animation: none !important; transition: none !important; }</style>')");
      const assert = (ok, message) => { if (!ok) throw Error(message); report.checks.push({ interaction: message }); };
      const click = async text => { await run(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === ${js(text)})?.click()`); await sleep(150); };
      const has = text => run(`Array.from(document.querySelectorAll('button')).some(b => b.textContent.trim() === ${js(text)})`);
      const fill = async (selector, value) => { await run(`(() => { const input = document.querySelector(${js(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${js(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`); await sleep(150); };
      const paste = async (selector, value) => { await run(`(() => { const dt = new DataTransfer(); dt.setData('text/plain', ${js(value)}); document.querySelector(${js(selector)}).dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })()`); await sleep(400); };
      const key = 'input[type=password]';
      for (const [mode, baseUrl] of [['google', 'https://generativelanguage.googleapis.com/v1beta/openai'], ['ollama', 'https://ollama.com/v1']]) {
        await run(`providerFixture.show(${js(mode)}); providerFixture.calls.length = 0; providerFixture.failure = false`); await sleep(250);
        assert(!await has('Connect') && !await has('Connect provider') && !await has('Test connection'), `${mode}: no Connect until there is a key`);
        assert(await run('providerFixture.calls.length === 0'), `${mode}: nothing is sent before a key`);
        await fill(key, 'fixture-only-key');
        await run('providerFixture.failure = true');
        await click('Connect');
        await sleep(400);
        assert(await run('!providerFixture.calls.some(c => c.save)'), `${mode}: failed check never saves`);
        assert(await run("document.body.innerText.includes('Fixture: credentials rejected')"), `${mode}: failure shown in words`);
        if (mode === 'google') await capture('google-failed-dark-1100');
        await run('providerFixture.failure = false');
        await click('Try again');
        await sleep(300);
        const saved = await run('providerFixture.calls.find(c => c.save)?.save');
        assert(saved?.kind === 'openai-compat' && saved.baseUrl === baseUrl && saved.auth === 'apikey' && saved.apiKey === 'fixture-only-key', `${mode}: saves hosted endpoint, compatible kind and key auth`);
        if (mode === 'google') await capture('google-connected-dark-1100');
        await sleep(900);
        assert(await run('providerFixture.calls.some(c => c.done)'), `${mode}: the setup closes itself once connected`);
      }
      // A Gemini-shaped key pasted into the field checks and connects with no further press.
      const gemini = 'AIza' + 'F'.repeat(35);
      await run("providerFixture.show('google'); providerFixture.calls.length = 0"); await sleep(250);
      await paste(key, gemini);
      const pasted = await run('providerFixture.calls.find(c => c.save)?.save');
      assert(pasted?.apiKey === gemini, 'google: a pasted key connects by itself');
      // OpenAI uses the same flow; OpenRouter and ChatGPT keep their one-click sign-in.
      await run("providerFixture.show('openai')"); await sleep(250);
      assert(await has('Open OpenAI'), 'openai: guided key flow');
      await run("providerFixture.show('openrouter')"); await sleep(250);
      assert(await has('Sign in with OpenRouter') && await has('Use a key you already have'), 'openrouter: sign-in first, key on request');
      await click('Use a key you already have');
      assert(await has('Open OpenRouter'), 'openrouter: key path is the guided flow');
      await run("providerFixture.show('vertex'); providerFixture.calls.length = 0"); await sleep(250);
      await click('Connect');
      assert(await run('providerFixture.calls.length === 0'), 'Vertex: missing project blocks requests');
      await fill('input[placeholder="my-google-project"]', 'fixture-project');
      await fill('input[placeholder="global"]', 'us-east5');
      await click('Connect');
      await sleep(200);
      const vertex = await run('providerFixture.calls.find(c => c.save)?.save');
      assert(vertex?.kind === 'vertex' && vertex.baseUrl === 'https://us-east5-aiplatform.googleapis.com/v1/projects/fixture-project/locations/us-east5' && !vertex.apiKey, 'Vertex: saves regional Google endpoint without a Claude key');
      for (const check of report.checks.filter(c => c.mode)) assert(!check.overflow, `${check.mode} ${check.theme}: fits ${check.width}px`);
    }
    report.bounds = win.getBounds();
    report.visible = win.isVisible();
    if (report.visible) throw Error('Fixture must stay hidden');
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.errors.length ? 1 : 0);
});
