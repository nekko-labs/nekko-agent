// Proves the phone-remote-control path end to end: paired device → relay →
// local agent (host). Exercises the v2 security model: transport auth (room
// key), the E2E HELLO handshake, one-time pairing codes, denial of unknown
// devices, remote device management (pairing a second device from the first),
// and live revocation (kick + re-deny).
//
// Usage: node scripts/itest-relay.mjs [--relay=wss://nekko-agent-relay.fly.dev] [baseUrl] [model]
// With no --relay, spawns a local relay from apps/relay/dist.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deriveKey, seal, open } from '@nekko-agent/shared';

const args = process.argv.slice(2);
const relayArg = args.find((a) => a.startsWith('--relay='));
const rest = args.filter((a) => !a.startsWith('--'));
const baseUrl = rest[0] || 'http://127.0.0.1:1338';
const ROOM = `itest-${Math.random().toString(36).slice(2, 10)}`;
const PAIR_KEY = 'secret123';
const RELAY_PORT = 4455;
const RELAY_URL = relayArg ? relayArg.slice('--relay='.length) : `ws://127.0.0.1:${RELAY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'nekko-relay-'));
writeFileSync(
  join(dataDir, 'settings.json'),
  JSON.stringify({ providers: [{ id: 'lm', kind: 'lmstudio', label: 'LM Studio', baseUrl, enabled: true }] }),
);

const procs = [];
const stop = () => procs.forEach((p) => p.kill());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `, ${detail}` : ''}`);
};

// 1. relay (skipped when testing a remote/managed relay)
if (!relayArg) {
  procs.push(
    spawn('node', ['apps/relay/dist/index.js'], {
      env: { ...process.env, NEKKO_RELAY_PORT: String(RELAY_PORT), NEKKO_RELAY_HOST: '127.0.0.1' },
      stdio: 'ignore',
    }),
  );
  await sleep(800);
}

// 2. relay-agent (the "local machine"); capture its printed pairing code.
let pairCode = null;
const agent = spawn('node', ['apps/web-app-server/dist/index.js'], {
  env: {
    ...process.env,
    NEKKO_RELAY_URL: RELAY_URL,
    NEKKO_ROOM: ROOM,
    NEKKO_PAIR_KEY: PAIR_KEY,
    NEKKO_DATA_DIR: dataDir,
  },
  stdio: ['ignore', 'pipe', 'inherit'],
});
procs.push(agent);
agent.stdout.on('data', (d) => {
  const m = String(d).match(/pairing code \(10 min\): ([A-Z2-9]+)/);
  if (m) pairCode = m[1];
});
for (let i = 0; i < 40 && !pairCode; i++) await sleep(200);
check('agent boot printed a pairing code', !!pairCode, pairCode ?? 'none');

const e2eKey = await deriveKey(PAIR_KEY, ROOM);

/** Minimal v2 device client: connects, hellos, then makes sealed req calls. */
async function device({ deviceId, name, pair }) {
  const ws = new WebSocket(`${RELAY_URL.replace(/\/$/, '')}/relay?role=client&room=${ROOM}&key=${PAIR_KEY}`);
  const pending = new Map();
  let nextId = 1;
  let hello = null;
  let onHello = null;
  const closed = new Promise((res) => ws.addEventListener('close', (ev) => res(ev.code)));
  ws.onmessage = async (ev) => {
    let env;
    try {
      env = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
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
    }
  };
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('client ws failed'));
  });
  const sendSealed = async (frame) => ws.send(JSON.stringify({ enc: await seal(e2eKey, frame) }));
  const call = async (channel, ...callArgs) => {
    const id = nextId++;
    return new Promise(async (resolve, reject) => {
      pending.set(id, { resolve, reject });
      await sendSealed({ type: 'req', id, channel, args: callArgs });
      setTimeout(() => pending.has(id) && reject(new Error(`timeout: ${channel}`)), 20000);
    });
  };
  const doHello = () =>
    new Promise(async (res) => {
      onHello = res;
      await sendSealed({ type: 'hello', deviceId, name, platform: 'web', ...(pair ? { pair } : {}) });
      setTimeout(() => res(hello ?? { type: 'timeout' }), 8000);
    });
  return { ws, call, doHello, sendSealed, closed, get helloReply() { return hello; } };
}

// 3. Wrong transport key is rejected at the relay.
const wrongKeyRejected = await new Promise((resolve) => {
  const bad = new WebSocket(`${RELAY_URL.replace(/\/$/, '')}/relay?role=client&room=${ROOM}&key=nope`);
  bad.onclose = (ev) => resolve(ev.code === 1008);
  setTimeout(() => resolve(false), 10000);
});
check('wrong-key client rejected at transport', wrongKeyRejected);

try {
  // 4. Right key but NO handshake → requests are refused.
  const sneaky = await device({ deviceId: 'sneaky-1', name: 'No hello' });
  const refused = await sneaky.call('settings:get').then(
    () => false,
    (e) => /not paired/.test(e.message),
  );
  check('request without HELLO refused', refused);

  // 5. Unknown device without a pairing code → denied + kicked.
  const strangerReply = await sneaky.doHello();
  check('unknown device denied', strangerReply.type === 'denied' && strangerReply.reason === 'unknown-device');
  check('denied device kicked (4001)', (await sneaky.closed) === 4001);

  // 6. Enroll device 1 with the boot pairing code → welcome + working calls.
  const phone = await device({ deviceId: 'phone-1', name: "Philip's phone", pair: pairCode });
  const w1 = await phone.doHello();
  check('device 1 enrolled via pairing code', w1.type === 'welcome' && w1.device?.name === "Philip's phone");
  const settings = await phone.call('settings:get');
  check('device 1 drives the host (settings:get)', Array.isArray(settings?.providers));
  const test = await phone.call('providers:test', 'lm');
  console.log(`   (model server ${test?.ok ? 'reachable: ' + baseUrl : 'not reachable, fine for this test'})`);

  // 7. Pairing code is single-use.
  const replayer = await device({ deviceId: 'replay-1', name: 'Replayer', pair: pairCode });
  const replayReply = await replayer.doHello();
  check('pairing code is single-use', replayReply.type === 'denied' && replayReply.reason === 'bad-code');

  // 8. Manage remotely: device 1 mints a code and enrolls device 2.
  const grant = await phone.call('remote:pair');
  check('device 1 minted a new pairing code remotely', typeof grant?.code === 'string');
  const tablet = await device({ deviceId: 'tablet-1', name: 'iPad', pair: grant.code });
  const w2 = await tablet.doHello();
  check('device 2 enrolled with the remote-minted code', w2.type === 'welcome');

  // 9. Revoke device 2 from device 1 → live kick + re-deny.
  const devices = await phone.call('remote:devices');
  check('registry lists both devices', devices.filter((d) => !d.revoked).length === 2);
  await phone.call('remote:revoke', 'tablet-1');
  check('revoked device kicked live (4001)', (await tablet.closed) === 4001);
  const zombie = await device({ deviceId: 'tablet-1', name: 'iPad' });
  const zombieReply = await zombie.doHello();
  check('revoked device denied on return', zombieReply.type === 'denied' && zombieReply.reason === 'revoked');

  const pass = results.every(Boolean);
  console.log(`\n${pass ? 'REMOTE CONTROL PATH PASS ✅' : 'FAIL ❌'} (relay: ${RELAY_URL})`);
  stop();
  process.exit(pass ? 0 : 1);
} catch (e) {
  console.error('FAIL ❌', e.message);
  stop();
  process.exit(1);
}
