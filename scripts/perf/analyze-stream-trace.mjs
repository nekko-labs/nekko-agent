// Read-only diagnostic: intervals are not frame work and nested event totals overlap.
import { readFileSync, writeFileSync } from 'node:fs';
import { frameWorkFromTrace } from './lib/trace.mjs';
import { summarize } from './lib/stats.mjs';
const file = process.argv[2];
const events = JSON.parse(readFileSync(file)).traceEvents;
const mains = events.filter(e => e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain');
const main = mains.map(m => ({ ...m, total: events.filter(e => e.pid === m.pid && e.tid === m.tid && e.ph === 'X' && String(e.cat).split(',').includes('toplevel')).reduce((s,e) => s+(e.dur??0),0) })).sort((a,b)=>b.total-a.total)[0];
if (!main) throw Error('No renderer main');
const local = events.filter(e=>e.pid===main.pid && e.tid===main.tid);
const starts = local.filter(e=>e.name==='AnimationFrame' && e.ph==='b').map(e=>e.ts).sort((a,b)=>a-b);
const intervals = starts.slice(1).map((s,i)=>(s-starts[i])/1000);
const totals = new Map(), invalidations = new Map(), paints = new Map();
for(const e of local){
 if(e.ph==='X') totals.set(e.name,(totals.get(e.name)??0)+(e.dur??0)/1000);
 const d=e.args?.data??{};
 if(/InvalidationTracking$/.test(e.name)){const k=[e.name,d.nodeName,d.reason].join(' | ');invalidations.set(k,(invalidations.get(k)??0)+1);}
 if(e.name==='Paint' && e.ph==='X'){const k=`${d.nodeId} ${d.nodeName}`;const p=paints.get(k)??{count:0,ms:0};p.count++;p.ms+=(e.dur??0)/1000;paints.set(k,p);}
}
const work=frameWorkFromTrace(events);
const threads = events.filter(e => e.ph === 'M' && e.name === 'thread_name');
const scheduling = new Map();
for (const e of events) {
 if (!/BeginFrame|BeginMainFrame|DrawFrame|SubmitCompositorFrame|FramePresented|PipelineReporter|Scheduler|SoftwareRenderer::DoDrawQuad/.test(e.name)) continue;
 const thread = threads.find(t => t.pid === e.pid && t.tid === e.tid)?.args?.name ?? '?';
 const key = `${thread} | ${e.name} | ${e.ph}`;
 const row = scheduling.get(key) ?? { count: 0, totalMs: 0, stamps: [] };
 row.count++; row.totalMs += (e.dur ?? 0) / 1000; row.stamps.push(e.ts);
 scheduling.set(key, row);
}
const schedulingSummary = [...scheduling].map(([key, row]) => {
 row.stamps.sort((a,b) => a-b);
 const gaps = row.stamps.slice(1).map((t,i) => (t-row.stamps[i])/1000).filter(x => x > 0);
 return { key, count: row.count, totalMs: row.totalMs, gapMs: gaps.length ? summarize(gaps) : null };
}).sort((a,b) => b.count-a.count);
const report={file,scheduling: schedulingSummary,renderer:{pid:main.pid,tid:main.tid},frameStarts:starts.length,spanMs:(starts.at(-1)-starts[0])/1000,intervalMs:summarize(intervals),workMs:summarize(work.work),busyFraction:work.busyFraction,
 totalsMs:[...totals].sort((a,b)=>b[1]-a[1]).slice(0,25),invalidations:[...invalidations].sort((a,b)=>b[1]-a[1]).slice(0,30),paints:[...paints].sort((a,b)=>b[1].ms-a[1].ms).slice(0,20)};
writeFileSync(process.argv[3]??file.replace('.trace.json','.analysis.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
