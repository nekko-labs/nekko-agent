import { EventEmitter } from 'events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  IpcChannels,
  IpcEvents,
  PAIRING_TTL_MS,
  callFromPhone,
  defaultDeviceName,
  deriveKey,
  newPairingCode,
  newRoomCode,
  newRoomSecret,
  normalizePlatform,
  open,
  phoneAccessPolicy,
  seal,
  verifyHello,
  type RemoteHelloReply,
} from '@nekko-agent/shared';

/**
 * What remote access produces, which the engine daemon's port
 * (crates/nekko-remote) must reproduce exactly, byte for byte:
 *
 * - the E2E layer: PBKDF2 key derivation, `seal` (with known IVs) and `open`;
 * - the HELLO rules (`verifyHello`) and the random material (codes, rooms, secrets);
 * - the remote service's `remote.json` and replies across a run of operations;
 * - the relay agent's frames: what it sends the relay for a scripted run of
 *   relay frames, sealed client frames and host events;
 * - the phone access policy (`phone-access.json`, from
 *   packages/shared/src/phone-access.ts) and how it decides a set of phone
 *   requests (`phone.json`).
 *
 * The phone apps (Expo, iOS, Android) and apps/relay speak this protocol, so
 * any drift here breaks every paired device. Fails if the file is stale;
 * rewrite it with UPDATE_GOLDEN=1.
 */
const crate = join(__dirname, '..', '..', '..', 'crates', 'nekko-remote');

function check(path: string, actual: unknown): void {
  if (process.env.UPDATE_GOLDEN) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, `${JSON.stringify(actual, null, 1)}\n`);
  }
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(JSON.parse(JSON.stringify(actual)));
}

const NOW = 1_760_000_000_000;

/**
 * The deterministic random source both sides use in these fixtures: call `n`
 * (counting from 0) fills byte `i` with `(n * 31 + i * 7 + 3) & 0xff`.
 */
function stubRandom(): void {
  let n = 0;
  vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
    const bytes = new Uint8Array((array as unknown as Uint8Array).buffer, (array as unknown as Uint8Array).byteOffset, (array as unknown as Uint8Array).byteLength);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (n * 31 + i * 7 + 3) & 0xff;
    n++;
    return array;
  });
}

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.resetModules();
});

const SECRET = '00112233445566778899aabbccddeeff';
const ROOM = 'a1b2c3d4e5f60718';

const VALUES: unknown[] = [
  { type: 'hello', deviceId: 'phone-1', name: 'Pixel', platform: 'android', pair: 'ABCD2345' },
  { type: 'req', id: 7, channel: 'tasks:list', args: [] },
  { type: 'res', id: 7, result: null },
  { type: 'event', channel: 'agent:event', payload: { type: 'text', sessionId: 's1', delta: 'héllo 🐱 "quoted"\n\tline ' } },
  { n: [0, -0, 0.1, 1e21, 1e-7, 123456789012345680000, -1.5, 9007199254740993] },
  { nested: { a: [true, false, null, { b: '' }] }, z: 1, a: 2 },
  'just a string',
  42,
  null,
  [],
];

