// Synthetic renderer only. Never launches the app main process or a host.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through agent-window-controls-integration.cjs');
const runDir = path.join(out, new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(runDir, { recursive: true });
const profile = path.join(runDir, 'profile');
app.setPath('userData', profile);
app.setPath('sessionData', profile);
const report = { revision: process.env.NEKKO_TEST_REVISION || 'working-tree', checks: [], captures: [], errors: [], visuallyInspected: false, hidden: true, focusable: false };
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: !/^(file:|data:|blob:)/.test(details.url) }));
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, done) => done(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  const win = new BrowserWindow({ width: 1400, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: Math.min(...screen.getAllDisplays().map(d => d.bounds.x)) - 3000, y: Math.min(...screen.getAllDisplays().map(d => d.bounds.y)) - 2000, title: 'Agent window controls synthetic sandbox', webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  win.showInactive();
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.on('focus', () => report.errors.push('Sandbox took OS focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const run = expression => win.webContents.executeJavaScript(expression, true);
  const capture = async name => {
    const file = path.join(runDir, name + '.png');
    fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
    report.captures.push(file);
  };
  const clickControl = async (kind, pane = 0) => run(`(() => {
    const root = ${pane} < 0 ? document : document.querySelectorAll('.command-wall-window')[${pane}];
    const labels = b => [b.textContent, b.getAttribute('aria-label'), b.title].join(' ');
    const patterns = { changes: /Changes/i, zen: /Zen|Switch to Focus mode/i, monitor: /Show Agent Monitor|Hide Agent Monitor|Show the plan panel|Hide the plan panel/i };
    const b = [...(root?.querySelectorAll('button') || [])].find(b => patterns[${JSON.stringify(kind)}].test(labels(b)));
    if (!b) return false;
    b.click(); return true;
  })()`);
  const facts = () => run(`(() => {
    const windows = [...document.querySelectorAll('.command-wall-window')];
    const rect = e => { if (!e) return null; const r=e.getBoundingClientRect(); return { x:r.x,y:r.y,w:r.width,h:r.height }; };
    return { mode: integration.state().settings.commandWall.layout.mode, selectedId: integration.state().activeSessionId,
      windows: windows.map(w => ({ pane: w.dataset.wallPane, hero:w.hasAttribute('data-wall-hero'), selected:w.hasAttribute('data-wall-selected'),
        status:rect(w.querySelector('[data-agent-status]')), icon:rect(w.querySelector('.numbered-agent-icon')), text:w.textContent,
        controls:[...w.querySelectorAll('button')].map(b=>({text:b.textContent,label:b.getAttribute('aria-label'),title:b.title,expanded:b.getAttribute('aria-expanded')})) })),
      activeSession:document.activeElement?.closest('[data-session-id]')?.getAttribute('data-session-id'),
      contextButtons:[...document.querySelectorAll('.command-wall-window button')].filter(b=>/context/i.test([b.title,b.getAttribute('aria-label'),b.textContent].join(' '))).map(b=>b.outerHTML),
      monitorControls:[...document.querySelectorAll('button')].filter(b=>/Agent Monitor|agent panel/i.test([b.title,b.getAttribute('aria-label'),b.textContent].join(' '))).map(b=>b.outerHTML),
      agentPanel:integration.state().settings.commandWall.agentPanel };
  })()`);
  try {
    for (const theme of [process.env.NEKKO_EVIDENCE_THEME || 'dark']) for (const width of [Number(process.env.NEKKO_EVIDENCE_WIDTH || 1400)]) for (const empty of [process.env.NEKKO_EVIDENCE_EMPTY === '1']) {
      win.setContentSize(width, 900);
      await win.loadFile(path.join(out, 'index.html'), { search: 'multi' + (empty ? '&empty' : '') });
      for (let i=0; i<60; i++) { if (await run("!!window.integration && document.querySelectorAll('.command-wall-window').length >= 2")) break; await sleep(100); }
      await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      await sleep(800);
      const name = `${theme}-${width}-${empty ? 'empty' : 'populated'}`;
      report.checks.push({ name: name + '-collapsed', facts: await facts() });
      await capture(name + '-collapsed');
      const expanded = await clickControl('changes'); await sleep(500);
      report.checks.push({ name: name + '-changes', clicked: expanded, facts: await facts() });
      await capture(name + '-changes');
      const zen = await clickControl('zen', 1); await sleep(650);
      const focusFacts = await facts();
      if (!process.env.NEKKO_TEST_REVISION && (focusFacts.mode !== 'focus' || !focusFacts.windows[1].hero)) throw Error('Zen did not focus second window');
      report.checks.push({ name: name + '-zen-second', clicked: zen, facts: focusFacts });
      await capture(name + '-zen-second');
      const monitor = await run(`(() => { const w = [...document.querySelectorAll('.command-wall-window')].find(w => w.hasAttribute('data-wall-hero')); const b = w?.querySelector('[data-plan-toggle]'); if (!b) return false; b.click(); return true; })()`); await sleep(300);
      report.checks.push({ name: name + '-monitor-toggle', clicked: monitor, facts: await facts() });
      await capture(name + '-monitor-toggle');
      if (!process.env.NEKKO_TEST_REVISION && width === 1400 && (!monitor || !await run("!!document.querySelector('.command-wall-window[data-wall-hero] aside[aria-label]')"))) throw Error('Agent Monitor did not open');
    }
    await sleep(500);
    await run("document.documentElement.dataset.theme='dark'");
    const frames = path.join(runDir, 'motion'); fs.mkdirSync(frames);
    const times = [];
    for (let i=0; i<36; i++) {
      if (i===6) await run("window.__setChanges(false)");
      if (i===24) await run("window.__setChanges(true)");
      const start=Date.now();
      fs.writeFileSync(path.join(frames, `frame-${String(i).padStart(3,'0')}.png`), (await win.capturePage(undefined, { stayHidden:true, stayAwake:true })).toPNG());
      times.push(Date.now()); await sleep(Math.max(0, 83-(Date.now()-start)));
    }
    report.motionFrameTimes = times;
    const video = path.join(runDir,'changes-expansion.mp4');
    cp.execFileSync('ffmpeg', ['-y','-framerate','12','-i',path.join(frames,'frame-%03d.png'),'-vf','pad=ceil(iw/2)*2:ceil(ih/2)*2','-c:v','libx264','-pix_fmt','yuv420p',video], { windowsHide:true, stdio:'pipe' });
    report.motion = video;
    report.isolation = { visible:win.isVisible(), focusable:win.isFocusable(), focused:win.isFocused(), profile };
  } catch (error) { report.errors.push(error.stack); process.exitCode=1; }
  finally {
    fs.writeFileSync(path.join(runDir,'report.json'), JSON.stringify(report,null,2));
    console.log('Agent window controls evidence: ' + runDir);
    win.destroy(); await session.defaultSession.closeAllConnections();
    app.quit();
  }
});
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { try { fs.rmSync(profile, { recursive:true,force:true }); } catch {} });
