// The turn variants through the web edition behind nekkod (PF14 A2):
// compaction, cancelling one, starting a queued prompt at once, and an image
// turn, each answered by the daemon with the real TS backend beside it.
//
// Runs on an isolated temporary data dir and home with a loopback scripted
// model (and the stand-in sd-server from `cargo build -p nekkod --examples`);
// never touches the user's data or a running app. Every process it starts is
// ended with its whole tree.
//
// Usage: node scripts/itest-turn-variants.mjs [path/to/nekkod]
// Needs `npm run build:web` and `cargo build -p nekkod --examples`.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { killTree, treeOptions } from './itest-procs.mjs';

const exe = process.platform === 'win32' ? '.exe' : '';
const targetDir = process.env.CARGO_TARGET_DIR ?? 'target';
const nekkod = resolve(process.argv[2] ?? join(targetDir, 'debug', `nekkod${exe}`));
const fakeSd = resolve(join(targetDir, 'debug', 'examples', `fake_sd_server${exe}`));
for (const p of [nekkod, fakeSd]) if (!existsSync(p)) throw new Error(`missing ${p}: cargo build -p nekkod --examples`);

const SERVER_PORT = 5900 + Math.floor(Math.random() * 400);
const ENGINE_PORT = SERVER_PORT + 400;
const TOKEN = randomBytes(24).toString('hex');
const root = mkdtempSync(join(tmpdir(), 'nekko-turn-variants-'));
const dataDir = join(root, 'data');
const home = join(root, 'home');
mkdirSync(join(dataDir, 'sessions'), { recursive: true });
mkdirSync(home, { recursive: true });

const procs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
};

// A scripted OpenAI-compatible model: a summary for compaction calls, a hold
// for the first chat turn (so it can be interrupted), a plain answer otherwise.
let holdNext = false;
const held = [];
const requests = [];
const model = createServer((req, res) => {
  // The model list (the daemon asks it for the context window) is not a chat call.
  if (req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ object: 'list', data: [{ id: 'synthetic', object: 'model' }] }));
  }
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const json = JSON.parse(body || '{}');
    requests.push(json);
    const text = JSON.stringify(json.messages ?? []);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const say = (t) => {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: t }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 5 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    };
    if (text.includes('Summarize this transcript segment')) {
      if (text.includes('HOLD-SUMMARY')) { res.write(': waiting\n\n'); held.push(res); return; }
      return say('Summary: the user asked things and got answers.');
    }
    if (holdNext) { holdNext = false; res.write(': waiting\n\n'); held.push(res); return; }
    say(`answer to ${json.messages?.at(-1)?.content ?? ''}`.slice(0, 80));
  });
});
await new Promise((r) => model.listen(0, '127.0.0.1', r));
const modelUrl = `http://127.0.0.1:${model.address().port}/v1`;

// An image model the library reads as one, and the stand-in sd-server as its runtime.
const imageModel = join(dataDir, 'models', 'image', 'acme_sd', 'tiny-sd.gguf');
mkdirSync(join(imageModel, '..'), { recursive: true });
writeFileSync(imageModel, tinyGguf('sd1', 'Tiny SD'));
mkdirSync(join(dataDir, 'engine', 'diffusion'), { recursive: true });
writeFileSync(join(dataDir, 'engine', 'diffusion', 'engine.json'), JSON.stringify({ buildId: 'fake', binPath: fakeSd, version: 'fake' }));

