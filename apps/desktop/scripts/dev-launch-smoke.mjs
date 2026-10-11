import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { prepareMacBundle } from './dev-launch.mjs';
import { seedDataDir } from '../../../scripts/perf/lib/seed.mjs';

if (!process.env.CI && process.env.NEKKO_VISIBLE_VERIFICATION !== '1') throw Error('Native branding/permission verification opens foreground windows. Run on a disposable CI desktop, or obtain explicit user approval before setting NEKKO_VISIBLE_VERIFICATION=1.');
if (process.platform !== 'darwin') throw Error('This smoke check requires macOS');
const out = resolve(process.argv[2] || 'native-smoke');
mkdirSync(out, { recursive: true });
const data = mkdtempSync(join(tmpdir(), 'nekko-native-smoke-'));
const entry = join(data, 'fixture');
mkdirSync(entry);
const require = createRequire(import.meta.url);
const electron = require('electron');
const original = readFileSync(resolve(electron, '../../Info.plist'));
const { launcher, bundle } = prepareMacBundle();
const plist = join(bundle, 'Contents/Info.plist');
const get = key => spawnSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], { encoding: 'utf8' }).stdout.trim();
if (get('CFBundleIdentifier') !== 'com.nekkoagent.desktop.dev' || get('CFBundleDisplayName') !== 'Nekko Agent') throw Error('Bundle identity mismatch');
if (spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'inherit' }).status !== 0) throw Error('Invalid bundle signature');
if (!original.equals(readFileSync(resolve(electron, '../../Info.plist')))) throw Error('Shared Electron runtime changed');
await build({ entryPoints: ['src/main/devLaunchProcess.ts'], outfile: join(entry, 'register.cjs'), bundle: true, platform: 'node', format: 'cjs' });
writeFileSync(join(entry, 'package.json'), JSON.stringify({ name: 'nekko-agent-native-fixture', main: 'index.cjs' }));
writeFileSync(join(entry, 'index.cjs'), `
const {app,BrowserWindow,Menu,systemPreferences}=require('electron');
const fs=require('node:fs'),path=require('node:path');
require('./register.cjs').registerDevLaunch(app);
app.setName('Nekko Agent');
app.setPath('userData',path.join(process.env.NEKKO_DATA_DIR,'desktop'));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:900,height:640,title:'Nekko Agent native verification'});
 await win.loadURL('data:text/html,<title>Nekko Agent</title><h1>Nekko Agent</h1><p>Isolated development bundle verification</p>');
 win.show();app.focus({steal:true});
 const report={name:app.getName(),execPath:process.execPath,userData:app.getPath('userData'),pid:process.pid,menu:Menu.getApplicationMenu()?.items.map(i=>i.label)};
 fs.writeFileSync(path.join(process.env.NEKKO_DATA_DIR,'report.json'),JSON.stringify(report));
 const timer=setInterval(()=>{if(!fs.existsSync(path.join(process.env.NEKKO_DATA_DIR,'request-mic')))return;clearInterval(timer);fs.writeFileSync(path.join(process.env.NEKKO_DATA_DIR,'permission-requested'),'microphone');void systemPreferences.askForMediaAccess('microphone');},100);
});
app.on('window-all-closed',()=>app.quit());
`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(check, label) { for (let i = 0; i < 150; i++) { if (check()) return; await sleep(100); } throw Error('Timeout: ' + label); }
const env = { ...process.env, NEKKO_DATA_DIR: data, NEKKO_DEV_OWNER: 'native-smoke' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
let child;
try {
  for (let launch = 0; launch < 2; launch++) {
    if (existsSync(join(data, 'report.json'))) writeFileSync(join(data, 'report.json'), 'null');
    child = spawn(launcher, [entry], { env, stdio: 'inherit' });
    let report;
    await waitFor(() => { try { report = JSON.parse(readFileSync(join(data, 'report.json'), 'utf8')); return !!report; } catch { return false; } }, 'native window');
    if (report.name !== 'Nekko Agent' || !report.execPath.startsWith(bundle) || !report.userData.startsWith(data)) throw Error('Native identity or isolated profile mismatch');
    writeFileSync(join(out, `launch-${launch}.json`), JSON.stringify(report, null, 2));
    if (launch === 1) {
      await sleep(1000);
      if (spawnSync('/usr/sbin/screencapture', ['-x', join(out, 'native-branding.png')]).status !== 0) throw Error('Native screenshot unavailable');
      writeFileSync(join(data, 'request-mic'), 'fixture only');
      await waitFor(() => existsSync(join(data, 'permission-requested')), 'permission request');
      await sleep(1500);
      if (spawnSync('/usr/sbin/screencapture', ['-x', join(out, 'native-permission.png')]).status !== 0) throw Error('Permission screenshot unavailable');
    }
    child.kill('SIGTERM');
    await waitFor(() => { try { process.kill(report.pid, 0); return false; } catch { return true; } }, 'owned app shutdown');
    await waitFor(() => child.exitCode !== null, 'wrapper shutdown');
    child = null;
  }
  // Exercise the actual main process and full renderer with an owned profile.
  const seeded = seedDataDir({ mockPort: 4591, chats: [10, 10] });
  const settingsFile = join(seeded.dir, 'settings.json');
  const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
  settings.commandWall = { root: { id: 'native_split', dir: 'row', sizes: [.5, .5], children: seeded.ids.map(id => ({ id: 'pane_' + id, kind: 'chat', refId: id })) }, autoAdd: false, filter: 'all', layout: { mode: 'grid', cols: 2, rows: 1 }, dock: { side: 'right', show: false, panels: {}, minimized: {} }, folded: {}, composer: { side: 'bottom', align: 'center' }, insights: { panels: {} }, watermark: Date.now() };
  writeFileSync(settingsFile, JSON.stringify(settings));
  const fullEntry = join(data, 'full-app'); mkdirSync(fullEntry);
  writeFileSync(join(fullEntry, 'package.json'), JSON.stringify({ name: 'nekko-agent-full-fixture', main: 'index.cjs' }));
  writeFileSync(join(fullEntry, 'index.cjs'), `
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path');
app.setAsDefaultProtocolClient=()=>false;
require(${JSON.stringify(resolve('out/main/index.js'))});
let checking=false;
const timer=setInterval(async()=>{
 if(checking)return;checking=true;
 try {
  const win=BrowserWindow.getAllWindows().find(w=>!w.isDestroyed());
  if(!win||win.webContents.isLoading())return;
  const ready=await win.webContents.executeJavaScript("!!document.querySelector('nav button[aria-label=\\\"Agents\\\"]')");
  if(!ready)return;
  clearInterval(timer);win.setBounds({x:40,y:50,width:940,height:700});win.show();app.focus({steal:true});
  await win.webContents.executeJavaScript("document.querySelector('nav button[aria-label=\\\"Agents\\\"]').click()");
  setTimeout(async()=>{
   const state=await win.webContents.executeJavaScript("({title:document.querySelector('h1')?.textContent,headerTop:document.querySelector('h1')?.getBoundingClientRect().top,headerLeft:document.querySelector('h1')?.getBoundingClientRect().left,inTitleBar:!!document.querySelector('.titlebar-mac h1'),text:document.body.innerText})");
   fs.writeFileSync(path.join(process.env.NEKKO_DATA_DIR,'native-full-state.json'),JSON.stringify({pid:process.pid,...state}));
   fs.writeFileSync(path.join(process.env.NEKKO_DATA_DIR,'native-full.png'),(await win.webContents.capturePage()).toPNG());
  },1500);
 }catch(error){fs.writeFileSync(path.join(process.env.NEKKO_DATA_DIR,'native-full-error.txt'),String(error));}finally{checking=false;}
},100);
`);
  child = spawn(launcher, [fullEntry], { env: { ...env, NEKKO_DATA_DIR: seeded.dir }, stdio: 'inherit' });
  await waitFor(() => existsSync(join(seeded.dir, 'native-full.png')), 'full Agents renderer');
  const fullState = JSON.parse(readFileSync(join(seeded.dir, 'native-full-state.json'), 'utf8'));
  // The heading sits in the app's own title strip, beside the traffic lights
  // (x 14..~66), so clearance is horizontal rather than below a native bar.
  if (fullState.title !== 'Agents' || !fullState.inTitleBar || fullState.headerLeft < 72) throw Error(`Native header clearance mismatch: ${JSON.stringify({ title: fullState.title, inTitleBar: fullState.inTitleBar, headerTop: fullState.headerTop, headerLeft: fullState.headerLeft })}`);
  writeFileSync(join(out, 'native-full-state.json'), JSON.stringify(fullState, null, 2));
  writeFileSync(join(out, 'native-full-renderer.png'), readFileSync(join(seeded.dir, 'native-full.png')));
  if (spawnSync('/usr/sbin/screencapture', ['-x', join(out, 'native-full-window.png')]).status !== 0) throw Error('Full native screenshot unavailable');
  child.kill('SIGTERM');
  await waitFor(() => { try { process.kill(fullState.pid, 0); return false; } catch { return true; } }, 'full app shutdown');
  await waitFor(() => child.exitCode !== null, 'full wrapper shutdown'); child = null;
  writeFileSync(join(out, 'result.json'), JSON.stringify({ signedIdentity: true, sharedRuntimeUnchanged: true, isolatedProfile: true, restart: true, shutdown: true, fullRenderer: true }, null, 2));
} finally { child?.kill('SIGTERM'); }
