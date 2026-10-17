// Hidden, non-focusable, off-screen window with network blocked: never touches the user desktop.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
const version = process.env.NEKKO_TEST_REVISION ? 'before' : 'after';
const dir = path.join(out, version);
fs.mkdirSync(dir, { recursive: true });
app.setPath('userData', path.join(dir, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const escapeUnsafeChars = str => str.replace(/[<>\u2028\u2029]/g, c => (
  c === '<' ? '\\u003C' :
  c === '>' ? '\\u003E' :
  c === '\u2028' ? '\\u2028' :
  '\\u2029'
));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_wc, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1100, height: 620, show: false, x: -16000, y: -16000, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.on('console-message', e => { if (e.level === 'error') console.log('[page]', e.message); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const checks = [];
  const check = async (name, s) => { if (!await run(s)) throw Error('FAILED: ' + name); checks.push(name); };
  const capture = async name => fs.writeFileSync(path.join(dir, name + '.png'), (await win.capturePage(undefined, { stayHidden: true })).toPNG());
  const type = async text => run(`(()=>{const i=document.querySelector('[data-chat-finder] input');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(i,${escapeUnsafeChars(JSON.stringify(text))});i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const key = async k => run(`document.querySelector('[data-chat-finder] input').dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(k)},bubbles:true}))`);
  const rows = "[...document.querySelectorAll('[data-finder-row]')]";
  try {
    await win.loadFile(path.join(out, 'index.html')); win.showInactive(); await sleep(900);
    for (const theme of ['dark', 'light']) { await run(`document.documentElement.dataset.theme='${theme}'`); await sleep(150); await capture(`header-${theme}`); }
    await run(`document.documentElement.dataset.theme='dark'`);
    if (version === 'after') {
      await check('search sits beside + with the same class and icon size', "(()=>{const s=document.querySelector('[data-chat-finder-toggle]'),p=s.nextElementSibling?.matches('.agent-panel-plus')?s.nextElementSibling:document.querySelector('[aria-label=\"New agent\"]');const a=s.querySelector('svg').getBoundingClientRect(),b=p.querySelector('svg').getBoundingClientRect();return s.classList.contains('agent-panel-plus')&&a.width===b.width&&a.height===b.height&&getComputedStyle(s).color===getComputedStyle(p).color})()");
      await run("document.querySelector('[data-chat-finder-toggle]').click()"); await sleep(200);
      await check('popup opens with latest chats newest first', `(()=>{const r=${rows};return r.length===9&&r[0].dataset.finderRow==='s0'&&r[8].dataset.finderRow==='s8'})()`);
      await check('ages read days to 30 then months', "(()=>{const a=[...document.querySelectorAll('[data-finder-age]')].map(e=>e.textContent);return JSON.stringify(a)===JSON.stringify(['Today','1 day','4 days','12 days','29 days','1 month','2 months','4 months','13 months'])})()");
      await check('Nekko search button and X are present', "!!document.querySelector('[data-finder-search] svg')&&!!document.querySelector('[data-finder-close]')");
      await capture('popup-latest-dark');
      await run(`document.documentElement.dataset.theme='light'`); await sleep(150); await capture('popup-latest-light'); await run(`document.documentElement.dataset.theme='dark'`);
      await type('fix'); await sleep(400);
      await check('no search while still typing', `${rows}.length===9`);
      await capture('popup-pending-dark');
      await sleep(1400);
      await check('search runs after typing pauses: title hit first, body hit after', `(()=>{const r=${rows}.map(e=>e.dataset.finderRow);return JSON.stringify(r)===JSON.stringify(['s1','s5'])})()`);
      await capture('popup-results-dark');
      await type('benchmark'); await key('Enter'); await sleep(100);
      await check('Enter searches at once', `(()=>{const r=${rows};return r.length===1&&r[0].dataset.finderRow==='s8'})()`);
      await key('Enter'); await sleep(150);
      await check('Enter on settled results opens the chat and closes the popup', "integration.opened.at(-1)==='s8'&&!document.querySelector('[data-chat-finder]')");
      await run("document.querySelector('[data-chat-finder-toggle]').click()"); await sleep(150);
      await run(`${rows}[2].click()`); await sleep(150);
      await check('clicking a row opens that chat', "integration.opened.at(-1)==='s2'&&!document.querySelector('[data-chat-finder]')");
      await run("document.querySelector('[data-chat-finder-toggle]').click()"); await sleep(150);
      await run("document.querySelector('[data-finder-close]').click()"); await sleep(100);
      await check('X closes', "!document.querySelector('[data-chat-finder]')");
      await run("document.querySelector('[data-chat-finder-toggle]').click()"); await sleep(150);
      await key('Escape'); await sleep(100);
      await check('Esc closes', "!document.querySelector('[data-chat-finder]')");
    }
    if (version === 'after' && process.env.NEKKO_MOTION) {
      // Frames for a short recording: open, type, wait line fills, results land.
      const motion = path.join(dir, 'motion'); fs.rmSync(motion, { recursive: true, force: true }); fs.mkdirSync(motion, { recursive: true });
      let n = 0; const frame = async () => fs.writeFileSync(path.join(motion, `f${String(n++).padStart(3, '0')}.png`), (await win.capturePage({ x: 0, y: 0, width: 520, height: 460 }, { stayHidden: true })).toPNG());
      for (let i = 0; i < 4; i++) { await frame(); await sleep(40); }
      await run("document.querySelector('[data-chat-finder-toggle]').click()");
      for (let i = 0; i < 6; i++) { await frame(); await sleep(30); }
      await type('fix');
      const t0 = Date.now(); while (Date.now() - t0 < 2000) { await frame(); await sleep(60); }
      for (let i = 0; i < 6; i++) { await frame(); await sleep(60); }
      checks.push(`motion frames ${n}`);
    }
    fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify({ checks }, null, 2));
    console.log(JSON.stringify({ version, checks }, null, 2));
  } catch (e) { console.error(e); process.exitCode = 1; }
  finally { win.destroy(); app.quit(); }
});
