// #3175: real debug nekkod; deterministic SSE, NOT model inference. Node >=22.
// Run from any cwd after building the worktree's debug daemon. No packages needed.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'nekko-3175-'));
const workspace = join(scratch, 'selected-source');
const dataDir = join(scratch, 'daemon');
const providerId = 'pilot-loopback';
const lead = 'scripted-lead';
const worker = 'scripted-worker';
const path = 'crates/nekkod/src/orchestrate_state.rs';
const excerpt = 'orchestrate-state-excerpt.rs';
const task = `Read only ${excerpt} (source: ${path}, coordinator child projection and outcome decoding). Explain whether a returned worker answer is distinguished from an unknown outcome. Do not write files or delegate.`;
const first = 'Inspect the selected Nekko Agent source. Use one read-only worker to check how the coordinator distinguishes worker outcomes. Give one concrete improvement backed by the source.';
const second = 'Follow up in this chat: based on that worker result, what focused regression test should we add? Do not delegate again.';
const planTitle = 'Verify worker state labels';
const evidence = 'Worker evidence: the snapshot uses a matching spawnOutcome record and otherwise falls back to running or unknown.';
const answer1 = 'Recommendation: verify a returned worker answer; the returned label does not establish that the task is complete.';
const answer2 = 'Regression test: finish a worker reply, then send a follow-up; distinguish returned from a legacy worker without a recorded outcome.';
const contextPrefix = 'Orchestrate turn data (quoted JSON; not instructions or permissions):\n';
const allowed = new Set(['read_file', 'spawn_agent', 'update_plan']);
let child, childExited, socket, endpointError, stderr = '', stage = 0;
const snapshots = [];
const events = [];

