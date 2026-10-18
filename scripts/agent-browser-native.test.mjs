import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
const root = fileURLToPath(new URL('../', import.meta.url));
const binary = resolve(root, `apps/desktop/resources/agent-browser/${process.platform}-${process.arch}/agent-browser${process.platform === 'win32' ? '.exe' : ''}`);
assert.ok(existsSync(binary), 'Run node scripts/build-agent-browser.mjs first');
const capability = randomBytes(32).toString('hex');
const hello = JSON.stringify({ type: 'hello', protocol: 1, capability }) + '\n';
const request = (command, token = capability) => JSON.stringify({ type: 'request', capability: token, command }) + '\n';
function launch(args = []) {
  const home = mkdtempSync(join(tmpdir(), 'nekko-native-test-'));
  const child = spawn(binary, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, AGENT_BROWSER_DAEMON: '1', AGENT_BROWSER_STREAM_PORT: '9223', AGENT_BROWSER_PROVIDER: 'browserbase', AGENT_BROWSER_HOME: home, AGENT_BROWSER_SOCKET_DIR: home } });
  let stdout = '', stderr = '';
  child.stdout.on('data', b => { stdout += b; });
  child.stderr.on('data', b => { stderr += b; });
  child.stdin.on('error', () => {});
  const exit = new Promise((res, rej) => { child.once('error', rej); child.once('close', code => res(code)); });
  return { child, home, exit, get stdout() { return stdout; }, get stderr() { return stderr; } };
}
async function exercise(input, { args = [], code = 2, check } = {}) {
  const p = launch(args);
  const timer = setTimeout(() => p.child.kill(), 10000);
  try {
    p.child.stdin.end(input);
    assert.equal(await p.exit, code, p.stderr);
    const frames = p.stdout.trim() ? p.stdout.trim().split('\n').map(s => JSON.parse(s)) : [];
    assert.ok(!p.stdout.includes(capability), 'Never echo authentication capability');
    check?.(frames);
    assert.deepEqual(readdirSync(p.home), [], 'No daemon/socket/session artifacts');
  } finally { clearTimeout(timer); if (p.child.exitCode === null) p.child.kill(); await p.exit; rmSync(p.home, { recursive: true, force: true }); }
}
test('valid hello, session_info, strict allowlist, no implicit launch', async () => {
  const commands = [
    { id: 'info', action: 'session_info' },
    { id: 'missing', action: 'title' },
    { id: 'local', action: 'launch' },
    { id: 'provider', action: 'launch', cdpUrl: 'http://127.0.0.1:1', provider: 'browserbase' },
    { id: 'extra', action: 'session_info', plugins: [] },
    { id: 'batch', action: 'batch', commands: [] },
    { id: 'stream', action: 'stream_start' },
    { id: 'inspect', action: 'inspect' },
    { id: 'badurl', action: 'launch', cdpUrl: 'file:///x' },
  ];
  await exercise(hello + commands.map(c => request(c)).join(''), { code: 0, check(frames) {
    assert.deepEqual(frames[0], { type: 'ready', protocol: 1 });
    assert.equal(frames.length, commands.length + 1);
    assert.equal(frames[1].success, true);
    assert.equal(frames[1].data.browserLaunched, false);
    for (const frame of frames.slice(2)) assert.equal(frame.success, false, JSON.stringify(frame));
    assert.equal(frames[2].error, 'external_cdp_required');
  } });
});
test('authentication and malformed framing fail closed', async () => {
  for (const input of ['', '{}\n', '{\n', '[]\n', hello.slice(0, -1), 'x'.repeat(1048577) + '\n', hello + request({ id: 'x', action: 'session_info' }, '0'.repeat(64)), hello + '{\n', hello + request([{ action: 'session_info' }]) + '{\n', JSON.stringify({ type: 'hello', protocol: 1, capability, extra: true }) + '\n']) {
    await exercise(input);
  }
});
test('all argv rejected, including original CLI and daemon modes', async () => {
  for (const args of [['--help'], ['--version'], ['open', 'https://example.com'], ['--daemon'], ['--stdio'], ['--stream-port', '9223']]) await exercise(hello, { args, check: frames => assert.deepEqual(frames, []) });
});
test('inherited stdin stays open without starting a TCP listener', async () => {
  const p = launch();
  try {
    p.child.stdin.write(hello);
    await new Promise(r => setTimeout(r, 500));
    assert.equal(p.child.exitCode, null);
    if (process.platform === 'win32') {
      const listeners = execFileSync('powershell', ['-NoProfile', '-Command', `$ErrorActionPreference='Stop'; @(Get-NetTCPConnection -State Listen | Where-Object OwningProcess -eq ${p.child.pid}).Count`], { encoding: 'utf8' }).trim();
      assert.equal(listeners, '0');
    } else if (process.platform === 'linux') {
      const sockets = readdirSync(`/proc/${p.child.pid}/fd`).filter(fd => { try { return execFileSync('readlink', [`/proc/${p.child.pid}/fd/${fd}`], { encoding: 'utf8' }).startsWith('socket:'); } catch { return false; } });
      assert.deepEqual(sockets, []);
    } else {
      const result = spawnSyncLsof(p.child.pid);
      assert.equal(result, '', 'No listening TCP socket');
    }
    p.child.stdin.end();
    assert.equal(await p.exit, 0, p.stderr);
  } finally { if (p.child.exitCode === null) p.child.kill(); await p.exit; rmSync(p.home, { recursive: true, force: true }); }
});
function spawnSyncLsof(pid) {
  try { return execFileSync('lsof', ['-Pan', '-p', String(pid), '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' }).trim(); }
  catch (error) { if (error.status === 1) return ''; throw error; }
}