it('seals, opens and derives keys as WebCrypto does', async () => {
  const key = await deriveKey(SECRET, ROOM);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: new TextEncoder().encode(`nekko-relay:${ROOM}`), iterations: 100_000, hash: 'SHA-256' },
    await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), 'PBKDF2', false, ['deriveKey']),
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt'],
  )));
  stubRandom();
  const frames = [];
  for (const value of VALUES) {
    const blob = await seal(key, value);
    frames.push({ value, text: JSON.stringify(value), blob, opened: await open(key, blob) });
  }
  vi.restoreAllMocks();
  const other = await deriveKey('ffeeddccbbaa99887766554433221100', 'room-2');
  stubRandom();
  const otherBlob = await seal(other, { type: 'hello', deviceId: 'x' });
  vi.restoreAllMocks();

  // Random material from the same deterministic source.
  stubRandom();
  const material = {
    pairingCode: newPairingCode(),
    pairingCode4: newPairingCode(4),
    room: newRoomCode(),
    secret: newRoomSecret(),
  };
  vi.restoreAllMocks();

  const devices = [
    { id: 'dev-1', name: 'iPhone', platform: 'ios', createdAt: NOW - 1000, lastSeenAt: NOW - 1000 },
    { id: 'dev-2', name: 'Old', platform: 'android', createdAt: NOW - 5000, lastSeenAt: NOW - 5000, revoked: true },
    { name: 'Reordered', id: 'dev-3', lastSeenAt: 1, platform: 'web', createdAt: 1, extra: { kept: true } },
  ];
  const grant = { code: 'ABCD2345', expiresAt: NOW + PAIRING_TTL_MS };
  const hellos: unknown[] = [
    null, 'hello', 42, {}, { type: 'hi', deviceId: 'dev-1' }, { type: 'hello' }, { type: 'hello', deviceId: '' },
    { type: 'hello', deviceId: '   ' }, { type: 'hello', deviceId: 7 }, { type: 'hello', deviceId: 'dev-1' },
    { type: 'hello', deviceId: 'dev-1', pair: 'WRONG' }, { type: 'hello', deviceId: 'dev-2' },
    { type: 'hello', deviceId: 'dev-3' }, { type: 'hello', deviceId: 'new' },
    { type: 'hello', deviceId: 'new', pair: 'WRONG' }, { type: 'hello', deviceId: 'new', pair: 'ABCD2345' },
    { type: 'hello', deviceId: 'new', pair: 'ABCD2345', name: '  My Phone  ', platform: 'IOS' },
    { type: 'hello', deviceId: 'new', pair: 'ABCD2345', name: '   ', platform: 'Android' },
    { type: 'hello', deviceId: 'new', pair: 'ABCD2345', name: 'x'.repeat(70) + '🐱', platform: 'web' },
    { type: 'hello', deviceId: 'new', pair: 'ABCD2345', name: '🐱'.repeat(40), platform: 'windows' },
    { type: 'hello', deviceId: 'new', pair: 'ABCD2345', name: 12, platform: 3 },
    { type: 'hello', deviceId: 'new', pair: '' },
    { type: 'hello', deviceId: 'new', pair: 'ABCD2345', platform: null },
    // A revoked device pairing again: with the live code it is re-admitted as new.
    { type: 'hello', deviceId: 'dev-2', pair: 'ABCD2345' },
    { type: 'hello', deviceId: 'dev-2', pair: 'ABCD2345', name: 'A55 di Davide', platform: 'android' },
    { type: 'hello', deviceId: 'dev-2', pair: 'WRONG' },
    { type: 'hello', deviceId: 'dev-2', pair: '' },
  ];
  const verdicts = [];
  for (const hello of hellos) {
    for (const pairing of [grant, null, { code: 'ABCD2345', expiresAt: NOW }]) {
      verdicts.push({ hello, pairing, now: NOW, verdict: verifyHello(devices as never, hello, pairing, NOW) });
    }
  }
  const platforms = [undefined, '', 'ios', 'IOS', 'Android', 'web', 'WEB', 'linux', 'ïos'].map((p) => ({
    platform: p ?? null,
    normalized: normalizePlatform(p),
    name: defaultDeviceName(p),
  }));

  check(join(crate, 'tests', 'golden', 'crypto.json'), {
    secret: SECRET,
    room: ROOM,
    key: hex(raw),
    frames,
    other: { secret: 'ffeeddccbbaa99887766554433221100', room: 'room-2', blob: otherBlob },
    material,
    devices,
    verdicts,
    platforms,
  });
});

