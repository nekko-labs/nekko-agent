// The Telegram bridge through the web edition behind nekkod (PF14 A4): the
// daemon polls a loopback stand-in for the Bot API, refuses an unlisted
// chat, starts a turn for an allowed one through its own admission, streams
// the reply into one Telegram message, answers `messaging:status`, and stops
// polling when disabled. The backend never runs a bridge of its own.
//
// Runs on an isolated temporary data dir and home with a loopback scripted
// model and a fake Bot API (`NEKKO_TELEGRAM_API_URL`); no real bot or token is
// used, and nothing touches the user's data or a running app. Every process it
// starts is ended with its whole tree.
//
// Usage: node scripts/itest-messaging-daemon.mjs [path/to/nekkod]
// Needs `npm run build:web` and `cargo build -p nekkod`.
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
if (!existsSync(nekkod)) throw new Error(`missing ${nekkod}: cargo build -p nekkod`);

const SERVER_PORT = 5900 + Math.floor(Math.random() * 400);
const TOKEN = randomBytes(24).toString('hex');
const BOT = '123:TEST';
const root = mkdtempSync(join(tmpdir(), 'nekko-messaging-'));
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

// A scripted OpenAI-compatible model streaming its answer in three pieces.
const requests = [];
const model = createServer((req, res) => {
  if (req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ object: 'list', data: [{ id: 'synthetic', object: 'model' }] }));
  }
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', async () => {
    const parsed = JSON.parse(body || '{}');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    // The chat's auto-title is a side call, answered at once and not counted.
    const titling = JSON.stringify(parsed.messages ?? []).includes('short title');
    if (!titling) requests.push(parsed);
    // Slower than the bridge's 1.5 s flush, so the reply is sent and then edited.
    for (const piece of titling ? ['Telegram chat'] : ['Hello ', 'from ', 'nekkod']) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
      if (!titling) await sleep(1_000);
    }
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
});
await new Promise((r) => model.listen(0, '127.0.0.1', r));
const modelUrl = `http://127.0.0.1:${model.address().port}/v1`;

// The fake Bot API: every call recorded; getUpdates held until updates are queued.
const tgCalls = [];
const queued = [];
let waiter = null;
let nextMessage = 900;
const telegram = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const [, bot, method] = req.url.split('/');
    const json = JSON.parse(body || '{}');
    tgCalls.push({ bot, method, body: json, at: Date.now() });
    const reply = (result) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result }));
    };
    if (method === 'getMe') return reply({ id: 7, is_bot: true, username: 'nekko_live_bot' });
    if (method === 'sendMessage') return reply({ message_id: nextMessage++, chat: { id: Number(json.chat_id), type: 'private' } });
    if (method === 'getUpdates') {
      if (queued.length) return reply(queued.splice(0));
      const timer = setTimeout(() => {
        waiter = null;
        reply([]);
      }, 25_000);
      waiter = (batch) => {
        clearTimeout(timer);
        reply(batch);
      };
      // `res`, not `req`: a request's 'close' fires once its body is read.
      res.on('close', () => {
        if (!res.writableEnded) {
          clearTimeout(timer);
          waiter = null;
        }
      });
      return;
    }
    reply(true);
  });
});
await new Promise((r) => telegram.listen(0, '127.0.0.1', r));
const push = (batch) => {
  if (waiter) {
    const w = waiter;
    waiter = null;
    w(batch);
  } else queued.push(...batch);
};

