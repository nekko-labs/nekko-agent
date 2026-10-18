// Full-flow agent browser benchmark: navigate -> locate -> fill -> submit ->
// verify -> capture, through the real bridge (startAgentBrowser) in hidden
// Electron, with phase timings from its onTiming hook.
//
//   node scripts/agent-browser-flow-benchmark.mjs [outFile] [--rounds 20] [--launches 12]
//        [--drivers native,native-nowake,playwright] [--strategy selectors]
//
// A driver name may end in -nowake to run the bridge without the hidden-window
// frame wake (wakeFrames: false), for before/after in the same process.
// --strategy selectors,snapshot compares how the agent locates the form: by
// listing controls with evaluate, or by the compact snapshot and its refs.
// Each driver and strategy pair is an arm; arms alternate sample by sample.
//
// Three scenarios, reported separately:
//   process-first  the first flow in a brand-new Electron process and profile
//                  (one per launch; arms take turns going first)
//   fresh-chat     a new chat in a running app: new driver, window, partition
//                  and empty HTTP cache, closed after the flow
//   warm-session   the same chat again: browser open, HTTP cache populated
// Within a launch, drivers alternate sample by sample. Every flow counts tool
// calls, retries, reply bytes (text the model would read, and image bytes
// separately) and fixture requests (to show what the HTTP cache served).
//
// Runs hidden with owned windows only, a throwaway --user-data-dir that is
// deleted afterwards, and the Electron process tree killed on exit. Excludes
// model latency, host/daemon dispatch and approvals: this is the bridge only.
import { build } from 'esbuild';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir, cpus, totalmem, release } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const outFile = resolve(positional[0] ?? join(root, '.shots/agent-browser-flow/result.json'));
const rounds = Number(flag('rounds', '20'));
const launches = Number(flag('launches', '12'));
const drivers = flag('drivers', 'native').split(',');
const strategies = flag('strategy', 'selectors').split(',');
const require = createRequire(import.meta.url);
const electron = process.env.NEKKO_SMOKE_ELECTRON || require('electron');
const playwrightCore = require.resolve('playwright-core', { paths: [join(root, 'apps/desktop')] });
const nativeBinary = join(root, 'apps/desktop/resources/agent-browser', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'agent-browser.exe' : 'agent-browser');
if (drivers.some((d) => d.startsWith('native')) && !existsSync(nativeBinary)) throw new Error(`No native browser at ${nativeBinary}; run node scripts/build-agent-browser.mjs`);
const scratch = mkdtempSync(join(tmpdir(), 'nekko-browser-flow-'));
const entry = join(scratch, 'flow.cjs');

const source = String.raw`
import { app } from 'electron';
import { writeFileSync, readFileSync } from 'node:fs';
import { createNativeDriver } from ${JSON.stringify(join(root, 'apps/desktop/src/main/agentNativeDriver.ts'))};
import { playwrightDriver } from ${JSON.stringify(join(root, 'apps/desktop/src/main/agentPlaywrightDriver.ts'))};
import { startAgentBrowser } from ${JSON.stringify(join(root, 'apps/desktop/src/main/agentBrowser.ts'))};
import { startFixture } from ${JSON.stringify(join(root, 'scripts/agent-browser-flow-fixture.mjs'))};
import { runFlow } from ${JSON.stringify(join(root, 'scripts/agent-browser-flow.mjs'))};
const config = JSON.parse(readFileSync(process.env.NEKKO_FLOW_CONFIG, 'utf8'));
app.setPath('userData', config.profile);
// Closing a chat destroys its last hidden window; do not let that quit the app.
app.on('window-all-closed', () => {});
// A variant is a driver plus bridge options: native, playwright, and a
// -nowake suffix for the hidden-window frame wake turned off.
const factories = { native: () => createNativeDriver(config.nativeBinary), playwright: playwrightDriver };
const variant = (name) => ({ driver: factories[name.split('-')[0]], wakeFrames: !name.endsWith('-nowake') });

app.whenReady().then(async () => {
  const result = { mode: config.mode, versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node }, flows: [], timings: [] };
  let server;
  const bridges = {};
  try {
    server = await startFixture();
    const { url, served } = server;
    let current = null;
    for (const d of config.drivers) {
      bridges[d] = await startAgentBrowser({ ...variant(d), onTiming: (t) => { if (current) current.push(t); } });
    }
    const flow = async (driver, sessionId, scenario, strategy, extra) => {
      const b = bridges[driver];
      const timings = []; current = timings;
      const before = { ...served };
      const post = async (input) => {
        const res = await fetch(b.url, { method: 'POST', headers: { Authorization: 'Bearer ' + b.token }, body: JSON.stringify({ sessionId, ...input }) });
        const text = await res.text();
        const body = JSON.parse(text);
        return { ok: res.ok, body, bytes: Buffer.byteLength(text) };
      };
      const row = await runFlow(post, { url, strategy, name: 'Nekko ' + sessionId, email: sessionId + '@example.test' });
      current = null;
      result.flows.push({ driver, scenario, strategy, sessionId, ...extra, ...row, served: { total: served.total - before.total, assets: served.assets - before.assets }, timings });
    };
    const close = (driver, sessionId) => fetch(bridges[driver].url, { method: 'POST', headers: { Authorization: 'Bearer ' + bridges[driver].token }, body: JSON.stringify({ sessionId, action: 'close' }) });
    // Every (driver, strategy) pair is one arm; arms alternate sample by
    // sample, reversing order every other round.
    const arms = config.drivers.flatMap((d) => config.strategies.map((s) => ({ d, s, id: d + '-' + s })));
    const order = (i) => (i % 2 ? [...arms].reverse() : arms);

    if (config.mode === 'process-first') {
      const first = arms.findIndex((a) => a.id === config.firstArm);
      const as = [...arms.slice(first), ...arms.slice(0, first)];
      for (const [k, a] of as.entries()) { await flow(a.d, 'first-' + a.id, 'process-first', a.s, { firstInProcess: k === 0, launch: config.launch }); await close(a.d, 'first-' + a.id); }
    } else {
      // Warm up each arm once so fresh-chat excludes one-off module loading.
      for (const a of arms) { await flow(a.d, 'warmup-' + a.id, 'warmup', a.s, {}); await close(a.d, 'warmup-' + a.id); }
      for (let i = 0; i < config.rounds; i++) for (const a of order(i)) { const id = 'fresh-' + a.id + '-' + i; await flow(a.d, id, 'fresh-chat', a.s, { round: i }); await close(a.d, id); }
      for (const a of arms) await flow(a.d, 'warm-' + a.id, 'warm-open', a.s, {});
      for (let i = 0; i < config.rounds; i++) for (const a of order(i)) await flow(a.d, 'warm-' + a.id, 'warm-session', a.s, { round: i });
      for (const a of arms) await close(a.d, 'warm-' + a.id);
    }
    result.passed = result.flows.every((f) => f.ok);
    if (!result.passed) process.exitCode = 1;
  } catch (error) { result.passed = false; result.error = String(error && error.stack || error); process.exitCode = 1; }
  finally {
    writeFileSync(config.out, JSON.stringify(result));
    for (const b of Object.values(bridges)) b.close();
    server?.close(); app.exit(process.exitCode ?? 0);
  }
});
`;

