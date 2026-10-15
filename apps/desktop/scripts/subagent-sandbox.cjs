const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through command-center-integration.cjs');
const runDir = path.join(out, new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(runDir, { recursive: true });
app.setPath('userData', path.join(runDir, 'profile'));
app.setPath('sessionData', path.join(runDir, 'profile'));
const report = { checks: [], errors: [], captures: [], visuallyInspected: false };
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, done) => done(false));
  const win = new BrowserWindow({ width: 1200, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: Math.min(...screen.getAllDisplays().map(d => d.bounds.x)) - 1400, y: Math.min(...screen.getAllDisplays().map(d => d.bounds.y)) - 1100, title: 'Synthetic Command Center verification', webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  win.on('focus', () => { report.errors.push('Verification window took OS focus'); process.exitCode = 1; });
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const check = async (name, expression) => { await sleep(180); if (!await run(expression)) throw Error(name); report.checks.push(name); };
  const click = async (text, selector = null) => {
    await run(`(() => {
      const scope = ${JSON.stringify(selector)};
      const root = scope === null ? document : document.querySelector(scope);
      const text = ${JSON.stringify(text)};
      const b = [...root.querySelectorAll('button')].find(b => b.textContent.trim() === text);
      if (!b) throw Error('Missing button ' + text);
      b.focus(); b.click();
    })()`);
    await sleep(180);
  };
  const reset = async () => { await run('window.integration.reset()'); await sleep(350); };
  const open = async category => { await run("document.querySelector('[data-wall-add-button]').click()");await sleep(180); if (category) { await run(`[...document.querySelectorAll('.agent-window-picker__option')].find(b=>b.querySelector('strong')?.textContent===${JSON.stringify(category)}).click()`); await sleep(180); } };
  const image = async () => { await open('Media'); await run("[...document.querySelectorAll('.agent-window-picker button')].find(b=>b.textContent.includes('Create image session')).click()"); await sleep(200); };
  const capture = async name => { await sleep(350); fs.writeFileSync(path.join(runDir, name + '.png'), (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG()); report.captures.push(path.join(runDir, name + '.png')); };
  try {
    await win.loadFile(path.join(out, 'index.html')); win.showInactive(); await sleep(900);
    await check('mounted full CommandCenterView', "!!document.querySelector('[data-command-wall]') && !!document.querySelector('.command-wall-window')");
    const current = !process.env.NEKKO_TEST_REVISION;
    const scroll = async end => { await run(`document.querySelector('[data-transcript-scroll]').scrollTop=${end ? '1e7' : '0'}`); await sleep(400); };
    const expand = async () => { await run("[...document.querySelectorAll('.command-wall-window button')].find(b=>b.textContent.includes('Worked on')).click()"); await sleep(250); await run("[...document.querySelectorAll('.command-wall-window li button')].filter(b=>b.textContent.includes('Spawned subagent')).forEach(b=>b.click())"); await sleep(400); };
    for (const theme of ['light','dark']) {
      await run(`document.documentElement.dataset.theme='${theme}'`);
      for (const [width,label] of [[1200,'desktop'],[400,'narrow']]) {
        win.setContentSize(width,900); await reset(); await click('Focused'); await scroll(true);
        await capture(`collapsed-${theme}-${label}`);
        if(current) await check('collapsed subagent cue '+theme+label,"document.querySelector('.command-wall-window').textContent.includes('3 subagents')");
        await expand(); await scroll(true); await capture(`expanded-${theme}-${label}`);
        if(current) {
          await check('completed/error/missing results '+theme+label,"['Result','Subagent failed','No subagent result recorded','All integration checks passed.'].every(t=>document.querySelector('.command-wall-window').textContent.includes(t))");
          await scroll(false); await scroll(true);
          await check('expanded state survives virtualization '+theme+label,"document.querySelector('.command-wall-window').textContent.includes('All integration checks passed.')");
        }
      }
    }
    win.setContentSize(1200,900); await reset(); await click('Focused'); await scroll(true);
    if(current) {
      for(let i=0;i<12 && !await run("document.querySelector('.command-wall-window').textContent.includes('automated wake-up')");i++){await run("document.querySelector('[data-transcript-scroll]').scrollTop-=200");await sleep(250);}
      await capture('watch-and-controls-dark-desktop');
      await check('watch and ordinary messages coexist',"document.querySelector('.command-wall-window').textContent.includes('automated wake-up') && document.querySelector('.command-wall-window').textContent.includes('Please check the integration')");
      await check('ordinary message controls remain',"!!document.querySelector('.command-wall-window button[title=\"Copy prompt\"]')");
    }
    await run('window.integration.clean()'); await sleep(350); await click('Focused');
    await run('window.integration.wake(Date.now()+120000)');
    await check('sleeping deadline appears', "document.body.textContent.includes('Sleeping · will check in')");
    await run("window.integration.inbox('Reply while sleeping')");
    await check('reply can be sent while sleeping', "window.integration.calls.some(c=>c.method==='send' && c.input.text==='Reply while sleeping')");
    await run('window.integration.wake(null)');
    await check('cancelled watch clears sleeping status', "!document.body.textContent.includes('Sleeping · will check in')");
    await run('window.integration.clean()'); await sleep(350); await click('Focused');
    await run("window.integration.failures.send=true; window.integration.inbox('Request that fails')");
    await check('failed request is visible', "document.querySelector('.command-wall-window')?.textContent.includes('Synthetic request failure')");
    await run('window.integration.failures.send=false');
    await click(process.env.NEKKO_TEST_REVISION ? 'Continue' : 'Retry');
    await check('retry sends after failed request', "window.integration.calls.some(c=>c.method==='send' && c.input.resume===true)");
    await run('window.integration.restore()'); await sleep(350); await click('Focused'); await scroll(true);
    const motion=path.join(runDir,'motion');fs.mkdirSync(motion);
    for(let frame=0;frame<16;frame++){
      if(frame===3) await expand();
      if(frame===10) await run("[...document.querySelectorAll('.command-wall-window button')].find(b=>b.textContent.includes('Worked on')).click()");
      fs.writeFileSync(path.join(motion,`${String(frame).padStart(3,'0')}.png`),(await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG());await sleep(100);
    }
    require('node:child_process').execFileSync('ffmpeg',['-y','-framerate','10','-i',path.join(motion,'%03d.png'),'-vf','pad=ceil(iw/2)*2:ceil(ih/2)*2','-c:v','libx264','-pix_fmt','yuv420p',path.join(runDir,'subagent-motion.mp4')],{stdio:'ignore',windowsHide:true});
    if (win.isFocused() || screen.getAllDisplays().some(d => { const b=win.getBounds(); return b.x < d.bounds.x+d.bounds.width && b.x+b.width > d.bounds.x && b.y < d.bounds.y+d.bounds.height && b.y+b.height > d.bounds.y; }) || report.errors.some(e => /Verification window/.test(e))) throw Error('Background verification visibility/focus invariant failed');
    report.background = { visible: win.isVisible(), focused: win.isFocused(), offscreen: win.getBounds().x + win.getBounds().width <= Math.min(...screen.getAllDisplays().map(d => d.bounds.x)) };
    report.success = true;
  } catch (e) { report.errors.push(String(e)); report.success = false; process.exitCode = 1; }
  finally { fs.writeFileSync(path.join(runDir, 'status.json'), JSON.stringify(report, null, 2)); fs.writeFileSync(path.join(out, 'latest-run.txt'), runDir); console.log(JSON.stringify({ runDir, ...report }, null, 2)); win.destroy(); app.exit(report.success ? 0 : 1); }
});
