/**
 * The phone's relay client against the real thing: a local relay
 * (apps/relay/dist), a headless agent (apps/web-app-server/dist in relay-agent mode)
 * and a fake OpenAI-compatible model server that streams a reply. Proves the
 * whole phone path: enrollment with the one-time code, the host's channels,
 * a chat turn streamed back as `agent:event`s, and denial of a stranger.
 *
 * Needs a root build first (`npm run build:web` or shared/core/host/server/relay).
 * Run: `NEKKO_ITEST=1 npx vitest run src/lib/relay.itest.ts` from apps/mobile.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID, webcrypto } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveKeyBytes } from './e2e';
import { Channels, Events, publicProviders, type AgentEvent, type Session, type SessionSummary } from './protocol';
import { RelayClient, type RelayState } from './relayClient';

const ROOT = resolve(__dirname, '../../../..');
const RELAY_PORT = 4600 + Math.floor(Math.random() * 300);
const MODEL_PORT = RELAY_PORT + 1;
const RELAY_URL = `ws://127.0.0.1:${RELAY_PORT}`;
const ROOM = webcrypto.getRandomValues(new Uint8Array(8)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');
const KEY = webcrypto.getRandomValues(new Uint8Array(16)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');

const procs: ChildProcess[] = [];
let modelServer: Server;
let pairCode = '';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Streams "Hello from your computer." as OpenAI chat-completion chunks. */
function startFakeModel(): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.url?.includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model' }] }));
      return;
    }
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const words = ['Hello ', 'from ', 'your ', 'computer.'];
      for (const w of words) {
        res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: w } }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 4 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((r) => server.listen(MODEL_PORT, '127.0.0.1', () => r(server)));
}

async function client(over: Partial<ConstructorParameters<typeof RelayClient>[0]> = {}) {
  const states: RelayState[] = [];
  const events: AgentEvent[] = [];
  const c = new RelayClient({
    relayUrl: RELAY_URL,
    room: ROOM,
    key: KEY,
    keyBytes: await deriveKeyBytes(KEY, ROOM),
    deviceId: randomUUID(),
    deviceName: 'Test phone',
    platform: 'android',
    onState: (s) => states.push(s),
    onEvent: (ch, p) => ch === Events.agentEvent && events.push(p as AgentEvent),
    ...over,
  });
  return { c, states, events };
}

describe.skipIf(!process.env.NEKKO_ITEST)('phone ↔ relay ↔ computer', () => {
  beforeAll(async () => {
    modelServer = await startFakeModel();
    procs.push(
      spawn(process.execPath, [join(ROOT, 'apps/relay/dist/index.js')], {
        env: { ...process.env, NEKKO_RELAY_PORT: String(RELAY_PORT), NEKKO_RELAY_HOST: '127.0.0.1', NEKKO_RELAY_ALLOW_UNAUTHENTICATED: '1' },
        stdio: 'ignore',
      }),
    );
    await sleep(800);
    const dataDir = mkdtempSync(join(tmpdir(), 'nekko-mobile-itest-'));
    writeFileSync(
      join(dataDir, 'settings.json'),
      JSON.stringify({
        providers: [{ id: 'fake', kind: 'openai-compat', label: 'Fake', baseUrl: `http://127.0.0.1:${MODEL_PORT}/v1`, apiKey: 'sk-should-never-reach-state', enabled: true }],
        defaultProviderId: 'fake',
        defaultModelId: 'fake-model',
      }),
    );
    const agent = spawn(process.execPath, [join(ROOT, 'apps/web-app-server/dist/index.js')], {
      env: {
        ...process.env,
        NEKKO_RELAY_URL: RELAY_URL,
        NEKKO_ROOM: ROOM,
        NEKKO_PAIR_KEY: KEY,
        NEKKO_DATA_DIR: dataDir,
        // The TS loop: this test is about the phone path, not the Rust daemon.
        NEKKO_AGENT_LOOP: 'ts',
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    procs.push(agent);
    agent.stdout!.on('data', (d) => {
      const m = String(d).match(/pairing code \(10 min\): ([A-Z2-9]+)/);
      if (m) pairCode = m[1];
    });
    for (let i = 0; i < 100 && !pairCode; i++) await sleep(100);
    expect(pairCode).toMatch(/^[A-Z2-9]{8}$/);
  }, 30_000);

  afterAll(() => {
    for (const p of procs) p.kill();
    modelServer?.close();
  });

  it('refuses a stranger without a pairing code', { timeout: 20_000 }, async () => {
    let denied = '';
    const { c } = await client({ onDenied: (r) => (denied = r) });
    c.connect();
    for (let i = 0; i < 50 && !denied; i++) await sleep(100);
    expect(['unknown-device', 'kicked']).toContain(denied);
    expect(c.current).toBe('denied');
    await expect(c.call(Channels.appInfo)).rejects.toThrow(/no longer paired/);
  });

  it('enrolls, drives the host, and streams a chat turn', async () => {
    let welcomedAs = '';
    const { c, states, events } = await client({ pairCode, onWelcome: (d) => (welcomedAs = d.name) });
    c.connect();
    const info = await c.call<{ version: string }>(Channels.appInfo);
    expect(typeof info.version).toBe('string');
    expect(welcomedAs).toBe('Test phone');
    expect(states).toContain('online');

    const providers = publicProviders(await c.call(Channels.providersList));
    expect(providers).toContainEqual({ id: 'fake', kind: 'openai-compat', label: 'Fake', enabled: true });
    expect(JSON.stringify(providers)).not.toContain('sk-');

    const session = await c.call<Session>(Channels.sessionCreate);
    expect(session.id).toMatch(/^s_/);

    // chat:send replies only when the turn ends; the stream is what we follow.
    const sent = c.callWithTimeout(60_000, Channels.chatSend, {
      sessionId: session.id,
      providerId: 'fake',
      modelId: 'fake-model',
      text: 'Say hello',
    });
    await sent;
    const mine = events.filter((e) => e.sessionId === session.id);
    const text = mine.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('');
    expect(text).toBe('Hello from your computer.');
    expect(mine.some((e) => e.type === 'done')).toBe(true);

    const saved = await c.call<Session>(Channels.sessionGet, session.id);
    expect(saved.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    const list = await c.call<SessionSummary[]>(Channels.sessionsSummaries);
    expect(list.some((s) => s.id === session.id)).toBe(true);

    // The one-time code is spent: a second phone presenting it is refused.
    let denied = '';
    const { c: replay } = await client({ pairCode, onDenied: (r) => (denied = r) });
    replay.connect();
    for (let i = 0; i < 50 && !denied; i++) await sleep(100);
    expect(['bad-code', 'kicked']).toContain(denied);
    c.close();
    replay.close();
  }, 60_000);
});
