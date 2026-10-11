// Chat-turn timings through the engine daemon, on either turn route (PF14).
//
// Starts nekkod with the desktop TS backend (Electron as Node, so no window)
// on an isolated temporary data dir, points a provider at a local
// OpenAI-compatible model server you started, and measures from the UI's
// side of the wire:
//   - first text: `chat:send` to the first streamed text event;
//   - gaps between text events (p50/p95/max);
//   - approval round trip: `tool:approve` sent to that call's `tool_result`
//     event, and `tool_approval_required` seen to `tool:approve` answered.
// `--load N` keeps N loops of host work going meanwhile (context previews and
// model-library scans), the load earlier PF14 entries measured under.
//
//   npm run build:app && cargo build -p nekkod --release
//   node scripts/bench-chat-turn.mjs --model-url http://127.0.0.1:18431/v1 --model gemma \
//     --route daemon|ts [--runs 3] [--load 8] [--json out.json]
//
// `--route ts` sets NEKKO_AGENT_LOOP=ts on the backend: every turn runs in
// the TS host, the escape hatch. Nothing touches the user's data directory or
// a running app; every spawned process is ended on exit.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? 'true' : all[i + 1]]] : acc), []));
const root = resolve(import.meta.dirname, '..');
const require = createRequire(join(root, 'apps', 'desktop', 'package.json'));
const electron = args.electron ?? require('electron');
const daemonExe = args.daemon ?? join(root, 'target', 'release', process.platform === 'win32' ? 'nekkod.exe' : 'nekkod');
const backendJs = args.backend ?? join(root, 'apps', 'desktop', 'out', 'main', 'backend.js');
const route = args.route ?? 'daemon';
const runs = Number(args.runs ?? 3);
const load = Number(args.load ?? 0);
let modelUrl = args['model-url'] ?? 'http://127.0.0.1:18431/v1';
const model = args.model ?? 'gemma';

// `--fake`: a deterministic model on a loopback port instead of a real one,
// so the numbers are the engine's and not the model's: 40 text tokens 15 ms
// apart, and a write_file call when asked for one.
if (args.fake) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', async () => {
      if (!req.url?.endsWith('/chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: model }] })); return; }
      const request = JSON.parse(body);
      const messages = request.messages ?? [];
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      const afterTool = messages.at(-1)?.role === 'tool';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (chunk) => res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      const text = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content ?? '');
      if (!afterTool && text.includes('write_file')) {
        const file = text.match(/create (\S+) /)?.[1] ?? 'note.txt';
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: file, content: 'hello' }) } }] }, finish_reason: 'tool_calls' }] });
      } else {
        const n = afterTool ? 3 : 40;
        for (let i = 0; i < n; i++) {
          send({ choices: [{ delta: { content: `tok${i} ` }, finish_reason: null }] });
          await new Promise((r) => setTimeout(r, 15));
        }
        send({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: n } });
      }
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  modelUrl = `http://127.0.0.1:${server.address().port}/v1`;
  process.on('exit', () => server.close());
}

const data = mkdtempSync(join(tmpdir(), 'nekko-bench-turn-'));
const workspace = join(data, 'project');
mkdirSync(workspace, { recursive: true });
writeFileSync(join(workspace, 'AGENTS.md'), 'Keep answers short.\n');
for (let i = 0; i < 400; i++) writeFileSync(join(workspace, `file${i}.ts`), `export const value${i} = ${i};\n`);
const token = randomBytes(24).toString('hex');
const children = [];

function cleanup() {
  for (const c of children) {
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else c.kill('SIGKILL');
    } catch { /* gone */ }
  }
}
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

function startDaemon() {
  const env = { ELECTRON_RUN_AS_NODE: '1', NEKKO_BACKEND_DATA_DIR: data, NEKKO_BACKEND_APP: '{}', NEKKO_BACKEND_ORIGINS: '["null"]' };
  if (route === 'ts') env.NEKKO_AGENT_LOOP = 'ts';
  const config = { token, allowedOrigins: ['null'], dataDir: data, backend: { exe: electron, args: [backendJs], env } };
  const child = spawn(daemonExe, [], { env: { ...process.env, NEKKOD_CONFIG: JSON.stringify(config) }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  children.push(child);
  child.stderr.on('data', (d) => { if (args.verbose) process.stderr.write(d); });
  return new Promise((ok, fail) => {
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      const m = buf.match(/NEKKOD_READY (\{.*\})/);
      if (m) ok(JSON.parse(m[1]).port);
    });
    child.on('exit', (code) => fail(new Error(`nekkod exited (${code})`)));
  });
}

const port = await startDaemon();
const base = `http://127.0.0.1:${port}`;
async function call(channel, ...a) {
  const res = await fetch(`${base}/api/${channel}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ args: a }) });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${channel}: ${body?.error ?? res.status}`);
  return body;
}

// Events, timestamped on arrival.
const listeners = new Set();
const ws = new WebSocket(`ws://127.0.0.1:${port}/api/events?token=${token}`);
await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
ws.onmessage = (m) => {
  const at = performance.now();
  const frame = JSON.parse(m.data);
  if (args.trace) console.log(at.toFixed(0), frame.channel, JSON.stringify(frame.payload).slice(0, 200));
  if (frame.channel !== 'agent:event') return;
  for (const l of listeners) l(frame.payload, at);
};

