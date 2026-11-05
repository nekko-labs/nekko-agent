// Hidden, isolated real-controls verification. No OS input or host connections.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
app.setPath('userData', path.join(out, 'profile'));
app.setPath('sessionData', path.join(out, 'profile'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1000, height: 720, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -4000, y: -3000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const report = { checks: [], errors: [], bounds: win.getBounds() };
  win.on('show', () => report.errors.push('became visible'));
  win.on('focus', () => report.errors.push('took focus'));
  const run = text => win.webContents.executeJavaScript(text, true);
  const check = async (name, expr) => { const passed = !!await run(expr); report.checks.push({ name, passed }); if (!passed) throw Error(name); };
  const capture = async name => { await win.capturePage(undefined, { stayHidden: true }); await sleep(220); fs.writeFileSync(path.join(out, name + '.png'), (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG()); };
  const select = async (start = 0, end = 18) => { await run(`interfaceFixture.editor.current.focus(); interfaceFixture.editor.current.setSelectionRange(${start},${end})`); await sleep(200); };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 60 && !await run('!!window.interfaceFixture'); i++) await sleep(100);
    await sleep(500);
    const after = await run('!!document.querySelector("[data-follow-up-location]")');
    for (const [label, width] of [['desktop', 1000], ['narrow', 390]]) {
      win.setContentSize(width, 720); await sleep(200); await select();
      await capture(label);
      await check(label + ': no automatic send', 'interfaceFixture.sends.length === 0');
      if (after) {
        await check(label + ': one row of tools', `(() => { const buttons = [...document.querySelectorAll('[data-composer-toolbar] button')]; return buttons.length === 11 && new Set(buttons.map(b => Math.round(b.getBoundingClientRect().top))).size === 1; })()`);
        await check(label + ': toolbar fits viewport', `(() => {const r=document.querySelector('[data-composer-toolbar]').getBoundingClientRect(); return r.left>=8 && r.right<=innerWidth-8 && r.top>=8 && r.bottom<=innerHeight-8;})()`);
      }
    }
    if (after) {
      win.setContentSize(1000, 720); await select(19, 43);
      await check('toolbar crosses agent boundary', `document.querySelector('[data-composer-toolbar]').getBoundingClientRect().right > document.querySelector('[data-agent-pane]').getBoundingClientRect().right`);
      await select();
      await run(`document.querySelector('[data-composer-toolbar] [aria-label="Bold"]').click()`); await sleep(250);
      await check('formatting preserves selected words', `interfaceFixture.editor.current.value === '**Make the next step** feel simple and connected.' && interfaceFixture.editor.current.selectionStart === 2 && interfaceFixture.editor.current.selectionEnd === 20`);
      await check('active formatting exposed', `document.querySelector('[data-composer-toolbar] [aria-label="Bold"]')?.getAttribute('aria-pressed') === 'true'`);
      await run(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
      await check('Escape dismisses toolbar', `!document.querySelector('[data-composer-toolbar]')`);
      await run(`document.querySelector('[data-follow-up-location] [value="subagent"]').click()`); await sleep(200);
      await check('changing destination does not send', 'interfaceFixture.sends.length === 0');
      await run(`document.querySelector('[data-follow-up-choices] > div:last-child button').click()`);
      await check('delegated payload is exact', String.raw`interfaceFixture.sends[0] === 'Do this in a subagent, then report back:\n\nCheck the latest CI and merge the PR'`);
      await run(`document.querySelector('[data-follow-up-location] [value="here"]').click()`); await sleep(200);
      await run(`document.querySelector('[data-follow-up-choices] > div:last-child button').click()`);
      await check('direct payload is exact', `interfaceFixture.sends[1] === 'Check the latest CI and merge the PR'`);
      await run('interfaceFixture.setCanDelegate(false)'); await sleep(200);
      await check('unavailable delegation hides slider only', `!document.querySelector('[data-follow-up-location]') && !!document.querySelector('[data-follow-up-choices] > div:last-child button')`);
      await run('interfaceFixture.setCanDelegate(true); interfaceFixture.setValue("Make the next step feel simple and connected.")'); await sleep(200);
      await select();
      await run(`document.querySelector('[data-follow-up-location] [value="here"]').focus()`);
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' });
      await sleep(200);
      await check('arrow key selects destination without sending', `document.querySelector('[data-follow-up-location] [value="subagent"]').checked && interfaceFixture.sends.length === 2`);
      await run('interfaceFixture.setPosition("top")'); await sleep(200); await select();
      await check('top-edge selection flips toolbar below', `document.querySelector('[data-composer-toolbar]').dataset.side === 'below'`);
      report.topEdge = await run(`({toolbar: document.querySelector('[data-composer-toolbar]').getBoundingClientRect().toJSON(), editor: interfaceFixture.editor.current.getBoundingClientRect().toJSON()})`);
      await capture('top-edge');
      await run('interfaceFixture.setPosition("right")'); await sleep(200); await select(25, 43);
      await check('right-edge selection keeps toolbar inside viewport', `document.querySelector('[data-composer-toolbar]').getBoundingClientRect().right <= innerWidth - 8`);
      report.rightEdge = await run(`({toolbar: document.querySelector('[data-composer-toolbar]').getBoundingClientRect().toJSON(), editor: interfaceFixture.editor.current.getBoundingClientRect().toJSON()})`);
      await capture('right-edge');
      await run('interfaceFixture.setPosition("normal")'); await sleep(200);
      const frames = [];
      for (let i = 0; i < 30; i++) {
        if (i === 3 || i === 17) await run(`document.querySelector('[data-follow-up-location] [value="${i === 3 ? 'here' : 'subagent'}"]').click()`);
        frames.push((await win.capturePage({ x: 16, y: 50, width: 370, height: 230 }, { stayHidden: true, stayAwake: false })).toPNG());
        await sleep(70);
      }
      require('./evidence-gif.cjs')(path.join(out, 'slider-motion.gif'), frames, 7);
    }
  } catch (error) { report.errors.push(String(error.stack || error)); }
  report.hidden = !win.isVisible();
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2)); win.destroy(); app.exit(report.errors.length ? 1 : 0);
});