await build({
  stdin: { contents: source, resolveDir: root, loader: 'ts' }, outfile: entry, bundle: true, platform: 'node', format: 'cjs', logLevel: 'error',
  external: ['electron'],
  plugins: [{ name: 'playwright-core-external', setup(b) { b.onResolve({ filter: /^playwright-core$/ }, () => ({ path: playwrightCore, external: true })); } }],
});

function launch(config) {
  const profile = join(scratch, `profile-${config.label}`);
  const out = join(scratch, `out-${config.label}.json`);
  const cfgFile = join(scratch, `config-${config.label}.json`);
  writeFileSync(cfgFile, JSON.stringify({ ...config, profile, out, nativeBinary, drivers, strategies }));
  const env = { ...process.env, NEKKO_FLOW_CONFIG: cfgFile }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [entry, `--user-data-dir=${profile}`], { env, windowsHide: true, stdio: ['ignore', process.env.NEKKO_FLOW_DEBUG ? 'inherit' : 'ignore', 'inherit'] });
  const killTree = () => {
    if (!child.pid || child.exitCode !== null) return;
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else child.kill('SIGKILL');
  };
  const timer = setTimeout(killTree, 600_000);
  return new Promise((done) => child.once('exit', (code) => {
    clearTimeout(timer); killTree();
    let result = { passed: false, error: `No result (exit ${code})` };
    try { result = JSON.parse(readFileSync(out, 'utf8')); } catch { /* reported */ }
    if (!process.env.NEKKO_FLOW_DEBUG) rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    done(result);
  }));
}

const git = (a) => { try { return execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim(); } catch { return null; } };
const report = {
  benchmark: 'agent-browser-flow', created: new Date().toISOString(), git: git(['rev-parse', 'HEAD']), dirty: Boolean(git(['status', '--porcelain', '--untracked-files=no'])),
  machine: { platform: process.platform, release: release(), arch: process.arch, cpu: cpus()[0]?.model, threads: cpus().length, memGiB: Math.round(totalmem() / 2 ** 30) },
  nativePin: JSON.parse(readFileSync(join(root, 'vendor/agent-browser/pin.json'), 'utf8')),
  settings: { rounds, launches, drivers, strategies, viewport: '1100x760 outer DIP, hidden' },
  launches: [],
};
try {
  // A failed flow is recorded, not fatal: a timeout is itself a measurement.
  for (let i = 0; i < launches; i++) {
    const arms = drivers.flatMap((d) => strategies.map((s) => `${d}-${s}`));
    const r = await launch({ label: `first-${i}`, mode: 'process-first', firstArm: arms[i % arms.length], launch: i, rounds });
    report.launches.push(r);
    console.error(`process-first ${i + 1}/${launches}: ${r.passed ? 'ok' : r.error ?? 'failed'}`);
  }
  if (rounds > 0) {
    const r = await launch({ label: 'steady', mode: 'steady', rounds });
    report.launches.push(r);
    console.error(`steady: ${r.passed ? 'ok' : r.error ?? 'failed'}`);
  }
} finally {
  if (!process.env.NEKKO_FLOW_DEBUG) rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
const { summarize } = await import('./agent-browser-flow.mjs');
report.summary = summarize(report.launches.flatMap((l) => l.flows ?? []));
report.passed = report.launches.every((l) => l.passed);
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(report, null, 1));
console.log(JSON.stringify({ out: outFile, passed: report.passed, summary: report.summary }, null, 2));
if (!report.passed) process.exitCode = 1;
