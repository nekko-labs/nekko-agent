const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const dir = process.env.NEKKO_EVIDENCE_DIR, kind = process.env.NEKKO_EVIDENCE_KIND;
const profile = fs.mkdtempSync(path.join(dir, 'profile-'));
app.setPath('userData', profile); app.setPath('sessionData', profile);
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
const report = { kind, checks: [], captures: [], errors: [], visuallyInspected: false, warnings: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((r, done) => done({ cancel: !/^(file:|data:|blob:)/.test(r.url) }));
  session.defaultSession.setPermissionRequestHandler((w, p, done) => done(false));
  const win = new BrowserWindow({ width: 1200, height: 900, useContentSize: true, x: -20000, y: -20000, show: false, focusable: false, skipTaskbar: true, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const run = js => win.webContents.executeJavaScript(js, true);
  const stable = () => run(`(async()=>{await document.fonts.ready;await new Promise(r=>setTimeout(r,500));return true})()`);
  const capture = async name => { await stable(); const image = await win.capturePage(undefined, { stayHidden: true, stayAwake: true }); if (image.isEmpty()) throw Error('Empty capture'); fs.writeFileSync(path.join(dir, name + '.png'), image.toPNG()); report.captures.push(name); };
  const observe = async name => report.checks.push({ name, state: await run(`({alerts:document.querySelectorAll('[role=alertdialog]').length, nestedButtons:document.querySelectorAll('button button').length,text:document.body.innerText, buttons:[...document.querySelectorAll('button')].map(b=>({text:b.innerText,label:b.getAttribute('aria-label')}))})`) });
  win.webContents.on('console-message', e => { if (e.level === 'error') (e.message === 'ResizeObserver loop completed with undelivered notifications.' ? report.warnings : report.errors).push(e.message); });
  try {
    await win.loadFile(path.join(dir, 'index.html')); await stable();
    for (const width of [1200, 390]) for (const theme of ['light', 'dark']) {
      win.setContentSize(width, 900); await run(`document.documentElement.dataset.theme='${theme}';evidence.route('chat')`); await stable();
      await run('evidence.approval()'); await capture(`${width}-${theme}-approval`); await observe('live approval');
      await run(`evidence.emit({type:'tool_result',result:{toolCallId:'unrelated',output:'Parallel read completed'}})`); await capture(`${width}-${theme}-unrelated-result`); await observe('unrelated result');
      if (!await run(`document.querySelectorAll('[role=alertdialog]').length===${kind === 'before' ? 0 : 1}`)) throw Error('Unexpected approval result retention');
      await run('evidence.hydrate()'); await stable(); await capture(`${width}-${theme}-hydrated`); await observe('hydrated approval');
      await run("evidence.route('navigation')"); await stable(); await capture(`${width}-${theme}-navigation`); await observe('navigation');
      if (kind === 'after') {
        if (!await run(`document.querySelectorAll('[aria-label^="Open subagent:"]').length===2&&!document.querySelector('button button')`)) throw Error('Missing accessible sibling navigation');
        await run(`document.querySelector('[aria-label^="Open subagent:"]').click()`); await stable();
        if (!await run(`evidence.state().workspaces.some(w=>JSON.stringify(w).includes('child'))&&evidence.state().view==='chat'`)) throw Error('Child did not open through store');
        await run("evidence.route('chat')"); await stable(); await run('evidence.approval()'); await stable();
        await run(`evidence.emit({type:'tool_result',result:{toolCallId:'approval-a',output:'Denied'}})`); await stable();
        if (!await run(`!document.querySelector('[role=alertdialog]')`)) throw Error('Matching result did not clear approval');
      }
    }
    if (win.isVisible() || win.isFocusable() || win.isFocused()) throw Error('Isolation failed');
  } catch (e) { report.errors.push(String(e)); }
  finally { fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); win.destroy(); app.exit(report.errors.length ? 1 : 0); }
});
