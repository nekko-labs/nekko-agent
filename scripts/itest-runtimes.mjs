// Exercises the runtime control plane (T149/T150) through a real nekkod (no TS
// backend, scratch data dir and home) against a real Ollama, on a
// discrete-GPU Windows box (RTX 5090): the open live checks are a real Ollama
// adapter pass (R6) and the discrete-GPU spill path (R5).
//
// By default the script starts its own `ollama serve` on a random loopback
// port, reading this machine's pulled models (OLLAMA_MODELS, no pruning), so
// the force-stop and supervised start below only ever end servers it started.
// `--ollama <url>` targets a server you already run instead, and force-stops
// it. LM Studio is checked only with `--lmstudio <url>` (it needs `lms` and a
// running LM Studio server). Needs `qwen3:14b` and
// `hf.co/mradermacher/shisa-v2.1-qwen3-8b-GGUF:Q5_K_M` pulled, and
// `cargo build -p nekkod`.
//
// Usage: node scripts/itest-runtimes.mjs [--nekkod path] [--ollama url] [--lmstudio url]
import { spawn } from 'node:child_process';
import { freemem, homedir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { startNekkod } from './itest-nekkod.mjs';
import { killTree, treeOptions } from './itest-procs.mjs';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const GB = (b) => (b == null ? '?' : `${(b / 1e9).toFixed(1)} GB`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });

// The pulled models, read where Ollama keeps them for this user (before the
// daemon's home moves to the scratch dir).
const ollamaEnv = { OLLAMA_MODELS: process.env.OLLAMA_MODELS ?? join(homedir(), '.ollama', 'models'), OLLAMA_NOPRUNE: '1' };
let ollama = null;
let ollamaUrl = arg('ollama');
const lmstudioUrl = arg('lmstudio');
const settings = {
  providers: [
    { id: 'oll', kind: 'ollama', label: 'Ollama', baseUrl: '', enabled: true },
    ...(lmstudioUrl ? [{ id: 'lms', kind: 'lmstudio', label: 'LM Studio', baseUrl: lmstudioUrl, enabled: true }] : []),
  ],
};
if (!ollamaUrl) {
  const port = await freePort();
  ollamaUrl = `http://127.0.0.1:${port}`;
  ollama = spawn('ollama', ['serve'], {
    env: { ...process.env, ...ollamaEnv, OLLAMA_HOST: `127.0.0.1:${port}` },
    stdio: 'ignore',
    ...treeOptions,
  });
  ollama.on('error', (e) => console.error(`ollama: ${e.message}`));
  for (let i = 0; i < 60; i++) {
    if (await fetch(`${ollamaUrl}/api/version`).then((r) => r.ok, () => false)) break;
    await sleep(500);
  }
}
settings.providers[0].baseUrl = ollamaUrl;
const daemon = await startNekkod({ nekkod: arg('nekkod'), settings, env: ollamaEnv, label: 'rt' });
const call = daemon.call;
console.log(`nekkod on :${daemon.port}, ollama at ${ollamaUrl}${ollama ? ' (started here)' : ''}`);

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!cond) failures++;
};
const fmtPlan = (p) =>
  p == null
    ? 'null plan'
    : `${p.verdict} | weights ${GB(p.weightsBytes)} + kv ${GB(p.kvCacheBytes)} + ovh ${GB(p.overheadBytes)} = ${GB(p.requiredBytes)} on "${p.deviceName}" free ${GB(p.deviceFreeBytes)} | gpu ${p.gpuLayers ?? '?'}/${p.totalLayers ?? '?'} layers, spill ${GB(p.spillBytes)} | reasons: ${p.reasons.map((r) => r.code).join(', ')}`;

