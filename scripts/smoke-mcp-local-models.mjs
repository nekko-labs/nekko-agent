// End-to-end check of local model management through `nekko-agent mcp`, the
// way Claude Code or Codex would drive it: search the catalog, download a tiny
// GGUF, load it into the built-in engine, chat with it through
// `nekko-agent_chat`, unload it and stop the engine.
//
// Isolation: the CLI runs on a fresh temporary data dir and home with
// NEKKO_URL cleared and the app link ignored, its engine is the nekkod this
// checkout built (NEKKOD_PATH), the model server listens on its own port, and
// models land in the temporary dir. The only thing borrowed is a llama-server
// binary (read-only), passed with --llama-server or found in the default
// install. Needs network for the ~90 MB download.
//
//   cargo build -p nekkod && npm run build:core && npm run build --workspace=apps/cli
//   node scripts/smoke-mcp-local-models.mjs [--llama-server /path/to/llama-server] [--keep]
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { nekkodPath } from './itest-nekkod.mjs';
import { killTree, treeOptions } from './itest-procs.mjs';

const root = resolve(import.meta.dirname, '..');
const cli = join(root, 'apps/cli/dist/index.js');
const REPO = 'bartowski/SmolLM2-135M-Instruct-GGUF';
const QUANT = 'Q4_K_M';
const PORT = 18_000 + Math.floor(Math.random() * 1000);

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
function findLlamaServer() {
  if (flag('llama-server')) return flag('llama-server');
  const base = join(homedir(), '.nekko-agent', 'engine');
  if (!existsSync(base)) return undefined;
  for (const backend of readdirSync(base)) {
    const dir = join(base, backend);
    const flat = join(dir, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server');
    if (existsSync(flat)) return flat;
    try {
      for (const build of readdirSync(dir)) {
        const bin = join(dir, build, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server');
        if (existsSync(bin)) return bin;
      }
    } catch {
      /* not a directory */
    }
  }
  return undefined;
}
const llamaServer = findLlamaServer();
if (!llamaServer) {
  console.error('No llama-server found. Pass --llama-server <path> (install the engine once from the app, or brew install llama.cpp).');
  process.exit(2);
}

// --data-dir reuses a kept run's directory (and its downloaded model).
const dataDir = flag('data-dir') ?? mkdtempSync(join(tmpdir(), 'nekko-mcp-local-'));
const home = mkdtempSync(join(tmpdir(), 'nekko-mcp-local-home-'));
/** llama-server processes serving a model from this run's data dir. */
const leftovers = () => {
  try {
    if (process.platform === 'win32') {
      // The data dir as Windows prints it in a command line, quotes doubled for PowerShell.
      const needle = dataDir.replace(/'/g, "''");
      const script = `Get-CimInstance Win32_Process -Filter "Name like 'llama-server%'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${needle}') } | ForEach-Object { $_.ProcessId }`;
      return execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true })
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
    }
    return execFileSync('ps', ['-eo', 'pid,command'], { encoding: 'utf8' })
      .split('\n')
      .filter((l) => l.includes('llama-server') && l.includes(dataDir))
      .map((l) => l.trim().split(/\s+/)[0]);
  } catch {
    return [];
  }
};
const psLog = (label) => console.log(`      [${label}] llama-server pids: ${leftovers().join(',') || 'none'}`);
if (!flag('data-dir')) writeFileSync(
  join(dataDir, 'settings.json'),
  JSON.stringify({ engineBinPath: llamaServer, engine: { port: PORT, bind: 'local', autoStart: false } }),
);
console.log(`data dir ${dataDir}\nengine   ${llamaServer} on :${PORT}\n`);

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
const rpc = (method, params, timeoutMs = 60_000) =>
  new Promise((res, rej) => {
    const id = nextId++;
    const t = setTimeout(() => rej(new Error(`${method} ${params?.name ?? ''} timed out\n${stderr.slice(-2000)}`)), timeoutMs);
    pending.set(id, (m) => (clearTimeout(t), res(m)));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
const call = async (name, args = {}, timeoutMs) => {
  const m = await rpc('tools/call', { name, arguments: args }, timeoutMs);
  const blocks = m.result?.content ?? [];
  const text = blocks[0]?.text ?? m.error?.message ?? '';
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { isError: Boolean(m.result?.isError || m.error), text, json, blocks };
};

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  return ok;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const names = (await rpc('tools/list', {})).result.tools.map((t) => t.name);
  const wanted = ['local_status', 'local_models', 'model_search', 'model_download', 'downloads', 'download_cancel', 'model_load', 'model_unload', 'runtime_start', 'runtime_stop'];
  check('tools/list exposes the local-model tools', wanted.every((w) => names.includes(`nekko-agent_${w}`)), `${names.length} tools`);

  // A reused data dir (--data-dir) has a model, which turns on engine.autoStart, so the
  // MCP server brings the engine up as the app would; a fresh one does not.
  const status = await call('nekko-agent_local_status');
  const expectRunning = Boolean(flag('data-dir'));
  check(`local_status: engine found${expectRunning ? '' : ', not running'}`, status.json?.engine?.installed === true && (expectRunning || status.json.engine.running === false), `${status.json?.engine?.version} running=${status.json?.engine?.running} provider=${status.json?.engine?.providerId}`);

  const search = await call('nekko-agent_model_search', { query: 'SmolLM2 135M Instruct' }, 60_000);
  const hit = search.json?.find?.((m) => m.id === REPO);
  check('model_search finds the repo with quantizations (or explains an empty result)', Boolean(hit?.quants?.length) || /unreachable/.test(search.json?.note ?? ''), hit ? `${hit.quants.length} quants` : search.text.slice(0, 160));

  const bad = await call('nekko-agent_model_download', { modelId: REPO, quant: 'Q9_NOPE' });
  check('model_download rejects an unknown quant and lists options', bad.isError && /Available:/.test(bad.text), bad.text.slice(0, 100));

  const dl = await call('nekko-agent_model_download', { modelId: REPO, quant: QUANT }, 60_000);
  check('model_download starts a job', !dl.isError && Boolean(dl.json?.jobId), dl.isError ? dl.text : `${dl.json.quant} ${dl.json.sizeGB} GB job ${dl.json.jobId}`);

  let done = false;
  let last;
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const jobs = (await call('nekko-agent_downloads')).json ?? [];
    last = jobs.find((j) => j.id === dl.json?.jobId);
    if (!last || ['done', 'failed', 'cancelled'].includes(last.state)) break;
    await sleep(1500);
  }
  done = last?.state === 'done';
  check('downloads reports the job through to done', done, last ? `${last.state} ${last.percent ?? '?'}% of ${last.totalGB} GB` : 'job vanished');

  const lib = await call('nekko-agent_local_models');
  const local = lib.json?.find?.((m) => m.id.includes('SmolLM2-135M'));
  check('local_models lists the downloaded model', Boolean(local), local ? `${local.id} ${local.sizeGB} GB fit=${local.fit}` : lib.text.slice(0, 200));

  if (local) {
    const load = await call('nekko-agent_model_load', { modelId: local.id }, 180_000);
    check('model_load starts the engine and loads the model', !load.isError && load.json?.ok, load.isError ? load.text.slice(0, 300) : load.json.hint);

    const after = await call('nekko-agent_local_status');
    psLog('after load');
    check('local_status shows it resident', after.json?.engine?.running && after.json.engine.resident.some((r) => r.id === local.id), JSON.stringify(after.json?.engine?.resident));

    const chat = await call('nekko-agent_chat', { prompt: 'Reply with one short sentence: what is 2+2?', provider: load.json?.providerId, model: local.id }, 180_000);
    const meta = (() => { try { return JSON.parse(chat.blocks[1]?.text ?? '{}'); } catch { return {}; } })();
    check('nekko-agent_chat answers with the loaded local model', !chat.isError && chat.text.trim().length > 0 && meta.model === local.id, `${meta.provider}/${meta.model}: ${chat.text.trim().slice(0, 80)}`);

    psLog('after chat');
    const unload = await call('nekko-agent_model_unload', { modelId: local.id }, 60_000);
    check('model_unload frees it', !unload.isError, unload.text.slice(0, 120));
    await sleep(4000);
    psLog('4 s after unload');
  }

  const stop = await call('nekko-agent_runtime_stop', {}, 60_000);
  check('runtime_stop stops the engine', !stop.isError && stop.json?.ok, stop.text.slice(0, 120));
  const final = await call('nekko-agent_local_status');
  check('local_status: engine stopped', final.json?.engine?.running === false);
  await sleep(4000);
  const left = leftovers();
  check('no llama-server left running for this data dir', left.length === 0, left.length ? `pids ${left.join(',')}` : '');

  const cloudRefusal = await call('nekko-agent_model_load', { modelId: 'x', providerId: 'nope' });
  check('model_load refuses an unknown provider with a clear message', cloudRefusal.isError && /No provider/.test(cloudRefusal.text), cloudRefusal.text.slice(0, 100));
} catch (e) {
  check('smoke run', false, e.message);
} finally {
  // Closing stdin ends the MCP server and, through its engine's stdin, nekkod;
  // whatever is still left of the tree after that is ended with it.
  child.stdin.end();
  await sleep(2500);
  const after = leftovers();
  if (after.length) console.log(`      leftover after the MCP server exited: ${after.join(',')}`);
  killTree(child);
  await sleep(500);
  if (!argv.includes('--keep') && !flag('data-dir')) {
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* a child may still hold a file */ }
  }
  try { rmSync(home, { recursive: true, force: true }); } catch { /* as above */ }
}
const failed = checks.filter((c) => !c.ok).length;
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
