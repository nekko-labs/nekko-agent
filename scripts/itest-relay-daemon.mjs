// The phone path with the relay agent in the engine daemon (crates/nekko-remote):
// a device on a local apps/relay reaches the web edition, which runs behind
// nekkod, whose agent dials the relay. Checks transport auth, the sealed HELLO,
// one-time pairing, requests to the daemon and through it to the TS host,
// host events fanned out to the phone, and live revocation.
//
// Never point this at the managed relay with real devices: it always starts
// its own relay on loopback.
//
// Usage: node scripts/itest-relay-daemon.mjs [path/to/nekkod]
// Needs `npm run build:web`, `npm run build -w @nekko-agent/relay` and a cargo build of nekkod.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { deriveKey, seal, open } from '@nekko-agent/shared';

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
const dataDir = mkdtempSync(join(tmpdir(), 'nekko-relay-daemon-'));

const procs = [];
const stop = () => {
  for (const p of procs) {
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true });
      else p.kill('SIGKILL');
    } catch {
      /* gone */
    }
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
};

procs.push(
  spawn(process.execPath, ['apps/relay/dist/index.js'], {
    env: { ...process.env, NEKKO_RELAY_PORT: String(RELAY_PORT), NEKKO_RELAY_HOST: '127.0.0.1', NEKKO_RELAY_ALLOW_UNAUTHENTICATED: '1' },
    stdio: 'ignore',
    windowsHide: true,
  }),
);
let serverOut = '';
const server = spawn(process.execPath, ['apps/server/dist/index.js'], {
  env: {
    ...process.env,
    NEKKO_PORT: String(SERVER_PORT),
    NEKKO_HOST: '127.0.0.1',
    NEKKO_DATA_DIR: dataDir,
    NEKKO_TOKEN: TOKEN,
    NEKKO_DAEMON: 'nekkod',
    NEKKOD_PATH: nekkod,
  },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
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
  check('the web edition runs behind nekkod', info?.app === 'nekkod', JSON.stringify(info?.backend));
  check('the daemon owns remote access', info?.owned?.includes('remote:status'));

  const status = await api('remote:enable', RELAY_URL);
  check('remote access enabled through the daemon', status?.enabled === true);
  const { room, key } = await api('remote:pairing');
  const grant = await api('remote:pair');
  const e2eKey = await deriveKey(key, room);
  let online = false;
  for (let i = 0; i < 40 && !online; i++) {
    online = (await api('remote:status'))?.online === true;
    if (!online) await sleep(250);
  }
  check('the daemon agent is online at the relay', online);

  async function device({ deviceId, name, pair }) {
    const ws = new WebSocket(`${RELAY_URL}/relay?role=client&room=${room}&key=${key}`);
    const pending = new Map();
    const events = [];
    let nextId = 1;
    let hello = null;
    let onHello = null;
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
      if (f.type === 'welcome' || f.type === 'denied') {
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
    const sendSealed = async (frame) => ws.send(JSON.stringify({ enc: await seal(e2eKey, frame) }));
    const call = (channel, ...callArgs) =>
      new Promise(async (resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        await sendSealed({ type: 'req', id, channel, args: callArgs });
        setTimeout(() => pending.has(id) && reject(new Error(`timeout: ${channel}`)), 20000);
      });
    const doHello = () =>
      new Promise(async (res) => {
        onHello = res;
        await sendSealed({ type: 'hello', deviceId, name, platform: 'android', ...(pair ? { pair } : {}) });
        setTimeout(() => res(hello ?? { type: 'timeout' }), 8000);
      });
    return { ws, call, doHello, closed, events };
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
  const settings = await phone.call('settings:get');
  check('the phone reaches the TS host through the daemon (settings:get)', typeof settings === 'object' && settings !== null);
  const sessions = await phone.call('sessions:summaries');
  check('the phone reaches a daemon service (sessions:summaries)', Array.isArray(sessions));
  check(
    'internal callbacks are not public',
    await phone.call('turn:pending').then(() => false, (e) => /Unknown channel/.test(e.message)),
  );
  // A host event fans out to the phone: creating a task fires tasks:updated.
  await phone.call('task:create', { title: 'From the phone', kind: 'scheduled', prompt: 'hi', runAt: Date.now() + 3_600_000 });
  for (let i = 0; i < 40 && !phone.events.some((e) => e.channel === 'tasks:updated'); i++) await sleep(100);
  check('host events reach the phone (tasks:updated)', phone.events.some((e) => e.channel === 'tasks:updated'));

  const replay = await device({ deviceId: 'replay-1', name: 'Replayer', pair: grant.code });
  const r = await replay.doHello();
  check('the code is single-use', r.type === 'denied' && r.reason === 'bad-code');

  const g2 = await phone.call('remote:pair');
  const tablet = await device({ deviceId: 'tablet-1', name: 'Tablet', pair: g2.code });
  check('the phone pairs a second device', (await tablet.doHello()).type === 'welcome');
  await phone.call('remote:revoke', 'tablet-1');
  check('revocation kicks it live (4001)', (await tablet.closed) === 4001);
  const zombie = await device({ deviceId: 'tablet-1', name: 'Tablet' });
  const z = await zombie.doHello();
  check('and denies it on return', z.type === 'denied' && z.reason === 'revoked');

  const pass = results.every(Boolean);
  console.log(`\n${pass ? 'DAEMON RELAY PATH PASS' : 'FAIL'} (relay ${RELAY_URL})`);
  stop();
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(pass ? 0 : 1);
} catch (e) {
  console.error('FAIL', e.message, '\n', serverOut.slice(-3000));
  stop();
  process.exit(1);
}
