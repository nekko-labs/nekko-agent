// End-to-end check of `nekko-agent mcp` as an external agent (Claude Code,
// Codex, ...) drives it: speak MCP over stdio to the built CLI, ask
// `nekko-agent_chat` to use a named provider + model, and confirm that model
// is the one that answered.
//
// Nothing touches the user's data or a running app: the CLI runs on a fresh
// temporary data dir and home with NEKKO_URL cleared and the app link
// ignored, its engine is the nekkod this checkout built (NEKKOD_PATH), and the
// "model server" is a loopback OpenAI-compatible stub started here. The CLI,
// nekkod and everything under them are ended as one tree.
//
//   cargo build -p nekkod && npm run build:core && npm run build --workspace=apps/cli
//   node scripts/smoke-mcp-chat.mjs [extra tool names to expect]
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { nekkodPath } from './itest-nekkod.mjs';
import { killTree, treeOptions } from './itest-procs.mjs';

const root = resolve(import.meta.dirname, '..');
const cli = join(root, 'apps/cli/dist/index.js');
const MODEL = 'smoke-model-7b';
const REPLY = 'pong from the stub';

const seen = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: MODEL, object: 'model' }] }));
      return;
    }
    if (req.url?.endsWith('/chat/completions')) {
      const parsed = JSON.parse(body || '{}');
      seen.push(parsed.model);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunk = (delta, finish = null) =>
        `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.write(chunk({ role: 'assistant', content: REPLY }));
      res.write(chunk({}, 'stop'));
      res.write(`data: ${JSON.stringify({ id: 'x', choices: [], usage: { prompt_tokens: 12, completion_tokens: 4 } })}\n\n`);
      res.end('data: [DONE]\n\n');
      return;
    }
    res.writeHead(404).end();
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const scratch = mkdtempSync(join(tmpdir(), 'nekko-mcp-smoke-'));
const dataDir = join(scratch, 'data');
const home = join(scratch, 'home');
mkdirSync(dataDir, { recursive: true });
mkdirSync(home, { recursive: true });
writeFileSync(
  join(dataDir, 'settings.json'),
  JSON.stringify({
    providers: [
      { id: 'smoke-stub', kind: 'openai-compat', label: 'Smoke stub', baseUrl: `http://127.0.0.1:${port}/v1`, enabled: true },
    ],
  }),
);

const child = spawn(process.execPath, [cli, 'mcp'], {
  env: { ...process.env, NEKKO_URL: '', NEKKO_TOKEN: '', NEKKO_DATA_DIR: dataDir, NEKKOD_PATH: nekkodPath(), HOME: home, USERPROFILE: home },
  stdio: ['pipe', 'pipe', 'pipe'],
  ...treeOptions,
});
let stderr = '';
child.stderr.on('data', (c) => (stderr += c));
const pending = new Map();
let buf = '';
child.stdout.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  }
});
let nextId = 1;
const rpc = (method, params, timeoutMs = 30_000) =>
  new Promise((res, rej) => {
    const id = nextId++;
    const t = setTimeout(() => rej(new Error(`${method} timed out\n${stderr}`)), timeoutMs);
    pending.set(id, (m) => (clearTimeout(t), res(m)));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const text = (m) => m.result?.content?.[0]?.text ?? m.error?.message ?? '';

try {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });
  check('initialize', init.result?.serverInfo?.name === 'nekko-agent', init.result?.serverInfo?.version);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const list = await rpc('tools/list', {});
  const names = list.result.tools.map((t) => t.name);
  check('tools/list exposes nekko-agent_chat', names.includes('nekko-agent_chat'), `${names.length} tools`);
  const extra = process.argv.slice(2);
  for (const want of extra) check(`tools/list exposes ${want}`, names.includes(want));

  const models = await rpc('tools/call', { name: 'nekko-agent_models_list', arguments: { providerId: 'smoke-stub' } });
  check('models_list sees the stub model', text(models).includes(MODEL), text(models).slice(0, 80));

  const chat = await rpc('tools/call', {
    name: 'nekko-agent_chat',
    arguments: { prompt: 'ping', provider: 'smoke-stub', model: MODEL },
  });
  // Reply text first, then a JSON block of metadata (session, provider, model, usage).
  const [replyBlock, metaBlock] = chat.result?.content ?? [];
  const meta = (() => {
    try {
      return JSON.parse(metaBlock?.text ?? '{}');
    } catch {
      return {};
    }
  })();
  check('chat returns without error', !chat.result?.isError && !chat.error, chat.error?.message ?? replyBlock?.text?.slice(0, 200));
  check('chat used the requested provider + model', meta.provider === 'smoke-stub' && meta.model === MODEL, `${meta.provider}/${meta.model}`);
  check('the stub model actually served the turn', seen.includes(MODEL), `requests: ${JSON.stringify(seen)}`);
  check('the reply came back to the MCP caller', replyBlock?.text?.includes(REPLY), replyBlock?.text?.slice(0, 80));
} catch (e) {
  check('smoke run', false, e.message);
} finally {
  // Closing stdin ends the MCP server and, through its engine's stdin, nekkod.
  child.stdin.end();
  await new Promise((r) => setTimeout(r, 1000));
  killTree(child);
  server.close();
  await new Promise((r) => setTimeout(r, 300));
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* a child may still hold a file */ }
}
const failed = checks.filter((c) => !c.ok).length;
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
