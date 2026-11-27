#!/usr/bin/env node
/**
 * The chat finder's index build, old path against new, against the real nekkod
 * binary on synthetic chats in a temp data dir (never ~/.nekko-agent).
 *
 *   node scripts/perf/finder-index-bench.mjs [--chats 500,2000] [--bin target/release/nekkod]
 *
 * Old: `session:get` for every chat, 6 at a time (what chatFinderIndex.ts did).
 * New: `sessions:finderText`, 25 chats a call, 2 calls at a time, then the same
 * again (the daemon's per-file cache) and after one chat changed.
 * Reports, per phase: time until the first 25 chats are indexed (the first
 * finder results that can match message text), time to the whole index, response bytes, the
 * client's JSON.parse time, and the daemon's CPU time (user+system, from ps).
 * Each phase runs on a fresh daemon.
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const COUNTS = arg('chats', '500,2000').split(',').map(Number);
const BIN = resolve(arg('bin', 'target/release/nekkod'));
const TOKEN = 'bench-token-0123456789abcdef';

const WORDS = 'the quick brown fox jumps over a lazy dog while agents refactor modules and write tests for the finder index'.split(' ');
let seed = 1;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const text = (n) => { let s = ''; while (s.length < n) s += WORDS[Math.floor(rnd() * WORDS.length)] + ' '; return s; };
const picture = (kb) => `data:image/png;base64,${'A'.repeat(kb * 1024)}`;

/** A chat like a real one: a few dozen messages, most with tool output; some with pictures; a few huge. */
function chat(i, total) {
  const big = i % 25 === 0; // 4% long agent chats with screenshots inside tool results (~10 MB)
  const pics = i % 5 === 0; // 20% carry a user photo
  const turns = big ? 250 : 12 + (i % 20);
  const messages = [];
  let at = 1_700_000_000_000 + i * 60_000;
  for (let t = 0; t < turns; t++) {
    messages.push({ id: `u${t}`, role: 'user', content: text(200), createdAt: at++, ...(pics && t === 0 ? { images: [picture(60)] } : {}) });
    messages.push({
      id: `a${t}`, role: 'assistant', content: text(500), reasoning: text(800), createdAt: at++,
      toolCalls: [{ id: `c${t}`, name: t % 3 ? 'bash' : 'write_file', input: t % 3 ? { command: 'ls -la' } : { path: `/repo/notes/n${t}.md`, content: text(1500) } }],
    });
    messages.push({ id: `r${t}`, role: 'tool', content: '', createdAt: at++, toolResult: { toolCallId: `c${t}`, output: text(2000), ...(big && t % 10 === 0 ? { images: [picture(250)] } : {}) } });
  }
  if (i % 7 === 0) messages.push({ id: 'needle', role: 'assistant', content: `result mentions zebracrossing${i % 3} here`, createdAt: at++ });
  return { id: `s_${i}`, title: `Chat ${i} ${WORDS[i % WORDS.length]}`, createdAt: 1_700_000_000_000 + i * 60_000, updatedAt: at, workspaceId: 'w1', mode: 'agent', messages };
}

function generate(n) {
  const root = mkdtempSync(join(tmpdir(), 'finder-bench-'));
  mkdirSync(join(root, 'sessions'), { recursive: true });
  let bytes = 0;
  for (let i = 0; i < n; i++) { const s = JSON.stringify(chat(i, n)); bytes += s.length; writeFileSync(join(root, 'sessions', `s_${i}.json`), s); }
  return { root, bytes };
}

const cpu = (pid) => {
  const [u, s] = execFileSync('ps', ['-o', 'utime=,stime=', '-p', String(pid)]).toString().trim().split(/\s+/);
  const sec = (t) => { const [m, rest] = t.split(':'); return Number(m) * 60 + Number(rest); };
  return sec(u) + sec(s);
};

async function daemon(root) {
  const child = spawn(BIN, ['--config-stdin'], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, HOME: root, NEKKO_FILE_VAULT: '1' },
  });
  child.stdin.write(`${JSON.stringify({ token: TOKEN, allowedOrigins: ['null'], dataDir: root })}\n`);
  const port = await new Promise((ok, fail) => {
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; const m = /NEKKOD_READY (.*)\n/.exec(buf); if (m) ok(JSON.parse(m[1]).port); });
    child.on('exit', () => fail(new Error('daemon exited')));
  });
  child.stdout.resume();
  return { child, port };
}

