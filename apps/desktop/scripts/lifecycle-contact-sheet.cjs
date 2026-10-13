// Local evidence index only. Images remain uninspected until reviewed by a human/parent.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.argv[2] || '.shots/lifecycle-evidence-routepaint-20261013-r4');
const reports = Object.fromEntries(['before', 'after'].map(side => [side, JSON.parse(fs.readFileSync(path.join(root, side, 'status.json'), 'utf8'))]));
const esc = s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const rel = file => path.relative(root, file).replaceAll('\\', '/');
const img = (file, caption) => `<figure><a href="${esc(rel(file))}"><img loading="lazy" src="${esc(rel(file))}"></a><figcaption>${esc(caption)}</figcaption></figure>`;
let html = `<!doctype html><meta charset="utf-8"><title>Lifecycle r4 evidence</title><style>body{font:15px system-ui;background:#202226;color:#eee;margin:24px}section{margin:32px 0}.pair{display:grid;grid-template-columns:1fr 1fr;gap:16px}figure{margin:0}img{width:100%;display:block}figcaption{padding:8px}h2{margin-bottom:8px}a{color:#9bd}video{width:100%}</style><h1>Lifecycle r4 matched evidence</h1><p>Captured renderer evidence, not pixel-inspected. Parent must inspect screenshots and motion. Narrow sidebar hiding is intentional actual responsive behavior; no drawer was forced open. Settings top captures retained. Control captures use the same chat-pane-action scrollIntoView center anchor on both revisions, real settings scroller, compositor priming and six stable frame pairs.</p>`;
for (const width of ['wide', 'narrow']) for (const theme of ['light', 'dark']) for (const surface of ['panes', 'completion', 'settings', 'settings-controls']) {
  const key = `${width}-${theme}-${surface}`;
  html += `<section><h2>${key}</h2><div class="pair">`;
  for (const side of ['before', 'after']) {
    const c = reports[side].captures.find(c => path.basename(c.file).endsWith(`-${key}.png`));
    if (!c) throw Error('Missing capture ' + side + ' ' + key);
    html += img(c.file, side + ': ' + key);
  }
  html += '</div></section>';
}
html += '<h1>Representative motion contact sheet</h1><p>Matched target times; actual sampled timestamps labeled. Completion at 400ms, expand completed at 1400ms, after-only modal open at 2000ms and cancel at 2800ms. These frames supplement, not replace, the videos.</p>';
for (const target of [0, 400, 500, 650, 1000, 1400, 1500, 2000, 2100, 2250, 2800, 2900, 3100]) {
  html += `<section><h2>Target ${target}ms</h2><div class="pair">`;
  for (const side of ['before', 'after']) {
    const times = reports[side].motion.timestampsMs;
    const index = times.reduce((best, t, i) => Math.abs(t-target) < Math.abs(times[best]-target) ? i : best, 0);
    html += img(path.join(root, side, 'motion-frames', `${index+1}.png`), `${side}: actual ${times[index]}ms (frame ${index+1})`);
  }
  html += '</div></section>';
}
html += '<h2>Motion videos</h2><div class="pair">';
for (const side of ['before', 'after']) html += `<figure><video controls preload="metadata" src="${esc(rel(reports[side].motion.file))}"></video><figcaption>${side}</figcaption></figure>`;
html += '</div>';
fs.writeFileSync(path.join(root, 'contact-sheet.html'), html);
console.log(path.join(root, 'contact-sheet.html'));
