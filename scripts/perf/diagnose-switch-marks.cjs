// Diagnostic only: preserve contract timing while retaining per-switch marks.
const fs = require('node:fs');
const p = 'scripts/perf/lib/probes.mjs';
let s = fs.readFileSync(p, 'utf8');
const edits = [
  ['    let start = null;', '    const switchId = (P.switchId = (P.switchId || 0) + 1);\n    const mark = (name) => performance.mark("cold-diag-" + switchId + "-" + name);\n    let start = null;'],
  ['      P.switchResult = res;', '      mark("finish");\n      (P.switchDiagnostics ||= []).push({ title, switchId, start, ...res });\n      P.switchResult = res;'],
  ['      const panel = visiblePanel(title);\n      const frameNow', '      mark("raf");\n      const panel = visiblePanel(title);\n      const frameNow'],
  ['      if (frameNow) sawFrame = true;', '      if (frameNow) { mark("frame-visible"); sawFrame = true; }'],
  ['          if (frameNow) res.frame = d;', '          if (frameNow) { mark("frame-task"); res.frame = d; }'],
  ['start = e.timeStamp; res.dispatch', 'start = e.timeStamp; mark("click"); res.dispatch'],
];
for (const [a,b] of edits) { if (!s.includes(a)) throw Error('Missing probe anchor: '+a); s=s.replace(a,b); }
fs.writeFileSync(p,s);
const r='scripts/perf/run.mjs';s=fs.readFileSync(r,'utf8');
const anchor="  if (flag('profile')) await stopProfile(app.cdp, OUT, 'cold-switch');";
if(!s.includes(anchor))throw Error('Missing cold completion');
s=s.replace(anchor,"  writeFileSync(join(OUT, 'switch-diagnostics.json'), JSON.stringify(await app.cdp.evaluate('window.__perf.switchDiagnostics'), null, 2));\n"+anchor);
s=s.replace("JSON.stringify(await app.cdp.evaluate('window.__perf.switchDiagnostics'), null, 2)", "JSON.stringify(await app.cdp.evaluate('({ switches: window.__perf.switchDiagnostics, marks: performance.getEntriesByType(\"mark\").filter(e => e.name.startsWith(\"cold-diag-\")).map(e => ({ name: e.name, startTime: e.startTime })) })'), null, 2)");
fs.writeFileSync(r,s);
const timeline = 'scripts/perf/lib/profile.mjs';
s = fs.readFileSync(timeline, 'utf8');
const categories = "includedCategories: ['devtools.timeline', 'toplevel', '__metadata']";
if (!s.includes(categories)) throw Error('Missing trace categories anchor');
s = s.replace(categories, "includedCategories: ['devtools.timeline', 'toplevel', '__metadata', 'blink.user_timing']");
fs.writeFileSync(timeline, s);