const server = spawn(process.execPath, ['apps/web-app-server/dist/index.js'], {
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
let serverOut = '';
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
const session = (id) => JSON.parse(readFileSync(join(dataDir, 'sessions', `${id}.json`), 'utf8'));
const writeSession = (s) => writeFileSync(join(dataDir, 'sessions', `${s.id}.json`), JSON.stringify(s, null, 2));
const until = async (what, fn, ms = 20_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
};

try {
  let info = null;
  for (let i = 0; i < 160 && !info?.owned; i++) {
    info = await api('daemon:info').catch(() => null);
    if (!info?.owned) await sleep(250);
  }
  if (!info?.owned) throw new Error(`the server never came up:\n${serverOut}`);
  for (const c of ['chat:compact', 'chat:cancelCompaction', 'chat:interruptQueued', 'chat:generateImage']) {
    check(`daemon owns ${c}`, info.owned.includes(c));
  }
  // Configure through the API, as the UI does (the daemon writes settings.json).
  await api('providers:save', { id: 'p1', kind: 'openai-compat', label: 'Scripted', baseUrl: modelUrl, enabled: true });
  await api('engine:settings', { port: ENGINE_PORT });
  const providers = (await api('settings:get')).providers ?? [];
  check('the scripted provider is saved', providers.some((p) => p.id === 'p1' && p.enabled), JSON.stringify(providers.map((p) => [p.id, p.kind, p.enabled])));

  // Compaction: three turns, then compact through the public server.
  const long = (s) => `${s} ${'background detail '.repeat(30)}`;
  writeSession({
    id: 's_live', title: 'Live chat', providerId: 'p1', modelId: 'synthetic', executionMode: 'unified', gitIsolation: false,
    messages: [
      { id: 'u1', role: 'user', content: long('First request'), createdAt: 1 },
      { id: 'a1', role: 'assistant', content: long('First answer'), createdAt: 2 },
      { id: 'u2', role: 'user', content: 'Second request', createdAt: 3 },
      { id: 'a2', role: 'assistant', content: 'Second answer', createdAt: 4 },
      { id: 'u3', role: 'user', content: 'Third request', createdAt: 5 },
      { id: 'a3', role: 'assistant', content: 'Third answer', createdAt: 6 },
    ],
    createdAt: 1, updatedAt: 1,
  });
  const landed = await api('chat:compact', 's_live', null);
  const compacted = session('s_live').messages;
  check('compaction lands the summary after what it replaces', compacted.length === 7 && compacted[2].compaction?.summarized === 2 && landed.id === 's_live', JSON.stringify(compacted[2]));

  // Cancel mid-compaction.
  writeSession({
    id: 's_cancel', title: 'Cancel', providerId: 'p1', modelId: 'synthetic', executionMode: 'unified', gitIsolation: false,
    messages: [
      { id: 'u1', role: 'user', content: long('HOLD-SUMMARY'), createdAt: 1 },
      { id: 'a1', role: 'assistant', content: 'ok', createdAt: 2 },
    ],
    createdAt: 1, updatedAt: 1,
  });
  const before = session('s_cancel').messages;
  const compacting = api('chat:compact', 's_cancel').then(() => 'landed', (e) => e.message);
  await until('the held summary call', () => held.length > 0);
  const blocked = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/chat:send`, {
    method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ args: [{ sessionId: 's_cancel', providerId: 'p1', modelId: 'synthetic', text: 'hi' }] }),
  });
  check('a turn is refused while the daemon compacts', blocked.ok && session('s_cancel').messages.length === before.length);
  const t0 = Date.now();
  await api('chat:cancelCompaction', 's_cancel');
  const outcome = await compacting;
  check('cancel ends the compaction and keeps the history', /Compaction cancelled/.test(outcome) && JSON.stringify(session('s_cancel').messages) === JSON.stringify(before), `${outcome} in ${Date.now() - t0} ms`);
  held.splice(0).forEach((r) => r.destroy());

  // Start a queued prompt at once, stopping the reply that runs.
  writeSession({ id: 's_jump', title: 'Jump', providerId: 'p1', modelId: 'synthetic', executionMode: 'unified', gitIsolation: false, messages: [], createdAt: 1, updatedAt: 1 });
  holdNext = true;
  const old = api('chat:send', { sessionId: 's_jump', providerId: 'p1', modelId: 'synthetic', text: 'old' });
  await until('the held reply', () => held.length > 0);
  for (const t of ['first', 'selected', 'last']) await api('chat:queue', 's_jump', t);
  await api('chat:interruptQueued', 's_jump', 1);
  await old;
  held.splice(0).forEach((r) => r.destroy());
  const users = session('s_jump').messages.filter((m) => m.role === 'user').map((m) => m.content);
  check('interruptQueued runs the chosen prompt, then the rest in order', JSON.stringify(users) === JSON.stringify(['old', 'selected', 'first', 'last']), JSON.stringify(session('s_jump').messages.map((m) => [m.role, m.content, m.interrupted ?? null])));

  // An image turn on the daemon's model server.
  const models = await api('engine:models');
  const imageRow = models.find((m) => m.modality === 'image');
  check('the library lists the image model', !!imageRow);
  writeSession({ id: 's_img', title: 'New chat', messages: [], createdAt: 1, updatedAt: 1 });
  const events = [];
  const ws = new WebSocket(`ws://127.0.0.1:${SERVER_PORT}/api/events?token=${TOKEN}`);
  ws.onmessage = (m) => { try { const e = JSON.parse(m.data); if (e.channel === 'agent:event' && e.payload.sessionId === 's_img') events.push(e.payload); } catch { /* not ours */ } };
  await until('the events socket', () => ws.readyState === 1);
  await api('chat:generateImage', { sessionId: 's_img', prompt: 'a calico cat', params: { modelId: imageRow.id, width: 512, height: 512, steps: 4, cfgScale: 1, seed: 7 } });
  await until('the image turn done event', () => events.some((e) => e.type === 'done'));
  const img = session('s_img');
  const stages = events.filter((e) => e.type === 'image_status').map((e) => e.label);
  check('the image turn lands a generated reply', img.chatType === 'image' && img.messages[1]?.generated?.seed === 7 && /^data:image\/png;base64,/.test(img.messages[1]?.images?.[0] ?? ''), JSON.stringify(img.messages[1]?.generated));
  check('the image turn reports its stages', stages.includes('Loading the image model') && stages.at(-1) === 'Generating a 512×512 image', JSON.stringify(stages));
  ws.close();
  await api('engine:stop').catch(() => {});
} catch (e) {
  check('run', false, `${e.message}\n${serverOut.slice(-4000)}`);
} finally {
  for (const p of procs) killTree(p);
  model.close();
  model.closeAllConnections?.();
  await sleep(1500);
  try { rmSync(root, { recursive: true, force: true }); } catch { /* a child may still hold a file */ }
}
const failed = results.filter((ok) => !ok).length;
console.log(failed ? `${failed} FAILED` : `all ${results.length} passed`);
process.exit(failed ? 1 : 0);

/** A minimal GGUF header naming an architecture, which the library reads. */
function tinyGguf(arch, name) {
  const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const s = (v) => Buffer.concat([u64(Buffer.byteLength(v)), Buffer.from(v)]);
  const text = (v) => Buffer.concat([u32(8), s(v)]);
  const int = (n) => Buffer.concat([u32(4), u32(n)]);
  const pairs = [['general.architecture', text(arch)], ['general.name', text(name)], ['general.file_type', int(15)]];
  return Buffer.concat([u32(0x46554747), u32(3), u64(0), u64(pairs.length), ...pairs.map(([k, v]) => Buffer.concat([s(k), v])), Buffer.alloc(64)]);
}
