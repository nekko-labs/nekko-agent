// Hidden About version evidence using the real resolver and a disposable profile.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Use layout-evidence-integration.cjs');
const desktop = path.resolve(__dirname, '..');
buildSync({ entryPoints: [path.join(desktop, 'src/main/appVersion.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(out, 'resolver.cjs') });
const { desktopVersion } = require(path.join(out, 'resolver.cjs'));
const version = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8')).version;
const after = desktopVersion({ isPackaged: false, version, appPath: desktop });
app.setPath('userData', path.join(out, 'profile'));
app.on('window-all-closed', () => {});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((request, done) => done({ cancel: !/^(file:|data:|blob:)/.test(request.url) }));
  session.defaultSession.setPermissionRequestHandler((_window, _permission, done) => done(false));
  const report = { errors: [], checks: {}, versions: { before: version, after }, captures: [] };
  try {
    for (const [label, identity] of Object.entries(report.versions)) {
      const win = new BrowserWindow({ width: 960, height: 800, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
      try {
        win.on('focus', () => report.errors.push('Window took focus'));
        win.webContents.on('console-message', event => { if (event.level === 'error') report.errors.push(event.message); });
        await win.loadFile(path.join(out, 'index.html'), { query: { version: identity } });
        const run = code => win.webContents.executeJavaScript(code);
        for (let i = 0; i < 80 && !await run('!!window.versionFixtureReady'); i++) await sleep(100);
        await sleep(300);
        await run('window.dispatchEvent(new Event("nekko:about"))');
        for (let i = 0; i < 80 && !await run('!!document.querySelector(".about-nekko .chip")'); i++) await sleep(100);
        report.checks[label] = await run(`document.querySelector('.about-nekko .chip')?.textContent === ${JSON.stringify('v' + identity)}`);
        report.checks[label + '-hidden'] = !win.isVisible() && !win.isFocused();
        await sleep(500);
        const file = `about-version-${label}.png`;
        fs.writeFileSync(path.join(out, file), (await win.capturePage(undefined, { stayHidden: true })).toPNG());
        report.captures.push(file);
        const beforePet = await run('document.querySelector(".about-nekko-purr")?.textContent');
        await run('document.querySelector(".about-nekko-cat").click()');
        await sleep(100);
        report.checks[label + '-interaction'] = beforePet !== await run('document.querySelector(".about-nekko-purr")?.textContent');
      } finally { win.destroy(); }
    }
    report.checks.development = after.includes('-dev.') && after !== version;
    report.checks.packaged = desktopVersion({ isPackaged: true, version: '0.9.3', appPath: desktop }) === '0.9.3';
  } catch (error) { report.errors.push(String(error.stack || error)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.errors.length || Object.values(report.checks).some(value => !value) ? 1 : 0);
});
