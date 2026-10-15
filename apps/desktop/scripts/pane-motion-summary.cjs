// Prints the frames where any wall window's box changed, from the newest
// pane-motion report under .shots/pane-motion/<before|after>.
const fs = require('node:fs');
const path = require('node:path');
const which = process.argv[2] || 'after';
const dir = path.resolve(__dirname, '../../../.shots/pane-motion', which);
const run = fs.readdirSync(dir).filter((d) => /^\d{4}-/.test(d)).sort().pop();
const report = JSON.parse(fs.readFileSync(path.join(dir, run, 'report.json'), 'utf8'));
for (const kind of ['open', 'close', 'openSide', 'closeSide']) {
  let last = '';
  let settled = 0;
  for (const f of report.timelines[kind] || []) {
    const line = f.panes.map((p) => `${p.id.slice(-8)}${p.leaving ? '(leaving)' : ''}: x${p.x} y${p.y} w${p.w} h${p.h} o${p.op}${p.clip ? ' ' + p.clip : ''}`).join(' | ') + (f.dust ? ` | dust ${f.dust}` : '');
    if (line !== last) { console.log(`${kind} ${String(f.t).padStart(4)}ms  ${line}`); last = line; settled = f.t; }
  }
  console.log(`${kind}: last change at ${settled}ms\n`);
}
console.log('errors:', report.errors);