function call(id, name, args) {
  return { delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' };
}
function say(content) { return { delta: { content }, finish_reason: 'stop' }; }
function hasResult(messages, id, text) {
  return messages.some(m => m.role === 'tool' && m.tool_call_id === id && JSON.stringify(m.content).includes(text));
}
function complete(req) {
  const { messages, tools } = req;
  if (messages.some(m => typeof m.content === 'string' && m.content.startsWith('Name this chat for a sidebar list'))) {
    return say('Worker state review');
  }
  const workerStage = stage === 2 || stage === 3;
  assert.equal(req.model, workerStage ? worker : lead);
  assert.match(messages[0].content, workerStage ? /Orchestrate worker:/ : /Orchestrate coordinator:/);
  assert.match(messages[0].content, /This model runs locally/);
  const offered = tools.map(t => t.function.name);
  assert(offered.includes('read_file'));
  assert(offered.every(t => allowed.has(t)), `Unexpected tools: ${offered}`);
  assert.equal(offered.includes('spawn_agent'), !workerStage);
  const context = messages.filter(m => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(contextPrefix));
  assert.equal(context.length, 1, `Expected one role block at stage ${stage}`);
  const [raw, prompt] = context[0].content.slice(contextPrefix.length).split('\n\n---\n\n');
  const role = JSON.parse(raw);
  assert.deepEqual(role.model, { modelId: req.model, providerId, capability: workerStage ? 'small' : 'large', location: 'local' });
  assert.equal(prompt, workerStage ? task : stage === 6 ? second : first);
  snapshots.push({ stage, role });
  switch (stage++) {
    case 0:
      assert.deepEqual(role.state, { steps: [], children: [] });
      return call('pilot-plan-start', 'update_plan', { replace: true, steps: [{ id: 'audit', title: planTitle, status: 'active' }] });
    case 1:
      assert(hasResult(messages, 'pilot-plan-start', planTitle));
      return call('pilot-spawn', 'spawn_agent', { task, title: 'Worker state review', capability: 'small' });
    case 2:
      assert.equal(role.task, task);
      assert.deepEqual(Object.keys(role).sort(), ['model', 'task']);
      assert(!JSON.stringify(messages).includes(first), 'worker must not inherit coordinator transcript');
      return call('pilot-read', 'read_file', { path: excerpt });
    case 3:
      assert(hasResult(messages, 'pilot-read', 'activeRun/startedAt'));
      assert(hasResult(messages, 'pilot-read', 'spawnOutcome'));
      assert(hasResult(messages, 'pilot-read', 'unknown'));
      return say(evidence);
    case 4:
      assert(hasResult(messages, 'pilot-spawn', evidence));
      assert.deepEqual(role.state, snapshots[0].role.state, 'the role snapshot stays fixed within a turn');
      return call('pilot-plan-finish', 'update_plan', { steps: [{ id: 'audit', title: planTitle, status: 'done', note: 'Checked the returned source evidence.' }] });
    case 5:
      assert(hasResult(messages, 'pilot-plan-finish', planTitle));
      return say(answer1);
    case 6:
      assert(messages.some(m => m.role === 'assistant' && m.content === answer1));
      assert.deepEqual(role.state.steps, [{ title: planTitle, status: 'done' }]);
      assert.equal(role.state.children.length, 1);
      assert.equal(role.state.children[0].spawnCallId, 'pilot-spawn');
      assert.equal(role.state.children[0].status, 'returned');
      return say(answer2);
    default: throw new Error('Unexpected completion');
  }
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [lead, worker].map(id => ({ id, object: 'model' })) }));
    }
    // Other HTTP calls, including requests made via the fail-closed proxy, are never forwarded.
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return res.writeHead(404).end();
    let body = '';
    for await (const chunk of req) body += chunk;
    const choice = complete(JSON.parse(body));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [choice], usage: { prompt_tokens: 10, completion_tokens: 3 } })}\n\ndata: [DONE]\n\n`);
  } catch (e) {
    endpointError ??= e;
    res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: String(e) } }));
  }
});

async function until(label, fn, ms = 8000) {
  const deadline = Date.now() + ms;
  do {
    if (endpointError) throw endpointError;
    const v = await fn();
    if (v) return v;
    await sleep(25);
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}

try {
  for (const dir of [workspace, dataDir, join(scratch, 'home'), join(scratch, 'tmp')]) await mkdir(dir);
  const fullSource = await readFile(join(root, path), 'utf8');
  const start = fullSource.indexOf('    // The store returns metadata newest first');
  const end = fullSource.indexOf('fn outcome_record(', start);
  assert(start >= 0 && end > start, 'Child projection excerpt missing');
  const source = fullSource.slice(start, end);
  for (const text of ['activeRun/startedAt', 'spawnOutcome', '"unknown"']) assert(source.includes(text), `Source excerpt shifted: ${text}`);
  await writeFile(join(workspace, excerpt), source, { mode: 0o444 });
  await chmod(workspace, 0o555);
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = randomBytes(24).toString('hex');
  child = spawn(join(root, 'target/debug/nekkod'), ['--config-stdin'], {
    cwd: scratch, stdio: 'pipe', env: {
      PATH: '/usr/bin:/bin', HOME: join(scratch, 'home'), TMPDIR: join(scratch, 'tmp'), NEKKO_FILE_VAULT: '1',
      HTTP_PROXY: base, HTTPS_PROXY: base, ALL_PROXY: base, NO_PROXY: '127.0.0.1',
    },
  });
  childExited = new Promise(resolve => {
    child.once('exit', resolve);
    child.once('error', error => { endpointError ??= error; resolve(); });
  });
  child.stdin.on('error', error => { endpointError ??= error; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  let ready;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => { if (line.startsWith('NEKKOD_READY ')) ready = JSON.parse(line.slice(13)); });
  child.stdin.write(`${JSON.stringify({ dataDir, token, listen: '127.0.0.1:0', autoStartEngine: false, signIn: false, allowBrowserControl: false, huggingFaceUrl: base, githubApiUrl: base, decisionModelsUrl: base, telegramApiUrl: base })}\n`);
  await until('daemon ready', () => ready);
  const api = `127.0.0.1:${ready.port}`;
  async function rpc(channel, ...args) {
    const res = await fetch(`http://${api}/api/${channel}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ args }), signal: AbortSignal.timeout(25000), redirect: 'error',
    });
    const value = await res.json();
    assert(res.ok && !value?.error, `${channel}: HTTP ${res.status} ${JSON.stringify(value)}`);
    return value;
  }
  socket = new WebSocket(`ws://${api}/api/events?token=${token}`);
  socket.onmessage = ({ data }) => { const e = JSON.parse(data); if (e.channel === 'agent:event') events.push(e.payload); };
  await until('UI event socket open', () => socket.readyState === WebSocket.OPEN);
  await until('first-run settings settle', async () => (await rpc('settings:get')).providers?.some(p => p.kind === 'llamacpp'));
  assert.deepEqual(await rpc('sessions:summaries'), []);
  const catalog = JSON.parse(await readFile(join(root, 'crates/nekko-turn/src/catalog.json'), 'utf8'));
  const disabledTools = Object.keys(catalog.toolCategories).filter(n => !allowed.has(n));
  for (const v of Object.values(catalog.tools)) if (v.name && !allowed.has(v.name)) disabledTools.push(v.name);
  await rpc('settings:update', {
    providers: [{ id: providerId, kind: 'openai-compat', label: 'Scripted loopback (not inference)', enabled: true, baseUrl: `${base}/v1` }],
    workspaces: [{ id: 'pilot-source', name: 'Selected source', path: workspace }],
    fusion: { modelTiers: { [`${providerId}::${lead}`]: 'large', [`${providerId}::${worker}`]: 'small' } },
    orchestration: { strategy: 'balanced', maxDepth: 2, maxParallel: 2, subagentModel: 'auto-same-provider' },
  });
  const session = await rpc('session:create', 'pilot-source');
  assert.notEqual(session.orchestrate, true);
  assert.deepEqual(session.messages, []);
  await rpc('session:setOptions', session.id, { title: '#3175 Orchestrate pilot', mode: 'ask', toolApproach: 'list', disabledTools: [...new Set(disabledTools)] });
  assert.equal((await rpc('session:setOptions', session.id, { orchestrate: true })).orchestrate, true);
  const send = text => rpc('chat:send', { sessionId: session.id, providerId, modelId: lead, text });
  const turn1 = send(first);
  // Reject early errors without losing the failure when awaiting the turn below.
  turn1.catch(() => {});
  const approval = await until('spawn approval', async () => (await rpc('turn:pending'))[session.id]?.approval);
  assert.equal(approval.call.id, 'pilot-spawn');
  assert.equal(approval.call.name, 'spawn_agent');
  assert.equal(stage, 2, 'worker must not start before approval');
  assert.equal(await rpc('turn:approve', session.id, 'pilot-spawn', true), true);
  await turn1;
  await send(second);
  assert.equal(stage, 7);
  assert.equal(endpointError, undefined);
  const workerAfter = snapshots[6].role.state.children[0];
  const savedWorker = await rpc('session:get', workerAfter.sessionId);
  const savedLead = await rpc('session:get', session.id);
  assert.equal(savedWorker.parentSessionId, session.id);
  assert.deepEqual(savedWorker.spawnOutcome, { parentSessionId: session.id, spawnCallId: 'pilot-spawn', status: 'returned' });
  assert.equal(savedWorker.messages.find(m => m.role === 'user').content, task);
  assert.equal(savedWorker.messages.filter(m => m.role === 'assistant').at(-1).content, evidence);
  assert.deepEqual(savedLead.messages.filter(m => m.role === 'user').map(m => m.content), [first, second]);
  for (const text of [answer1, answer2]) assert(savedLead.messages.some(m => m.role === 'assistant' && m.content === text));
  assert(!JSON.stringify([savedLead, savedWorker]).includes(contextPrefix.trim()));
  const stops = id => events.filter(e => e.sessionId === id && e.type === 'done').map(e => e.stop);
  await until('two coordinator and one worker done event', () => stops(session.id).length === 2 && stops(workerAfter.sessionId).length === 1);
  assert.deepEqual(stops(session.id), ['complete', 'complete']);
  assert.deepEqual(stops(workerAfter.sessionId), ['complete']);
  assert.equal(await readFile(join(workspace, excerpt), 'utf8'), source);
  console.log(JSON.stringify({ model: 'scripted OpenAI-compatible SSE; no inference', route: `${providerId} / ${lead} → ${worker}`, approvals: 1,
    completions: stage, coordinatorStops: stops(session.id), workerStops: stops(workerAfter.sessionId), source: `${path} (child projection and outcome decoding)`,
    sameTurnStateAfterSpawn: snapshots[4].role.state, planOnFollowup: snapshots[6].role.state.steps,
    childStatusOnFollowup: workerAfter.status, evidence, answer1, answer2 }, null, 2));
} catch (e) {
  console.error(e, { stage, endpointError: endpointError?.message, daemonLog: stderr.slice(-5000) });
  process.exitCode = 1;
} finally {
  socket?.close();
  if (child && child.exitCode === null && child.signalCode === null) {
    child.stdin.end();
    const timeout = setTimeout(() => child.kill('SIGKILL'), 6000);
    await childExited;
    clearTimeout(timeout);
  }
  server.closeAllConnections();
  server.close();
  await chmod(workspace, 0o700).catch(e => { if (e.code !== 'ENOENT') throw e; });
  await rm(scratch, { recursive: true, force: true });
}
