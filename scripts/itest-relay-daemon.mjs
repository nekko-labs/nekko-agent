// The phone path with the relay agent in the engine daemon (crates/nekko-remote):
// a device on a local apps/relay-server reaches the Local Web UI, which runs behind
// nekkod, whose agent dials the relay. Checks transport auth, the sealed HELLO
// answering the agent's challenge (phone protocol 4, with a legacy phone too),
// replayed HELLOs and requests, one-time pairing, requests to the daemon and
// through it to the TS host, host events fanned out to the phone, the phone
// channel allowlist, and live revocation.
//
// Never point this at the managed relay with real devices: it always starts
// its own relay on loopback.
//
// Usage: node scripts/itest-relay-daemon.mjs [path/to/nekkod]
// Needs `npm run build:web`, `npm run build -w @nekko-agent/relay-server` and a cargo build of nekkod.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { deriveKey, relayAuth, seal, open } from '@nekko-agent/shared';
import { killTree, treeOptions } from './itest-procs.mjs';

const exe = process.platform === 'win32' ? 'nekkod.exe' : 'nekkod';
const nekkod =
  process.argv[2] ??
  [process.env.CARGO_TARGET_DIR && join(process.env.CARGO_TARGET_DIR, 'debug', exe), join('target', 'debug', exe)].find(
    (p) => p && existsSync(p),
  );
if (!nekkod) throw new Error('build nekkod first (cargo build -p nekkod) or pass its path');

const RELAY_PORT = 4400 + Math.floor(Math.random() * 500);
const SERVER_PORT = 5400 + Math.floor(Math.random() * 500);
const RELAY_URL = `ws://127.0.0.1:${RELAY_PORT}`;
const TOKEN = randomBytes(24).toString('hex');
const root = mkdtempSync(join(tmpdir(), 'nekko-relay-daemon-'));
const dataDir = join(root, 'data');
const home = join(root, 'home');
mkdirSync(dataDir, { recursive: true });
mkdirSync(home, { recursive: true });

const procs = [];
const stop = () => {
  for (const p of procs) killTree(p);
  try { rmSync(root, { recursive: true, force: true }); } catch { /* a child may still hold a file */ }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
};

procs.push(
  spawn(process.execPath, ['apps/relay-server/dist/index.js'], {
    env: { ...process.env, NEKKO_RELAY_PORT: String(RELAY_PORT), NEKKO_RELAY_HOST: '127.0.0.1', NEKKO_RELAY_ALLOW_UNAUTHENTICATED: '1' },
    stdio: 'ignore',
    ...treeOptions,
  }),
);
let serverOut = '';
const server = spawn(process.execPath, ['apps/local-web-ui/dist/index.js'], {
  env: {
    ...process.env,
    NEKKO_PORT: String(SERVER_PORT),
    NEKKO_HOST: '127.0.0.1',
    NEKKO_DATA_DIR: dataDir,
    NEKKO_TOKEN: TOKEN,
    NEKKOD_PATH: nekkod,
    HOME: home,
    USERPROFILE: home,
  },
  stdio: ['pipe', 'pipe', 'pipe'],
  ...treeOptions,
});
procs.push(server);
server.stdout.on('data', (d) => (serverOut += d));
server.stderr.on('data', (d) => (serverOut += d));

