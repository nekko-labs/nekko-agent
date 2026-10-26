// Synthetic full-App verification only: isolated profile, blocked network, no OS input.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], checks: {}, cpu: [], errors: [] };
const expectNew = process.env.NEKKO_EXPECT_WAVE_NEW === '1';
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 350)); });
  win.on('focus', () => report.errors.push('took focus'));
  const run = s => win.webContents.executeJavaScript(s);
  const assert = (value, label) => { report.checks[label] = value; if (expectNew && !value) throw Error(label); };
  const cpu = () => Object.fromEntries(['GPU', 'Tab'].map(type => [type, app.getAppMetrics().filter(m => m.type === type).reduce((sum, m) => sum + (m.cpu.cumulativeCPUUsage || 0), 0)]));
  const measure = async name => { if (process.env.NEKKO_WAVE_SKIP_CPU === '1') return; const a = cpu(), start = Date.now(); await sleep(Number(process.env.NEKKO_WAVE_SAMPLE_MS || 6000)); const b = cpu(), seconds = (Date.now() - start) / 1000; report.cpu.push({name, seconds, gpuProcessCpu: (b.GPU-a.GPU)/seconds*100, rendererCpu: (b.Tab-a.Tab)/seconds*100}); };
  const shot = async name => { const file = path.join(out, name + '.png'); fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(file); };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 80 && !await run('!!window.layoutFixture && !!document.querySelector("[data-chat-surface]")'); i++) await sleep(100);
    await sleep(1500);
    await shot('default-empty');
    await run(`(() => { const f = layoutFixture, s = f.store.getState(); f.store.setState({ settings: {...s.settings, themePreset: 'lilac', theme: 'light', backgroundAnimation: true, mascotEnabled: true} }); })()`);
    if (!await run(`!!document.querySelector('[data-chat-surface]')`)) throw Error('App fixture did not render agent panels');
    await sleep(1000);
    await shot('empty-agent');
    report.checks.initial = await run(`({waves:document.querySelectorAll('.pixel-wave-background').length, panes:[...document.querySelectorAll('[data-chat-surface]')].map(e=>({id:e.dataset.sessionId,surface:e.dataset.chatSurface,empty:e.hasAttribute('data-clean-start')})),hidden:document.hidden,focused:document.hasFocus()})`);
    await measure('unfocused-empty');
    assert(await run(`Array.from(document.querySelectorAll('.pixel-wave-texture')).every(e => getComputedStyle(e).animationPlayState === 'paused')`), 'unfocused-paused');
    if (expectNew) assert(await run(`Array.from(document.querySelectorAll('.pixel-wave-texture')).every(e => !Number(e.getAnimations()[0]?.currentTime))`), 'unfocused-clock-stopped');
    await run(`Object.defineProperty(document, 'hasFocus', {configurable:true,value:()=>true}); window.dispatchEvent(new Event('focus')); document.documentElement.removeAttribute('data-app-inactive')`); // Synthetic active-state CSS, never focus the real desktop.
    fs.mkdirSync(path.join(out, 'motion'), { recursive: true });
    for (let i = 0; i < 12; i++) { fs.writeFileSync(path.join(out, 'motion', String(i).padStart(3, '0') + '.png'), (await win.capturePage(undefined, { stayHidden: true })).toPNG()); await sleep(180); }
    if (expectNew) assert(await run(`Array.from(document.querySelectorAll('.pixel-wave-texture')).some(e => Number(e.getAnimations()[0]?.currentTime) > 0)`), 'focused-wave-advances');
    assert(await run(`Array.from(document.querySelectorAll('.pixel-wave-texture')).every(e => e.getBoundingClientRect().width === 720 && e.getBoundingClientRect().height === 360)`), 'bounded-textures');
    await measure('synthetic-focused-empty');
    if (expectNew) {
      await run(`Object.defineProperty(document,'hasFocus',{configurable:true,value:()=>false});window.dispatchEvent(new Event('blur'))`);
      const blurTime = await run(`Number(document.querySelector('.pixel-wave-texture').getAnimations()[0]?.currentTime)`);
      await sleep(900);
      assert(await run(`Number(document.querySelector('.pixel-wave-texture').getAnimations()[0]?.currentTime) === ${blurTime}`), 'blur-freezes-clock');
      await run(`Object.defineProperty(document,'hasFocus',{configurable:true,value:()=>true});window.dispatchEvent(new Event('focus'))`);
      await run(`document.querySelector('.pixel-wave-background').style.transform='translateX(-20000px)'`); await sleep(150);
      assert(await run(`document.querySelector('.pixel-wave-background').hasAttribute('data-wave-paused')`), 'offscreen-panel-paused');
      const pausedTime = await run(`Number(document.querySelector('.pixel-wave-texture').getAnimations()[0]?.currentTime)`);
      await sleep(900);
      assert(await run(`Number(document.querySelector('.pixel-wave-texture').getAnimations()[0]?.currentTime) === ${pausedTime}`), 'offscreen-clock-stopped');
      await run(`document.querySelector('.pixel-wave-background').style.transform=''`); await sleep(150);
    }
    assert(await run(`Array.from(document.querySelectorAll('.pixel-wave-background')).every(e => !!e.closest('[data-chat-surface]'))`), 'waves-only-in-agent-panels');
    await win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    assert(await run(`Array.from(document.querySelectorAll('.pixel-wave-texture')).every(e => getComputedStyle(e).animationName === 'none')`), 'reduced-motion-still');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {features:[]});
    await run(`(() => {const f=layoutFixture; f.store.setState({settings:{...f.store.getState().settings,backgroundAnimation:false}})})()`);
    await sleep(150);
    assert(await run(`document.querySelectorAll('.pixel-wave-background').length === 0`), 'setting-disables-wave');
    await run(`(() => {const f=layoutFixture; f.store.setState({settings:{...f.store.getState().settings,backgroundAnimation:true}})})()`);
    await sleep(150);
    // Exercise the real send path through the composer inbox, before any host token.
    await run(`layoutFixture.bridge.sendChat = () => new Promise(() => {}); layoutFixture.store.setState({composerInbox:{sessionId:'a',text:'Check the synthetic workspace',run:true}})`);
    await sleep(300);
    assert(await run(`!document.querySelector('[data-session-id="a"] .pixel-wave-background')`), 'send-removes-wave-before-token');
    assert(await run(`document.querySelector('.pixel-mascot')?.dataset.mascotPose === 'working'`), 'send-colors-cat-before-token');
    // Persist the synthetic user message then emit a running token, without a host.
    await run(`(() => {const f=layoutFixture, s=f.records[0]; s.messages=[{id:'user-1',role:'user',content:'Check the synthetic workspace',createdAt:Date.now()}]; f.putCachedSession(s); f.emitAgent({type:'session_meta',sessionId:'a'}); f.emitAgent({type:'text',sessionId:'a',delta:'Inspecting the workspace.'});})()`);
    await sleep(500);
    assert(await run(`!document.querySelector('[data-session-id="a"] .pixel-wave-background')`), 'first-message-removes-wave');
    assert(await run(`document.querySelector('.pixel-mascot')?.dataset.mascotPose === 'working'`), 'working-cat');
    assert(await run(`document.querySelectorAll('.composer-beam-ring').length === 0`), 'no-working-beams');
    assert(await run(`document.querySelector('.pixel-mascot svg')?.getAnimations({subtree:true}).length === 0`), 'working-cat-no-motion');
    await shot('working-agent');
    await run(`layoutFixture.emitAgent({type:'text',sessionId:'background-agent',delta:'Working elsewhere'});layoutFixture.emitAgent({type:'done',sessionId:'a',messageId:'reply-1'})`);
    await sleep(150);
    assert(await run(`document.querySelector('.pixel-mascot')?.dataset.mascotPose === 'working'`), 'background-agent-keeps-cat-working');
    await run(`layoutFixture.emitAgent({type:'question',sessionId:'background-agent',request:{id:'q',callId:'q',questions:[]}})`);
    await sleep(150);
    assert(await run(`document.querySelector('.pixel-mascot')?.dataset.mascotPose !== 'working'`), 'waiting-cat-idle');
    await run(`layoutFixture.emitAgent({type:'done',sessionId:'background-agent',messageId:'reply-2'})`);
    await sleep(150);
    await shot('finished-agent');
    // Match default-theme working state too; primary evidence uses the default palette.
    await run(`(() => {const f=layoutFixture;f.store.setState({settings:{...f.store.getState().settings,themePreset:undefined,theme:'dark'}});f.emitAgent({type:'text',sessionId:'a',delta:'Working'});})()`);
    await sleep(250); await shot('default-working');
    fs.mkdirSync(path.join(out, 'motion-working'), { recursive: true });
    for (let i = 0; i < 16; i++) { fs.writeFileSync(path.join(out, 'motion-working', String(i).padStart(3, '0') + '.png'), (await win.capturePage(undefined, { stayHidden: true })).resize({width:1440}).toPNG()); await sleep(150); }
    await run(`document.querySelector('button[title^="Dynamic ("]')?.click()`); await sleep(500);
    await shot('default-dynamic-working');
    assert(await run(`document.querySelectorAll('.composer-beam-ring').length === 0`), 'dynamic-no-working-beams');
    report.checks.bounds = win.getBounds();
    report.checks.visible = win.isVisible();
    await shot('active-agent');
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.errors.length ? 1 : 0);
});