const server = spawn(process.execPath, ['apps/web-app-server/dist/index.js'], {
  env: {
    ...process.env,
    NEKKO_PORT: String(SERVER_PORT),
    NEKKO_HOST: '127.0.0.1',
    NEKKO_DATA_DIR: dataDir,
    NEKKO_TOKEN: TOKEN,
    NEKKOD_PATH: nekkod,
    NEKKO_TELEGRAM_API_URL: `http://127.0.0.1:${telegram.address().port}`,
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
const until = async (what, fn, ms = 20_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
};

try {
  await until('the server', async () => {
    try {
      return (await fetch(`http://127.0.0.1:${SERVER_PORT}/health`)).ok;
    } catch {
      return false;
    }
  }, 60_000);
  check('engine is nekkod', /nekkod/.test(serverOut), serverOut.split('\n').find((l) => /engine/.test(l)) ?? '');

  await api('providers:save', { id: 'p1', kind: 'openai-compat', label: 'Scripted', baseUrl: modelUrl, enabled: true });
  await api('settings:update', { defaultProviderId: 'p1', defaultModelId: 'synthetic', defaultChatMode: 'yolo' });
  const before = await api('messaging:status');
  check('status is empty while unconfigured', JSON.stringify(before) === '{}', JSON.stringify(before));

  await api('settings:update', { messaging: { telegram: { enabled: true, botToken: BOT, allowedChatIds: ['42'] } } });
  await until('the first long poll', () => tgCalls.some((c) => c.method === 'getUpdates'));
  const status = await until('getMe', async () => (await api('messaging:status')).telegram?.botUsername).then(() => api('messaging:status'));
  check('messaging:status from the daemon', status.telegram?.running === true && status.telegram.botUsername === 'nekko_live_bot' && status.telegram.boundChats === 0, JSON.stringify(status));
  check('every call carries the bot token in the path', tgCalls.every((c) => c.bot === `bot${BOT}`));

  push([
    { update_id: 1, message: { message_id: 1, chat: { id: 99, type: 'private' }, text: 'let me in' } },
    { update_id: 2, message: { message_id: 2, chat: { id: 42, type: 'private' }, text: 'say hello' } },
  ]);
  await until('the refusal', () => tgCalls.some((c) => c.method === 'sendMessage' && c.body.chat_id === '99'));
  check('unlisted chat refused', tgCalls.find((c) => c.body.chat_id === '99').body.text === 'Nekko Agent: this chat is not on the allowlist.');
  const t0 = Date.now();
  await until('the final reply', () => tgCalls.some((c) => c.method === 'editMessageText' && c.body.text === 'Hello from nekkod'), 30_000);
  const to42 = tgCalls.filter((c) => c.body.chat_id === '42');
  const edits = to42.filter((c) => c.method === 'editMessageText');
  check(
    'one message, then edits',
    to42.filter((c) => c.method === 'sendMessage').length === 1 && edits.length >= 1 && new Set(edits.map((c) => c.body.message_id)).size === 1,
    to42.map((c) => `${c.method}:${JSON.stringify(c.body.text)}`).join(' | '),
  );
  check('reply took the turn through the model', requests.length === 1 && requests[0].messages.at(-1).content === 'say hello', `${Date.now() - t0} ms`);
  const state = JSON.parse(readFileSync(join(dataDir, 'messaging-state.json'), 'utf8'));
  const sid = state.bindings['42'];
  check('state file written by the daemon', state.offset === 3 && typeof sid === 'string' && !state.bindings['99'], JSON.stringify(state));
  const chat = JSON.parse(readFileSync(join(dataDir, 'sessions', `${sid}.json`), 'utf8'));
  check('the reply is saved in the bound chat', chat.messages.at(-1)?.content === 'Hello from nekkod');
  const after = await api('messaging:status');
  check('boundChats counts the new binding', after.telegram?.boundChats === 1, JSON.stringify(after));

  // A second message continues the same chat, once the first chain (its
  // title included) has ended: a message meanwhile is refused as busy.
  await until('the chain to end', async () => !(await api('chat:running')).includes(sid));
  push([{ update_id: 3, message: { message_id: 3, chat: { id: 42, type: 'private' }, text: 'again' } }]);
  const finals = () => tgCalls.filter((c) => c.method === 'editMessageText' && c.body.text === 'Hello from nekkod').length;
  const before2 = finals();
  await until('the second reply', () => requests.length === 2 && finals() > before2, 30_000);
  const state2 = JSON.parse(readFileSync(join(dataDir, 'messaging-state.json'), 'utf8'));
  check('same chat continues', state2.bindings['42'] === sid && Object.keys(state2.bindings).length === 1);

  const polls = tgCalls.filter((c) => c.method === 'getUpdates').length;
  await api('settings:update', { messaging: { telegram: { enabled: false, botToken: BOT, allowedChatIds: ['42'] } } });
  await until('the bridge to stop', async () => JSON.stringify(await api('messaging:status')) === '{}', 5_000);
  await sleep(1_000);
  check('no poll after disabling', tgCalls.filter((c) => c.method === 'getUpdates').length === polls);

  // Timing: messaging:status through the public server.
  const times = [];
  for (let i = 0; i < 20; i++) {
    const s = performance.now();
    await api('messaging:status');
    times.push(performance.now() - s);
  }
  times.sort((a, b) => a - b);
  console.log(`messaging:status p50 ${times[10].toFixed(2)} ms`);
} catch (e) {
  check('run', false, e.message);
  console.log('telegram calls:', JSON.stringify(tgCalls.filter((c) => c.method !== 'getUpdates').map((c) => [c.method, c.body])));
  console.log('model requests:', requests.length);
  try {
    console.log('state:', readFileSync(join(dataDir, 'messaging-state.json'), 'utf8'));
    for (const f of (await import('node:fs')).readdirSync(join(dataDir, 'sessions'))) console.log(f, readFileSync(join(dataDir, 'sessions', f), 'utf8').slice(0, 1500));
  } catch (err) {
    console.log('no state', err.message);
  }
  console.log(serverOut.slice(-3000));
} finally {
  for (const p of procs) killTree(p);
  model.close();
  telegram.close();
  telegram.closeAllConnections?.();
  model.closeAllConnections?.();
  await sleep(500);
  try { rmSync(root, { recursive: true, force: true }); } catch { /* a child may still hold a file */ }
}
const ok = results.length > 0 && results.every(Boolean);
console.log(`${results.filter(Boolean).length}/${results.length} checks passed`);
process.exit(ok ? 0 : 1);
