// The small services through the Local Web UI behind nekkod (PF14 A4):
// `app:info`, `workspace:add` (headless), `session:watches`, `updates:check`
// with a provider whose model list changes, `pr:continueStack` and
// `pr:linkStack` against a loopback GitHub API, and `data:wipe`, each
// answered by the daemon with the real TS backend beside it.
//
// Runs on an isolated temporary data dir and home with loopback servers only;
// `gh` is pointed at a name that does not exist so the REST fallback runs, and
// git may use local transports only. Never touches the user's data, network
// accounts or a running app. Every process it starts is ended with its tree.
//
// Usage: node scripts/itest-small-services.mjs [path/to/nekkod]
// Needs `npm run build:web` (or `npm run build`).
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { killTree, treeOptions } from './itest-procs.mjs';

const exe = process.platform === 'win32' ? '.exe' : '';
const targetDir = process.env.CARGO_TARGET_DIR ?? 'target';
const nekkod = resolve(process.argv[2] ?? join(targetDir, 'debug', `nekkod${exe}`));
if (!existsSync(nekkod)) throw new Error(`missing ${nekkod}: cargo build -p nekkod`);

const SERVER_PORT = 6300 + Math.floor(Math.random() * 400);
const TOKEN = randomBytes(24).toString('hex');
const root = mkdtempSync(join(tmpdir(), 'nekko-small-services-'));
const dataDir = join(root, 'data');
const home = join(root, 'home');
const clone = join(root, 'clone');
for (const d of [join(dataDir, 'sessions'), join(dataDir, 'memory'), home, clone]) mkdirSync(d, { recursive: true });

const procs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
};
const git = (args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], { cwd: clone, encoding: 'utf8' }).trim();

// A provider whose model list grows between checks.
let models = ['m1'];
const model = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ object: 'list', data: models.map((id) => ({ id, object: 'model' })) }));
});
await new Promise((r) => model.listen(0, '127.0.0.1', r));
const modelUrl = `http://127.0.0.1:${model.address().port}/v1`;

// A loopback GitHub REST API: two open PRs in one repository, no stacks yet.
const sha = 'c'.repeat(40);
const pr = (n, head, base) => ({ number: n, state: 'open', title: `PR ${n}`, head: { ref: head, sha: n === 12 ? sha : 'd'.repeat(40), repo: { full_name: 'owner/repo' } }, base: { ref: base, repo: { full_name: 'owner/repo' } } });
const github = [];
const gh = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const path = req.url.replace(/^\//, '');
    github.push([req.method, path, body ? JSON.parse(body) : null]);
    const answers = {
      'repos/owner/repo/pulls/12': pr(12, 'parent', 'main'),
      'repos/owner/repo/pulls/13': pr(13, 'nekko/child', 'parent'),
      'repos/owner/repo/stacks?pull_request=12': [],
    };
    const v = req.method === 'POST' ? { number: 3 } : answers[path];
    res.writeHead(v === undefined ? 404 : req.method === 'POST' ? 201 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(v ?? { message: 'Not Found' }));
  });
});
await new Promise((r) => gh.listen(0, '127.0.0.1', r));
const ghUrl = `http://127.0.0.1:${gh.address().port}`;

// The user's clone: a GitHub remote, the dependent branch checked out.
git(['init', '-q']);
writeFileSync(join(clone, 'a.txt'), 'a');
git(['add', '.']);
git(['commit', '-q', '-m', 'one']);
git(['checkout', '-q', '-b', 'nekko/child']);
git(['remote', 'add', 'origin', 'https://github.com/owner/repo.git']);

// What a wipe removes, and what it keeps.
const write = (p, text) => { mkdirSync(join(dataDir, p, '..'), { recursive: true }); writeFileSync(join(dataDir, p), text); };
write('sessions/s_src.json', JSON.stringify({ id: 's_src', title: 'Source', workspaceId: 'w1', executionMode: 'worktree', gitIsolation: true, providerId: 'p1', modelId: 'm1', messages: [], createdAt: 1, updatedAt: 1 }));
write('sessions/s_dep.json', JSON.stringify({
  id: 's_dep', title: 'Follow-up to PR #12', titleAuto: false, workspaceId: 'w1', executionMode: 'worktree', gitIsolation: true,
  gitStackParent: { workspaceId: 'w1', url: 'https://github.com/owner/repo/pull/12', branch: 'parent', sha },
  gitWorktrees: { w1: { path: clone, branch: 'nekko/child' } }, messages: [], createdAt: 1, updatedAt: 1,
}));
write('memory/note.md', 'a note');
write('usage.jsonl', '{}\n');
write('tokens.json', '{}');
write('agent-watches.json', JSON.stringify([{ id: 'w1', sessionId: 's_src', kind: 'timer', prompt: 'secret continuation', nextPollAt: 10, intervalMs: 60000, deadlineAt: 4102444800000, status: 'active', failures: 0 }]));

