import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

// Only owned fixture windows and a temporary profile. Never captures user apps.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const out = resolve(process.argv[2] ?? join(root, '.shots/capture-smoke'));
mkdirSync(out, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'nekko-capture-smoke-'));
const entry = join(profile, 'capture.cjs');
const require = createRequire(import.meta.url);
const electron = require('electron');
const native = process.argv.includes('--native');
const source = String.raw`
import { app, BrowserWindow, screen } from 'electron';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { startAgentBrowser } from ${JSON.stringify(join(root, 'apps/desktop/src/main/agentBrowser.ts'))};
import { captureWindow } from ${JSON.stringify(join(root, 'apps/desktop/src/main/windowCapture.ts'))};
app.setPath('userData', ${JSON.stringify(profile)});
// The temporary bundled entry is not the desktop app root. Resolve staged native
// resources from the real desktop path, just as an unpackaged app launch does.
app.setAppPath(${JSON.stringify(join(root, 'apps/desktop'))});
const out = ${JSON.stringify(out)};
const native = ${native};
const pause = ms => new Promise(r => setTimeout(r, ms));
function foreground() {
  if (process.platform !== 'win32') return null;
  const command = 'Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public class CaptureForeground { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); }\'; [CaptureForeground]::GetForegroundWindow().ToInt64()';
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', command], { windowsHide: true }).toString().trim();
}
app.whenReady().then(async () => {
  let bridge, target, server;
  const result = { platform: process.platform, nativeRequested: native };
  try {
    const before = foreground();
    server = createServer((_req, res) => { res.writeHead(200, {'Content-Type':'text/html'}); res.end('<html><head><title>Capture fixture</title></head><body style="background:#142338;color:#fff;font:24px sans-serif;padding:36px"><h1>Background capture</h1><input id="input" value="untouched"><button id="button" onclick="document.querySelector(\'#status\').textContent=\'Clicked without OS input\'">Test</button><p id="status">Ready</p></body></html>'); });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const url = 'http://127.0.0.1:' + server.address().port;
    bridge = await startAgentBrowser();
    process.env.NEKKO_BROWSER_URL = bridge.url;
    process.env.NEKKO_BROWSER_TOKEN = bridge.token;
    const post = async input => {
      const response = await fetch(bridge.url, {method:'POST', headers:{Authorization:'Bearer '+bridge.token,'Content-Type':'application/json'},body:JSON.stringify({sessionId:'fixture',...input})});
      const body = await response.json(); if(!response.ok) throw new Error(body.error); return body;
    };
    await post({action:'navigate',url});
    const owned = BrowserWindow.getAllWindows()[0];
    let activations = 0; owned.on('focus', () => activations++); owned.on('show', () => activations++);
    await post({action:'fill',selector:'#input',value:'Background fill'});
    await post({action:'click',selector:'#button'});
    await owned.webContents.executeJavaScript("window.focus(); alert('This dialog must be suppressed');");
    await pause(500);
    const listed = await post({tool:'capture',action:'list'});
    const id = listed.windows.find(w => w.id.startsWith('nekko:')).id;
    const screenshot = await post({tool:'capture',action:'screenshot',window_id:id});
    writeFileSync(join(out,'hidden-owned.png'),Buffer.from(screenshot.data,'base64'));
    if(owned.isVisible() || owned.isFocused() || activations) throw new Error('Background actions surfaced the owned window');
    if(!screenshot.width || !screenshot.height || screenshot.source !== 'owned-page') throw new Error('Invalid hidden screenshot');
    result.hiddenOwned = {width:screenshot.width,height:screenshot.height,source:screenshot.source,visible:owned.isVisible(),focused:owned.isFocused(),activations,dialogSuppressed:true,focusable:process.platform==='linux'?null:owned.isFocusable()};
    // Host tools check the chat's execution mode, so the fixture chat must
    // exist as a normal (host) session in a throwaway data dir.
    const { setDataDir } = await import(${JSON.stringify(pathToFileURL(join(root, 'packages/host/dist/paths.js')).href)});
    const { createSession, saveSession } = await import(${JSON.stringify(pathToFileURL(join(root, 'packages/host/dist/sessions.js')).href)});
    setDataDir(join(out, 'host-data'));
    saveSession({ ...createSession(), id: 'fixture' });
    const { executeTool } = await import(${JSON.stringify(pathToFileURL(join(root, 'packages/host/dist/tools.js')).href)});
    const transported = await executeTool({id:'shot',name:'capture',input:{action:'screenshot',window_id:id,path:'hidden-transport.png'}}, {settings:{sandboxMode:'workspace-jail',workspaces:[{path:out}]},defaultCwd:out,sessionId:'fixture',allowBrowserControl:true,requestApproval:async (_call,reason) => { if(!reason.includes('selected chat model')) throw new Error('Missing disclosure'); return true; }});
    if(transported.isError || !transported.images?.[0]?.startsWith('data:image/png;base64,')) throw new Error('Screenshot pixels did not reach tool result');
    const { OpenAICompatProvider } = await import(${JSON.stringify(pathToFileURL(join(root, 'packages/core/dist/providers/openai-compat.js')).href)});
    let request;
    const model = createServer(async (req,res) => {
      const chunks=[]; for await(const chunk of req) chunks.push(chunk);
      request=JSON.parse(Buffer.concat(chunks).toString());
      res.writeHead(200,{'Content-Type':'text/event-stream'});
      res.end('data: {"choices":[{"delta":{"content":"Fixture response"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
    await new Promise(r=>model.listen(0,'127.0.0.1',r));
    try {
      const provider=new OpenAICompatProvider({id:'fixture',kind:'openai-compat',enabled:true,baseUrl:'http://127.0.0.1:'+model.address().port+'/v1'});
      const messages=[{id:'a',role:'assistant',content:'',createdAt:1,toolCalls:[{id:'shot',name:'capture',input:{}}]},{id:'t',role:'tool',content:'',createdAt:2,toolResult:transported}];
      for await(const _ of provider.chat({model:'fixture',messages})) {}
      const image=request.messages.flatMap(m=>Array.isArray(m.content)?m.content:[]).find(c=>c.type==='image_url');
      if(image?.image_url?.url !== transported.images[0]) throw new Error('Provider did not receive exact captured pixels');
      result.pixelTransport={approvedDisclosure:true,modelReceivedExactPixels:true,bytes:Buffer.from(transported.images[0].split(',')[1],'base64').length,liveInference:false};
    } finally { model.close(); }
    if(native) {
      target = new BrowserWindow({width:600,height:400,x:Math.min(...screen.getAllDisplays().map(d=>d.bounds.x))-800,y:Math.min(...screen.getAllDisplays().map(d=>d.bounds.y))-600,show:false,focusable:false,skipTaskbar:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
      await target.loadURL(url); target.showInactive(); await pause(500);
      const windows = await captureWindow('native-fixture',{action:'list'});
      const selection = windows.windows.find(w => w.id === target.getMediaSourceId());
      if(!selection) throw new Error('Owned native fixture was not enumerated by the OS');
      const shot = await captureWindow('native-fixture',{action:'screenshot',window_id:selection.id},url);
      writeFileSync(join(out,'native-window.png'),Buffer.from(shot.data,'base64'));
      result.nativeWindow={source:shot.source,width:shot.width,height:shot.height,focused:target.isFocused(),bounds:target.getBounds()};
      if(target.isFocused() || shot.source !== 'native-window') throw new Error('Native capture changed focus or provenance');
      const clip = await captureWindow('native-fixture',{action:'record',window_id:selection.id,seconds:1},url);
      if (clip.mime !== 'video/webm' || !clip.data || !clip.width || !clip.height) throw new Error('Selected window recording failed');
      writeFileSync(join(out,'native-window.webm'),Buffer.from(clip.data,'base64'));
      result.nativeRecording={mime:clip.mime,width:clip.width,height:clip.height,bytes:Buffer.from(clip.data,'base64').length};
      target.hide();
    }
    const after = foreground();
    result.foreground = { before, after, unchanged: before === null ? null : before === after };
    if(before !== after) throw new Error('Foreground window changed during capture');
    result.passed = true;
  } catch(error) { result.passed=false; result.error=error.stack; process.exitCode=1; }
  finally {
    writeFileSync(join(out,'result.json'),JSON.stringify(result,null,2));
    target?.destroy(); bridge?.close(); server?.close(); app.quit();
  }
});
`;
// playwright-core (behind agentBrowser.ts) reads its own files at runtime and
// must not be bundled; require it from this checkout's node_modules instead.
const playwrightCore = require.resolve('playwright-core', { paths: [join(root, 'apps/desktop')] });
await build({ stdin: { contents: source, resolveDir: root, loader: 'ts' }, outfile: entry, bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'file:*'],
  plugins: [{ name: 'playwright-core-external', setup(b) { b.onResolve({ filter: /^playwright-core$/ }, () => ({ path: playwrightCore, external: true })); } }] });
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [entry], { env, windowsHide: true, stdio: 'inherit' });
const timer = setTimeout(() => child.kill(), 60_000);
const code = await new Promise(r => child.once('exit', r)); clearTimeout(timer);
const result = JSON.parse(readFileSync(join(out, 'result.json'), 'utf8'));
console.log(JSON.stringify(result, null, 2));
if (code || !result.passed) process.exitCode = 1;
