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
  const win = new BrowserWindow({ width: 1100, height: 720, show: false, x: -16000, y: -16000, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.on('console-message', e => { if (e.level === 'error') console.log('[page]', e.message); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const checks = [];
  const check = async (name, s) => { if (!await run(s)) throw Error('FAILED: ' + name); checks.push(name); };
  const capture = async name => fs.writeFileSync(path.join(dir, name + '.png'), (await win.capturePage({ x: 0, y: 0, width: 780, height: 720 }, { stayHidden: true })).toPNG());
  const type = async text => run(`(()=>{const i=document.querySelector('[data-chat-finder] input');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(i,${escapeUnsafeChars(JSON.stringify(text))});i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const key = async k => run(`document.querySelector('[data-chat-finder] input').dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(k)},bubbles:true}))`);
  const click = async sel => run(`document.querySelector(${JSON.stringify(sel)}).click()`);
  const rows = "[...document.querySelectorAll('[data-finder-row]')]";
  const ids = `${rows}.map(e=>e.dataset.finderRow)`;
  const openFinder = async () => { await click('[data-chat-finder-toggle]'); await sleep(200); };
  try {
    await win.loadFile(path.join(out, 'index.html')); win.showInactive(); await sleep(900);
    await run(`document.documentElement.dataset.theme='dark'`);
    await openFinder();
    await capture('popup-latest-dark');
    await run(`document.documentElement.dataset.theme='light'`); await sleep(150); await capture('popup-latest-light'); await run(`document.documentElement.dataset.theme='dark'`);
    if (version === 'after') {
      await check('popup opens on All with latest chats newest first', `(()=>{const r=${ids};return r.length===9&&r[0]==='s0'&&r[8]==='s8'&&document.querySelector('[data-finder-scope="all"]').getAttribute('aria-selected')==='true'})()`);
      await check('six scope tabs and a date button', "document.querySelectorAll('[data-finder-scope]').length===6&&!!document.querySelector('[data-finder-date]')");
      // 1000 ms debounce: nothing at 600 ms, results by 1100 ms.
      await type('kerning'); await sleep(600);
      await check('no search 600 ms after typing', `${rows}.length===9`);
      await sleep(550);
      await check('search runs 1 s after typing stops and finds a word deep in the messages', `(()=>{const r=${rows};return r.length===1&&r[0].dataset.finderRow==='s1'&&r[0].dataset.finderKind==='message'})()`);
      await capture('all-message-hit-dark');
      await run(`${rows}[0].click()`); await sleep(150);
      await check('clicking a message hit opens the chat and seeds Find in chat with the word', "integration.opened.at(-1)==='s1'&&!document.querySelector('[data-chat-finder]')&&integration.findSeed()?.query==='kerning'&&integration.findSeed()?.sessionId==='s1'");
      await openFinder();
      // Chats tab: titles/descriptions only.
      await click('[data-finder-scope="chats"]'); await type('kerning'); await key('Enter'); await sleep(150);
      await check('Chats tab does not search inside messages', `${rows}.length===0`);
      await type('oauth'); await key('Enter'); await sleep(150);
      await check('Chats tab matches the description', `(()=>{const r=${rows};return r.length===1&&r[0].dataset.finderRow==='s5'})()`);
      // Messages tab.
      await click('[data-finder-scope="messages"]'); await type('stripe'); await key('Enter'); await sleep(300);
      await check('Messages tab finds a reply', `(()=>{const r=${ids};return r.length===1&&r[0]==='s6'})()`);
      await capture('messages-dark');
      // Artifacts tab.
      await click('[data-finder-scope="artifacts"]'); await type(''); await key('Enter'); await sleep(300);
      await check('Artifacts tab lists the linked report', "(()=>{const a=[...document.querySelectorAll('[data-finder-artifact]')];return a.length===1&&a[0].dataset.finderRow==='s2'})()");
      await capture('artifacts-dark');
      await run("document.querySelector('[data-finder-artifact]').click()"); await sleep(150);
      await check('clicking an artifact opens the chat that made it', "integration.opened.at(-1)==='s2'&&!document.querySelector('[data-chat-finder]')");
      await openFinder();
      // Groups tab.
      await click('[data-finder-scope="groups"]'); await sleep(200);
      await check('Groups tab shows General, nekko-agent and website with their chats', `(()=>{const f=[...document.querySelectorAll('[data-finder-facet]')].map(e=>e.dataset.finderFacet);return JSON.stringify(f)===JSON.stringify(['__none','w1','w2'])})()`);
      await check('a group shows 5 then Show all', "!!document.querySelector('[data-finder-facet=\"w1\"] [data-finder-facet-more]')||document.querySelectorAll('[data-finder-facet=\"w1\"] [data-finder-row]').length===4");
      await capture('groups-dark');
      await type('website'); await key('Enter'); await sleep(150);
      await check('searching a group name shows that group with all its chats', `(()=>{const f=[...document.querySelectorAll('[data-finder-facet]')];return f.length===1&&f[0].dataset.finderFacet==='w2'&&f[0].querySelectorAll('[data-finder-row]').length===2})()`);
      await run("document.querySelector('[data-finder-facet=\"w2\"] [data-finder-row]').click()"); await sleep(150);
      await check('a chat inside a group opens', "integration.opened.at(-1)==='s3'&&!document.querySelector('[data-chat-finder]')");
      await openFinder();
      // Providers tab.
      await click('[data-finder-scope="providers"]'); await sleep(200);
      await check('Providers tab splits Local and Cloud sections', "!!document.querySelector('[data-finder-section=\"local\"] [data-finder-facet=\"p:eng\"]')&&!!document.querySelector('[data-finder-section=\"cloud\"] [data-finder-facet=\"p:ant\"]')");
      await capture('providers-dark');
      await run(`document.documentElement.dataset.theme='light'`); await sleep(150); await capture('providers-light'); await run(`document.documentElement.dataset.theme='dark'`);
      await type('local'); await key('Enter'); await sleep(150);
      await check('"local" keeps only local providers', `(()=>{const f=[...document.querySelectorAll('[data-finder-facet]')].map(e=>e.dataset.finderFacet);return JSON.stringify(f)===JSON.stringify(['p:eng'])})()`);
      await run("document.querySelector('[data-finder-facet=\"p:eng\"] [data-finder-row]').click()"); await sleep(150);
      await check('a chat inside a provider opens', "integration.opened.at(-1)==='s2'");
      await openFinder();
      // Date range: single calendar, two clicks.
      await click('[data-finder-date]'); await sleep(150);
      await check('calendar opens as one month grid', "document.querySelectorAll('[data-finder-calendar] [data-day]').length===42");
      await run("[...document.querySelectorAll('[data-finder-calendar] button')].find(b=>b.textContent==='7 days').click()"); await sleep(150);
      await check('7-day preset keeps only chats active in the last week', `(()=>{const r=${ids};return JSON.stringify(r)===JSON.stringify(['s0','s1','s2'])})()`);
      await capture('range-results-dark');
      await click('[data-finder-range-label]'); await sleep(150);
      // Pick from = today - 13, to = today - 11 via two clicks on day cells.
      await run(`(()=>{const day=d=>{const t=new Date();t.setHours(0,0,0,0);t.setDate(t.getDate()-d);return t.toDateString()};const cell=d=>document.querySelector('[data-finder-calendar] [aria-label="'+day(d)+'"]');let c=cell(13);if(!c){document.querySelector('[aria-label="Previous month"]').click();}})()`); await sleep(100);
      await run(`(()=>{const day=d=>{const t=new Date();t.setHours(0,0,0,0);t.setDate(t.getDate()-d);return t.toDateString()};const cell=d=>document.querySelector('[data-finder-calendar] [aria-label="'+day(d)+'"]');cell(13).click();})()`); await sleep(80);
      await capture('calendar-picking-dark');
      await run(`(()=>{const day=d=>{const t=new Date();t.setHours(0,0,0,0);t.setDate(t.getDate()-d);return t.toDateString()};const cell=d=>document.querySelector('[data-finder-calendar] [aria-label="'+day(d)+'"]');(cell(11)||(document.querySelector('[aria-label="Next month"]').click(),null));})()`); await sleep(80);
      await run(`(()=>{const day=d=>{const t=new Date();t.setHours(0,0,0,0);t.setDate(t.getDate()-d);return t.toDateString()};document.querySelector('[data-finder-calendar] [aria-label="'+day(11)+'"]').click();})()`); await sleep(150);
      await check('two clicks pick a from–to range and filter to it', `(()=>{const r=${ids};return JSON.stringify(r)===JSON.stringify(['s3'])&&!document.querySelector('[data-finder-calendar]')})()`);
      await click('[data-finder-range-x]'); await sleep(150);
      await check('clearing the range brings every chat back', `${rows}.length===9`);
      await click('[data-finder-date]'); await sleep(150);
      await capture('calendar-dark');
      await run(`document.documentElement.dataset.theme='light'`); await sleep(150); await capture('calendar-light'); await run(`document.documentElement.dataset.theme='dark'`);
      await key('Escape'); await sleep(80);
      await check('Esc closes the calendar first', "!document.querySelector('[data-finder-calendar]')&&!!document.querySelector('[data-chat-finder]')");
      await key('Escape'); await sleep(80);
      await check('Esc again closes the popup', "!document.querySelector('[data-chat-finder]')");
      // Narrow window: popup stays inside the viewport.
      win.setContentSize(360, 640); await sleep(200);
      await openFinder();
      await check('popup fits a narrow window', "(()=>{const r=document.querySelector('[data-chat-finder]').getBoundingClientRect();return r.left>=0&&r.right<=window.innerWidth})()");
      fs.writeFileSync(path.join(dir, 'narrow-dark.png'), (await win.capturePage(undefined, { stayHidden: true })).toPNG());
    }
    fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify({ checks }, null, 2));
    console.log(JSON.stringify({ version, checks }, null, 2));
  } catch (e) { console.error(e); process.exitCode = 1; }
  finally { win.destroy(); app.quit(); }
});
