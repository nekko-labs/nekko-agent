// Electron half of slash-menu-integration.cjs: hidden, non-focusable, offline.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
const version = process.env.NEKKO_TEST_REVISION ? 'before' : 'after';
const dir = path.join(out, version);
fs.mkdirSync(dir, { recursive: true });
app.setPath('userData', path.join(dir, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const EDITOR = '[contenteditable][aria-expanded]';
const MENU = '[id^="slash-menu-"]';
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_wc, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1200, height: 900, show: false, x: -16000, y: -16000, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const run = async s => { try { return await win.webContents.executeJavaScript(s, true); } catch (e) { console.error('Failed expression:', s); throw e; } };
  const checks = [];
  const observed = {};
  const check = async (name, s) => { if (!await run(s)) throw Error(name); checks.push(name); };
  const capture = async name => fs.writeFileSync(path.join(dir, name + '.png'), (await win.capturePage(undefined, { stayHidden: true })).toPNG());
  // Replace the whole draft by typing over it, as the user would.
  const type = async text => {
    await run(`(()=>{const el=document.querySelector('${EDITOR}');el.focus();el.setSelectionRange(0,el.value.length)})()`); await sleep(100);
    await win.webContents.insertText(text); await sleep(400);
  };
  // Type `text` with the caret at `at` in the current draft.
  const typeAt = async (at, text) => {
    await run(`document.querySelector('${EDITOR}').setSelectionRange(${at},${at})`); await sleep(150);
    await win.webContents.insertText(text); await sleep(400);
  };
  const draft = () => run(`document.querySelector('${EDITOR}').value`);
  const menuOpen = () => run(`!!document.querySelector('${MENU}')`);
  try {
    await win.loadFile(path.join(out, 'index.html')); win.showInactive(); await sleep(1000);
    for (const theme of ['light', 'dark']) {
      for (const width of [1200, 480]) {
        win.setContentSize(width, 900); await run(`document.documentElement.dataset.theme='${theme}'`); await sleep(200);
        await type('/');
        observed[`empty-${theme}-${width}`] = { draft: await draft(), menuOpen: await menuOpen() };
        await capture(`empty-${theme}-${width}`);
        await type('Help me with this /');
        observed[`nonempty-${theme}-${width}`] = { draft: await draft(), menuOpen: await menuOpen() };
        await capture(`nonempty-${theme}-${width}`);
        await type('Fix  this'); await typeAt(4, '/');
        observed[`mid-${theme}-${width}`] = { draft: await draft(), menuOpen: await menuOpen() };
        await capture(`mid-${theme}-${width}`);
      }
    }
    win.setContentSize(1200, 900); await run("document.documentElement.dataset.theme='light'");
    await type('/');
    await check('empty draft opens the menu', `!!document.querySelector('${MENU}')`);
    if (version === 'after') {
      await type('Help me with this /');
      await check('slash after text opens the menu', `!!document.querySelector('${MENU}')`);
      await win.webContents.insertText('pl'); await sleep(300);
      await check('trailing query filters skills', `[...document.querySelectorAll('${MENU} [role=option]')].some(b=>b.textContent.includes('/plan'))`);
      await run(`[...document.querySelectorAll('${MENU} [role=option]')].find(b=>b.textContent.includes('/plan')).click()`); await sleep(400);
      await check('picking a skill keeps the draft text', `document.querySelector('${EDITOR}').value==='Help me with this '`);
      await check('picked skill is armed', "!!document.querySelector('.skill-pill')");
      await check('menu closes after picking', `!document.querySelector('${MENU}')`);
      await capture('picked-light-1200');
      await type('Fix  this'); await typeAt(4, '/');
      await check('slash typed mid-draft opens the menu', `!!document.querySelector('${MENU}')`);
      await win.webContents.insertText('pl'); await sleep(300);
      await run(`[...document.querySelectorAll('${MENU} [role=option]')].find(b=>b.textContent.includes('/plan')).click()`); await sleep(400);
      await check('picking mid-draft removes only the query', `document.querySelector('${EDITOR}').value==='Fix this'`);
      await check('caret lands where the query was', `document.querySelector('${EDITOR}').selectionStart===4`);
      await capture('mid-picked-light-1200');
      await type('Fix this'); await typeAt(4, '/');
      await check('a slash glued to the next word stays shut', `!document.querySelector('${MENU}')`);
      await type('Help me with this /'); await typeAt(4, '');
      await check('moving the caret away closes the menu', `!document.querySelector('${MENU}')`);
      await type('see a/b');
      await check('a slash inside a word does not open the menu', `!document.querySelector('${MENU}')`);
    }
  } catch (e) { console.error(e); process.exitCode = 1; }
  finally {
    fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify({ checks, observed }, null, 2));
    console.log(JSON.stringify({ dir, checks, observed }, null, 2));
    win.destroy(); app.quit();
  }
});