// Wait for the backend (forwarded channels work once it is up).
for (let i = 0; ; i++) {
  try { await call('settings:get'); break; } catch (e) { if (i > 120) throw e; await new Promise((r) => setTimeout(r, 500)); }
}
await call('settings:update', {
  workspaces: [{ id: 'w1', name: 'project', path: workspace, addedAt: Date.now() }],
  providers: [{ id: 'local', kind: 'llamacpp', label: 'Local', baseUrl: modelUrl, enabled: true }],
  defaultChatMode: 'ask',
});
const info = await call('daemon:info');
console.log(`route=${route} daemon owns chat:turn=${info.owned.includes('chat:turn')} load=${load}`);

let busy = load > 0;
let loadCalls = 0;
async function loadLoop(sessionId) {
  while (busy) {
    await Promise.all([call('context:preview', sessionId, []).catch(() => {}), call('engine:folders').catch(() => {})]);
    loadCalls++;
  }
}

function pct(list, p) {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
}

async function newSession() {
  const s = await call('session:create', 'w1');
  await call('session:setOptions', s.id, { gitIsolation: false });
  await call('session:setOptions', s.id, { title: 'bench', mode: 'ask' });
  return s.id;
}

/** One turn; resolves with its timings once `done` (or an error) arrives. */
function turn(sessionId, text, { approve } = {}) {
  return new Promise((ok, fail) => {
    const t = { texts: [], approvals: [] };
    let start;
    const timer = setTimeout(() => { listeners.delete(on); fail(new Error('turn timed out')); }, Number(args.timeout ?? 180_000));
    const on = (e, at) => {
      if (e.sessionId !== sessionId || e.relayOnly) return;
      if (e.type === 'text') t.texts.push(at);
      if (e.type === 'tool_approval_required' && approve) {
        const rec = { id: e.call.id, sent: performance.now(), seenAt: at };
        t.approvals.push(rec);
        call('tool:approve', sessionId, e.call.id, true).then(() => { rec.seenToAnswered = performance.now() - rec.seenAt; });
      }
      if (e.type === 'tool_result') {
        const rec = t.approvals.find((x) => x.id === e.result.toolCallId);
        if (rec) rec.toResult = at - rec.sent;
      }
      if (e.type === 'done' || e.type === 'error') {
        clearTimeout(timer);
        listeners.delete(on);
        setTimeout(() => ok({
          error: e.type === 'error' ? e.message : undefined,
          firstText: t.texts.length ? t.texts[0] - start : null,
          gaps: t.texts.slice(1).map((x, i) => x - t.texts[i]),
          approvals: t.approvals,
        }), 50);
      }
    };
    listeners.add(on);
    start = performance.now();
    call('chat:send', { sessionId, providerId: 'local', modelId: model, text }).catch(fail);
  });
}

const results = { route, load, runs: [] };
try {
  const warm = await newSession();
  await turn(warm, 'Reply with one word: ready.');
  const loaders = busy ? Array.from({ length: load }, () => loadLoop(warm)) : [];
  for (let i = 0; i < runs; i++) {
    const sid = await newSession();
    const text = await turn(sid, 'Write four short sentences about cats. Do not use any tools.');
    const tool = await turn(sid, `Use the write_file tool to create note${i}.txt in the project containing exactly: hello ${i}. Then reply "done".`, { approve: true });
    const r = { firstText: text.firstText, gaps: text.gaps, error: text.error ?? tool.error, approvals: tool.approvals };
    results.runs.push(r);
    console.log(`run ${i + 1}: first text ${r.firstText?.toFixed(0)} ms, gaps p50 ${pct(r.gaps, 0.5)?.toFixed(1)} p95 ${pct(r.gaps, 0.95)?.toFixed(1)} max ${Math.max(...r.gaps, 0).toFixed(1)} ms, approval ${tool.approvals.map((a) => `${a.toResult?.toFixed(1)} ms to result (${a.seenToAnswered.toFixed(1)} ms to answer)`).join(', ') || 'none'}${r.error ? `, error: ${r.error}` : ''}`);
  }
  busy = false;
  await Promise.all(loaders);
  const all = (f) => results.runs.flatMap(f).filter((x) => typeof x === 'number');
  results.summary = {
    firstTextMedian: pct(all((r) => [r.firstText]), 0.5),
    gapP50: pct(all((r) => r.gaps), 0.5),
    gapP95: pct(all((r) => r.gaps), 0.95),
    gapMax: Math.max(...all((r) => r.gaps)),
    approvalToResultMedian: pct(all((r) => r.approvals.map((a) => a.toResult)), 0.5),
    approvalAnswerMedian: pct(all((r) => r.approvals.map((a) => a.seenToAnswered)), 0.5),
    loadCalls,
  };
  console.log(JSON.stringify(results.summary));
  if (args.json) writeFileSync(args.json, JSON.stringify(results, null, 2));
} finally {
  busy = false;
  ws.close();
  cleanup();
  setTimeout(() => { try { rmSync(data, { recursive: true, force: true }); } catch { /* still held */ } process.exit(0); }, 1500);
}
