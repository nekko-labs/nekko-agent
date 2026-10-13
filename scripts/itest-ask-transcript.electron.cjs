const { app, BrowserWindow, session, protocol, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.argv[2];
protocol.registerSchemesAsPrivileged([{ scheme: 'fixture', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.setPath('userData', path.join(out, 'profile'));
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => app.exit(2), 90000);
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  protocol.handle('fixture', request => {
    const u = new URL(request.url);
    const f = path.resolve(out, u.hostname, 'dist', '.' + decodeURIComponent(u.pathname));
    if (!f.startsWith(path.resolve(out) + path.sep)) return new Response('', { status: 403 });
    const type = f.endsWith('.js') ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : 'text/html';
    return new Response(fs.readFileSync(f), { headers: { 'Content-Type': type } });
  });
  session.defaultSession.webRequest.onBeforeRequest((d, cb) => cb({ cancel: /^(https?|wss?|ftp):/i.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  const cases = [];
  for (const width of [1200, 390]) for (const theme of ['light', 'dark']) for (const version of ['baseline', 'after']) {
    const win = new BrowserWindow({ width, height: 2400, frame: false, useContentSize: true, x: -30000, y: -30000, show: false, focusable: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    win.setContentSize(width, 2400);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const errors = [];
    win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
    await win.loadURL(`fixture://${version}/index.html`);
    await win.webContents.executeJavaScript(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
    await sleep(200);
    const measured = await win.webContents.executeJavaScript('({width:innerWidth,height:innerHeight})');
    const bounds = win.getBounds();
    win.setBounds({ ...bounds, width: bounds.width + width - measured.width, height: bounds.height + 2400 - measured.height });
    await sleep(400);
    const assertions = await win.webContents.executeJavaScript('window.fixture.check()');
    const dimensions = await win.webContents.executeJavaScript('({width:innerWidth,height:innerHeight,scroll:document.documentElement.scrollHeight})');
    const name = `${version}-${width}-${theme}`;
    fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
    cases.push({ name, assertions, dimensions, errors, hidden: !win.isVisible(), focusable: win.isFocusable() });
    win.destroy();
  }
  fs.writeFileSync(path.join(out, 'assertions.json'), JSON.stringify({ inspected: false, cases }, null, 2));
  console.log(JSON.stringify(cases, null, 2));
  // Full-size paired sheets preserve readable text for independent inspection.
  for (const width of [1200, 390]) for (const theme of ['light', 'dark']) {
    const pair = ['baseline', 'after'].map(version => {
      const name = `${version}-${width}-${theme}`;
      return `<figure><figcaption>${name}</figcaption><img src="data:image/png;base64,${fs.readFileSync(path.join(out, name + '.png')).toString('base64')}"></figure>`;
    }).join('');
    const paired = new BrowserWindow({ width: width * 2, height: 2440, useContentSize: true, frame: false, show: false, focusable: false, x: -30000, y: -30000, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    paired.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    await paired.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<style>body{margin:0;background:#ddd;font:16px sans-serif}main{display:flex}figure{margin:0;width:${width}px}figcaption{height:40px;box-sizing:border-box;padding:10px}img{display:block;width:${width}px;height:2400px}</style><main>${pair}</main>`));
    await sleep(250);
    fs.writeFileSync(path.join(out, `contact-sheet-${width}-${theme}.png`), (await paired.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
    paired.destroy();
  }
  // A contact sheet rendered from captured bytes, not claimed as inspected evidence.
  const images = cases.map(c => ({ name: c.name, data: fs.readFileSync(path.join(out, c.name + '.png')).toString('base64') }));
  const cards = images.map(i => `<figure><figcaption>${i.name}</figcaption><img src="data:image/png;base64,${i.data}"></figure>`).join('');
  const sheet = new BrowserWindow({ width: 1600, height: 2260, show: false, focusable: false, x: -30000, y: -30000, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  sheet.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  await sheet.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<style>body{margin:16px;background:#ddd;font:16px sans-serif}main{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}figure{margin:0;background:white}figcaption{padding:8px}img{width:100%;height:930px;object-fit:contain;object-position:top}</style><main>${cards}</main>`));
  await sleep(250);
  fs.writeFileSync(path.join(out, 'contact-sheet.png'), (await sheet.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
  sheet.destroy();
  fs.writeFileSync(path.join(out, 'gallery.html'), `<!doctype html><meta charset="utf-8"><title>Ask transcript evidence</title><style>body{font:16px system-ui;margin:24px;background:#eee}main{display:grid;grid-template-columns:1fr 1fr;gap:20px}img{max-width:100%;border:1px solid #bbb}figure{margin:0}h2{font-size:18px}</style><h1>Before / after renderer evidence</h1><p>Baseline ${JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8')).baseline}. Current integration source. Captured, not visually inspected. Each pair uses identical data, viewport and theme.</p><a href="contact-sheet.png">Contact sheet</a><main>${cases.map(c => `<figure><h2>${c.name}</h2><a href="${c.name}.png"><img src="${c.name}.png"></a></figure>`).join('')}</main>`);
  clearTimeout(deadline);
  const pass = cases.every(c => c.hidden && !c.focusable && c.errors.length === 0 && c.dimensions.width === Number(c.name.split('-')[1]) && c.dimensions.height === 2400 && c.dimensions.scroll <= c.dimensions.height && (c.name.startsWith('after') ? Object.values(c.assertions).every(Boolean) : !c.assertions.qaVisible && !c.assertions.skippedVisible && !c.assertions.unattendedVisible && c.assertions.assistantVisible && c.assertions.errorHasNoReply && c.assertions.pendingHasNoReply));
  app.exit(pass ? 0 : 1);
}).catch(e => { fs.writeFileSync(path.join(out, 'runner-error.txt'), e.stack); console.error(e); app.exit(1); });
