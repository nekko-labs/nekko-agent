// Read-only aggregation of every run, no best-of selection or budget edits.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = '.shots/perf-investigation/narrow-controls';
const order = ['baseline-1', 'context-1', 'rocket-1', 'baseline-2', 'rocket-2', 'context-2'];
const rows = order.map(name => {
 const dir = join(root, name);
 const a = JSON.parse(readFileSync(join(dir, 'streaming.analysis.json')));
 const t = JSON.parse(readFileSync(join(dir, 'diagnostic-targets.json')));
 const totals = Object.fromEntries(a.totalsMs);
 return { name, pid: a.renderer.pid, frames: a.frameStarts - 1, spanMs: a.spanMs, work: a.workMs, interval: a.intervalMs, busy: a.busyFraction, paint: totals.Paint ?? 0, style: totals.UpdateLayoutTree ?? 0, layout: totals.Layout ?? 0, targets: t.targets, scheduling: a.scheduling };
});
writeFileSync(join(root, 'summary.json'), JSON.stringify(rows, null, 2));
for (const r of rows) console.log(JSON.stringify({ ...r, targets: undefined, scheduling: undefined }));
