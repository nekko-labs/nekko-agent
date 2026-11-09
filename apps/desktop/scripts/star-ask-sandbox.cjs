// The in-chat GitHub star ask (spec/platform/github-star-ask.md), on the real
// App against the synthetic bridge. Hidden, off-screen, non-focusable, blocked
// network, isolated profile; no OS input and no real GitHub request.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.disableHardwareAcceleration(); // capturePage throws UnknownVizError on GPU-less hosts otherwise
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], checks: [], errors: [] };
const baseline = process.env.NEKKO_STAR_ASK_BASELINE === '1';
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1280, height: 860, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false, offscreen: true } });
  const run = s => win.webContents.executeJavaScript(s, true);
  const shot = async name => { await run('document.getAnimations().forEach(a => { try { a.finish(); } catch {} })'); await sleep(60); const f = path.join(out, name + '.png'); fs.writeFileSync(f, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(f); };
  const check = async (name, code) => { if (!(await run(code))) throw Error(name); report.checks.push(name); };
  win.on('focus', () => report.errors.push('took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 400)); });
  // One prompt sent through the real composer path, then its reply finishing.
  let n = 0;
  const prompt = async () => {
    n++;
    await run(`layoutFixture.store.setState({composerInbox:{sessionId:'a',text:'Tidy the release notes, part ${n}',run:true}})`);
    await sleep(250);
    await run(`(() => { const f = layoutFixture, s = f.records[0];
      s.messages = [...s.messages.filter(m => !String(m.id).startsWith('star-')), {id:'star-u${n}',role:'user',content:'Tidy the release notes, part ${n}',createdAt:Date.now()}, {id:'star-a${n}',role:'assistant',content:'Done: the notes are grouped by area and each line says what changed for people using the app.',createdAt:Date.now()}];
      f.putCachedSession(s); f.emitAgent({type:'text',sessionId:'a',delta:'Done.'}); f.emitAgent({type:'done',sessionId:'a',messageId:'star-a${n}'}); })()`);
    await sleep(450);
  };
  const askShown = '!!document.querySelector("[data-testid=github-star-ask]")';
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 80 && !(await run('!!window.layoutFixture && !!document.querySelector("[data-chat-surface]")')); i++) await sleep(150);
    await sleep(1200);
    await run(`document.querySelector('.zones-intro button[aria-label="Close"]')?.click()`);
    // No GitHub connector: the card opens the repository.
    await run(`localStorage.setItem('nekko.star-ask', JSON.stringify({prompts:8,asked:0}));
      Object.assign(layoutFixture.bridge, {
        supportStarStatus: async () => window.starState || {state:'unavailable',reason:'Connect your GitHub account in Connectors to check or add a star here. You can also star on GitHub.'},
        supportStar: async () => { window.starWrites = (window.starWrites||0)+1; window.starState = {state:'starred',login:'nekko-supporter'}; return {...window.starState,newlyStarred:true}; },
        openPath: async (url) => { window.openedUrl = url; },
        sendChat: async (opts) => { layoutFixture.lastSend = opts; },
      }); 0`);
    await prompt();
    await shot('ninth-reply');
    if (!baseline) await check('no card before the 10th finished prompt', `!${askShown}`);
    await prompt();
    await shot('tenth-reply');
    if (baseline) return;
    await check('card under the 10th reply', askShown);
    await check('the first ask is used up as soon as it shows', `JSON.parse(localStorage.getItem('nekko.star-ask')).asked === 1`);
    await check('card is not a modal', `!document.querySelector('[role=dialog]') && !!document.querySelector('[data-chat-surface] [data-testid=github-star-ask]')`);
    await check('nothing written to GitHub by showing it', '!window.starWrites');
    win.setContentSize(390, 844); await sleep(350); await shot('tenth-reply-narrow');
    await check('narrow width does not overflow', 'document.documentElement.scrollWidth <= innerWidth');
    win.setContentSize(1280, 860); await sleep(300);
    // Sending again without choosing counts as Not now: it goes, and does not come back at 11.
    await prompt();
    await check('ignored card leaves with the next prompt and stays away', `!${askShown}`);
    // Jump to just before the second ask; this time the account is connected.
    await run(`localStorage.setItem('nekko.star-ask', JSON.stringify({prompts:48,asked:1})); window.starState = {state:'not-starred',login:'nekko-supporter'};`);
    await prompt();
    await check('no card at 49', `!${askShown}`);
    await prompt();
    await check('card again at 50', askShown);
    await check('connected account stars in place', `document.querySelector('[data-testid=star-ask-star]').textContent.includes('@nekko-supporter')`);
    await shot('fiftieth-reply-connected');
    await run(`document.querySelector('[data-testid=star-ask-star]').click()`); await sleep(400);
    await check('one explicit click writes exactly one star', 'window.starWrites === 1');
    await check('thanks in place', `document.querySelector('[data-testid=github-star-ask]').textContent.includes('Thank you, @nekko-supporter')`);
    await check('starring stops the ask for good', `JSON.parse(localStorage.getItem('nekko.star-ask')).stopped === true`);
    await shot('starred-thanks');
    // A stargazer is never shown it, even when a count is due.
    await run(`localStorage.setItem('nekko.star-ask', JSON.stringify({prompts:9,asked:0}))`);
    await prompt();
    await check('an existing star hides the card and stops asking', `!${askShown} && JSON.parse(localStorage.getItem('nekko.star-ask')).stopped === true`);
    // Don't ask again, without a connector: opens nothing, stops for good.
    await run(`localStorage.setItem('nekko.star-ask', JSON.stringify({prompts:9,asked:0})); window.starState = null; window.openedUrl = null;`);
    await prompt();
    await run(`document.querySelector('[data-testid=star-ask-never]').click()`); await sleep(200);
    await check("Don't ask again closes it, opens nothing and stops", `!${askShown} && !window.openedUrl && JSON.parse(localStorage.getItem('nekko.star-ask')).stopped === true`);
    // Star on GitHub without a connector opens the fixed repository page.
    await run(`localStorage.setItem('nekko.star-ask', JSON.stringify({prompts:9,asked:0}))`);
    await prompt();
    await run(`document.querySelector('[data-testid=star-ask-star]').click()`); await sleep(250);
    await check('opens the repository page', `window.openedUrl === 'https://github.com/nekko-labs/nekko-agent' && !window.starWrites || window.starWrites === 1`);
    await shot('opened-github');
  } catch (e) {
    report.errors.push(String(e && e.stack || e));
  } finally {
    report.windowBounds = win.getBounds();
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    app.exit(report.errors.some(e => /^Error/.test(e)) ? 1 : 0);
  }
});
