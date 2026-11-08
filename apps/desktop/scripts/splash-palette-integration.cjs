// Run with Electron. Real renderer modules, synthetic data, isolated storage, no network.
// Set NEKKO_TEST_REVISION to the unchanged base commit to capture matching before evidence.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { app, BrowserWindow, session } = require('electron');
const repo = path.resolve(__dirname, '../../..');
const revision = process.env.NEKKO_TEST_REVISION;
const label = revision ? 'before' : 'after';
const out = path.join(repo, '.shots/splash-palette', label);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nekko-splash-palette-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = value => JSON.stringify(value).replace(/[<>/\u2028\u2029]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
app.commandLine.appendSwitch('force-color-profile', 'srgb');
app.setPath('userData', profile);
app.setPath('sessionData', profile);
app.dock?.hide();
let win;
async function main() {
  await app.whenReady();
  fs.mkdirSync(out, { recursive: true });
  let source = path.join(repo, 'apps/desktop/src/renderer');
  if (revision) {
    source = path.join(out, 'base-source');
    for (const file of ['splash.ts', 'splashCells.ts', 'components/BrandMark.tsx', 'components/cloud/RecoveryKeyDialog.tsx', 'components/cloud/cloud.css']) {
      const dest = path.join(source, file);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, cp.execFileSync('git', ['show', `${revision}:apps/desktop/src/renderer/${file}`], { cwd: repo }));
    }
  }
  await require('esbuild').build({
    stdin: { contents: `import * as splash from ${JSON.stringify(path.join(source, 'splash.ts'))}; import { saveKit } from ${JSON.stringify(path.join(source, 'components/cloud/RecoveryKeyDialog.tsx'))}; window.fixture = { ...splash, saveKit };`, resolveDir: repo, loader: 'ts' },
    bundle: true, format: 'iife', outfile: path.join(out, 'fixture.js'), jsx: 'automatic', loader: { '.css': 'empty' },
    alias: { '@nekko-agent/shared': path.join(repo, 'packages/shared/src/index.ts') },
    // Expose the existing download handler only inside this fixture, not in the shipping API.
    plugins: [{ name: 'recovery-kit-handler', setup(build) { build.onLoad({ filter: /RecoveryKeyDialog\.tsx$/ }, args => ({ contents: fs.readFileSync(args.path, 'utf8') + '\nexport { saveKit };', loader: 'tsx' })); } }],
  });
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\' data: blob:; script-src \'self\'; style-src \'unsafe-inline\'; connect-src \'none\'"><style>:root{--paper:#0c0c11}body{margin:0;background:#0c0c11;color:white}</style></head><body><script src="fixture.js"></script></body></html>');
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: !/^(file:|data:|blob:)/.test(details.url) }));
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, done) => done(false));
  session.defaultSession.on('will-download', (event) => event.preventDefault());
  win = new BrowserWindow({ width: 1280, height: 696, x: -5000, y: -5000, useContentSize: true, show: false, focusable: false, skipTaskbar: true, title: `Nekko splash palette ${label}`, webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const errors = [];
  win.webContents.on('render-process-gone', (_event, details) => console.error('Renderer exited', details));
  win.on('focus', () => errors.push('Fixture took focus'));
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  const run = s => win.webContents.executeJavaScript(s);
  const load = () => win.loadFile(path.join(out, 'index.html'));
  const shot = async name => {
    // Give the compositor time to paint paused animations, especially the first load.
    await sleep(100);
    fs.writeFileSync(path.join(out, `${name}.png`), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
  };
  const checks = [];
  for (const name of ['fresh', 'cached-lilac', 'nekko-dark', 'indigo', 'nebula', 'custom']) {
    console.log('Capture', label, name);
    await load();
    const candidates = name === 'nebula' ? ['#9d8ce6'] : name === 'custom' ? ['#336699'] : name === 'indigo' ? ['#a68fd0'] : ['#c084b5'];
    const preset = name === 'nekko-dark' ? 'x-plum-dark' : name === 'indigo' ? 'x-indigo-dark' : name === 'custom' ? 'custom' : 'nebula';
    await run(`localStorage.clear(); ${name === 'cached-lilac' ? "localStorage.setItem('nekko.splash', JSON.stringify({bg:'#9d8ce6',fg:'#17151f',paper:'#0c0c11'}));" : name === 'fresh' ? '' : `fixture.rememberSplashColours(${js(candidates)}, ${js(preset)});`} fixture.playSplash(new Promise(()=>{}));`);
    // Let the real build reach its smooth logo; don't race startup's on-screen callback.
    await sleep(1500);
    await run('document.getAnimations().forEach(a=>a.pause())');
    const colors = await run(`({bg:document.querySelector('svg > rect').getAttribute('fill'),fg:document.querySelector('svg > g > g > g > path:last-child').getAttribute('fill'),stored:JSON.parse(localStorage.getItem('nekko.splash'))})`);
    if (!revision) {
      const expected = name === 'indigo' ? '#2b124c' : name === 'nebula' ? '#9d8ce6' : name === 'custom' ? '#336699' : '#190019';
      if (colors.bg !== expected) throw Error(`${name}: expected ${expected}, got ${colors.bg}`);
    }
    await shot(name);
    const { PNG } = require('pngjs');
    const pixels = PNG.sync.read(fs.readFileSync(path.join(out, `${name}.png`)));
    const actual = '#' + [...pixels.data.subarray(0, 3)].map(c => c.toString(16).padStart(2, '0')).join('');
    // Compare exact DOM fills above and reject a blank/unpainted frame here.
    let hasLogo = false;
    for (let i = 4; i < pixels.data.length; i += 4) {
      if (Math.abs(pixels.data[i] - pixels.data[0]) > 30 || Math.abs(pixels.data[i + 1] - pixels.data[1]) > 30) { hasLogo = true; break; }
    }
    if (!hasLogo) throw Error(`${name}: blank capture without a logo`);
    if (actual !== colors.bg.toLowerCase()) throw Error(`${name}: captured fill ${actual} differs from DOM ${colors.bg}`);
    checks.push({ name, ...colors, capturedBg: actual });
  }
  // Offscreen rendering advances compositor animations without showing a window.
  for (const mode of ['normal', 'reduced', 'reload']) {
    console.log('Lifecycle', label, mode);
    await load();
    await run(`localStorage.clear(); ${mode === 'reduced' ? "window.matchMedia=()=>({matches:true});" : ''} fixture.${mode === 'reload' ? 'playReloadCover' : 'playSplash'}(Promise.resolve());`);
    await sleep(mode === 'normal' ? 2400 : 700);
    if (await run("!!document.querySelector('[aria-hidden]')")) throw Error(`${mode}: cover did not clear`);
    checks.push({ name: `${mode}-lifecycle`, cleared: true });
  }
  console.log('Recovery kit', label);
  await load();
  console.log('Generating synthetic kit');
  const kit = await run(`(async()=>{HTMLAnchorElement.prototype.click=()=>{}; let output; URL.createObjectURL=blob=>{output=blob;return 'blob:synthetic-kit'}; await fixture.saveKit(Array(12).fill('ABCDE').join('-'),'fixture@example.invalid'); return output.text()})()`);
  if (!revision && (!kit.includes('border:1.5px solid #5a2352') || kit.includes('#6d5efc'))) throw Error('Recovery kit retains brand violet');
  console.log('Generated kit', kit.length);
  fs.writeFileSync(path.join(out, 'recovery-kit.html'), kit);
  await win.loadFile(path.join(out, 'recovery-kit.html'));
  console.log('Loaded kit');
  await shot('recovery-kit');
  checks.push({ name: 'recovery-kit', border: await run("getComputedStyle(document.querySelector('.key')).borderColor") });
  if (errors.length) throw Error(errors.join('\n'));
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ label, revision: revision || cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), visible: win.isVisible(), focusable: win.isFocusable(), bounds: win.getBounds(), checks, errors }, null, 2));
  console.log(JSON.stringify(checks));
}
let exitCode = 0;
main().catch(e => { console.error(e); exitCode = 1; }).finally(() => {
  win?.destroy();
  fs.rmSync(profile, { recursive: true, force: true });
  app.exit(exitCode);
});
