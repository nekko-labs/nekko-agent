// Local-only diagnostic: captures only the synthetic window created here.
const { app, BrowserWindow, desktopCapturer } = require('electron');
const fs = require('node:fs'); const path = require('node:path'); const http = require('node:http');
const root = process.env.NEKKO_CAPTURE_DIAG;
if (!root || !root.includes('.shots')) throw Error('Scratch profile required');
fs.mkdirSync(root, { recursive: true }); app.setPath('userData', path.join(root, 'profile'));
app.whenReady().then(async () => {
  const server = http.createServer((_q, s) => { s.setHeader('Content-Type', 'text/html'); s.end('<!doctype html><title>Capture diagnostic</title><body>Local isolated window</body>'); });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); const url = `http://127.0.0.1:${server.address().port}/`;
  const target = new BrowserWindow({ width: 500, height: 400, show: false, title: 'Nekko capture diagnostic target', webPreferences: { sandbox: true } });
  await target.loadURL(url); target.setTitle('Nekko capture diagnostic target'); target.showInactive();
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 320, height: 200 } });
  const source = sources.find(s => s.name === 'Nekko capture diagnostic target'); if (!source) throw Error('Synthetic target missing');
  const report = { versions: process.versions, source: source.id, thumbnailEmpty: source.thumbnail.isEmpty(), results: [] };
  if (!source.thumbnail.isEmpty()) fs.writeFileSync(path.join(root, 'target-thumbnail.png'), source.thumbnail.toPNG());
  for (const visible of [false, true]) {
    const win = new BrowserWindow({ width: 320, height: 240, show: false, focusable: false, skipTaskbar: true, webPreferences: { partition: 'capture-diag', sandbox: true, contextIsolation: true, backgroundThrottling: false } });
    win.webContents.session.setDisplayMediaRequestHandler((_r, cb) => cb({ video: source })); await win.loadURL(url); if (visible) win.showInactive();
    const result = await win.webContents.executeJavaScript(`(async()=>{try{const stream=await navigator.mediaDevices.getDisplayMedia({video:{frameRate:15},audio:false}); const settings=stream.getVideoTracks()[0].getSettings();stream.getTracks().forEach(t=>t.stop());return {ok:true,settings};}catch(e){return {ok:false,name:e.name,message:e.message,stack:e.stack};}})()`, true);
    report.results.push({ visible, ...result }); win.webContents.session.setDisplayMediaRequestHandler(null); win.destroy();
  }
  await require('esbuild').build({ entryPoints: [path.join(__dirname, '../src/main/windowCapture.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: path.join(root, 'production-capture.cjs') });
  const production = require(path.join(root, 'production-capture.cjs'));
  const listed = await production.captureWindow('diagnostic', { action: 'list' });
  const selected = listed.windows.find(w => w.title === 'Nekko capture diagnostic target');
  try { const result = await production.captureWindow('diagnostic', { action: 'screenshot', window_id: selected.id }, url); report.production = { ok: true, width: result.width, height: result.height }; fs.writeFileSync(path.join(root, 'production.png'), Buffer.from(result.data, 'base64')); }
  catch(e) { report.production = { ok: false, message: e.message }; }
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); target.destroy(); server.close(); app.exit();
}).catch(e => { console.error(e); app.exit(1); });
