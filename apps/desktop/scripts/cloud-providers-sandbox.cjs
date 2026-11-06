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
    for (const width of [1100, 390]) {
      win.setContentSize(width, 1000);
      for (const mode of ['shortcuts', 'chooser', 'google', 'vertex', 'ollama']) {
        await run(`providerFixture.show(${js(mode)})`);
        await sleep(350);
        const file = path.join(out, `${mode}-${width}.png`);
        fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG());
        report.captures.push(file);
        const metrics = await run('({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, text: document.body.innerText })');
        report.checks.push({ mode, width, overflow: metrics.scrollWidth > metrics.width, text: metrics.text });
        if (!metrics.text.trim()) throw Error(`${mode} did not render`);
      }
    }
    if (!out.includes('before-cloud')) {
      const assert = (ok, message) => { if (!ok) throw Error(message); report.checks.push({ interaction: message }); };
      const click = async text => { await run(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === ${js(text)})?.click()`); await sleep(100); };
      const fill = async (selector, value) => { await run(`(() => { const input = document.querySelector(${js(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${js(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`); await sleep(100); };
      for (const [mode, baseUrl] of [['google', 'https://generativelanguage.googleapis.com/v1beta/openai'], ['ollama', 'https://ollama.com/v1']]) {
        await run(`providerFixture.show(${js(mode)}); providerFixture.calls.length = 0`); await sleep(200);
        await click('Connect provider');
        assert(await run('providerFixture.calls.length === 0'), `${mode}: missing API key blocks requests`);
        await fill('input[type=password]', 'fixture-only-key');
        await run('providerFixture.failure = true');
        await click('Connect provider');
        assert(await run('!providerFixture.calls.some(c => c.save)'), `${mode}: failed validation never saves`);
        await run('providerFixture.failure = false');
        await click('Test connection');
        await click('Connect provider');
        const saved = await run('providerFixture.calls.find(c => c.save)?.save');
        assert(saved?.kind === 'openai-compat' && saved.baseUrl === baseUrl && saved.auth === 'apikey' && saved.apiKey === 'fixture-only-key', `${mode}: saves hosted endpoint, compatible kind and key auth`);
      }
      await run("providerFixture.show('vertex'); providerFixture.calls.length = 0"); await sleep(200);
      await click('Connect provider');
      assert(await run('providerFixture.calls.length === 0'), 'Vertex: missing project blocks requests');
      await fill('input[placeholder="my-google-project"]', 'fixture-project');
      await fill('input[placeholder="global"]', 'us-east5');
      await click('Connect provider');
      const vertex = await run('providerFixture.calls.find(c => c.save)?.save');
      assert(vertex?.kind === 'vertex' && vertex.baseUrl === 'https://us-east5-aiplatform.googleapis.com/v1/projects/fixture-project/locations/us-east5' && !vertex.apiKey, 'Vertex: saves regional Google endpoint without a Claude key');
      for (const check of report.checks.filter(c => c.mode)) assert(!check.overflow, `${check.mode}: fits ${check.width}px`);
    }
    report.bounds = win.getBounds();
    report.visible = win.isVisible();
    if (report.visible) throw Error('Fixture must stay hidden');
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.errors.length ? 1 : 0);
});
