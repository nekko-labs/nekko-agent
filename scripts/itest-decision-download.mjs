#!/usr/bin/env node
// Live check of the decision-model download: a release nekkod with its own data
// directory (deleted afterwards) downloads a catalog model from the real
// decision-models-v1 release through its download queue, checks every file,
// loads it and answers a question.
//
//   node scripts/itest-decision-download.mjs [--nekkod target/release/nekkod.exe] [--model laya-en] [--precision fp16] [--ep directml]
//
// Nothing else is touched: no backend, no settings outside the scratch dir.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const exe = resolve(arg('nekkod', join('target', 'release', process.platform === 'win32' ? 'nekkod.exe' : 'nekkod')));
const model = arg('model', 'laya-en');
const precision = arg('precision', 'fp16');
const ep = arg('ep', process.platform === 'win32' ? 'directml' : process.platform === 'darwin' ? 'coreml' : 'cpu');

const data = mkdtempSync(join(tmpdir(), 'nekko-decision-itest-'));
writeFileSync(join(data, 'settings.json'), JSON.stringify({ engine: { modelFolders: [] } }));
const token = `itest-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
const child = spawn(exe, ['--config-stdin'], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
child.stdin.on('error', () => {});
child.stdin.write(`${JSON.stringify({ token, dataDir: data, allowedOrigins: [] })}\n`);
const killTree = () => {
  if (child.exitCode !== null) return;
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
  } else child.kill('SIGKILL');
};

const port = await new Promise((ok, fail) => {
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (l) => { if (l.startsWith('NEKKOD_READY ')) ok(JSON.parse(l.slice(13)).port); });
  child.on('exit', (c) => fail(new Error(`nekkod exited ${c}`)));
});
const call = async (channel, ...args) => {
  const res = await fetch(`http://127.0.0.1:${port}/api/${channel}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ args }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${channel}: ${res.status} ${JSON.stringify(body)}`);
  return body;
};

const t0 = Date.now();
let failed = false;
try {
  const started = await call('decisions:download', model, precision);
  console.log('download:', started.message);
  if (!started.ok) throw new Error(started.message);
  let last = '';
  for (;;) {
    const jobs = (await call('engine:downloads')).filter((j) => String(j.id).startsWith(`decision:${model}:`));
    const line = jobs.map((j) => `${j.file ?? j.id} ${j.state}${j.totalBytes ? ` ${Math.round((100 * j.receivedBytes) / j.totalBytes)}%` : ''}`).join(', ');
    if (line !== last) { console.log(`  ${((Date.now() - t0) / 1000).toFixed(0)} s: ${line}`); last = line; }
    const bad = jobs.find((j) => j.state === 'failed' || j.state === 'cancelled');
    if (bad) throw new Error(`${bad.id}: ${bad.message}`);
    if (jobs.length && jobs.every((j) => j.state === 'done')) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  const took = (Date.now() - t0) / 1000;
  const dir = join(data, 'models', 'decision', model);
  const files = readdirSync(dir).map((f) => `${f} ${statSync(join(dir, f)).size}`);
  console.log(`downloaded in ${took.toFixed(0)} s into ${dir}:\n  ${files.join('\n  ')}`);
  const models = await call('decisions:models');
  console.log('models:', JSON.stringify(models.map((m) => ({ id: m.id, precisions: m.precisions, sizeBytes: m.sizeBytes }))));
  // decide:load directly, so the provider can be pinned; decisions:load picks the platform's.
  const loaded = await call('decide:load', { dir, precision, ep, name: model });
  console.log('loaded:', JSON.stringify({ ep: loaded.ep, precision: loaded.precision, loadMs: loaded.loadMs, fallbacks: loaded.epFallbacks }));
  const viaService = await call('decisions:status');
  console.log('status:', JSON.stringify(viaService.local));
  const answer = await call('decisions:run', 'local', {
    state: 'Hi, we were billed twice for March. Please refund the duplicate today or we will cancel our plan.',
    questions: {
      department: { type: 'choice', instructions: 'Which department should handle this?', criteria: { billing: 'invoices, payments, refunds', technical: 'bugs, outages', other: 'everything else' } },
      churn_risk: { type: 'noul', instructions: 'Does the user threaten to cancel or leave?' },
    },
  });
  console.log('answer:', JSON.stringify({ department: answer.answers.department.choice, probabilities: answer.answers.department.probabilities, churn: answer.answers.churn_risk.noul, latencyMs: answer.latencyMs }));
  if (answer.answers.department.choice !== 'billing') throw new Error('unexpected answer');
  if (ep !== 'cpu' && loaded.ep !== ep) throw new Error(`asked for ${ep}, ran on ${loaded.ep}`);
  console.log('PASS');
} catch (e) {
  failed = true;
  console.error('FAIL', e.message);
} finally {
  killTree();
  await new Promise((r) => setTimeout(r, 500));
  rmSync(data, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
