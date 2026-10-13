const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const dir = process.env.NEKKO_EVIDENCE_DIR, kind = process.env.NEKKO_EVIDENCE_KIND;
app.commandLine.appendSwitch('force-device-scale-factor', '1');
const profile = fs.mkdtempSync(path.join(dir, 'profile-')); app.setPath('userData', profile); app.setPath('sessionData', profile);
const report = { kind, revision: kind === 'before' ? '76c2db7b' : 'working-source', checks: [], errors: [], captures: [], timing: [], visuallyInspected: false, limitations: ['Parent screenshot inspection required', 'DOM-synthetic drag events exercise React handlers, not native OS drag', 'Hidden renderer capture does not prove OS chrome or focus permissions'] };
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((r, done) => done({ cancel: !/^(file:|data:|blob:)/.test(r.url) }));
  session.defaultSession.setPermissionRequestHandler((w, p, d) => d(false)); session.defaultSession.setPermissionCheckHandler(() => false);
  const left = Math.min(...screen.getAllDisplays().map(d => d.bounds.x));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: left - 5000, y: -3000, title: 'Isolated group drag evidence', webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('Unexpected OS focus'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const stable = async () => { await run(`document.fonts.ready`); await sleep(400); };
  const event = async (group, part, type, related) => { await run(`evidence.event(${group},${JSON.stringify(part)},${JSON.stringify(type)},${JSON.stringify(related)})`); await sleep(60); };
  const capture = async name => { await stable(); const img = await win.capturePage(undefined, { stayHidden: true, stayAwake: true }); if (img.isEmpty()) throw Error('Empty screenshot'); fs.writeFileSync(path.join(dir, name + '.png'), img.toPNG()); report.captures.push({ name, size: img.getSize(), dom: await run(`({width:innerWidth,height:innerHeight,theme:document.documentElement.dataset.theme,orientation:document.querySelector('[data-agent-panel]').dataset.orientation,groups:evidence.groups().map(g=>({name:g.innerText,gap:g.dataset.groupGap,rect:(()=>{const r=g.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()}))})`) }); };
  const check = async (name, code) => { report.checks.push({ name, passed: !!await run(code), expectedBaselineFailure: kind === 'before' && /nested|group drop/.test(name) }); };
  const configure = async (width, theme, orientation) => {
    win.setContentSize(width, 900);
    for (let i = 0; i < 8; i++) { await sleep(100); const v = await run('({w:innerWidth,h:innerHeight})'); if (v.w === width && v.h === 900) break; const b = win.getBounds(); win.setBounds({ ...b, width: b.width + width - v.w, height: b.height + 900 - v.h }); }
    await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)};evidence.configure(${JSON.stringify(orientation)})`); await stable();
    if (width < 768 && orientation === 'vertical') { await run(`document.querySelector('[aria-label="Open agent list"]')?.click()`); await stable(); }
  };
  try {
    await win.loadFile(path.join(dir, 'index.html')); await sleep(800); await stable();
    for (const width of [1440, 390]) for (const theme of ['light', 'dark']) for (const orientation of ['vertical', 'horizontal']) {
      await configure(width, theme, orientation);
      const label = `${width}-${theme}-${orientation}`;
      await check(label + ' exact viewport and three groups', `innerWidth===${width}&&innerHeight===900&&evidence.groups().length===3`);
      await capture(label + '-idle');
      await event(2, 'header', 'dragstart'); await event(0, 'card', 'dragover');
      await capture(label + '-hover');
      const hover = await run(`evidence.groups()[0].getAttribute('data-group-gap') || evidence.groups()[0].className`);
      await event(0, 'group', 'dragleave', 'card');
      await check(label + ' nested dragleave retains hover', `(evidence.groups()[0].getAttribute('data-group-gap') || evidence.groups()[0].className)===${JSON.stringify(hover)}`);
      await capture(label + '-nested-hover');
      if (kind === 'after') {
        await check(label + ' insertion gap has expected size', `(()=>{const g=evidence.groups()[0], gap=g.querySelector('.agent-panel-group-gap');return document.querySelector('[data-agent-panel]').dataset.orientation==='vertical'?Math.abs(gap.getBoundingClientRect().height-36)<1:Math.abs(parseFloat(getComputedStyle(g).paddingLeft)-48)<1})()`);
        await event(0, 'group', 'dragleave'); await stable();
        await check(label + ' leaving group closes gap', `!evidence.groups()[0].hasAttribute('data-group-gap')`);
        await event(0, 'card', 'dragover'); await stable();
      }
      await event(0, 'card', 'drop'); await stable();
      await check(label + ' group drop on card persists order', `evidence.settings().workspaces.map(p=>p.id).join(',')==='p3,p1,p2'&&evidence.calls().some(c=>c.method==='updateSettings'&&c.patch.workspaces.map(p=>p.id).join(',')==='p3,p1,p2')`);
      await capture(label + '-reordered');
      const selfOrder = await run(`evidence.settings().workspaces.map(p=>p.id).join(',')`);
      await run('evidence.calls().length=0'); await event(0, 'header', 'dragstart'); await event(0, 'card', 'dragover'); await event(0, 'card', 'drop'); await stable();
      await check(label + ' self drop safe', `evidence.settings().workspaces.map(p=>p.id).join(',')===${JSON.stringify(selfOrder)}&&evidence.settings().workspaces.length===3&&new Set(evidence.settings().workspaces.map(p=>p.id)).size===3`);
      if (kind === 'after') await check(label + ' self drop no write', `!evidence.calls().some(c=>c.method==='updateSettings')`);
      await event(0, 'card', 'dragstart'); await event(1, 'card', 'dragover'); await event(1, 'card', 'drop'); await stable();
      await check(label + ' agent card drag persists chat layout', `evidence.calls().some(c=>c.method==='setSessionWorkspace')&&evidence.calls().some(c=>c.method==='setSessionOptions')`);
    }
    await configure(1440, 'dark', 'vertical');
    const frames = path.join(dir, 'motion'); fs.mkdirSync(frames, { recursive: true }); const started = Date.now();
    for (let i = 0; i < 36; i++) {
      if (i === 3) await event(2, 'header', 'dragstart');
      if (i === 5) await event(1, 'card', 'dragover');
      if (i === 13) await event(0, 'card', 'dragover');
      if (i === 20) await event(0, 'group', 'dragleave', 'card');
      if (i === 27) await event(0, 'card', 'drop');
      report.timing.push({ frame: i, elapsedMs: Date.now() - started });
      const img = await win.capturePage(undefined, { stayHidden: true, stayAwake: true }); fs.writeFileSync(path.join(frames, String(i).padStart(4, '0') + '.png'), img.toPNG()); await sleep(100);
    }
    fs.writeFileSync(path.join(frames, 'frames.txt'), report.timing.map((t, i) => `file '${String(i).padStart(4, '0')}.png'\nduration ${((report.timing[i + 1]?.elapsedMs ?? t.elapsedMs + 100) - t.elapsedMs) / 1000}`).join('\n') + "\nfile '0035.png'\n");
    cp.execFileSync('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', path.join(frames, 'frames.txt'), '-vsync', 'vfr', '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-pix_fmt', 'yuv420p', path.join(dir, 'group-drag-motion.mp4')], { windowsHide: true, stdio: 'pipe' });
    report.background = { focused: win.isFocused(), visible: win.isVisible(), focusable: win.isFocusable(), bounds: win.getBounds(), profile };
  } catch (e) { report.errors.push(String(e)); try { report.debug = await run('document.body.innerText'); await capture('failure-debug'); } catch (_) {} }
  finally { fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ kind, captures: report.captures.length, failed: report.checks.filter(c => !c.passed), errors: report.errors }, null, 2)); win.destroy(); app.exit(report.errors.length || (kind === 'after' && report.checks.some(c => !c.passed)) ? 1 : 0); }
});
