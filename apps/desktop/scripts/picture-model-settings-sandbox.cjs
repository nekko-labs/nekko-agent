// Hidden, isolated full-App evidence for Settings → Agents → Pictures (#2973):
// the agents' default picture model, with ready, not-ready and video models.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], checks: [], errors: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1200, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') console.error(e.message.slice(0, 500)); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const shot = async name => { const f = path.join(out, `${name}.png`); fs.writeFileSync(f, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(f); };
  const check = async (name, expression) => { const ok = await run(expression); report.checks.push({ name, ok }); if (!ok) throw Error(name); };
  const control = "document.querySelector('[aria-label=\"Picture model for agents\"]')";
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 100 && !(await run('!!window.layoutFixture')); i++) await sleep(100);
    await run(`(() => {
      const f = layoutFixture;
      f.bridge.engineModels = async () => [
        { id: 'z-image-turbo', name: 'Z-Image Turbo', modality: 'image' },
        { id: 'flux2-klein-4b', name: 'FLUX.2 klein 4B', modality: 'image' },
        { id: 'qwen-image', name: 'Qwen Image', modality: 'image' },
        { id: 'wan', name: 'Wan 2.2 TI2V 5B', modality: 'image' },
        { id: 'qwen3-8b', name: 'Qwen3 8B', modality: 'text' },
      ];
      const can = { 'z-image-turbo': [true, ['create']], 'flux2-klein-4b': [true, ['create', 'edit']], 'qwen-image': [false, ['create']], wan: [true, ['video']] };
      f.bridge.engineImageCompanions = async (id) => can[id] ? { ready: can[id][0], capabilities: can[id][1], files: [], missingBytes: 0, defaults: { steps: 8, cfgScale: 1 } } : null;
      window.savedPatches = [];
      const update = f.bridge.updateSettings;
      f.bridge.updateSettings = async (patch) => { window.savedPatches.push(patch); return update ? update(patch) : patch; };
      f.store.setState({ view: 'settings' });
    })()`);
    for (let i = 0; i < 50 && !(await run(`!!${control}`)); i++) await sleep(100);
    const scroll = `${control}.closest('section').scrollIntoView({ block: 'center' })`;
    await run(scroll); await sleep(200);
    await shot('pictures-desktop');
    await check('Automatic first, then the ready picture models only',
      `JSON.stringify([...${control}.options].map(o => o.textContent)) === JSON.stringify(['Automatic', 'Z-Image Turbo', 'FLUX.2 klein 4B · edits too'])`);
    await run(`(() => { const e = ${control}; const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(e, 'flux2-klein-4b'); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await sleep(200);
    await check('choosing a model saves agentPictureModel', "window.savedPatches.some(p => p.agentPictureModel === 'flux2-klein-4b')");
    win.setContentSize(390, 844); await sleep(300); await run(scroll); await sleep(150);
    await shot('pictures-mobile');
    report.bounds = win.getBounds(); report.visible = win.isVisible();
    if (report.visible) throw Error('fixture became visible');
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ checks: report.checks, errors: report.errors, visible: report.visible }));
  app.exit(report.errors.length ? 1 : 0);
});
