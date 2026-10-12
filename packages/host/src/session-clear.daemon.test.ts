import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { expect, it } from 'vitest';
import { createDispatcher } from './dispatch.js';
import type { Host } from './host.js';
import { setDataDir } from './paths.js';
import { agentLogPath, appendAgentLog, flushAgentLogs, readAgentLog } from './agent-log.js';

it('real daemon awaits real host log queue before deleting or clearing JSON', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nekko-clear-daemon-'));
  setDataDir(dir);
  mkdirSync(join(dir, 'sessions'));
  const dispatch = createDispatcher({} as Host);
  const callbacks: string[] = [];
  const token = 'isolated-daemon-test-token';
  const server = createServer(async (req, res) => {
    try {
      // This fixture serves authenticated POST callbacks, not the event socket.
      if (req.method !== 'POST') { res.writeHead(404).end(); return; }
      expect(req.headers.authorization).toMatch(/^Bearer .+/);
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const { args } = JSON.parse(Buffer.concat(chunks).toString());
      const channel = decodeURIComponent(req.url!.slice('/api/'.length));
      if (channel === 'sessions:deleteAgentLog') {
        const id = args[0] as string;
        callbacks.push(id);
        // JSON must still exist when the callback starts. Queue writes here,
        // without draining them, to deterministically overlap unlink and append.
        expect(existsSync(join(dir, 'sessions', `${id}.json`))).toBe(true);
        for (let i = 0; i < 100; i++) appendAgentLog(id, `queued-${i}\n`);
        const removal = dispatch(channel, args);
        appendAgentLog(id, 'racing-late-output');
        await removal;
        expect(existsSync(agentLogPath(id))).toBe(false);
        expect(existsSync(join(dir, 'sessions', `${id}.json`))).toBe(true);
      } else if (channel !== 'settings:get') throw new Error(`Unexpected channel: ${channel}`);
      res.setHeader('content-type', 'application/json');
      res.end(channel === 'settings:get' ? '{"workspaces":[]}' : 'null');
    } catch (error) {
      console.error('Isolated daemon callback harness failed:', error);
      res.statusCode = 400;
      res.setHeader('content-type', 'application/json');
      res.end('{"error":"Callback harness failed"}');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing harness port');
  // The daemon supervises this tiny readiness bridge, while requests are handled
  // in-process by the actual dispatcher and actual agent-log queue above.
  const bridge = `console.log('NEKKO_BACKEND_READY '+JSON.stringify({port:${address.port}}));process.stdin.resume();process.stdin.on('end',()=>process.exit(0));`;
  const binary = process.env.NEKKOD_TEST_BINARY ?? resolve('../../target/debug', process.platform === 'win32' ? 'nekkod.exe' : 'nekkod');
  const child = spawn(binary, [], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NEKKOD_CONFIG: JSON.stringify({ token, dataDir: dir,
      backend: { exe: process.execPath, args: ['-e', bridge] } }) },
  });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  try {
    const lines = createInterface({ input: child.stdout });
    const ready = await Promise.race([
      once(lines, 'line').then(([line]) => JSON.parse(String(line).replace(/^NEKKOD_READY /, '')) as { port: number }),
      once(child, 'error').then(([error]) => { throw error; }),
      once(child, 'exit').then(([code]) => { throw new Error(`nekkod exited ${code}: ${stderr}`); }),
    ]);
    const post = async (channel: string, args: unknown[]) => {
      const response = await fetch(`http://127.0.0.1:${ready.port}/api/${channel}`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ args }), signal: AbortSignal.timeout(15_000),
      });
      const body = await response.json();
      expect(response.status, JSON.stringify(body)).toBe(200);
      return body;
    };
    for (const id of ['delete_race', 'clear_race', 'retained']) {
      writeFileSync(join(dir, 'sessions', `${id}.json`), JSON.stringify({ id, title: id, updatedAt: 5, messages: [] }));
      appendAgentLog(id, 'initial');
    }
    await post('session:delete', ['delete_race']);
    expect(existsSync(join(dir, 'sessions', 'delete_race.json'))).toBe(false);
    // Keep a non-session sidecar to prove clearing only removes selected IDs.
    rmSync(join(dir, 'sessions', 'retained.json'));
    expect(await post('sessions:clear', ['all'])).toBe(1);
    expect(callbacks).toEqual(['delete_race', 'clear_race']);
    for (const id of callbacks) appendAgentLog(id, 'output-after-http-success');
    await flushAgentLogs();
    for (const id of callbacks) {
      expect(existsSync(join(dir, 'sessions', `${id}.json`))).toBe(false);
      expect(await readAgentLog(id, 1024)).toBeNull();
    }
    expect(readFileSync(agentLogPath('retained'), 'utf8')).toBe('initial');
  } finally {
    child.stdin.end();
    if (child.exitCode === null) {
      await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 7_000))]);
      if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    }
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await flushAgentLogs();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
