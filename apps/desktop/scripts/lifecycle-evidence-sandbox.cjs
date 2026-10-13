// Hidden renderer evidence only. Never foreground or focus an OS window.
const { app, BrowserWindow, session, screen, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch with lifecycle-evidence-integration.cjs');
const base = !!process.env.NEKKO_TEST_REVISION;
const dir = path.join(out, base ? 'before' : 'after');
const evidencePrefix = `lifecycle-${base ? 'before' : 'after'}-${Date.now()}`;
fs.mkdirSync(dir, { recursive: true });
const profile = fs.mkdtempSync(path.join(dir, 'profile-'));
app.setPath('userData', profile); app.setPath('sessionData', profile);
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  const report = { revision: process.env.NEKKO_TEST_REVISION || 'working-tree', checks: [], errors: [], captures: [], visuallyInspected: false, blockedNetwork: [] };
  session.defaultSession.webRequest.onBeforeRequest((r, done) => { const cancel = !/^(file:|data:|blob:)/.test(r.url); if (cancel) report.blockedNetwork.push(r.url); done({ cancel }); });
  session.defaultSession.setPermissionRequestHandler((_c, _p, done) => done(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  const left = Math.min(...screen.getAllDisplays().map(d => d.bounds.x));
  const win = new BrowserWindow({ width: 1440, height: 1000, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: left - 4500, y: -3000, title: 'Hidden lifecycle fixture', webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false, preload: path.join(__dirname, 'lifecycle-terminal-preload.cjs') } });
  win.on('focus', () => report.errors.push('Fixture took OS focus'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const check = async (name, s) => { report.checks.push({ name, passed: !!await run(s) }); };
  const stable = async (expectedRoute) => run(`(async () => {
    await document.fonts.ready;
    let previous = '', count = 0;
    const deadline = performance.now() + 10000;
    while (performance.now() < deadline) {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const root = document.querySelector('[data-lifecycle-route]');
      const route = root?.dataset.lifecycleRoute;
      const settings = route === 'settings';
      const ready = route === ${JSON.stringify(expectedRoute)} && (!settings ||
        (document.body.innerText.includes('Appearance') && !!document.querySelector('input[placeholder="Relay URL, e.g. wss://nekko-agent-relay.fly.dev"]') && !document.querySelector('[aria-label="Input alpha"]')));
      const fingerprint = JSON.stringify([document.documentElement.dataset.theme, innerWidth, innerHeight, root?.innerText,
        [...(root?.querySelectorAll('section, input, button, main, aside') || [])].map(e => { const r = e.getBoundingClientRect(); return [r.x,r.y,r.width,r.height]; })]);
      const animating = document.getAnimations().some(a => a.playState === 'running' && a.effect?.getComputedTiming().iterations !== Infinity);
      count = ready && !animating && fingerprint === previous ? count + 1 : 0;
      previous = fingerprint;
      if (count >= 6) return { route, theme: document.documentElement.dataset.theme, viewport: { width: innerWidth, height: innerHeight }, stableFramePairs: count, settingsMounted: settings, paneInputAbsent: !document.querySelector('[aria-label="Input alpha"]') };
    }
    throw Error('DOM/frame stability timeout for route ' + ${JSON.stringify(expectedRoute)});
  })()`);
  const capture = async name => {
    const route = name.includes('-settings') ? 'settings' : 'panes';
    const dom = await stable(route);
    const expectedWidth = name.startsWith('wide-') ? 1440 : 760;
    const expectedTheme = name.includes('-light-') ? 'light' : 'dark';
    if (dom.theme !== expectedTheme || dom.viewport.width !== expectedWidth || dom.viewport.height !== 1000) throw Error('Capture theme/viewport mismatch: ' + name + ' ' + JSON.stringify(dom));
    const file = path.join(dir, evidencePrefix + '-' + name + '.png');
    // Prime compositor capture after the stable DOM, then wait for another frame gate.
    await win.capturePage(undefined, { stayHidden: true, stayAwake: true });
    await stable(route);
    const image = await win.capturePage(undefined, { stayHidden: true, stayAwake: true });
    if (image.isEmpty()) throw Error('Empty capture ' + name);
    fs.writeFileSync(file, image.toPNG()); report.captures.push({ file, size: image.getSize(), dom });
  };
  const reset = async (opts = {}) => { await run(`lifecycle.reset(${JSON.stringify(opts)})`); await sleep(450); };
  const themeFor = async theme => { await run(`lifecycle.patch({theme:${JSON.stringify(theme)}});document.documentElement.dataset.theme=${JSON.stringify(theme)}`); };
  const resize = async width => {
    win.setContentSize(width, 1000);
    for (let i = 0; i < 5; i++) {
      await sleep(100);
      const actual = await run('({width:innerWidth,height:innerHeight})');
      if (actual.width === width && actual.height === 1000) return;
      const bounds = win.getBounds();
      win.setBounds({ ...bounds, width: bounds.width + width - actual.width, height: bounds.height + 1000 - actual.height });
    }
    throw Error('Could not establish exact content viewport ' + width + 'x1000');
  };
  const key = async (id, k) => { await run(`document.querySelector('[aria-label="${id}"]').focus(); window.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(k)},ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true}))`); await sleep(350); };
  const button = text => run(`(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e)throw Error('Missing button '+${JSON.stringify(text)});e.click()})()`);
  let terminalHost, realTerminal;
  try {
    if (!base) {
      const { pathToFileURL } = require('node:url');
      const hostDir = path.resolve(__dirname, '../../../packages/host/dist');
      const paths = await import(pathToFileURL(path.join(hostDir, 'paths.js')).href);
      paths.setDataDir(path.join(profile, 'host'));
      terminalHost = await import(pathToFileURL(path.join(hostDir, 'terminal.js')).href);
      realTerminal = await terminalHost.createTerminal({ cwd: profile, shell: path.join(process.env.SystemRoot, 'System32/cmd.exe'), title: 'Disposable PTY survival fixture' });
      if (!realTerminal.running) throw Error('Real PTY did not start');
      ipcMain.handle('lifecycle:terminal:list', () => terminalHost.listTerminals());
      ipcMain.handle('lifecycle:terminal:close', (_event, id) => terminalHost.closeTerminal(id));
      ipcMain.handle('lifecycle:terminal:probe', async () => {
        const marker = 'NEKKO_SURVIVAL_' + Date.now();
        terminalHost.runInTerminal(realTerminal.id, 'echo ' + marker);
        for (let i = 0; i < 50; i++) {
          await sleep(100);
          const snapshot = await terminalHost.terminalSnapshot(realTerminal.id);
          if (snapshot?.info.running && snapshot.buffer.replace(/\\x1b\\[[0-9;?]*[A-Za-z]/g, '').includes(marker + '\r\n')) return true;
        }
        return false;
      });
    }
    await win.loadFile(path.join(out, 'index.html'));
    // Off-screen, non-focusable mapping keeps layout and compositor frames alive.
    win.showInactive();
    await sleep(1200);
    // The actual owning view supplies the existing responsive AgentSidebar overlay.
    for (const theme of ['light', 'dark']) {
      await resize(760); await reset({ command: true }); await themeFor(theme); await sleep(500);
      await run("lifecycle.state().archiveChat('alpha')"); await sleep(500);
      const label = `narrow-${theme}-drawer`;
      const opener = "document.querySelector('[aria-label=\"Open agent list\"]')";
      if (!base) {
        await check(label + ': completion auto-reveals destination without focus', "document.querySelector('[data-completed-toggle]').getBoundingClientRect().width>0 && lifecycle.state().completionTipSessionId==='alpha'");
        await run("[...document.querySelectorAll('div')].find(e => e.classList.contains('bg-black/40')).click()"); await sleep(200);
      }
      await check(label + ': existing opener visible, destination hidden', `(() => { const b=${opener}, d=document.querySelector('[data-completed-toggle]'); return b?.getBoundingClientRect().width>0 && d?.getBoundingClientRect().width===0; })()`);
      if (!base) await check(label + ': closed drawer highlights opener', `${opener}.style.outline.includes('2px') && lifecycle.state().completionTipSessionId==='alpha'`);
      await capture(label + '-closed');
      await run(`${opener}.click()`); await sleep(250);
      await run("document.querySelector('[data-completed-toggle]').scrollIntoView({block:'center',behavior:'instant'})");
      await check(label + ': opening drawer reveals destination without consuming tip', `document.querySelector('[data-completed-toggle]').getBoundingClientRect().width>0 && lifecycle.state().completionTipSessionId==='alpha'`);
      if (!base) await check(label + ': highlight transfers to destination', `!${opener}.style.outline && document.querySelector('[data-completed-toggle]').style.outline.includes('2px')`);
      await capture(label + '-opened');
      await run("[...document.querySelectorAll('div')].find(e => e.classList.contains('bg-black/40')).click()"); await sleep(200);
      if (!base) await check(label + ': closing restores opener highlight', `${opener}.style.outline.includes('2px') && lifecycle.state().completionTipSessionId==='alpha'`);
      await run(`${opener}.click()`); await sleep(150);
      await run("document.querySelector('[data-completed-toggle]').click()"); await sleep(200);
      await check(label + ': destination clears tip and expands completed group', `lifecycle.state().completionTipSessionId===null && document.querySelector('[data-completed-toggle]').getAttribute('aria-expanded')==='true'`);
      if (!base) {
        await reset({ command: true }); await themeFor(theme); await run("lifecycle.state().archiveChat('alpha')"); await sleep(400);
        await run(`(() => { const b=${opener}; b.parentElement.querySelector('button.text-accent').click(); })()`);
        await check(label + ': dismiss clears tip without opening drawer', `!${opener}.style.outline && ${opener}.getAttribute('aria-expanded')==='false' && !lifecycle.state().completionTipSessionId`);
        await reset({ command: true, showTips: false }); await themeFor(theme); await run("lifecycle.state().archiveChat('alpha')"); await sleep(350);
        await check(label + ': tips disabled leaves opener unchanged', `!${opener}.style.outline && !lifecycle.state().completionTipSessionId`);
        await reset({ command: true, failSave: true }); await run("lifecycle.state().archiveChat('alpha')"); await sleep(350);
        await check(label + ': failed completion does not guide drawer', `!${opener}.style.outline && !lifecycle.state().completionTipSessionId && !lifecycle.state().settings.completionTipSeen`);
      }
    }
    for (const width of process.env.NEKKO_DRAWER_ONLY ? [] : [1440, 760]) for (const theme of ['light', 'dark']) {
      await resize(width); await reset(); await themeFor(theme); await sleep(300);
      const label = `${width === 1440 ? 'wide' : 'narrow'}-${theme}`;
      await capture(label + '-panes');
      report[label] = await run(`({titles:[...document.querySelectorAll('button[title]')].map(e=>({label:e.getAttribute('aria-label'),title:e.title})),missingLabel:document.body.innerText.includes('No project attached')})`);
      if (!base) {
        await check(label + ': complete/minimize action chord titles', `(()=>{const b=[...document.querySelectorAll('button[title]')];return b.some(e=>e.title.includes('Complete this chat')&&e.title.includes('Shift+E'))&&b.some(e=>e.title.includes('Minimize this window')&&e.title.includes('Shift+M'))})()`);
        await check(label + ': no missing-project label', `!document.body.innerText.includes('No project attached')`);
        await key('Input alpha', 'Delete');
        await check(label + ': delete chord opens real modal', `!!document.querySelector('[aria-modal="true"]') && document.body.innerText.includes('Skip future deletion confirmations')`);
        await capture(label + '-delete-modal');
        await button('Cancel'); await sleep(250);
        await check(label + ': cancel preserves both chats', `lifecycle.records().length===2&&!document.querySelector('[aria-modal="true"]')`);
      }
      await reset(); await themeFor(theme);
      if (base) { await run("lifecycle.state().archiveChat('alpha')"); await sleep(400); }
      else await key('Input alpha', 'e');
      const completionVisibility = await run(`(() => {
        const e = document.querySelector('[data-completed-toggle]');
        if (!e) throw Error('Missing completed toggle');
        if (base && innerWidth >= 768) e.scrollIntoView({ block: 'center', behavior: 'instant' });
        const r = e.getBoundingClientRect();
        const visible = r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight;
        return { visible, outline: e.style.outline, responsiveSidebarHidden: innerWidth < 768 && !visible };
      })()`);
      report[label].completionVisibility = completionVisibility;
      if (width === 1440 && (!completionVisibility.visible || (!base && !completionVisibility.outline.includes('2px')))) throw Error('Wide Show completed must be visible and highlighted');
      if (!base && !completionVisibility.visible) throw Error('Completion destination must be revealed at every viewport');
      if (width === 760) report[label].responsiveNote = base ? 'Baseline hides the completion destination.' : 'Existing Agents drawer automatically reveals the highlighted destination without focus.';
      await capture(label + '-completion');
      if (!base) {
        await check(label + ': only alpha completed and first tip highlighted', `lifecycle.records().find(s=>s.id==='alpha').archivedAt>0&&!lifecycle.records().find(s=>s.id==='beta').archivedAt&&lifecycle.state().completionTipSessionId==='alpha'&&[...document.querySelectorAll('[data-completed-toggle]')].some(e=>e.style.outline.includes('2px'))`);
        await check(label + ': tip names Show completed in left panel', `[...document.querySelectorAll('[role="status"]')].some(e=>e.textContent.includes('Open Show completed'))`);
        await run("document.querySelector('[data-completed-toggle]').click()"); await sleep(200);
        await key('Input beta', 'e');
        await check(label + ': completion tip only once', `lifecycle.state().completionTipSessionId===null&&lifecycle.calls.filter(c=>c.method==='settings'&&c.patch.completionTipSeen).length===1`);
      }
      await reset(); await themeFor(theme); await run("lifecycle.route('settings')"); await sleep(700);
      await stable('settings');
      await check(label + ': SettingsView mounted, panes absent', `document.querySelector('[data-lifecycle-route="settings"]')!==null&&!document.querySelector('[aria-label="Input alpha"]')&&document.body.innerText.includes('Appearance')`);
      await capture(label + '-settings');
      report[label].settingsScroll = await run(`(() => {
        const anchor = document.getElementById('chat-pane-action');
        if (!anchor) throw Error('Missing matched Appearance anchor');
        anchor.scrollIntoView({ block: 'center', behavior: 'instant' });
        let scroller = anchor.parentElement;
        while (scroller && !/auto|scroll/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
        if (!scroller || scroller.scrollTop <= 0) throw Error('Real settings scroller did not scroll');
        const bounds = scroller.getBoundingClientRect();
        const rows = ['Chat pane top-right action', 'Show tips', 'Confirm deletions'].map(text => {
          const e = [...document.querySelectorAll('label, span')].find(e => e.textContent === text);
          const r = e?.getBoundingClientRect();
          return { text, present: !!e, visible: !!r && r.height > 0 && r.top >= Math.max(0, bounds.top) && r.bottom <= Math.min(innerHeight, bounds.bottom), top: r?.top, bottom: r?.bottom };
        });
        if (!rows[0].visible || (${!base} && rows.some(r => !r.visible))) throw Error('Appearance controls outside visible scroller: ' + JSON.stringify(rows));
        return { anchor: 'chat-pane-action', scrollTop: scroller.scrollTop, bounds: { top: bounds.top, bottom: bounds.bottom }, rows };
      })()`);
      await capture(label + '-settings-controls');
      if (!base) await check(label + ': real Show tips and Confirm deletions settings', `document.body.innerText.includes('Show tips')&&document.body.innerText.includes('Confirm deletions')&&document.body.innerText.includes('Remote access')&&!!document.querySelector('input[placeholder="Relay URL, e.g. wss://nekko-agent-relay.fly.dev"]')`);
    }
    if (!base) {
      await reset(); await key('Input beta', 'm');
      await check('two panes: beta minimize leaves alpha and both records', `lifecycle.minimized().includes('beta')&&!lifecycle.minimized().includes('alpha')&&lifecycle.records().length===2`);
      await key('Terminal input', 'm');
      await check('terminal minimize preserves synthetic PID and avoids closeTerminal', `lifecycle.terminals()[0].pid===4242&&!lifecycle.calls.some(c=>c.method==='closeTerminal')&&lifecycle.minimized().includes('term')`);
      await reset(); await key('Input beta', 'Delete'); await button('Delete'); await sleep(350);
      await check('delete confirm removes only targeted beta', `lifecycle.records().length===1&&lifecycle.records()[0].id==='alpha'`);
      await reset(); await key('Input alpha', 'Delete'); await run("document.querySelector('[aria-modal=true] input[type=checkbox]').click()"); await button('Delete'); await sleep(300);
      await check('skip preference persisted', `lifecycle.state().settings.skipDeleteConfirmation===true`);
      await key('Input beta', 'Delete');
      await check('skip deletes without second modal', `!document.querySelector('[aria-modal=true]')&&lifecycle.records().length===0`);
      await reset(); await run("lifecycle.patch({skipDeleteConfirmation:true});lifecycle.route('settings')"); await sleep(600);
      await run(`(()=>{const row=[...document.querySelectorAll('span')].find(e=>e.textContent==='Confirm deletions').parentElement;row.querySelector('button').click()})()`); await sleep(250);
      await check('settings resets confirmation independently of tips', `lifecycle.state().settings.skipDeleteConfirmation===false&&lifecycle.state().settings.showTips===true`);
      await run("lifecycle.route('panes')"); await sleep(300); await key('Input alpha', 'Delete');
      await check('reset brings modal back', `!!document.querySelector('[aria-modal=true]')`); await button('Cancel');
      await reset({ showTips: false }); await key('Input alpha', 'e');
      await check('tips disabled: successful completion without tip', `lifecycle.records()[0].archivedAt>0&&!lifecycle.state().completionTipSessionId&&!lifecycle.calls.some(c=>c.method==='settings')`);
      await reset({ failSave: true }); await key('Input alpha', 'e');
      await check('failed completion save: no tip or seen preference', `!lifecycle.records()[0].archivedAt&&!lifecycle.state().completionTipSessionId&&!lifecycle.state().settings.completionTipSeen`);
      await reset({ failPreference: true }); await key('Input alpha', 'e');
      await check('failed tip preference save: no tip, remains eligible', `lifecycle.records()[0].archivedAt>0&&!lifecycle.state().completionTipSessionId&&!lifecycle.state().settings.completionTipSeen`);
      await reset(); await key('Terminal input', 'Delete'); await button('Cancel'); await sleep(100);
      await check('terminal cancel preserves PID', `lifecycle.terminals().length===1&&!lifecycle.calls.some(c=>c.method==='closeTerminal')`);
      await key('Terminal input', 'Delete'); await button('Delete'); await sleep(300);
      await check('terminal confirm closes synthetic host process', `lifecycle.terminals().length===0&&lifecycle.calls.some(c=>c.method==='closeTerminal')`);
      await reset(); await run('lifecycle.useRealTerminal()');
      await check('real PTY executes before minimize', 'lifecycleTerminal.probe()');
      await key('Terminal input', 'm');
      await check('real PTY minimize retains Agents entry without shutdown', `lifecycle.minimized().includes('term')&&lifecycle.terminals().length===1&&!lifecycle.calls.some(c=>c.method==='closeTerminal')`);
      await check('real PTY executes after renderer window removal', 'lifecycleTerminal.probe()');
      report.realPty = { backend: 'TypeScript host node-pty, Windows cmd, disposable cwd/data', beforeAndAfterExecution: true, daemonBackendTested: false };
    }
    if (process.env.NEKKO_DRAWER_ONLY) {
      await resize(760); await reset({ command: true }); await themeFor('dark');
      const frames = path.join(dir, 'drawer-motion-frames'); fs.mkdirSync(frames, { recursive: true });
      const times = [], start = Date.now(); let stage = 0;
      while (Date.now() - start < 2600) {
        const t = Date.now() - start;
        if (t > 300 && stage === 0) { await run("lifecycle.state().archiveChat('alpha')"); stage++; }
        if (t > 1000 && stage === 1) { await run("document.querySelector('[aria-label=\"Open agent list\"]').click()"); stage++; }
        if (t > 1700 && stage === 2) { await run("document.querySelector('[data-completed-toggle]').click()"); stage++; }
        times.push(Date.now() - start);
        fs.writeFileSync(path.join(frames, `${times.length}.png`), (await win.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG()); await sleep(65);
      }
      fs.writeFileSync(path.join(frames, 'frames.txt'), times.map((t,i)=>`file '${i+1}.png'\nduration ${((times[i+1]??2600)-t)/1000}`).join('\n')+`\nfile '${times.length}.png'\n`);
      const file = path.join(dir, evidencePrefix + '-drawer-motion.mp4');
      cp.execFileSync('ffmpeg', ['-y','-f','concat','-safe','0','-i',path.join(frames,'frames.txt'),'-vf','fps=15,pad=ceil(iw/2)*2:ceil(ih/2)*2','-c:v','libx264','-pix_fmt','yuv420p',file], { windowsHide: true, stdio: 'pipe' });
      report.motion = { timestampsMs: times, file };
    } else {
    // Timestamped renderer frames: completion tip appears, expands, then modal opens/closes.
    win.setContentSize(1440, 1000); await reset(); await run("document.documentElement.dataset.theme='dark'");
    const frames = path.join(dir, 'motion-frames'); fs.mkdirSync(frames, { recursive: true });
    const times = [], start = Date.now(); let stage = 0;
    while (Date.now() - start < 3200) {
      const t = Date.now() - start;
      if (t > 400 && stage === 0) { if (base) await run("lifecycle.state().archiveChat('alpha')"); else await run(`document.querySelector('[aria-label="Input alpha"]').focus();window.dispatchEvent(new KeyboardEvent('keydown',{key:'e',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true}))`); await run(`new Promise(resolve => requestAnimationFrame(() => { document.querySelector('[data-completed-toggle]')?.scrollIntoView({block:'center',behavior:'instant'}); resolve(); }))`); stage++; }
      if (t > 1400 && stage === 1) { await run("document.querySelector('[data-completed-toggle]')?.click()"); stage++; }
      if (t > 2000 && stage === 2) { if (!base) await run(`document.querySelector('[aria-label="Input beta"]').focus();window.dispatchEvent(new KeyboardEvent('keydown',{key:'Delete',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true}))`); stage++; }
      if (t > 2800 && stage === 3) { if (!base) await button('Cancel'); stage++; }
      times.push(Date.now() - start); fs.writeFileSync(path.join(frames, `${times.length}.png`), (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG()); await sleep(65);
    }
    fs.writeFileSync(path.join(frames, 'frames.txt'), times.map((t,i)=>`file '${i+1}.png'\nduration ${((times[i+1]??3200)-t)/1000}`).join('\n')+`\nfile '${times.length}.png'\n`);
    cp.execFileSync('ffmpeg', ['-y','-f','concat','-safe','0','-i',path.join(frames,'frames.txt'),'-vf','fps=15,pad=ceil(iw/2)*2:ceil(ih/2)*2','-c:v','libx264','-pix_fmt','yuv420p',path.join(dir,evidencePrefix+'-motion.mp4')], { windowsHide: true, stdio: 'pipe' });
    report.motion = { timestampsMs: times, file: path.join(dir, evidencePrefix + '-motion.mp4') };
    }
    report.background = { focused: win.isFocused(), visible: win.isVisible(), bounds: win.getBounds(), displays: screen.getAllDisplays().map(d=>d.bounds) };
    if (win.isFocused()) throw Error('OS focus acquired');
    report.success = !report.errors.length && report.checks.every(c=>c.passed);
  } catch(e) { report.errors.push(String(e)); report.success = false; }
  finally { if (realTerminal) terminalHost.closeTerminal(realTerminal.id); win.destroy(); fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(report,null,2)); console.log(JSON.stringify(report,null,2)); app.exit(report.success ? 0 : 1); }
});