it('lists the channels a paired phone may call', async () => {
  // Every public channel the host's dispatcher serves: what the TS relay let a
  // phone reach, minus the daemon's internal callbacks, which are not public.
  const { createDispatcher } = await import('./dispatch.js');
  const host = new Proxy({}, { get: (_t, key) => (key === 'events' ? new EventEmitter() : () => undefined) });
  const dispatch = createDispatcher(host as never);
  const served = [...new Set(Object.values(IpcChannels))].filter((channel) => {
    try {
      void Promise.resolve(dispatch(channel, [])).catch(() => {});
      return true;
    } catch (e) {
      return !String((e as Error).message).startsWith('Unknown channel');
    }
  });
  const path = join(crate, 'src', 'channels.json');
  if (process.env.UPDATE_GOLDEN) writeFileSync(path, `${JSON.stringify(served.sort(), null, 1)}\n`);
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(served.sort());
});

it('writes the phone access policy the daemon enforces', () => {
  // The Rust gate (crates/nekko-remote/src/phone.rs) reads these lists; the
  // TS constants in packages/shared/src/phone-access.ts are the source.
  check(join(crate, 'src', 'phone-access.json'), phoneAccessPolicy());
  const served = new Set<string>(JSON.parse(readFileSync(join(crate, 'src', 'channels.json'), 'utf8')));
  for (const c of phoneAccessPolicy().channels) expect(served.has(c), c).toBe(true);
});

it('decides phone requests the way the daemon must', async () => {
  // Each case: what the phone sent, what reached the host and what the phone got back.
  const settings = {
    theme: 'dark', accent: '#6d5efc', themePreset: 'nebula', defaultProviderId: 'p1', defaultModelId: 'm1',
    favoriteModels: ['p1::m1'], defaultChatMode: 'ask', chatPaneAction: 'complete', sandboxMode: 'workspace',
    providers: [{ id: 'p1', kind: 'openai', label: 'GPT', baseUrl: 'https://x', apiKey: 'sk-secret', tokenKey: 'tk', enabled: true }],
    guardrails: [{ id: 'g' }], hooks: [{ id: 'h', command: 'curl' }], hfToken: 'hf_secret', aboutUser: 'me',
    voice: { enabled: true, language: 'en', modelPath: '/m.bin', sensitivity: 50 },
  };
  const requests: Array<[string, unknown]> = [
    ['data:wipe', []],
    ['settings:reset', []],
    ['remote:rotate', []],
    ['remote:status', []],
    ['terminal:create', [{}]],
    ['file:write', ['/etc/hosts', 'x']],
    ['workspace:addByPath', ['/']],
    ['voice:install', []],
    ['mcp:hypergate:connect', [1]],
    ['tasks:list', []],
    ['turn:pending', []],
    ['sessions:summaries', []],
    ['session:get', ['s1', { deep: [1] }]],
    ['session:delete', ['s1']],
    ['voice:transcribe', [[0, 1, 2]]],
    ['settings:get', []],
    ['settings:get', 'not a list'],
    ['providers:list', []],
    ['settings:update', [{ chatPaneAction: 'delete', skipDeleteConfirmation: true }]],
    ['settings:update', [{ defaultChatMode: 'guardrails' }]],
    ['settings:update', [{ defaultChatMode: 'yolo' }]],
    ['settings:update', [{ defaultChatMode: 'turbo' }]],
    ['settings:update', [{ chatPaneAction: 'delete', sandboxMode: 'off' }]],
    ['settings:update', [{ voice: { language: 'it' } }]],
    ['settings:update', [{ voice: { enabled: false, modelPath: '/evil' } }]],
    ['settings:update', [{ voice: { language: 'x y' } }]],
    ['settings:update', [{ voice: null }]],
    ['settings:update', [null]],
    ['settings:update', []],
    ['session:setOptions', ['s1', { providerId: 'p1', modelId: 'm1' }]],
    ['session:setOptions', ['s1', { archivedAt: 5 }]],
    ['session:setOptions', ['s1', { mode: 'yolo' }]],
    ['session:setOptions', ['s1', { mode: 'guardrails', disabledTools: [] }]],
    ['session:setOptions', ['s1']],
    ['chat:send', [{ sessionId: 's1', providerId: 'p1', modelId: 'm1', text: 'hi' }]],
    ['chat:send', [{ sessionId: 's1', text: 'hi', attachedPaths: ['/etc/passwd'] }]],
    ['skills:runnable', []],
    ['chat:send', [{ sessionId: 's1', providerId: 'p1', modelId: 'm1', text: 'x', skill: { name: 'review', input: ' this ' } }]],
    ['chat:send', [{ sessionId: 's1', text: '', skill: { name: 'tidy' } }]],
    ['chat:send', [{ sessionId: 's1', text: 'x', skill: { name: 'goal', input: 'x' } }]],
    ['chat:send', [{ sessionId: 's1', text: 'x', skill: 'review' }]],
    ['chat:send', [{ sessionId: 's1', text: 'x', skill: { name: 'review', input: 3 } }]],
    ['chat:send', [{ sessionId: 's1', text: 'x', skill: { name: 'review', template: 't' } }]],
    ['chat:queue', ['s1', 'plain']],
    ['chat:queue', ['s1', { text: '', skill: { name: 'review', input: 'later' } }]],
    ['chat:queue', ['s1', { text: 'x', attachedPaths: ['/etc'] }]],
    ['chat:queue', ['s1', 7]],
  ];
  // What the computer can run: the phone sees names, never templates or folders.
  const skills = [
    { name: 'review', description: 'Review the code', category: 'Code quality', source: 'builtin', template: 'Review carefully.\n' },
    { name: 'tidy', description: 'Tidy up', category: 'Imported', source: 'claude', template: 'Use the "tidy" skill. Files in /Users/me/.claude/skills/tidy.' },
  ];
  const cases = [];
  for (const [channel, args] of requests) {
    const calls: unknown[] = [];
    const dispatch = (ch: string, a: unknown[]) => {
      calls.push([ch, a]);
      if (ch === 'skills:runnable') return skills;
      return ch.startsWith('settings:') || ch === 'providers:list' ? (ch === 'providers:list' ? settings.providers : settings) : { ok: ch };
    };
    const outcome = await callFromPhone(dispatch, channel, Array.isArray(args) ? args : []).then(
      (result) => ({ result }),
      (e: Error) => ({ error: e.message }),
    );
    cases.push({ channel, args, calls, ...outcome });
  }
  check(join(crate, 'tests', 'golden', 'phone.json'), { settings, skills, cases });
});

