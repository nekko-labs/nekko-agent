import assert from 'node:assert/strict';
import test from 'node:test';
import { BUDGETS } from './budgets.mjs';
import { PART_OF, partsFor, summarize } from './compare.mjs';

const timing = (id, p50, p95, budget, extra = {}) => ({ id, label: id, budget, p50, p95, pass: p95 <= budget, ...extra });
const report = (budgets, memoryBudgets = []) => ({
  machine: { cpu: 'Test CPU', cpus: 4 }, browser: 'Chrome/1', budgets, memoryBudgets,
});

test('every timing budget maps to a run.mjs --only part', () => {
  for (const b of BUDGETS) assert.ok(PART_OF[b.id], `${b.id} has no part`);
});

test('a cold-switch failure is measured again as latency, not as streaming frames', () => {
  const failed = report([
    timing('cold_switch_frame', 29, 36.3, 33),
    timing('stream_frame_work', 4.5, 7.8, 14),
    { id: 'terminal_keypress', skipped: 'no terminal', pass: true },
  ]);
  assert.deepEqual(partsFor(failed), ['latency']);
});

test('failures in several parts are measured in run order', () => {
  const failed = report(
    [timing('stream_frame_work', 9, 15, 14), timing('warm_switch', 20, 31, 30)],
    [{ id: 'gpu_tiles', label: 'tiles', unit: 'MB', budget: 320, value: 400, pass: false }],
  );
  assert.deepEqual(partsFor(failed), ['latency', 'frames', 'memory']);
});

test('a passing report needs no comparison', () => {
  assert.deepEqual(partsFor(report([timing('cold_switch_frame', 20, 25, 33)])), []);
});

test('summary reads a baseline failure with head inside the base range', () => {
  const failed = report([timing('cold_switch_frame', 29, 36.3, 33), timing('warm_switch', 14, 17, 30)]);
  const at = (p95) => report([timing('cold_switch_frame', 27, p95, 33)]);
  const md = summarize(failed, { 'base-1': at(39), 'head-1': at(34.2), 'head-2': at(34.1), 'base-2': at(34.0) });
  assert.match(md, /\| cold_switch_frame \| 33 ms \| 27\.0 \/ 39\.0 \| 27\.0 \/ 34\.2 \| 27\.0 \/ 34\.1 \| 27\.0 \/ 34\.0 \|/);
  assert.match(md, /unchanged base misses the gate 2 of 2 times; head within the base range/);
  assert.doesNotMatch(md, /warm_switch/);
});

test('summary flags a head slower than base in both pairs', () => {
  const failed = report([timing('cold_switch_frame', 29, 40, 33)]);
  const at = (p95) => report([timing('cold_switch_frame', 25, p95, 33)]);
  const md = summarize(failed, { 'base-1': at(30), 'head-1': at(38), 'head-2': at(39), 'base-2': at(31) });
  assert.match(md, /\| head slower than base in both pairs \|/);
  assert.doesNotMatch(md, /unchanged base misses/);
});

test('summary says which phases are missing', () => {
  const failed = report([timing('cold_switch_frame', 29, 40, 33)]);
  const md = summarize(failed, { 'base-1': report([timing('cold_switch_frame', 25, 30, 33)]) });
  assert.match(md, /Missing phases \(did not produce a report\): head-1, head-2, base-2\./);
  assert.match(md, /\| incomplete \|/);
});