const api = async (channel, ...args) => {
  const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/${channel}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ args }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${channel}: ${res.status} ${JSON.stringify(body)}`);
  return body?.result !== undefined ? body.result : body;
};

try {
  let info = null;
  for (let i = 0; i < 120 && !info; i++) {
    info = await api('daemon:info').catch(() => null);
    if (!info) await sleep(250);
  }
  check('the Local Web UI runs behind nekkod', info?.app === 'nekkod', JSON.stringify(info?.backend));

  const status = await api('remote:enable', RELAY_URL);
  check('remote access enabled through the daemon', status?.enabled === true);
  const { room, key } = await api('remote:pairing');
  const grant = await api('remote:pair');
  const e2eKey = await deriveKey(key, room);
  // The relay checks a credential derived from the secret, never the secret (decision 0036).
  const auth = await relayAuth(key, room);
  let online = false;
  for (let i = 0; i < 40 && !online; i++) {
    online = (await api('remote:status'))?.online === true;
    if (!online) await sleep(250);
  }
  check('the daemon agent is online at the relay', online);

  async function device({ deviceId, name, pair, legacy = false }) {
    const ws = new WebSocket(`${RELAY_URL}/relay?role=client&room=${room}&key=${auth}`);
    const pending = new Map();
    const events = [];
    const sent = [];
    let nextId = 1;
    let seq = 0;
    let hello = null;
    let onHello = null;
    // The agent's challenges, newest last (phone protocol 4).
    const challenges = [];
    let onChallenge = null;
    const closed = new Promise((res) => ws.addEventListener('close', (ev) => res(ev.code)));
    ws.onmessage = async (ev) => {
      let env;
      try {
        env = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (!env.enc) return;
      const f = await open(e2eKey, env.enc);
      if (f.type === 'challenge') {
        challenges.push(f.challenge);
        onChallenge?.(f.challenge);
      } else if (f.type === 'welcome' || f.type === 'denied') {
        hello = f;
        onHello?.(f);
      } else if (f.type === 'res' && pending.has(f.id)) {
        const { resolve, reject } = pending.get(f.id);
        pending.delete(f.id);
        f.error ? reject(new Error(f.error)) : resolve(f.result);
      } else if (f.type === 'event') {
        events.push(f);
      }
    };
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error('client ws failed'));
    });
    const sendSealed = async (frame) => {
      const text = JSON.stringify({ enc: await seal(e2eKey, frame) });
      sent.push(text);
      ws.send(text);
    };
    const call = (channel, ...callArgs) =>
      new Promise(async (resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        const bound = legacy ? {} : { seq: ++seq, challenge: hello?.challenge };
        await sendSealed({ type: 'req', id, ...bound, channel, args: callArgs });
        setTimeout(() => pending.has(id) && reject(new Error(`timeout: ${channel}`)), 20000);
      });
    const nextChallenge = (after) =>
      new Promise((res) => {
        if (challenges.length > after) return res(challenges[challenges.length - 1]);
        onChallenge = res;
        setTimeout(() => res(null), 8000);
      });
    // `answer`: the challenge to send (default: the agent's newest); legacy phones send none.
    const doHello = (answer) =>
      new Promise(async (res) => {
        hello = null;
        onHello = res;
        const challenge = legacy ? undefined : (answer ?? (await nextChallenge(0)));
        await sendSealed({
          type: 'hello', deviceId, name, platform: 'android',
          ...(legacy ? {} : { protocol: 4, challenge }), ...(pair ? { pair } : {}),
        });
        if (hello === null) seq = 0;
        setTimeout(() => res(hello ?? { type: 'timeout' }), 8000);
      }).then((h) => (h.type === 'welcome' && !legacy ? Object.assign(h, { challenge: challenges[challenges.length - 1] }) : h));
    return { ws, call, doHello, closed, events, challenges, nextChallenge, sent, raw: (text) => ws.send(text) };
  }

  const wrongKey = await new Promise((resolve) => {
    const bad = new WebSocket(`${RELAY_URL}/relay?role=client&room=${room}&key=nope`);
    bad.onclose = (ev) => resolve(ev.code === 1008);
    setTimeout(() => resolve(false), 10000);
  });
  check('wrong-key client rejected at the relay', wrongKey);

  const sneaky = await device({ deviceId: 'sneaky-1', name: 'No hello' });
  check(
    'a request before HELLO is refused',
    await sneaky.call('settings:get').then(() => false, (e) => /not paired/.test(e.message)),
  );
  const stranger = await sneaky.doHello();
  check('an unknown device is denied', stranger.type === 'denied' && stranger.reason === 'unknown-device');
  check('and kicked (4001)', (await sneaky.closed) === 4001);

  const phone = await device({ deviceId: 'phone-1', name: 'Pixel', pair: grant.code });
  const w = await phone.doHello();
  check('a device enrolls with the one-time code', w.type === 'welcome' && w.device?.name === 'Pixel');
  const saved = JSON.parse(readFileSync(join(dataDir, 'remote.json'), 'utf8'));
  check('remote.json holds it (written by the daemon)', saved.devices?.[0]?.id === 'phone-1');
  check('the agent challenged the connection before the HELLO', phone.challenges.length === 1 && phone.challenges[0].length === 24);
  const settings = await phone.call('settings:get');
  check('the phone reaches the TS host through the daemon (settings:get)', typeof settings === 'object' && settings !== null);
  const sessions = await phone.call('sessions:summaries');
  check('the phone reaches a daemon service (sessions:summaries)', Array.isArray(sessions));
  // A phone may call only the channels in PHONE_CHANNELS (packages/shared/src/phone-access.ts).
  const denied = (channel) => (e) => e.message === `Not allowed from a paired phone (channel-denied): ${channel}`;
  check('internal callbacks are not public', await phone.call('turn:pending').then(() => false, denied('turn:pending')));
  check('a phone cannot pair devices itself', await phone.call('remote:pair').then(() => false, denied('remote:pair')));
  // A host event fans out to the phone: a task made on the computer fires tasks:updated.
  await api('task:create', { title: 'From the computer', kind: 'scheduled', prompt: 'hi', runAt: Date.now() + 3_600_000 });
  for (let i = 0; i < 40 && !phone.events.some((e) => e.channel === 'tasks:updated'); i++) await sleep(100);
  check('host events reach the phone (tasks:updated)', phone.events.some((e) => e.channel === 'tasks:updated'));

  // Relay replay protection: a request sent again byte for byte is dropped
  // and the connection challenged anew; the recorded HELLO on a new connection is never welcomed.
  const lastReq = phone.sent[phone.sent.length - 1];
  const before = phone.challenges.length;
  phone.raw(lastReq);
  check('a replayed request is answered with a new challenge, not run', (await phone.nextChallenge(before)) !== null);
  const recordedHello = phone.sent[0];
  const eve = await device({ deviceId: 'eve-1', name: 'Recorder' });
  await eve.nextChallenge(0);
  eve.raw(recordedHello);
  await sleep(1500);
  check('a recorded HELLO is not welcomed on another connection', eve.challenges.length === 2);
  const old = await device({ deviceId: 'phone-1', name: 'Pixel', legacy: true });
  check('a legacy phone is still welcomed by default', (await old.doHello()).type === 'welcome');
  const marked = JSON.parse(readFileSync(join(dataDir, 'remote.json'), 'utf8'));
  check('and marked as legacy', marked.devices?.[0]?.legacyProtocol === true);
  check('its requests need no counter', Array.isArray(await old.call('sessions:summaries')));

  const replay = await device({ deviceId: 'replay-1', name: 'Replayer', pair: grant.code });
  const r = await replay.doHello();
  check('the code is single-use', r.type === 'denied' && r.reason === 'bad-code');

  const g2 = await api('remote:pair');
  const tablet = await device({ deviceId: 'tablet-1', name: 'Tablet', pair: g2.code });
  check('the computer pairs a second device', (await tablet.doHello()).type === 'welcome');
  await api('remote:revoke', 'tablet-1');
  check('revocation kicks it live (4001)', (await tablet.closed) === 4001);
  const zombie = await device({ deviceId: 'tablet-1', name: 'Tablet' });
  const z = await zombie.doHello();
  check('and denies it on return', z.type === 'denied' && z.reason === 'revoked');

  const pass = results.every(Boolean);
  console.log(`\n${pass ? 'DAEMON RELAY PATH PASS' : 'FAIL'} (relay ${RELAY_URL})`);
  stop();
  process.exit(pass ? 0 : 1);
} catch (e) {
  console.error('FAIL', e.message, '\n', serverOut.slice(-3000));
  stop();
  process.exit(1);
}
