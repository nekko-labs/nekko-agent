// Exercises the MCP streamable-HTTP transport against a Hypergate daemon
// (hypergated): detects the gateway, adds a scratch echo server through the
// daemon API, connects Nekko Agent's host MCP client to the gateway URL, and
// lists + calls a tool through it, then proves a wrong token is refused.
//
// Two ways to run it:
//   node scripts/itest-mcp-http.mjs [daemonBase]
//     against a hypergated you already run (default http://localhost:7777).
//     It adds and then deletes one scratch server, `op-itest-echo`.
//   node scripts/itest-mcp-http.mjs --spawn [path/to/hypergate]
//     starts its own hypergated from a hypergate checkout (default
//     ../hypergate, built: `npm ci` there) on a free loopback port with a
//     temporary HYPERGATE_DIR and HOME, no keychain, and ends its whole process
//     tree afterwards. This is what CI runs; it never touches a real
//     ~/.hypergate or a running daemon.
//
// Exits non-zero on any failure, including a daemon that never comes up.
// Needs `npm run build:web` (or at least @nekko-agent/host built).
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const args = process.argv.slice(2);
const spawnMode = args[0] === '--spawn';
const hypergateDir = resolve(spawnMode ? (args[1] ?? '../hypergate') : '../hypergate');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scratch = mkdtempSync(join(tmpdir(), 'op-mcp-itest-'));

let daemon = null;
let daemonOut = '';
let base = args[0] && !spawnMode ? args[0] : 'http://localhost:7777';
let token = '';

const killTree = (p) => {
  if (!p?.pid || p.exitCode !== null) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-p.pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
};
const cleanup = async () => {
  killTree(daemon);
  await sleep(300);
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* a child may still hold a file */ }
};
const fail = async (message) => {
  console.error(`FAIL ${message}`);
  if (daemonOut) console.error(daemonOut.slice(-3000));
  await cleanup();
  process.exit(1);
};

const freePort = () =>
  new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });

try {
  if (spawnMode) {
    const entry = join(hypergateDir, 'apps/daemon/src/index.ts');
    if (!existsSync(entry)) await fail(`no hypergate checkout at ${hypergateDir} (expected ${entry})`);
    const port = await freePort();
    token = randomBytes(24).toString('hex');
    const home = join(scratch, 'home');
    base = `http://localhost:${port}`;
    daemon = spawn(process.execPath, ['--experimental-strip-types', entry], {
      cwd: hypergateDir,
      env: {
        ...process.env,
        HYPERGATE_PORT: String(port),
        HYPERGATE_DIR: join(scratch, 'hypergate'),
        HYPERGATE_TOKEN: token,
        HYPERGATE_NO_KEYCHAIN: '1',
        HYPERGATE_STDIO_PROXY: '0',
        HOME: home,
        USERPROFILE: home,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Its own process group on Unix, so the whole tree can be killed.
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    daemon.stdout.on('data', (d) => (daemonOut += d));
    daemon.stderr.on('data', (d) => (daemonOut += d));
  }

  let health = null;
  for (let i = 0; i < (spawnMode ? 120 : 1) && health?.service !== 'hypergated'; i++) {
    health = await fetch(`${base}/health`).then((r) => r.json(), () => null);
    if (health?.service !== 'hypergated') {
      if (daemon && daemon.exitCode !== null) await fail(`hypergated exited with ${daemon.exitCode}`);
      if (spawnMode) await sleep(250);
    }
  }
  if (health?.service !== 'hypergated') {
    await fail(spawnMode ? `hypergated never answered at ${base}` : `No hypergated at ${base}: start it (npm run daemon in hypergate) and retry.`);
  }
  const auth = token ? { authorization: `Bearer ${token}` } : {};
  const gw = await (await fetch(`${base}/api/gateway`, { headers: auth })).json();
  console.log(`gateway: ${gw.url} (daemon v${health.version})`);

  // Give the gateway something to aggregate: hypergate's echo fixture.
  const echoPath = join(hypergateDir, 'packages/core/src/fixtures/echo-server.mjs');
  await fetch(`${base}/api/servers/op-itest-echo`, { method: 'DELETE', headers: auth }).catch(() => {});
  const added = await (await fetch(`${base}/api/servers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({ id: 'op-itest-echo', name: 'itest echo', runtime: 'process', command: process.execPath, args: [echoPath], enabled: true }),
  })).json();
  if (added.state !== 'ready') await fail(`echo server not ready: ${JSON.stringify(added)}`);

  // The host and its MCP client from this checkout's packages/host/dist: the
  // tool call below must read the same module state the host's sync filled.
  // (`@nekko-agent/host` resolves through node_modules, which in a worktree
  // can be another checkout's build, a second copy with its own state.)
  const { createHost } = await import('../packages/host/dist/index.js');
  const { callMcpTool } = await import('../packages/host/dist/mcp.js');
  const host = createHost({ dataDir: join(scratch, 'host') });
  await host.updateSettings({
    mcpServers: [{ id: 'hypergate', name: 'Hypergate gateway', command: '', args: [], url: gw.url, token: gw.token, enabled: true }],
  });

  const status = await host.mcpStatus();
  const gwStatus = status.find((s) => s.id === 'hypergate');
  console.log(`status: connected=${gwStatus?.connected} tools=${gwStatus?.tools.length} err=${gwStatus?.error ?? '-'}`);
  const echoTool = gwStatus?.tools.find((t) => t.name === 'op-itest-echo__echo');

  // Call the tool through the agent tool-routing path.
  const result = await callMcpTool({ id: 't1', name: 'mcp__hypergate__op-itest-echo__echo', input: { text: 'paw-to-paw' } });
  console.log(`tool call: isError=${result.isError} output=${JSON.stringify(result.output)}`);

  // Also prove a bad token is rejected.
  await host.updateSettings({
    mcpServers: [{ id: 'bad', name: 'bad token', command: '', args: [], url: gw.url, token: 'wrong', enabled: true }],
  });
  const bad = (await host.mcpStatus()).find((s) => s.id === 'bad');
  console.log(`bad-token status: connected=${bad?.connected} err=${bad?.error ?? '-'}`);
  // Drop the host's MCP connections so nothing keeps this process alive.
  await host.updateSettings({ mcpServers: [] });
  await host.mcpStatus();

  await fetch(`${base}/api/servers/op-itest-echo`, { method: 'DELETE', headers: auth }).catch(() => {});

  const pass = gwStatus?.connected && echoTool && !result.isError && result.output === 'paw-to-paw' && bad && !bad.connected;
  console.log(`\n${pass ? 'MCP HTTP TRANSPORT PASS' : 'FAIL'}`);
  await cleanup();
  process.exit(pass ? 0 : 1);
} catch (e) {
  await fail(e instanceof Error ? e.stack ?? e.message : String(e));
}