/** A relay socket the agent dials, recording what it sends. */
class FakeSocket {
  static last: FakeSocket | null = null;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => Promise<void> | void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.last = this;
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    /* the transcript never closes the socket */
  }
}

const settle = () => new Promise((r) => setTimeout(r, 30));

it('runs the relay agent protocol frame for frame', async () => {
  const realWebSocket = globalThis.WebSocket;
  (globalThis as { WebSocket: unknown }).WebSocket = FakeSocket;
  try {
    stubRandom();
    const key = await deriveKey(SECRET, ROOM);
    // The host the phone reaches: a few channels with fixed answers.
    const responses: Record<string, { result?: unknown; error?: string }> = {
      [IpcChannels.sessionsSummaries]: { result: [{ id: 's1', title: 'Nightly', updatedAt: 1.5 }] },
      [IpcChannels.tasksList]: { result: [{ id: 't1', title: 'Nightly', nextRunAt: 1.5 }] },
      [IpcChannels.settingsGet]: { error: 'settings are broken' },
      [IpcChannels.chatAbort]: { result: undefined },
      [IpcChannels.providersList]: { result: [{ id: 'p1', kind: 'openai', label: 'GPT', baseUrl: 'https://x', apiKey: 'sk-secret', enabled: true }] },
      [IpcChannels.sessionGet]: { result: { id: 's1', title: 'ünï 🐱', messages: [{ role: 'user', content: 'a b' }] } },
    };
    const calls: Array<{ channel: string; args: unknown[] }> = [];
    const events = new EventEmitter();
    const answer = (channel: string) => (...args: unknown[]) => {
      calls.push({ channel, args });
      const r = responses[channel];
      if (r.error) throw new Error(r.error);
      return r.result;
    };
    const host = {
      events,
      listSessionSummaries: answer(IpcChannels.sessionsSummaries),
      listTasks: answer(IpcChannels.tasksList),
      getSettings: answer(IpcChannels.settingsGet),
      abortChat: answer(IpcChannels.chatAbort),
      listProviders: answer(IpcChannels.providersList),
      getSession: answer(IpcChannels.sessionGet),
    };
    const verify = (hello: unknown): RemoteHelloReply => {
      const h = hello as { deviceId?: string };
      return h?.deviceId === 'phone-1' || h?.deviceId === 'phone-2'
        ? { type: 'welcome', device: { id: h.deviceId, name: 'Phone', platform: 'android', createdAt: 1, lastSeenAt: 2 } }
        : { type: 'denied', reason: 'unknown-device' };
    };
    const { connectRelayAgent } = await import('./relay.js');
    const handle = connectRelayAgent(host as never, { relayUrl: 'ws://127.0.0.1:4400/', room: ROOM, key: SECRET, access: 'tok en/1', verify });
    const ws = FakeSocket.last!;
    ws.onopen?.();

    const sealed = async (value: unknown) => JSON.stringify({ enc: await seal(key, value) });
    type Step =
      | { relay: unknown }
      | { relayText: string }
      | { client: string; value: unknown }
      | { client: string; data: string }
      | { event: string; payload: unknown }
      | { kick: string };
    const script: Step[] = [
      { relay: { type: 'client-open', cid: 'c1' } },
      { client: 'c1', value: { type: 'req', id: 1, channel: IpcChannels.sessionsSummaries, args: [] } },
      { client: 'c1', value: { type: 'hello', deviceId: 'stranger' } },
      { relay: { type: 'client-open', cid: 'c2' } },
      { client: 'c2', value: { type: 'hello', deviceId: 'phone-1', name: 'P' } },
      { client: 'c2', value: { type: 'req', id: 2, channel: IpcChannels.sessionsSummaries, args: [] } },
      { client: 'c2', value: { type: 'req', id: 3, channel: IpcChannels.settingsGet } },
      { client: 'c2', value: { type: 'req', id: 4, channel: IpcChannels.chatAbort, args: ['s1'] } },
      { client: 'c2', value: { type: 'req', id: 'five', channel: IpcChannels.sessionGet, args: ['s1', { deep: [1, 2] }] } },
      { client: 'c2', value: { type: 'req', id: 6, channel: 'no:such', args: [] } },
      // Served by the host, but not to a phone: refused before the host sees it.
      { client: 'c2', value: { type: 'req', id: 61, channel: IpcChannels.tasksList, args: [] } },
      { client: 'c2', value: { type: 'req', id: 62, channel: IpcChannels.dataWipe, args: [] } },
      // Provider records reach a phone without their keys; a non-list `args` counts as none.
      { client: 'c2', value: { type: 'req', id: 63, channel: IpcChannels.providersList, args: 'not a list' } },
      { client: 'c2', value: { type: 'pong' } },
      { client: 'c2', data: 'not json' },
      { client: 'c2', data: '{"plain":true}' },
      { client: 'c2', data: '{"enc":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}' },
      { relayText: 'not json either' },
      { relay: { type: 'c', cid: 'c2', data: 5 } },
      { relay: { type: 'mystery', cid: 'c2' } },
      // A frame on a connection the relay never announced still counts.
      { client: 'c9', value: { type: 'hello', deviceId: 'phone-2' } },
      { event: IpcEvents.agentEvent, payload: { type: 'text', sessionId: 's1', delta: 'hi 🐱' } },
      { event: IpcEvents.agentEvent, payload: { type: 'done', sessionId: 's1', usage: { inputTokens: 3, outputTokens: 0.5 } } },
      { event: IpcEvents.terminalEvent, payload: { type: 'data', terminalId: 'term_1', data: '\u001b[31mred\u001b[0m' } },
      { event: IpcEvents.changesUpdated, payload: { sessionId: 's1' } },
      { event: IpcEvents.tasksUpdated, payload: [{ id: 't1' }] },
      { event: IpcEvents.trainingUpdated, payload: [] },
      { event: IpcEvents.workflowsUpdated, payload: { workflows: [], runs: [] } },
      { event: IpcEvents.limitsUpdated, payload: { tokenKey: 'claude:a', limits: { windows: [] } } },
      { event: IpcEvents.appearanceUpdated, payload: { theme: 'dark', accent: '#fb923c' } },
      { event: IpcEvents.indexProgress, payload: { workspaceId: 'w1', done: 3, total: 9 } },
      { kick: 'phone-2' },
      { relay: { type: 'client-close', cid: 'c2' } },
      { event: IpcEvents.agentEvent, payload: { type: 'text', sessionId: 's1', delta: 'after close' } },
      { client: 'c2', value: { type: 'req', id: 7, channel: IpcChannels.sessionsSummaries, args: [] } },
      { kick: 'phone-1' },
    ];

    const steps = [];
    for (const step of script) {
      const before = ws.sent.length;
      let input: unknown;
      if ('relay' in step) {
        input = { relay: JSON.stringify(step.relay) };
        await ws.onmessage?.({ data: JSON.stringify(step.relay) });
      } else if ('relayText' in step) {
        input = { relay: step.relayText };
        await ws.onmessage?.({ data: step.relayText });
      } else if ('client' in step) {
        const data = 'value' in step ? await sealed(step.value) : step.data;
        input = { relay: JSON.stringify({ type: 'c', cid: step.client, data }) };
        await ws.onmessage?.({ data: JSON.stringify({ type: 'c', cid: step.client, data }) });
      } else if ('event' in step) {
        const name = Object.entries(IpcEvents).find(([, ch]) => ch === step.event)![0];
        input = { event: { channel: step.event, payload: step.payload } };
        events.emit(name, step.payload);
      } else {
        input = { kick: step.kick };
        handle.kickDevice(step.kick);
      }
      await settle();
      steps.push({ input, sent: ws.sent.slice(before), connected: handle.connectedDevices() });
    }
    handle.stop();
    vi.restoreAllMocks();

    check(join(crate, 'tests', 'golden', 'agent.json'), {
      secret: SECRET,
      room: ROOM,
      url: ws.url,
      responses,
      calls,
      steps,
      relayedEvents: [
        IpcEvents.agentEvent, IpcEvents.indexProgress, IpcEvents.terminalEvent, IpcEvents.changesUpdated,
        IpcEvents.tasksUpdated, IpcEvents.trainingUpdated, IpcEvents.workflowsUpdated, IpcEvents.limitsUpdated,
        IpcEvents.appearanceUpdated,
      ],
    });
  } finally {
    (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
  }
});

it('keeps remote.json and its replies across a run of operations', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nekko-remote-golden-'));
  try {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    stubRandom();
    let verify: ((hello: unknown) => RemoteHelloReply) | undefined;
    const kicked: string[] = [];
    vi.doMock('./relay.js', () => ({
      connectRelayAgent: (_host: unknown, opts: { verify: (hello: unknown) => RemoteHelloReply; relayUrl: string; room: string; key: string }) => {
        verify = opts.verify;
        return {
          stop() {},
          kickDevice: (id: string) => kicked.push(id),
          connectedDevices: () => [],
          isOnline: () => false,
          lastError: () => undefined,
        };
      },
    }));
    const { setDataDir } = await import('./paths.js');
    setDataDir(dir);
    const { createRemoteService } = await import('./remote.js');
    const remote = createRemoteService({} as never);
    const file = join(dir, 'remote.json');
    const read = () => {
      try {
        return readFileSync(file, 'utf8');
      } catch {
        return null;
      }
    };
    type Op = { op: string; args?: unknown[]; at?: number; file?: string };
    const ops: Op[] = [
      { op: 'status' },
      { op: 'devices' },
      { op: 'pairing' },
      { op: 'enable', args: ['wss://relay.example/'] },
      { op: 'pairing' },
      { op: 'hello', args: [{ type: 'hello', deviceId: 'phone-1', name: 'Pixel 9', platform: 'android' }] },
      { op: 'pair' },
      { op: 'hello', args: [{ type: 'hello', deviceId: 'phone-1', name: 'Pixel 9', platform: 'android', pair: 'WRONG' }] },
      { op: 'hello', args: [{ type: 'hello', deviceId: 'phone-1', name: '  Pixel 9  ', platform: 'android', pair: '@code' }] },
      { op: 'hello', args: [{ type: 'hello', deviceId: 'phone-2', pair: '@code' }] },
      { op: 'pair' },
      { op: 'hello', args: [{ type: 'hello', deviceId: 'phone-2', platform: 'ios', pair: '@code' }], at: NOW + 60_000 },
      { op: 'hello', args: [{ type: 'hello', deviceId: 'phone-1' }], at: NOW + 120_000 },
      { op: 'rename', args: ['phone-1', '  Work phone  '] },
      { op: 'rename', args: ['phone-1', '   '] },
      { op: 'rename', args: ['phone-2', 'y'.repeat(80)] },
      { op: 'rename', args: ['nobody', 'Ghost'] },
      { op: 'pair' },
      { op: 'hello', args: [{ type: 'hello', deviceId: 'phone-3', pair: '@code' }], at: NOW + PAIRING_TTL_MS + 1 },
      { op: 'revoke', args: ['phone-2'] },
      { op: 'hello', args: [{ type: 'hello', deviceId: 'phone-2' }] },
      // The revoked phone pairs again with a fresh code: re-admitted, the code is spent.
      { op: 'pair' },
      { op: 'hello', args: [{ type: 'hello', deviceId: 'phone-2', name: 'Pixel again', platform: 'android', pair: '@code' }] },
      { op: 'hello', args: [{ type: 'hello', deviceId: 'phone-2' }] },
      { op: 'hello', args: [{ type: 'hello', deviceId: 'phone-4', pair: '@code' }] },
      { op: 'revoke', args: ['phone-2'] },
      { op: 'revoke', args: ['nobody'] },
      { op: 'status' },
      { op: 'disable' },
      { op: 'pairing' },
      { op: 'enable', args: ['ws://127.0.0.1:4400'] },
      { op: 'rotate' },
      { op: 'devices' },
      { op: 'disable' },
      { op: 'rotate' },
      { op: 'file', file: '{"enabled":true,"devices":[{"id":"d","name":"n","platform":"ios","createdAt":1,"lastSeenAt":2,"extra":[1]}],"relayUrl":"ws://x","unknown":5,"room":"r","secret":"s"}' },
      { op: 'status' },
      { op: 'rename', args: ['d', 'New'] },
      { op: 'file', file: 'not json' },
      { op: 'status' },
      { op: 'enable', args: ['ws://y'] },
      { op: 'file', file: '{"enabled":true}' },
      { op: 'status' },
      { op: 'devices' },
      { op: 'pairing' },
    ];
    let code = '';
    const out = [];
    for (const step of ops) {
      if (step.at) vi.setSystemTime(step.at);
      const args = (step.args ?? []).map((a) =>
        a && typeof a === 'object' && (a as { pair?: string }).pair === '@code' ? { ...(a as object), pair: code } : a,
      );
      let result: unknown;
      switch (step.op) {
        case 'file':
          writeFileSync(file, step.file!);
          result = null;
          break;
        case 'hello':
          result = verify!(args[0]);
          break;
        case 'pair': {
          const g = remote.pair();
          code = g.code;
          result = g;
          break;
        }
        default:
          result = (remote as unknown as Record<string, (...a: unknown[]) => unknown>)[step.op](...args);
      }
      out.push({ op: step.op, args, now: Date.now(), result: result ?? null, file: read(), kicked: [...kicked] });
    }
    remote.stop();
    check(join(crate, 'tests', 'golden', 'service.json'), { start: NOW, ops: out });
  } finally {
    vi.doUnmock('./relay.js');
    rmSync(dir, { recursive: true, force: true });
  }
});
