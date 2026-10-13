// Local evidence only. Parent must inspect pixels before publishing these captures.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.argv[2] || '.shots/lifecycle-merged-r5');
const reports = Object.fromEntries(['before', 'after'].map(side => [side, JSON.parse(fs.readFileSync(path.join(root, side, 'status.json'), 'utf8'))]));
const esc = s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const rel = file => path.relative(root, file).replaceAll('\\', '/');
const img = (file, caption) => `<figure><a href="${esc(rel(file))}"><img loading="eager" src="${esc(rel(file))}"></a><figcaption>${esc(caption)}</figcaption></figure>`;
const header = title => `<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{font:13px system-ui;background:#202226;color:#eee;margin:12px}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}figure{margin:0}img,video{width:100%;display:block}figcaption{padding:5px}a{color:#9bd}</style><h1>${title}</h1><p>Captured, not pixel-inspected. Parent review required. Click an image for full-resolution evidence. All windows were isolated, off-screen and non-focusable.</p><nav><a href="contact-sheet.html">All surfaces</a> | <a href="drawer-contact.html">Owning-view drawer</a> | <a href="motion-contact.html">Motion</a></nav>`;
let html = header('Matched lifecycle evidence') + '<div class="grid">';
for (const width of ['wide', 'narrow']) for (const theme of ['light', 'dark']) for (const surface of ['panes', 'completion', 'settings', 'settings-controls']) {
  const key = `${width}-${theme}-${surface}`;
  for (const side of ['before', 'after']) {
    const c = reports[side].captures.find(c => path.basename(c.file).endsWith(`-${key}.png`));
    if (!c) throw Error('Missing capture ' + side + ' ' + key);
    html += img(c.file, side + ': ' + key);
  }
}
for (const c of reports.after.captures.filter(c => c.file.includes('delete-modal'))) html += img(c.file, 'New confirmation: no renderer before state');
fs.writeFileSync(path.join(root, 'contact-sheet.html'), html + '</div>');
html = header('Existing agent drawer before/after') + '<p>After completion automatically reveals the existing drawer. Closed captures are taken after explicitly closing it; pending guidance returns to Agents. Opened captures use the same Agents action on both revisions.</p><div class="grid">';
for (const theme of ['light', 'dark']) for (const state of ['closed', 'opened']) for (const side of ['before', 'after']) {
  const key = `narrow-${theme}-drawer-${state}`;
  const c = reports[side].captures.find(c => path.basename(c.file).endsWith(`-${key}.png`));
  if (!c) throw Error('Missing capture ' + side + ' ' + key);
  html += img(c.file, side + ': ' + key);
}
fs.writeFileSync(path.join(root, 'drawer-contact.html'), html + '</div>');
html = header('Matched lifecycle motion frames') + '<div class="grid">';
for (const target of [0, 400, 500, 650, 1000, 1400, 1500, 2000, 2100, 2250, 2800, 2900, 3100]) for (const side of ['before', 'after']) {
  const times = reports[side].motion.timestampsMs;
  const index = times.reduce((best, t, i) => Math.abs(t - target) < Math.abs(times[best] - target) ? i : best, 0);
  html += img(path.join(root, side, 'motion-frames', `${index + 1}.png`), `${side}: target ${target}ms, actual ${times[index]}ms`);
}
html += '</div><h2>Recordings</h2><div class="grid">';
for (const side of ['before', 'after']) html += `<figure><video controls preload="metadata" src="${esc(rel(reports[side].motion.file))}"></video><figcaption>${side}</figcaption></figure>`;
fs.writeFileSync(path.join(root, 'motion-contact.html'), html + '</div>');
console.log(root);