// The configuration nekkod gets is written by the server; the GitHub API
// address reaches it through the environment the server passes on.
const server = spawn(process.execPath, ['apps/local-web-ui/dist/index.js'], {
  env: {
    ...process.env,
    NEKKO_PORT: String(SERVER_PORT),
    NEKKO_HOST: '127.0.0.1',
    NEKKO_DATA_DIR: dataDir,
    NEKKO_TOKEN: TOKEN,
    NEKKOD_PATH: nekkod,
    NEKKO_VERSION: '7.7.7',
    NEKKO_GH_PATH: 'nekko-no-such-gh',
    NEKKO_GITHUB_API_URL: ghUrl,
    GIT_ALLOW_PROTOCOL: 'file',
    GIT_TERMINAL_PROMPT: '0',
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

const call = async (channel, ...args) => {
  const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/${channel}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ args }),
  });
  const body = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, body: body?.result !== undefined ? body.result : body };
};
const api = async (channel, ...args) => {
  const r = await call(channel, ...args);
  if (!r.ok) throw new Error(`${channel}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const until = async (what, fn, ms = 20_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const timed = async (n, fn) => {
  const ms = [];
  for (let i = 0; i < n; i++) { const t = performance.now(); await fn(); ms.push(performance.now() - t); }
  ms.sort((a, b) => a - b);
  return ms[Math.floor(ms.length / 2)].toFixed(2);
};

try {
  let info = null;
  for (let i = 0; i < 160 && !info?.owned; i++) {
    info = await api('daemon:info').catch(() => null);
    if (!info?.owned) await sleep(250);
  }
  if (!info?.owned) throw new Error(`the server never came up:\n${serverOut}`);
  for (const c of ['pr:continueStack', 'pr:linkStack', 'data:wipe', 'app:info', 'updates:check', 'workspace:add', 'session:watches']) {
    check(`daemon owns ${c}`, info.owned.includes(c));
  }
  await api('providers:save', { id: 'p1', kind: 'openai-compat', label: 'Scripted', baseUrl: modelUrl, enabled: true });
  await api('workspace:addByPath', clone);
  const ws = (await api('workspace:list'))[0];
  // The chats point at the folder by the id the daemon gave it.
  for (const id of ['s_src', 's_dep']) {
    const s = JSON.parse(readFileSync(join(dataDir, 'sessions', `${id}.json`), 'utf8'));
    s.workspaceId = ws.id;
    if (s.gitStackParent) { s.gitStackParent.workspaceId = ws.id; s.gitWorktrees = { [ws.id]: s.gitWorktrees.w1 }; }
    writeFileSync(join(dataDir, 'sessions', `${id}.json`), JSON.stringify(s));
  }

  const appInfo = await api('app:info');
  check('app:info is the Local Web UI at the server version', appInfo.edition === 'web' && appInfo.version === '7.7.7' && appInfo.platform === process.platform, JSON.stringify(appInfo));
  const added = await api('workspace:add');
  check('workspace:add lists the folders headless', Array.isArray(added) && added.length === 1 && added[0].id === ws.id, JSON.stringify(added));
  const views = await api('session:watches', 's_src');
  check('session:watches shows the watch without its prompt', views.length === 1 && views[0].id === 'w1' && !JSON.stringify(views).includes('secret'), JSON.stringify(views));

  // updates:check: the first run seeds; a new model then reaches the UI once.
  const events = [];
  const sock = new WebSocket(`ws://127.0.0.1:${SERVER_PORT}/api/events?token=${TOKEN}`);
  sock.onmessage = (m) => { try { const e = JSON.parse(m.data); if (e.channel === 'models:updated') events.push(e.payload); } catch { /* not ours */ } };
  await until('the events socket', () => sock.readyState === 1);
  await api('updates:check');
  models = ['m1', 'm2'];
  await api('updates:check');
  await until('models:updated', () => events.length > 0, 5000).catch(() => {});
  await sleep(300);
  check('updates:check tells the UI once about a new model', events.length === 1 && events[0].providerId === 'p1', JSON.stringify(events));
  sock.close();

  // PR stacks: continuing fetches nothing over the network (local transports
  // only), so it stops at the fetch with no chat made; linking the prepared
  // dependent chat creates the stack on the loopback GitHub.
  const cont = await call('pr:continueStack', 's_src', 'https://github.com/owner/repo/pull/12');
  check('pr:continueStack reads the PR, matches the remote, refuses the fetch', !cont.ok && /Could not fetch the parent PR/.test(JSON.stringify(cont.body)) && github.some((g) => g[1] === 'repos/owner/repo/pulls/12'), JSON.stringify(cont.body));
  const link = await api('pr:linkStack', 's_dep', 'https://github.com/owner/repo/pull/13');
  check('pr:linkStack creates the native stack', link.ok === true && github.some((g) => g[0] === 'POST' && g[1] === 'repos/owner/repo/stacks' && JSON.stringify(g[2]) === '{"pull_requests":[12,13]}'), JSON.stringify(link));

  const median = {
    'app:info': await timed(20, () => api('app:info')),
    'session:watches': await timed(20, () => api('session:watches', 's_src')),
  };
  console.log(`medians through the public server (ms): ${JSON.stringify(median)}`);

  // data:wipe: chats, memory, usage gone; sign-ins kept; settings reset.
  await api('settings:update', { theme: 'light' });
  const next = await api('data:wipe');
  const left = readdirSync(join(dataDir, 'sessions')).filter((f) => f.endsWith('.json'));
  check('data:wipe clears chats, memory and usage and resets settings', left.length === 0 && !existsSync(join(dataDir, 'memory', 'note.md')) && !existsSync(join(dataDir, 'usage.jsonl')) && next.theme !== 'light' && (await api('settings:get')).theme !== 'light', JSON.stringify({ left, theme: next.theme }));
  check('data:wipe keeps sign-ins', existsSync(join(dataDir, 'tokens.json')));
  check('the folder itself is untouched', existsSync(join(clone, 'a.txt')));
} catch (e) {
  check('run', false, `${e.message}\n${serverOut.slice(-4000)}`);
} finally {
  for (const p of procs) killTree(p);
  model.close();
  gh.close();
  model.closeAllConnections?.();
  gh.closeAllConnections?.();
  await sleep(1500);
  try { rmSync(root, { recursive: true, force: true }); } catch { /* a child may still hold a file */ }
}
const failed = results.filter((ok) => !ok).length;
console.log(failed ? `${failed} FAILED` : `all ${results.length} passed`);
process.exit(failed ? 1 : 0);
