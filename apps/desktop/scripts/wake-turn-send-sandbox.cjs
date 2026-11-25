// A message sent while a Claude Code wake-up turn waits on a sub-agent
// (spec/agents/claude-code-subagents.md). The real ChatPane against the
// synthetic bridge: hidden, off-screen, non-focusable, blocked network,
// isolated profile. NEKKO_WAKE_SEND_BASELINE=1 captures without the checks.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.disableHardwareAcceleration();
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], checks: [], errors: [] };
const baseline = process.env.NEKKO_WAKE_SEND_BASELINE === '1';
const PROMPT = 'Split it into three PRs and keep 3290 as the first';
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1280, height: 860, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false, offscreen: true } });
  const run = s => win.webContents.executeJavaScript(s, true);
  const shot = async name => { await run('document.getAnimations().forEach(a => { try { a.finish(); } catch {} })'); await sleep(80); const f = path.join(out, name + '.png'); fs.writeFileSync(f, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(f); };
  const check = async (name, code) => { if (baseline) return; if (!(await run(code))) throw Error(name); report.checks.push(name); };
  win.on('focus', () => report.errors.push('took focus'));
  // The chat as the engine has it: a finished turn, and nothing else saved.
  const reset = running => run(`(() => { const f = layoutFixture, s = f.records[0];
    s.messages = [{id:'u1',role:'user',content:'Split it, go ahead with it',createdAt:Date.now()-60000},
      {id:'a1',role:'assistant',content:'The split is underway: the sub-agent that built #3290 is reorganising the commits.',createdAt:Date.now()-50000}];
    s.queue = []; s.activeRun = ${running ? `{startedAt:Date.now()-40000,afterMessageId:'a1'}` : 'undefined'};
    localStorage.setItem('fixture.running', JSON.stringify(${running ? `['a']` : '[]'}));
    f.putCachedSession({...s, messages:[...s.messages]}); window.sends = 0; window.queued = 0; })()`);
  // Type into the chat's own composer and press its send button.
  const send = async () => {
    await run(`(() => { const ed = document.querySelector('[data-chat-surface] .composer textarea, [data-chat-surface] .composer [contenteditable]'); if (!ed) throw Error('no composer'); ed.focus();
      if (ed.tagName === 'TEXTAREA') { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(ed, ${JSON.stringify(PROMPT)}); ed.dispatchEvent(new Event('input',{bubbles:true})); }
      else document.execCommand('insertText', false, ${JSON.stringify(PROMPT)}); })()`);
    await sleep(300);
    await run(`document.querySelector('[data-chat-surface] [data-composer-action="send"]').click()`);
    await sleep(700);
    // Anything re-reads the chat (here: the wake-up's sub-agent news).
    await run(`layoutFixture.emitAgent({type:'session_meta',sessionId:'a'})`);
    await sleep(700);
  };
  // In the transcript: anywhere in the chat but its message box and queue.
  const shown = `[...document.querySelectorAll('[data-chat-surface] *')].some(m => !m.children.length && m.textContent.includes(${JSON.stringify(PROMPT)}) && !m.closest('.composer, .collapse-wrap, textarea'))`;
  const inQueue = `[...document.querySelectorAll('[data-chat-surface] .collapse-wrap:not(.collapsed)')].some(q => q.textContent.includes(${JSON.stringify(PROMPT)}))`;
  // A fresh app per case, so one case's turn never carries into the next.
  const boot = async () => {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 80 && !(await run('!!window.layoutFixture && !!document.querySelector("[data-chat-surface]")')); i++) await sleep(150);
    await sleep(1200);
    await run(`document.querySelector('.zones-intro button[aria-label="Close"]')?.click()`);
    await run(`(() => { const f = layoutFixture, s = () => f.records[0];
      Object.assign(f.bridge, {
        // A turn waiting behind the wake-up: admitted, never ending here.
        sendChat: async () => { window.sends++; return new Promise(() => {}); },
        queuePrompt: async (_id, item) => { window.queued++; s().queue = [...(s().queue || []), item]; return {...s(), messages:[...s().messages]}; },
        getSession: async () => ({...s(), messages:[...s().messages]}),
      }); 0 })()`);
  };
  try {
    // 1. The engine runs a wake-up turn this chat has heard nothing from.
    await boot();
    await reset(true);
    await sleep(600);
    await send();
    await shot('wake-turn-send');
    await check('it joins the queue instead of starting a turn', 'window.queued === 1 && window.sends === 0');
    await check('the queue above the message box shows it', inQueue);

    // 2. A sent message whose turn has not saved it yet survives a re-read.
    await boot();
    await reset(false);
    await sleep(600);
    await send();
    await shot('sent-before-save');
    await check('it was sent', 'window.sends === 1');
    await check('it stays in the transcript until saved', shown);
    await check('no horizontal overflow', 'document.documentElement.scrollWidth <= innerWidth');
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.errors.length ? 1 : 0);
});
