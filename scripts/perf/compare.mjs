#!/usr/bin/env node
/**
 * Base-versus-head comparison for a failed speed contract (issue #712).
 *
 * The `perf` job's diagnostic step uses this twice:
 *
 *   node scripts/perf/compare.mjs parts <perf-report.json>
 *     prints the `run.mjs --only` parts that hold the budgets the report
 *     failed ("latency", "frames", "memory"), one per line. A cold-switch
 *     failure is measured again with `--only latency`, not with the streaming
 *     frames that the old automatic profile measured.
 *
 *   node scripts/perf/compare.mjs summary <failed perf-report.json> <dir> [part]
 *     reads <dir>/<phase>/perf-report.json for the matched phases
 *     (base-1, head-1, head-2, base-2: unchanged base and PR head measured
 *     alternately on the same runner) and prints a Markdown table of the
 *     budgets that failed (those of `part` only, when given), with every
 *     phase's p50 and p95.
 *
 * The summary states what the numbers show and no more: whether the unchanged
 * base also misses the gate (a baseline failure), and whether both head runs
 * are slower than both base runs. Two pairs are evidence, not proof; see
 * docs/runbooks/failing-checks.md.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
export const PHASES = ['base-1', 'head-1', 'head-2', 'base-2'];

// Which `run.mjs --only` part measures each timing budget (compare.test.mjs
// checks that every budget in budgets.mjs has one).
export const PART_OF = {
  composer_keypress: 'latency',
  terminal_keypress: 'latency',
  warm_switch: 'latency',
  cold_switch_frame: 'latency',
  cold_switch_history: 'latency',
  stream_frame_work: 'frames',
};

const partOf = (b) => (b.kind === 'memory' ? 'memory' : PART_OF[b.id]);

/** The budget rows (timing and memory) a report failed, of one part when given. */
export function failedBudgets(report, part = null) {
  const timing = (report.budgets ?? []).filter((b) => !b.skipped && !b.pass).map((b) => ({ ...b, kind: 'timing' }));
  const memory = (report.memoryBudgets ?? []).filter((b) => !b.skipped && !b.pass).map((b) => ({ ...b, kind: 'memory' }));
  return [...timing, ...memory].filter((b) => !part || partOf(b) === part);
}

/** The `--only` parts to measure again for a report's failed budgets, in run order. */
export function partsFor(report) {
  const parts = new Set(failedBudgets(report).map(partOf).filter(Boolean));
  return ['latency', 'frames', 'memory'].filter((p) => parts.has(p));
}

function row(report, id) {
  if (!report) return null;
  return (report.budgets ?? []).find((b) => b.id === id && !b.skipped)
    ?? (report.memoryBudgets ?? []).find((b) => b.id === id && !b.skipped)
    ?? null;
}

/** The Markdown summary of a matched base/head comparison. */
export function summarize(failed, phases, part = null) {
  const failures = failedBudgets(failed, part);
  const lines = ['## Matched base/head comparison of the failed budgets', ''];
  if (!failures.length) return [...lines, 'No budget failed; nothing to compare.', ''].join('\n');
  const where = Object.values(phases).find(Boolean);
  if (where) lines.push(`${where.machine?.cpu ?? 'unknown CPU'} (${where.machine?.cpus} threads), ${where.browser}. Order ${PHASES.join(', ')}; one unprofiled attempt each.`, '');
  const missing = PHASES.filter((p) => !phases[p]);
  if (missing.length) lines.push(`Missing phases (did not produce a report): ${missing.join(', ')}.`, '');
  lines.push(`| Budget | Gate | ${PHASES.map((p) => `${p} p50 / p95`).join(' | ')} | Reading |`);
  lines.push(`| --- | --- | ${PHASES.map(() => '---').join(' | ')} | --- |`);
  for (const f of failures) {
    const unit = f.kind === 'memory' ? ` ${f.unit}` : ' ms';
    const value = (r) => (f.kind === 'memory' ? r?.value : r?.p95);
    const cells = PHASES.map((p) => {
      const r = row(phases[p], f.id);
      if (!r) return '-';
      return f.kind === 'memory' ? `${r.value.toFixed(2)}${unit}` : `${r.p50.toFixed(1)} / ${r.p95.toFixed(1)}`;
    });
    const base = ['base-1', 'base-2'].map((p) => value(row(phases[p], f.id))).filter((v) => v != null);
    const head = ['head-1', 'head-2'].map((p) => value(row(phases[p], f.id))).filter((v) => v != null);
    lines.push(`| ${f.label} | ${f.budget}${unit} | ${cells.join(' | ')} | ${reading(base, head, f.budget)} |`);
  }
  lines.push('', 'p95 is nearest-rank over one attempt per phase. A head that is slower in both pairs needs a fix or two more matched pairs; a base that also misses the gate is a baseline failure (add the run to #712).', '');
  return lines.join('\n');
}

function reading(base, head, gate) {
  if (base.length < 2 || head.length < 2) return 'incomplete';
  const notes = [];
  const baseFails = base.filter((v) => v > gate).length;
  if (baseFails) notes.push(`unchanged base misses the gate ${baseFails} of ${base.length} times`);
  if (Math.min(...head) > Math.max(...base)) notes.push('head slower than base in both pairs');
  else if (Math.max(...head) < Math.min(...base)) notes.push('head faster than base in both pairs');
  else notes.push('head within the base range');
  return notes.join('; ');
}

function readReport(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

function main(argv) {
  const [cmd, ...args] = argv;
  if (cmd === 'parts' && args.length === 1) {
    const report = readReport(args[0]);
    if (report) for (const p of partsFor(report)) console.log(p);
    return 0;
  }
  if (cmd === 'summary' && (args.length === 2 || args.length === 3)) {
    const failed = readReport(args[0]);
    if (!failed) {
      console.log(`No failed report at ${args[0]}; nothing to compare.`);
      return 0;
    }
    const phases = Object.fromEntries(PHASES.map((p) => [p, readReport(join(args[1], p, 'perf-report.json'))]));
    console.log(summarize(failed, phases, args[2] ?? null));
    return 0;
  }
  console.error('usage: compare.mjs parts <perf-report.json> | summary <failed perf-report.json> <dir> [part]');
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv.slice(2)));
