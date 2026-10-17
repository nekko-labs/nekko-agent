import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// The relay "Relay on this computer" ships is apps/relay bundled into
// out/main/relay.js (CI builds every workspace before npm test). Bundling once
// turned ws's optional bufferutil into an empty stub, and the relay died on the
// first masked frame a phone sent: run the real bundle and push frames through it.

const bundle = join(dirname(fileURLToPath(import.meta.url)), '../../out/main/relay.js');

describe('bundled relay (out/main/relay.js)', () => {
  let child: ChildProcess | undefined;
  afterEach(() => {
    child?.stdin?.end();
    child?.kill();
  });

  it("leaves ws's optional native helpers to a runtime require", () => {
    const src = readFileSync(bundle, 'utf8');
    expect(src).toMatch(/require\(\s*["']bufferutil["']\s*\)/);
  });

  it('routes frames between an agent and a phone and keeps running', async () => {
    child = spawn(process.execPath, [bundle], {
      env: { ...process.env, NEKKO_RELAY_HOST: '127.0.0.1', NEKKO_RELAY_PORT: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr!.on('data', (d) => (stderr += String(d)));
    const port = await new Promise<number>((done, fail) => {
      child!.stdout!.on('data', (d) => {
        const m = String(d).match(/NEKKO_RELAY_READY (\{.*\})/);
        if (m) done(JSON.parse(m[1]).port);
      });
      child!.on('exit', (c) => fail(new Error(`relay exited ${c}: ${stderr}`)));
    });

    const room = 'a1b2c3d4e5f60718';
    const key = '00112233445566778899aabbccddeeff';
    const url = (role: string) => `ws://127.0.0.1:${port}/relay?role=${role}&room=${room}&key=${key}`;
    // Node's own WebSocket client: it masks every frame, as a phone does.
    const frames = (ws: WebSocket) => {
      const got: any[] = [];
      ws.addEventListener('message', (e) => got.push(JSON.parse(String(e.data))));
      return got;
    };
    const opened = (ws: WebSocket) =>
      new Promise<void>((done, fail) => {
        ws.addEventListener('open', () => done(), { once: true });
        ws.addEventListener('error', () => fail(new Error('websocket error')), { once: true });
      });

    const agent = new WebSocket(url('agent'));
    const toAgent = frames(agent);
    await opened(agent);
    const phone = new WebSocket(url('client'));
    const toPhone = frames(phone);
    await opened(phone);

    // Client frames are masked: exactly what crashed the stubbed bufferutil.
    const big = 'x'.repeat(64 * 1024);
    phone.send(JSON.stringify({ enc: big }));
    await expect.poll(() => toAgent.find((f) => f.type === 'c'), { timeout: 5000 }).toBeTruthy();
    const cid = toAgent.find((f) => f.type === 'c').cid;
    expect(JSON.parse(toAgent.find((f) => f.type === 'c').data).enc).toBe(big);

    // Agent → phone is a `d` routing envelope.
    agent.send(JSON.stringify({ type: 'd', cid, data: JSON.stringify({ enc: 'reply' }) }));
    await expect.poll(() => toPhone.some((f) => f.enc === 'reply'), { timeout: 5000 }).toBe(true);

    const health = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.json());
    expect(health).toMatchObject({ ok: true, rooms: 1 });
    expect(child.exitCode).toBeNull();
    agent.close();
    phone.close();
  }, 20_000);
});
