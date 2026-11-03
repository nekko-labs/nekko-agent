// The Agents panel with subagents, and the composer's "where does this run"
// choice, in the real App against the layout fixture. Hidden, off-screen and
// non-focusable. Launch: NEKKO_LAYOUT_SANDBOX=subagent-evidence-sandbox.cjs
// node apps/desktop/scripts/layout-evidence-integration.cjs
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], facts: {}, errors: [] };
const seed = `(async () => {
  const { records, store, putCachedSession, emitAgent } = layoutFixture;
  const now = Date.now();
  const parent = records[0];
  parent.messages = [
    { id: 'u0', role: 'user', content: 'Audit the billing module', createdAt: now - 9000 },
    { id: 'a0', role: 'assistant', content: 'Two gaps found, in invoices and refunds.', createdAt: now - 8000 },
  ];
  const kid = (id, title, reply) => ({ ...parent, id, title, parentSessionId: 'a', createdAt: now - 7000, messages: reply
    ? [{ id: id + 'u', role: 'user', content: title, createdAt: now - 6000 }, { id: id + 'a', role: 'assistant', content: reply, createdAt: now - 5000 }]
    : [{ id: id + 'u', role: 'user', content: title, createdAt: now - 6000 }] });
  records.push(kid('k1', 'Trace the invoice totals', 'The totals round twice.'), kid('k2', 'Check refund webhooks', 'Webhooks are idempotent.'), kid('k3', 'Review the tax rules'));
  records.forEach(putCachedSession);
  await store.getState().refreshSessions();
})()`;
const working = `['k3', 'a'].forEach((sessionId) => layoutFixture.emitAgent({ type: 'text', sessionId, delta: '' }))`;
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const minX = Math.min(...screen.getAllDisplays().map(d => d.bounds.x)), minY = Math.min(...screen.getAllDisplays().map(d => d.bounds.y));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: minX - 1700, y: minY - 1100, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => { report.errors.push('took focus'); });
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 200)); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const shot = async (name, rect) => { const f = path.join(out, name + '.png'); fs.writeFileSync(f, (await win.capturePage(rect, { stayHidden: true, stayAwake: false })).toPNG()); report.captures.push(f); };
  const rows = () => run(`[...document.querySelectorAll('[data-agent-panel] button.pl-6')].map(b => b.textContent.trim())`);
  const clickText = t => run(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === ${JSON.stringify(t)}); if (b) b.click(); return !!b; })()`);
  const panel = { x: 0, y: 0, width: 420, height: 640 };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 50 && !(await run("!!window.layoutFixture && !!document.querySelector('[data-agent-panel]')")); i++) await sleep(200);
    await sleep(700);
    await run(seed);
    await sleep(700);
    await run(working);
    await sleep(500);
    report.facts.workingIcons = await run(`[...document.querySelectorAll('[data-agent-panel] button.pl-6')].map(b => b.lastElementChild?.outerHTML.slice(0, 120))`);
    report.facts.parentWorking = await rows();
    await shot('panel-parent-working', panel);
    await run(`layoutFixture.emitAgent({ type: 'done', sessionId: 'a', messageId: 'a0' })`);
    await sleep(400);
    report.facts.parentIdle = await rows();
    await shot('panel-parent-idle', panel);
    await run(`layoutFixture.emitAgent({ type: 'done', sessionId: 'k3', messageId: 'k3u' })`);
    await sleep(400);
    report.facts.nothingWorking = await rows();
    await shot('panel-all-finished', panel);
    await run(`(() => { const c = [...document.querySelectorAll('[data-agent-panel] button, [data-agent-panel] [role=button]')].find(x => x.textContent.includes('Diagnose failed build')); if (c) c.click(); return !!c; })()`);
    await sleep(500);
    report.facts.anotherChatOpen = await rows();
    report.facts.card = await run(`[...document.querySelectorAll('[data-agent-panel] [title*="spawned by this chat"]')].map(e => e.textContent.trim())`);
    await shot('panel-another-chat-open', panel);
    // Follow-up in the composer, in the real ChatPane.
    await run('layoutFixture.showRetry()');
    await sleep(900);
    await run(`(() => { const r = layoutFixture.records[0]; r.messages = r.messages.filter(m => !m.interrupted); layoutFixture.putCachedSession(r); })()`);
    report.facts.noDraft = await run(`!!document.querySelector('[data-work-place]')`);
    await run(`(() => { const e = document.querySelector('.composer-editor-wrap [contenteditable]') || document.querySelector('.composer-editor-wrap textarea'); e.focus(); document.execCommand('insertText', false, 'Also add a refund test'); })()`);
    await sleep(500);
    report.facts.withDraft = await run(`document.querySelector('[data-work-place]')?.textContent ?? null`);
    await shot('composer-follow-up', { x: 0, y: 620, width: 1440, height: 280 });
    report.facts.clicked = await clickText('In a subagent');
    await sleep(400);
    report.facts.sent = await run(`layoutFixture.lastSend?.text ?? null`);
    report.facts.draftAfter = await run(`document.querySelector('.composer-editor-wrap [contenteditable]')?.textContent ?? null`);
  } catch (e) { report.errors.push(String(e && e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.captures.length ? 0 : 1);
});
