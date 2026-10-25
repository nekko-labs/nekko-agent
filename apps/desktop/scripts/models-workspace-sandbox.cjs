const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], metrics: {}, errors: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const minX = Math.min(...screen.getAllDisplays().map(d => d.bounds.x)), minY = Math.min(...screen.getAllDisplays().map(d => d.bounds.y));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: minX - 1700, y: minY - 1100, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => { report.errors.push('took focus'); });
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 300)); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const shot = async name => { const f = path.join(out, name + '.png'); fs.writeFileSync(f, (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG()); report.captures.push(f); };
  fs.cpSync(path.join(__dirname, '../src/renderer/public/providers'), path.join(out, 'providers'), { recursive: true });
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 80 && !(await run('!!window.layoutFixture')); i++) await sleep(100);
    await run(`(() => {
      const providers = [{id:'cloud',kind:'openai',label:'OpenAI',enabled:true,baseUrl:'https://api.openai.com/v1'}, {id:'local',kind:'lmstudio',label:'LM Studio',enabled:false,baseUrl:'http://localhost:1234/v1'}];
      window.nekko.listProviders = async () => providers;
      window.nekko.testProvider = async () => ({ok:true});
      window.nekko.listModelsStatus = async (id) => ({models:[{id:'gpt-fixture',providerId:id,name:'GPT fixture',contextWindow:128000}]});
      window.nekko.engineCatalog = async () => [];
      window.nekko.listModelFolders = async () => [];
      window.nekko.engineModels = async () => [];
      window.nekko.engineDownloads = async () => [];
      window.nekko.engineStatus = async () => ({install:{available:[]},running:false,resident:[],loading:[],log:[],settings:{port:11500,bind:'local',autoload:[]}});
      layoutFixture.store.setState({ providers, activeModelId:'fixture', view:'models' });
    })()`);
    for (const width of [1440, 390]) {
      win.setContentSize(width, 900);
      for (const view of ['models', 'modelserver']) {
        await run(`layoutFixture.store.getState().setView('${view}')`);
        await sleep(1000);
        await shot(`${view}-${width}`);
      }
    }
    // Interact with the real renderer; do not save credentials or run any server.
    if (await run("!!document.querySelector('.models-subnav')")) {
      win.setContentSize(1440, 900);
      await run("document.querySelectorAll('.models-subnav button')[1].click()");
      await sleep(300);
      report.metrics.shortcuts = [];
      for (const kind of ['chatgpt', 'anthropic', 'openai', 'openrouter', 'vertex', 'any']) {
        const index = ['chatgpt', 'anthropic', 'openai', 'openrouter', 'vertex', 'any'].indexOf(kind);
        await run(`document.querySelectorAll('.models-add-strip button')[${index}].click()`);
        await sleep(200);
        const opened = await run(`document.querySelector('[data-provider-setup]')?.dataset.providerSetup === '${kind}'`);
        if (!opened) throw new Error('Shortcut did not open ' + kind);
        if (kind === 'any' && !(await run("!!document.querySelector('.provider-choices')"))) throw new Error('Overflow chooser missing');
        report.metrics.shortcuts.push(kind);
        await run(`document.querySelector('[aria-label="Close provider setup"]').click()`);
        await sleep(100);
      }
      await run("document.querySelectorAll('.models-subnav button')[0].click()");
      await sleep(300);
      if (!(await run("!!document.querySelector('.models-local-connections')"))) throw new Error('Local connections missing');
      await run("document.querySelector('.models-local-connections').scrollIntoView()");
      await sleep(200);
      await shot('local-connections-1440');
      // Short interaction recording, encoded from hidden renderer frames.
      const modules = process.env.NEKKO_TEST_MODULES || path.join(__dirname, '../../../node_modules');
      const { PNG } = require(path.join(modules, 'pngjs'));
      const { GifWriter } = require(path.join(modules, 'omggif'));
      const frames = [];
      for (let i = 0; i < 12; i++) {
        if (i === 0) await run("document.querySelectorAll('.models-subnav button')[1].click()");
        if (i === 3) await run("document.querySelector('[aria-label=\"More providers\"]').click()");
        if (i === 6) await run("document.querySelector('[aria-label=\"Close provider setup\"]').click()");
        if (i === 9) await run("document.querySelectorAll('.models-subnav button')[0].click()");
        await sleep(250);
        frames.push(PNG.sync.read((await win.capturePage(undefined, { stayHidden: true })).resize({ width: 960 }).toPNG()));
      }
      const counts = new Map();
      const key = (d, i) => (d[i] >> 3) << 10 | (d[i + 1] >> 3) << 5 | (d[i + 2] >> 3);
      for (const f of frames) for (let i = 0; i < f.data.length; i += 4) { const k = key(f.data, i); counts.set(k, (counts.get(k) || 0) + 1); }
      const colors = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 256).map(([k]) => ((k >> 10) * 8) << 16 | (((k >> 5) & 31) * 8) << 8 | (k & 31) * 8);
      while (colors.length < 256) colors.push(0);
      const indices = new Map([...counts.keys()].map(k => {
        const rgb = [(k >> 10) * 8, ((k >> 5) & 31) * 8, (k & 31) * 8];
        let best = 0, distance = Infinity;
        colors.forEach((c, i) => { const d = (rgb[0] - (c >> 16)) ** 2 + (rgb[1] - ((c >> 8) & 255)) ** 2 + (rgb[2] - (c & 255)) ** 2; if (d < distance) { distance = d; best = i; } });
        return [k, best];
      }));
      const buffer = Buffer.alloc(20 * 1024 * 1024);
      const gif = new GifWriter(buffer, frames[0].width, frames[0].height, { palette: colors, loop: 0 });
      for (const f of frames) { const pixels = new Uint8Array(f.width * f.height); for (let i = 0; i < pixels.length; i++) pixels[i] = indices.get(key(f.data, i * 4)); gif.addFrame(0, 0, f.width, f.height, pixels, { delay: 25 }); }
      fs.writeFileSync(path.join(out, 'models-navigation.gif'), buffer.subarray(0, gif.end()));
      report.metrics.navigation = 'cloud to local via subnavigation';
    }
    report.metrics.bounds = win.getBounds();
    report.metrics.visible = win.isVisible();
  } catch (e) { report.failed = true; report.errors.push(String(e && e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(!report.failed && report.captures.length >= 4 ? 0 : 1);
});
