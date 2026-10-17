// Real-Electron smoke test for the Playwright-backed agent browser.
//
//   node apps/desktop/scripts/browser-automation-smoke.mjs [outDir]
//
// Runs hidden: owned windows only, never shown or focused, a throwaway
// --user-data-dir that is deleted afterwards, and the Electron process tree is
// killed on exit. Set NEKKO_SMOKE_ELECTRON to an electron binary when this
// checkout has no downloaded Electron (for example a fresh worktree).
import { build } from 'esbuild';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv[2] ?? join(root, '.shots/browser-automation-smoke'));
mkdirSync(out, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), 'nekko-browser-smoke-'));
const profile = join(scratch, 'profile');
const entry = join(scratch, 'smoke.cjs');
const require = createRequire(import.meta.url);
const electron = process.env.NEKKO_SMOKE_ELECTRON || require('electron');
const playwrightCore = require.resolve('playwright-core', { paths: [join(root, 'apps/desktop')] });

const source = String.raw`
import { app, BrowserWindow } from 'electron';
import { createServer } from 'node:http';
import { existsSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createNativeDriver } from ${JSON.stringify(join(root, 'apps/desktop/src/main/agentNativeDriver.ts'))};
const nativeDriver = () => createNativeDriver(${JSON.stringify(join(root, 'apps/desktop/resources/agent-browser', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'agent-browser.exe' : 'agent-browser'))});
import { startAgentBrowser } from ${JSON.stringify(join(root, 'apps/desktop/src/main/agentBrowser.ts'))};
import { AgentCdpTransport } from ${JSON.stringify(join(root, 'apps/desktop/src/main/agentCdpTransport.ts'))};
const out = ${JSON.stringify(out)};
const profile = ${JSON.stringify(profile)};
app.setPath('userData', profile);
function foreground() {
  if (process.platform !== 'win32') return null;
  const command = 'Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public class SmokeForeground { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); }\'; [SmokeForeground]::GetForegroundWindow().ToInt64()';
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', command], { windowsHide: true }).toString().trim();
}
const page = (title, body) => '<!doctype html><html><head><title>' + title + '</title></head><body style="font:16px sans-serif">' + body + '</body></html>';
const fixture = page('Smoke fixture', [
  '<h1>Agent browser smoke</h1>',
  '<form id="form" onsubmit="event.preventDefault(); document.querySelector(\'#status\').textContent = \'Submitted \' + document.querySelector(\'#name\').value;">',
  '<input id="name" value=""><button id="go" type="button" onclick="document.querySelector(\'#status\').textContent=\'Clicked\'">Go</button></form>',
  '<p id="status">Ready</p>',
  '<a href="/second">Second page</a> <a href="https://example.com/">Example</a>',
  '<div id="late"></div>',
  '<div style="height:4000px"></div><p id="bottom">Bottom of page</p>',
  '<script>console.error("fixture console error"); fetch("/missing"); setTimeout(() => { document.querySelector("#late").textContent = "Arrived late"; }, 700);</script>',
].join(''));
app.whenReady().then(async () => {
  const result = { platform: process.platform, versions: process.versions, driver: 'native-candidate-experimental', revision: '4fc3cc5c', samples: {cold: [], warm: []}, steps: {} };
  let bridge, server, ui;
  try {
    const before = foreground();
    server = createServer((req, res) => {
      if (req.url === '/missing') { res.writeHead(404); res.end('missing'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(req.url === '/second' ? page('Second page', '<p>Second tab content</p>') : fixture);
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const url = 'http://127.0.0.1:' + server.address().port + '/';
    // Stands in for the Nekko UI: a window the agent must never reach.
    ui = new BrowserWindow({ show: false, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, partition: 'smoke-ui' } });
    await ui.loadURL('data:text/html,<title>Nekko UI stand-in</title><button id="approve">Approve</button>');
    bridge = await startAgentBrowser({driver: nativeDriver});
    const post = async (input, expectError) => {
      const response = await fetch(bridge.url, { method: 'POST', headers: { Authorization: 'Bearer ' + bridge.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'smoke', ...input }) });
      const body = await response.json();
      if (expectError ? response.ok : !response.ok) throw new Error(input.action + ': ' + (body.error ?? 'unexpected success ' + JSON.stringify(body).slice(0, 200)));
      return body;
    };
    const step = async (name, input, check) => {
      const t = Date.now();
      const body = await post(input, false);
      if (check && !check(body)) throw new Error(name + ' failed its check: ' + JSON.stringify(body).slice(0, 400));
      result.steps[name] = { ms: Date.now() - t, output: String(body.output).slice(0, 160) };
      return body;
    };
    for (let i=0; i<20; i++) { const start=performance.now(); await post({action:'navigate',url}); result.samples.cold.push(performance.now()-start); await post({action:'close'}); }
    await step('navigate', { action: 'navigate', url }, b => b.output.startsWith('Smoke fixture'));
    for (let i=0; i<20; i++) { const start=performance.now(); await post({action:'inspect'}); result.samples.warm.push(performance.now()-start); }
    result.memory = app.getAppMetrics();
    result.fixture = {url, outer:[1100,760], theme:'light', sampleMeaning:{cold:'new chat driver and renderer through navigation',warm:'inspect existing loaded fixture'}};
    const owned = BrowserWindow.getAllWindows().find(w => w !== ui);
    let activations = 0; owned.on('focus', () => activations++); owned.on('show', () => activations++);
    await step('fill', { action: 'fill', selector: '#name', value: 'Nekko' }, b => b.output === 'Field filled.');
    await step('click', { action: 'click', selector: '#go' }, b => b.output.includes('Clicked'));
    await step('wait', { action: 'wait', text: 'Arrived late', timeout_ms: 5000 }, b => b.output.includes('visible'));
    await step('pressEnd', { action: 'press', selector: '#name', key: 'End' }, b => b.output === 'Pressed End.');
    await step('type', { action: 'type', text: ' Agent' }, b => b.output.includes('Typed 6') && b.output.includes('focused element'));
    await step('press', { action: 'press', selector: '#name', key: 'Enter' });
    await step('evaluate', { action: 'evaluate', expression: 'document.querySelector("#status").textContent' }, b => b.output === 'Submitted Nekko Agent');
    await step('scroll', { action: 'scroll', direction: 'down', amount: 800 }, b => /y=8\d\d/.test(b.output));
    await step('scrollIntoView', { action: 'scroll', selector: '#bottom' }, b => !/y=0 /.test(b.output));
    await step('extractText', { action: 'extract', selector: '#status' }, b => b.output === 'Submitted Nekko Agent');
    await step('extractLinks', { action: 'extract', what: 'links' }, b => b.output.includes('Second page (' + url + 'second)'));
    await step('scrollTop', { action: 'scroll', direction: 'up', amount: 20000 }, b => /y=0 /.test(b.output));
    const shot = await step('screenshot', { action: 'screenshot' }, b => b.image?.mime === 'image/png' && b.image.data.length > 1000 && !b.output.includes(b.image.data.slice(0, 40)));
    writeFileSync(join(out, 'agent-page.png'), Buffer.from(shot.image.data, 'base64'));
    await step('logs', { action: 'logs' }, b => b.output.includes('fixture console error') && b.output.includes('404'));
    await step('logsDrained', { action: 'logs' }, b => b.output.startsWith('No console'));
    await step('tabNew', { action: 'tab_new', url: url + 'second' }, b => b.output.startsWith('Second page'));
    await step('tabs', { action: 'tabs' }, b => b.output.includes('[0]') && b.output.includes('* [1]'));
    await step('tabSwitch', { action: 'tab_switch', tab: 0 }, b => b.output.includes('* [0]'));
    await step('inspectAfterSwitch', { action: 'inspect' }, b => b.output.startsWith('Smoke fixture'));
    await step('tabClose', { action: 'tab_close', tab: 1 }, b => b.output.includes('Closed tab 1') && !b.output.includes('[1]'));
    await step('waitAttached', { action: 'wait', selector: '#name', state: 'attached', timeout_ms: 1000 });
    await step('waitHidden', { action: 'wait', selector: '#absent', state: 'hidden', timeout_ms: 1000 });
    await step('waitDetached', { action: 'wait', selector: '#absent', state: 'detached', timeout_ms: 1000 });
    await post({action:'evaluate', expression: "for(let i=1;i<=2;i++){let b=document.createElement('button');b.className='duplicate';b.textContent='Duplicate '+i;b.onclick=()=>window.duplicate=i;document.body.append(b)};true"});
    await step('firstMatch', {action:'click', selector:'.duplicate'});
    await step('firstMatchResult', {action:'evaluate', expression:'window.duplicate'}, b => b.output === '1');
    await post({action:'evaluate', expression:'setTimeout(() => { throw new Error("parity-page-error") }, 0); true'});
    await new Promise(r => setTimeout(r, 100));
    await step('pageError', {action:'logs'}, b => b.output.includes('parity-page-error'));
    await step('popupDenied', {action:'evaluate', expression:'window.open("about:blank") === null'}, b => b.output === 'true');
    await step('permissionsDenied', {action:'evaluate', expression:'navigator.permissions.query({name:"notifications"}).then(p=>p.state)'}, b => b.output === 'denied');
    const countBeforeDialog = BrowserWindow.getAllWindows().length;
    await step('dialogDisabled', {action:'evaluate', expression:'alert("must not show"); "returned"'}, b => b.output === 'returned');
    if (BrowserWindow.getAllWindows().length !== countBeforeDialog) throw new Error('Popup or dialog window appeared');
    // Guardrails that must hold through the native adapter as well.
    await post({ action: 'navigate', url: 'file:///C:/Windows/win.ini' }, true);
    const denied = await post({ action: 'evaluate', expression: 'location.href = "file:///C:/Windows/win.ini"; 1' }, false);
    await new Promise(r => setTimeout(r, 300));
    const still = await post({ action: 'evaluate', expression: 'location.protocol' });
    if (still.output !== 'http:') throw new Error('Page escaped to ' + still.output);
    result.steps.fileNavigationBlocked = true;
    // Isolation: the in-process transport never touches the UI window, and
    // there is no remote-debugging port anywhere.
    result.security = {
      uiDebuggerAttached: ui.webContents.debugger.isAttached(),
      remoteDebuggingSwitch: app.commandLine.hasSwitch('remote-debugging-port') || app.commandLine.hasSwitch('remote-debugging-pipe'),
      devToolsActivePortFile: existsSync(join(profile, 'DevToolsActivePort')),
    };
    if (result.security.uiDebuggerAttached || result.security.remoteDebuggingSwitch || result.security.devToolsActivePortFile) throw new Error('Isolation check failed');
    // A raw transport sees only the windows given to it, and refuses to reach any other target.
    result.stage = 'raw transport';
    const { chromium } = require('playwright-core');
    const transport = new AgentCdpTransport({ product: 'Chrome/' + process.versions.chrome, userAgent: app.userAgentFallback, createTarget: async () => { throw new Error('no'); }, closeTarget: () => {} });
    result.stage = 'raw connect';
    const browser = await chromium.connectOverCDP(transport);
    result.stage = 'raw connected';
    const pages = browser.contexts()[0].pages().length;
    let cdpSessionRefused = false;
    try { await browser.newBrowserCDPSession(); } catch { cdpSessionRefused = true; }
    await browser.close();
    result.security.rawTransportPages = pages;
    result.security.browserCdpSessionRefused = cdpSessionRefused;
    if (pages !== 0 || !cdpSessionRefused) throw new Error('Raw transport exposed other targets');
    result.hidden = { visible: owned.isDestroyed() ? false : owned.isVisible(), focused: owned.isDestroyed() ? false : owned.isFocused(), activations };
    if (result.hidden.visible || result.hidden.focused || activations) throw new Error('Agent window surfaced');
    await step('close', { action: 'close' }, b => b.output === 'In-app browser closed.');
    await new Promise(r => setTimeout(r, 300));
    result.windowsAfterClose = BrowserWindow.getAllWindows().filter(w => w !== ui).length;
    if (result.windowsAfterClose) throw new Error('Agent windows left open after close');
    const after = foreground();
    result.foreground = { unchanged: before === null ? null : before === after };
    if (before !== after) throw new Error('Foreground window changed');
    result.passed = true;
  } catch (error) { result.passed = false; result.error = String(error && error.stack || error); process.exitCode = 1; }
  finally {
    writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2));
    bridge?.close(); server?.close(); ui?.destroy(); app.exit(process.exitCode ?? 0);
  }
});
`;

await build({
  stdin: { contents: source, resolveDir: root, loader: 'ts' }, outfile: entry, bundle: true, platform: 'node', format: 'cjs', logLevel: 'error',
  external: ['electron'],
  plugins: [{ name: 'playwright-core-external', setup(b) { b.onResolve({ filter: /^playwright-core$/ }, () => ({ path: playwrightCore, external: true })); } }],
});
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [entry, `--user-data-dir=${profile}`], { env, windowsHide: true, stdio: 'inherit' });
const killTree = () => {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else child.kill('SIGKILL');
};
const timer = setTimeout(killTree, 120_000);
const code = await new Promise((r) => child.once('exit', r));
clearTimeout(timer);
killTree();
let result = { passed: false, error: 'No result written' };
try { result = JSON.parse(readFileSync(join(out, 'result.json'), 'utf8')); } catch { /* reported below */ }
if (!process.env.NEKKO_SMOKE_KEEP) rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
console.log(JSON.stringify(result, null, 2));
if (code || !result.passed) process.exitCode = 1;
