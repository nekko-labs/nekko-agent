// Diagnostic only. Does not install a package or launch/attach a browser.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';

assert.equal(process.platform, 'win32', 'This probe checks the Windows TCP implementation only.');
assert.ok(process.argv[2] && process.argv[3], 'Usage: node scripts/agent-browser-ipc-probe.mjs <0.39.1-exe> <new-output.json>');
const binary = resolve(process.argv[2]);
const output = resolve(process.argv[3]);
assert.ok(!existsSync(output), 'Refusing to overwrite prior evidence.');
const binarySha256 = createHash('sha256').update(readFileSync(binary)).digest('hex');
assert.equal(binarySha256, 'af1ff5f2afd5c187fb50ac3bbc1e7114baadc180d67cef63f644af9031be5049', 'Expected the npm agent-browser@0.39.1 Windows x64 executable.');
const dir = mkdtempSync(join(tmpdir(), 'nekko-ab-probe-'));
const session = `nekko-probe-${randomBytes(12).toString('hex')}`;
// Do not inherit browser/provider/restore settings or the user home directory.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(SystemRoot|WINDIR|TEMP|TMP|PATH|PATHEXT)$/i.test(key)));
Object.assign(env, {
  AGENT_BROWSER_DAEMON: '1', AGENT_BROWSER_SESSION: session,
  AGENT_BROWSER_SOCKET_DIR: dir, AGENT_BROWSER_HOME: dir,
  AGENT_BROWSER_IDLE_TIMEOUT_MS: '10000',
  USERPROFILE: dir, HOME: dir, APPDATA: dir, LOCALAPPDATA: dir,
});
const child = spawn(binary, [], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
let stderr = '';
child.stderr.on('data', (b) => { stderr = (stderr + b).slice(-4000); });
const exited = new Promise((resolve, reject) => {
  child.once('exit', (code, signal) => resolve({ code, signal }));
  child.once('error', reject);
});
let report;
try {
  const portFile = join(dir, `${session}.port`);
  for (let i = 0; i < 100 && !existsSync(portFile) && child.exitCode === null; i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(existsSync(portFile), `No owned daemon port file. ${stderr}`);
  const port = Number(readFileSync(portFile, 'utf8'));
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
  const request = { id: 'untrusted-client', action: 'session_info' };
  const response = await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let text = '';
    socket.setTimeout(5000, () => socket.destroy(new Error('Probe timeout')));
    socket.on('error', reject);
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('data', (b) => {
      text += b;
      if (text.length > 65536) socket.destroy(new Error('Oversized response'));
      else if (text.includes('\n')) {
        socket.end();
        try { resolve(JSON.parse(text.split('\n')[0])); } catch (error) { reject(error); }
      }
    });
  });
  assert.equal(response.id, request.id);
  assert.equal(response.success, true);
  assert.equal(response.data.backgroundPid, child.pid, 'Never accept a response from another process.');
  assert.equal(response.data.session, session);
  assert.equal(response.data.socketDir, dir);
  assert.equal(response.data.browserLaunched, false);
  report = {
    at: new Date().toISOString(), platform: process.platform, node: process.version,
    binarySha256, packageVersion: '0.39.1',
    sourceTag: '1165952d74ceed98fdc2dd97190ad41f44dd0e24',
    upstreamMainChecked: 'dac13bb87468fe9d74a040d862720f6cc17a9565',
    pid: child.pid, request, response, authenticationSent: false, browserLaunched: false,
  };
} finally {
  if (child.exitCode === null) execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  await exited;
  rmSync(dir, { recursive: true, force: true });
}
report.cleanup = { ownedProcessTreeEnded: true, temporaryDirectoryRemoved: !existsSync(dir) };
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report, null, 2));
