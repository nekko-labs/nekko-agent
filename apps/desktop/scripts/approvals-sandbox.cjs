// Matching base/head evidence against real components and a synthetic bridge only.
// NEKKO_FIXTURE=chat-modes-fixture.tsx NEKKO_SANDBOX=approvals-sandbox.cjs node apps/desktop/scripts/chat-search-integration.cjs
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Use chat-search-integration.cjs');
const baseline = !!process.env.NEKKO_TEST_REVISION;
const dir = path.join(out, baseline ? 'approvals-before' : 'approvals-after');
fs.mkdirSync(dir, { recursive: true });
app.setPath('userData', path.join(dir, 'profile'));
app.setPath('sessionData', path.join(dir, 'profile'));
const js = v => JSON.stringify(v).replace(/[<>/\u2028\u2029]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((r, done) => done({ cancel: !/^(file:|data:|blob:)/.test(r.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1100, height: 720, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  const report = { baseline, checks: [], errors: [], captures: [] };
  win.webContents.on('console-message', e => { if (e.level === 'error') console.error('renderer:', e.message); });
  win.webContents.on('render-process-gone', (_e, details) => report.errors.push(JSON.stringify(details)));
  win.on('show', () => report.errors.push('became visible'));
  win.on('focus', () => report.errors.push('took focus'));
  const run = code => win.webContents.executeJavaScript(code, true);
  const has = selector => run(`!!document.querySelector(${js(selector)})`);
  const wait = async selector => { for (let i = 0; i < 60; i++) { if (await has(selector)) return; await sleep(100); } throw Error('Missing ' + selector); };
  const click = async selector => { await wait(selector); await run(`document.querySelector(${js(selector)}).click()`); await sleep(250); };
  const check = async (name, code) => { const passed = !!(await run(code)); report.checks.push({ name, passed }); if (!passed) throw Error(name); };
  const shot = async name => { await sleep(500); await win.capturePage(undefined, { stayHidden: true }); await sleep(200); const file = path.join(dir, `${baseline ? 'before' : 'after'}-${name}.png`); fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(file); };
  const scene = async (mode, extra = {}) => {
    await run(`localStorage.removeItem('nekko.composer.details'); localStorage.removeItem('nekko.simpleChoices'); localStorage.setItem('nekko.chatMode',${js(mode)}); localStorage.setItem('fixture.scene',${js(JSON.stringify({ local: false, changes: 0, long: false, ...extra }))}); location.hash=''; location.reload()`).catch(() => {});
    await sleep(300); await wait('[data-session-id="alpha"] .composer'); await sleep(1000);
  };
  try {
    await win.loadFile(path.join(out, 'index.html')); await wait('.composer');
    for (const width of [1100, 760]) {
      win.setContentSize(width, 720);
      await scene('expert');
      await shot(`detailed-${width}`);
      if (!baseline) {
        await check('Detailed approvals and Mode have separate rows ' + width, `!!document.querySelector('[data-composer-details] [data-asks-first]') && !!document.querySelector('[data-composer-mode-row] [data-chat-mode-button]') && document.querySelector('[data-composer-mode-row]').getBoundingClientRect().top >= document.querySelector('[data-asks-first]').getBoundingClientRect().bottom`);
        await check('No horizontal page overflow ' + width, 'document.documentElement.scrollWidth <= innerWidth');
        await click('[data-asks-first]'); await shot(`detailed-menu-${width}`); await click('[data-asks-first]');
      }
      await click('[data-chat-mode-button]'); await shot(`mode-panel-${width}`); await click('[data-chat-mode-button]');
    }
    win.setContentSize(1100, 720);
    await scene('simple'); if (!baseline) await check('Simple has one icon-only approvals control', `document.querySelectorAll('[data-asks-first]').length===1 && document.querySelector('[data-asks-first]').classList.contains('composer-permissions')`); await click('[data-asks-first]'); await shot('simple-menu');
    if (!baseline) {
      await check('Exactly three named choices with Gentleface icons', `(()=>{const m=document.querySelector('[data-asks-menu]'); return m.querySelectorAll('[role="menuitemradio"]').length===3 && ['Always ask','Ask when it matters','No restrictions'].every(t=>m.textContent.includes(t)) && ['hand','shield-check','running'].every(n=>m.querySelector('[data-gf-icon="'+n+'"]'))})()`);
      await check('A bottom row of Incognito, Privacy Shield and Internet access switches', `[...document.querySelectorAll('[data-asks-toggles] [data-asks-toggle]')].map(b=>b.dataset.asksToggle).join()==='incognito,shield,internet'`);
      // The fixture's model is local, so Internet access can be switched off (a cloud model locks it on: see AsksFirstMenu.test.tsx).
      await click('[data-asks-toggle="internet"]');
      await check('Internet access switches off for a local model', `document.querySelector('[data-asks-toggle="internet"]').getAttribute('aria-pressed')==='false'`);
      await click('[data-asks-toggle="incognito"]'); await click('[data-asks-toggle="shield"]');
      await check('Switching keeps the menu open: Incognito and Shield lit, Internet off', `!!document.querySelector('[data-asks-menu]') && document.querySelector('[data-asks-toggle="incognito"]').getAttribute('aria-pressed')==='true' && document.querySelector('[data-asks-toggle="shield"]').getAttribute('aria-pressed')==='true'`);
      await shot('simple-menu-toggles-on');
      await click('[data-asks-toggle="incognito"]'); await click('[data-asks-toggle="shield"]'); await click('[data-asks-toggle="internet"]');
      await check('Switching them again restores all three', `document.querySelector('[data-asks-toggle="incognito"]').getAttribute('aria-pressed')==='false' && document.querySelector('[data-asks-toggle="shield"]').getAttribute('aria-pressed')==='false' && document.querySelector('[data-asks-toggle="internet"]').getAttribute('aria-pressed')==='true'`);
    }
    await click('[data-asks-menu] > button:nth-of-type(3)'); await wait('#yolo-warning-title'); await shot('warning');
    await check('No restrictions waits for confirmation', `document.querySelector('[data-asks-first]').dataset.asksFirst==='guardrails'`);
    await run(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Keep asking').click()`); await sleep(200);
    await check('Cancel preserves the policy', `document.querySelector('[data-asks-first]').dataset.asksFirst==='guardrails' && !document.querySelector('#yolo-warning-title')`);
    await click('[data-asks-first]'); await click('[data-asks-menu] > button:nth-of-type(3)'); await wait('#yolo-warning-title');
    await run(`document.querySelector('#yolo-warning-title').closest('[role="dialog"]').querySelector('.btn-primary').click()`); await sleep(400);
    await check('Confirm preserves the yolo wire value', `document.querySelector('[data-asks-first]').dataset.asksFirst==='yolo'`);
    await click('[data-asks-first]'); await click('[data-asks-menu] button:first-child');
    await check('Always ask preserves the ask wire value', `document.querySelector('[data-asks-first]').dataset.asksFirst==='ask'`);
    await scene('simple', { sandbox: true });
    if (baseline) await check('Sandbox locks approvals to Always ask', `document.querySelector('[data-asks-first]').disabled && document.querySelector('[data-asks-first]').dataset.asksFirst==='ask'`);
    else {
      // The menu still opens in a sandbox, for its switches; only Always ask can be chosen.
      await click('[data-asks-first]'); await shot('sandbox-menu');
      await check('Sandbox locks approvals to Always ask', `document.querySelector('[data-asks-first]').dataset.asksFirst==='ask' && [...document.querySelectorAll('[data-asks-menu] [role="menuitemradio"]')].map(b=>b.disabled).join()==='false,true,true' && !document.querySelector('[data-asks-toggle="incognito"]').disabled`);
      await click('[data-asks-first]');
    }
    await scene('expert', { wall: true }); await shot('wall');
    if (!baseline) await check('Wall approvals stay beside model with Mode below', `!!document.querySelector('[data-composer-foot] [data-asks-first]') && !!document.querySelector('[data-composer-mode-row] [data-chat-mode-button]') && !document.querySelector('[data-composer-foot] [data-chat-mode-button]')`);
    await scene('expert', { clean: true }); await shot('new-chat');
    if (!baseline) await check('New Detailed chat includes approvals and lower Mode row', `!!document.querySelector('[data-clean-start-model] [data-asks-first]') && !!document.querySelector('[data-composer-mode-row] [data-chat-mode-button]')`);
    await scene('expert'); await click('.composer-details-toggle'); await shot('collapsed');
    if (!baseline) await check('Collapsed details do not leave Mode or approvals behind', `!document.querySelector('[data-asks-first]') && !document.querySelector('[data-chat-mode-button]')`);
    await run(`location.hash='#settings'; location.reload()`); await sleep(300); await wait('[data-simple-mode-settings]');
    await run(`document.querySelector('[data-simple-area="Chat · message box"]').scrollIntoView({block:'start'})`); await shot('preview');
    if (win.isVisible() || win.isFocused()) throw Error('Fixture was visible or focused');
  } catch (e) { report.errors.push(String(e.stack || e)); report.page = await run('({url:location.href,text:document.body.innerText.slice(0,2000),html:document.body.innerHTML.slice(-1000)})'); }
  finally { report.bounds = win.getBounds(); fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); win.destroy(); app.exit(report.errors.length ? 1 : 0); }
});
