// The signup fixture served to agent-browser-flow-benchmark.mjs: a small
// single-page app whose form is rendered by script after an API call, so an
// agent that looks too early finds nothing and has to wait. Static assets are
// cacheable, so a warm session can serve them from the HTTP cache.
import { createServer } from 'node:http';

const links = Array.from({ length: 40 }, (_, i) => `<a href="/article/${i}">Article ${i}: notes on local agents</a>`).join(' ');
const prose = Array.from({ length: 12 }, (_, i) => `<p>Paragraph ${i}. Nekko keeps your work on your computer, and this fixture pads the page so summaries and snapshots have realistic weight.</p>`).join('');
export const html = '<!doctype html><html><head><title>Signup fixture</title><link rel="stylesheet" href="/static/app.css"><script src="/static/app.js" defer></script></head><body>'
  + `<header><h1>Nekko Newsletter</h1><nav>${links}</nav></header><main id="root"><p>Loading form...</p></main><footer>${prose}</footer></body></html>`;
export const appJs = `/*${'x'.repeat(48000)}*/\n` + [
  'fetch("/api/form").then(r => r.json()).then(form => {',
  '  const root = document.getElementById("root");',
  '  root.innerHTML = "<h2>" + form.title + "</h2><form id=signup><label for=email>Email</label> <input id=email name=email type=email required> "',
  '    + "<label for=name>Name</label> <input id=name name=name> <label><input id=agree type=checkbox checked> Weekly digest</label> "',
  '    + "<select id=plan><option>Free</option><option>Pro</option></select> <button type=submit>Subscribe</button></form>";',
  '  document.getElementById("signup").addEventListener("submit", (event) => {',
  '    event.preventDefault();',
  '    const name = document.getElementById("name").value, email = document.getElementById("email").value;',
  '    root.innerHTML = "<p>Subscribing...</p>";',
  '    fetch("/api/subscribe", { method: "POST", body: JSON.stringify({ name, email }) }).then(() => {',
  '      root.innerHTML = "<p id=result role=status>Thanks, " + name + "! Check " + email + ".</p>";',
  '    });',
  '  });',
  '});',
].join('\n');
export const appCss = `body{font:16px sans-serif;margin:24px}nav a{margin-right:8px}/*${'y'.repeat(16000)}*/`;

/** Start the fixture on a loopback port. `served` counts requests (all, and cacheable assets). */
export async function startFixture() {
  const served = { total: 0, assets: 0 };
  const server = createServer((req, res) => {
    served.total++;
    if (req.url === '/static/app.js' || req.url === '/static/app.css') {
      served.assets++;
      res.writeHead(200, { 'Content-Type': req.url.endsWith('.js') ? 'text/javascript' : 'text/css', 'Cache-Control': 'max-age=3600' });
      res.end(req.url.endsWith('.js') ? appJs : appCss); return;
    }
    if (req.url === '/api/form') { setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ title: 'Join the list' })); }, 120); return; }
    if (req.url === '/api/subscribe') { req.resume(); setTimeout(() => { res.writeHead(204, { 'Cache-Control': 'no-store' }); res.end(); }, 80); return; }
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' }); res.end(html);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/`, served, close: () => server.close() };
}