try {
  // --- Detection and status -----------------------------------------------
  const ollStatus = await call('runtime:status', 'oll');
  check('ollama detected running', ollStatus?.running === true, `v${ollStatus?.version}`);
  check('ollama server not owned (spawned outside the daemon)', ollStatus?.owned === false);

  // --- Model facts --------------------------------------------------------
  const ollFacts = await call('runtime:facts', 'oll');
  console.log('  ollama models:', ollFacts.map((m) => `${m.id} [w ${GB(m.weightsBytes)} L${m.layers ?? '?'} kvH${m.kvHeads ?? '?'} d${m.headDim ?? '?'}]`).join('\n    '));
  const qwen = ollFacts.find((m) => m.id === 'qwen3:14b');
  check('ollama reports layer geometry (/api/show)', typeof qwen?.layers === 'number' && typeof qwen?.kvHeads === 'number' && typeof qwen?.headDim === 'number', qwen && `L${qwen.layers} kvH${qwen.kvHeads} d${qwen.headDim}`);

  // --- Fit plans on the discrete GPU --------------------------------------
  const fit = await call('runtime:plan', 'oll', 'qwen3:14b', { contextTokens: 8192, parallelSlots: 1, kvCacheDtype: 'f16', gpuLayerFraction: 1 });
  check('qwen3:14b @8k fits or is tight on the 5090', fit?.verdict === 'fits' || fit?.verdict === 'tight', fmtPlan(fit));
  check('plan measured against the NVIDIA device', /nvidia|5090|geforce/i.test(fit?.deviceName ?? ''), fit?.deviceName);
  check('discrete GPU not pooled with system RAM', (fit?.deviceTotalBytes ?? 0) > 0 && (fit?.deviceTotalBytes ?? 0) < 40e9, `device total ${GB(fit?.deviceTotalBytes)} (not +RAM)`);

  const spill = await call('runtime:plan', 'oll', 'qwen3:14b', { contextTokens: 2_000_000, parallelSlots: 4, kvCacheDtype: 'f16', gpuLayerFraction: 1 });
  check('absurd context cannot pretend to fit', spill != null && spill.verdict !== 'fits' && spill.verdict !== 'unknown', fmtPlan(spill));
  check('spill/overflow gives reasons', (spill?.reasons.length ?? 0) > 0, spill?.reasons.map((r) => r.code).join(','));

  // --- LM Studio (only when asked for) ------------------------------------
  if (lmstudioUrl) {
    const lmsStatus = await call('runtime:status', 'lms');
    check('lmstudio detected running', lmsStatus?.running === true, `v${lmsStatus?.version}`);
    const lmsFacts = await call('runtime:facts', 'lms');
    console.log(`  lmstudio models: ${lmsFacts.length} reported`);
    check('lmstudio reports real weights (lms ls)', lmsFacts.some((m) => (m.weightsBytes ?? 0) > 1e9));
    const big = lmsFacts.filter((m) => (m.weightsBytes ?? 0) > 20e9).sort((a, b) => (b.weightsBytes ?? 0) - (a.weightsBytes ?? 0))[0];
    if (big) {
      const p = await call('runtime:plan', 'lms', big.id);
      check('lmstudio weights-only plan stays honest', p != null && p.weightsBytes === big.weightsBytes && (p.verdict === 'unknown' || p.reasons.some((r) => r.code === 'missing-metadata' || r.code === 'weights-exceed-device')), fmtPlan(p));
    } else {
      console.log('  (no >20 GB lmstudio model to probe the partial verdict)');
    }
  } else {
    console.log('  (LM Studio skipped: pass --lmstudio http://localhost:1338 with LM Studio serving)');
  }

  // --- Load -> measured residency -> unload (Ollama reports its own spill) --
  // One ~6 GB model, mostly in VRAM; refuse rather than squeeze a tight box.
  if (freemem() < 4e9) throw new Error(`only ${GB(freemem())} RAM free; not loading a model`);
  const target = 'hf.co/mradermacher/shisa-v2.1-qwen3-8b-GGUF:Q5_K_M';
  const lr = await call('runtime:load', 'oll', target, { contextTokens: 8192, ttlSeconds: 300 });
  check('load via /api/generate', lr.ok, lr.message);
  const after = await call('runtime:status', 'oll');
  const resident = after?.resident.find((r) => r.id.includes('shisa'));
  console.log('  resident:', JSON.stringify(after?.resident));
  check('resident model reports size + vram split', typeof resident?.sizeBytes === 'number' && typeof resident?.vramBytes === 'number', resident && `size ${GB(resident.sizeBytes)} vram ${GB(resident.vramBytes)} ctx ${resident.contextLength}`);
  const ur = await call('model:unload', 'oll', target);
  check('unload via the Models-page path', ur.ok === true, ur.message);
  // Eviction is asynchronous inside Ollama; poll rather than sample once.
  let clearedOk = false;
  for (let i = 0; i < 15 && !clearedOk; i++) {
    await sleep(1000);
    const s = await call('runtime:status', 'oll');
    clearedOk = !s?.resident.some((r) => r.id.includes('shisa'));
  }
  check('no longer resident', clearedOk);

  // --- Ownership boundary, then a supervised start/stop cycle -------------
  const refuse = await call('runtime:stop', 'oll');
  check('stopping a server the daemon did not start asks first', refuse.ok === false && refuse.needsConfirmation === true, JSON.stringify(refuse));
  const forced = await call('runtime:stop', 'oll', true);
  check('confirmed force-stop works', forced.ok === true, forced.message);
  for (let i = 0; i < 20 && (await fetch(`${ollamaUrl}/api/version`).then((r) => r.ok, () => false)); i++) await sleep(250);
  const started = await call('runtime:start', 'oll');
  check('supervised start', started.running === true, 'error' in started ? started.error : '');
  const ownedStatus = await call('runtime:status', 'oll');
  check('now owned by the supervisor', ownedStatus?.owned === true && ownedStatus.running === true);
  const stopped = await call('runtime:stop', 'oll');
  check('owned server stops without force', stopped.ok === true, stopped.message);
} catch (e) {
  check('runtimes run', false, e instanceof Error ? e.message : String(e));
} finally {
  await daemon.stop();
  killTree(ollama);
}

console.log(`\n${failures === 0 ? 'RUNTIMES PASS ✅' : `RUNTIMES FAIL ❌ (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