async function call(d, channel, args, stats) {
  const res = await fetch(`http://127.0.0.1:${d.port}/api/${encodeURIComponent(channel)}`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ args }) });
  const body = await res.text();
  stats.bytes += Buffer.byteLength(body);
  const t = performance.now();
  const json = JSON.parse(body);
  stats.parse += performance.now() - t;
  return json;
}

/** The first finder results can match message text once this many chats are indexed. */
const FIRST = 25;

/** Run `units` (each an array of chat ids) with `parallel` in flight; note when FIRST chats are done. */
async function pool(units, parallel, run, mark) {
  let next = 0, done = 0;
  await Promise.all(Array.from({ length: parallel }, async () => {
    while (next < units.length) { const u = units[next++]; await run(u); done += u.length; if (done >= FIRST) mark(); }
  }));
}

async function phase(label, root, n, work) {
  const d = await daemon(root);
  try {
    const stats = { bytes: 0, parse: 0 };
    // The list every finder open needs either way; not part of the index build.
    const list = await call(d, 'sessions:summaries', [], { bytes: 0, parse: 0 });
    const ids = list.sort((a, b) => b.updatedAt - a.updatedAt).map((s) => s.id);
    const cpu0 = cpu(d.child.pid);
    const t0 = performance.now();
    let first = 0;
    await work(d, ids, stats, () => { first ||= performance.now() - t0; });
    const total = performance.now() - t0;
    const row = { chats: n, phase: label, firstMs: Math.round(first), totalMs: Math.round(total), MB: +(stats.bytes / 1e6).toFixed(2), clientParseMs: Math.round(stats.parse), daemonCpuS: +(cpu(d.child.pid) - cpu0).toFixed(2) };
    return { row, d, ids };
  } catch (e) { d.child.kill(); throw e; }
}

const oldWork = (d, ids, stats, mark) => pool(ids.map((id) => [id]), 6, ([id]) => call(d, 'session:get', [id], stats), mark);
const chunks = (ids, k) => Array.from({ length: Math.ceil(ids.length / k) }, (_, i) => ids.slice(i * k, i * k + k));
const newWork = (d, ids, stats, mark) => pool(chunks(ids, 25), 2, (c) => call(d, 'sessions:finderText', [c], stats), mark);

const rows = [];
for (const n of COUNTS) {
  const { root, bytes } = generate(n);
  console.error(`${n} chats, ${(bytes / 1e6).toFixed(0)} MB on disk in ${root}`);
  try {
    let r = await phase('old: session:get x6', root, n, oldWork); rows.push(r.row); r.d.child.kill();
    r = await phase('new: finderText, cold', root, n, newWork); rows.push(r.row);
    // Same daemon, cache warm, every chat asked for again: the daemon's cost when nothing changed.
    const warmStats = { bytes: 0, parse: 0 };
    const cpu0 = cpu(r.d.child.pid), t0 = performance.now();
    await newWork(r.d, r.ids, warmStats, () => {});
    rows.push({ chats: n, phase: 'new: finderText, warm (file cache)', firstMs: '-', totalMs: Math.round(performance.now() - t0), MB: +(warmStats.bytes / 1e6).toFixed(2), clientParseMs: Math.round(warmStats.parse), daemonCpuS: +(cpu(r.d.child.pid) - cpu0).toFixed(2) });
    // One chat saved since: only it is read again.
    const touched = join(root, 'sessions', `${r.ids[0]}.json`);
    const now = new Date(); utimesSync(touched, now, new Date(now.getTime() + 5000));
    const oneStats = { bytes: 0, parse: 0 };
    const t1 = performance.now(), cpu1 = cpu(r.d.child.pid);
    await newWork(r.d, [r.ids[0]], oneStats, () => {});
    rows.push({ chats: n, phase: 'new: one chat saved, asked again', firstMs: '-', totalMs: Math.round(performance.now() - t1), MB: +(oneStats.bytes / 1e6).toFixed(2), clientParseMs: Math.round(oneStats.parse), daemonCpuS: +(cpu(r.d.child.pid) - cpu1).toFixed(2) });
    r.d.child.kill();
  } finally { rmSync(root, { recursive: true, force: true }); }
}
console.table(rows);
console.log(JSON.stringify(rows));
