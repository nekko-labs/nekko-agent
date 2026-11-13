// Code mode in a Claude Agent chat: the Mode panel's Tools row and the Tools flyout's
// "How tools reach the model" radios. Real ChatPane via the layout fixture's showFolderComposer;
// synthetic bridge only. Hidden, off-screen, non-focusable; renderer input only.
//   NEKKO_LAYOUT_SANDBOX=code-mode-claude-sandbox.cjs NEKKO_TEST_LABEL=after node apps/desktop/scripts/layout-evidence-integration.cjs
// Baseline: add NEKKO_TEST_SOURCE=<base worktree> NEKKO_TEST_LABEL=before. PNGs land in .shots/code-mode-claude.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Use layout-evidence-integration.cjs');
const before = !!process.env.NEKKO_TEST_SOURCE;
const prefix = before ? 'before-' : 'after-';
const shots = path.resolve(out, '../../../.shots/code-mode-claude');
fs.mkdirSync(shots, { recursive: true });
app.setPath('userData', path.join(out, 'profile'));
app.setPath('sessionData', path.join(out, 'profile'));
app.disableHardwareAcceleration();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const js = (v) => JSON.stringify(v).replace(/[<>/\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const report = { before, checks: [], captures: [], errors: [], notes: {} };
const CLAUDE_PROVIDER = { id: 'cc', kind: 'claude-code', name: 'Claude', label: 'Claude Agent', enabled: true, claudeCode: {} };

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1300, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -10000, y: -10000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('show', () => report.errors.push('Became visible'));
  win.on('focus', () => report.errors.push('Took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push('console: ' + String(e.message).slice(0, 300)); });
  const run = code => win.webContents.executeJavaScript(code, true);
  const has = sel => run(`!!document.querySelector(${js(sel)})`);
  const wait = async sel => { for (let i = 0; i < 80; i++) { if (await has(sel)) return; await sleep(100); } throw Error('Missing ' + sel); };
  const click = sel => run(`document.querySelector(${js(sel)}).click()`);
  const check = (name, value) => { report.checks.push({ name, value }); };
  const rectOf = sel => run(`(()=>{const e=document.querySelector(${js(sel)});if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`);
  const crop = (rects, pad = 8) => {
    const r = rects.filter(Boolean);
    const x0 = Math.max(0, Math.floor(Math.min(...r.map(a => a.x)) - pad)), y0 = Math.max(0, Math.floor(Math.min(...r.map(a => a.y)) - pad));
    const x1 = Math.ceil(Math.max(...r.map(a => a.x + a.width)) + pad), y1 = Math.ceil(Math.max(...r.map(a => a.y + a.height)) + pad);
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  };
  const shot = async (name, rect) => {
    await sleep(200);
    await win.capturePage(rect, { stayHidden: true }); // first capture can be stale on a hidden window
    await sleep(100);
    const file = path.join(shots, prefix + name + '.png');
    fs.writeFileSync(file, (await win.capturePage(rect, { stayHidden: true })).toPNG());
    report.captures.push(file);
  };
  try {
    win.setContentSize(1300, 900);
    await win.loadURL('about:blank');
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 100 && !(await run('!!window.layoutFixture')); i++) await sleep(100);
    await run(`(()=>{const h=document.documentElement;const off=()=>h.removeAttribute('data-app-inactive');off();new MutationObserver(off).observe(h,{attributes:true,attributeFilter:['data-app-inactive']})})()`);
    await sleep(900);
    // A Claude Agent chat (provider kind claude-code) that was left on code mode.
    await run(`layoutFixture.composerSeed = (r) => { delete layoutFixture.settings.themePreset; r.providerId = 'cc'; r.toolApproach = 'code'; }; 0`);
    const TOOLS = ['read_file', 'write_file', 'edit_file', 'list_dir', 'glob', 'grep', 'bash', 'web_fetch', 'web_search'].map(name => ({ name, description: name.replace(/_/g, ' ') }));
    await run(`layoutFixture.bridge.listTools = async () => ${js(TOOLS)}; 0`);
    await run(`layoutFixture.showFolderComposer(false, true, 'full', '')`);
    await wait('.composer'); await wait('[data-chat-mode-button]'); await sleep(600);
    // showFolderComposer sets the store's providers last; add the Claude one after it mounts.
    await run(`(()=>{const s=layoutFixture.store;s.setState({providers:[...s.getState().providers, ${js(CLAUDE_PROVIDER)}]})})()`);
    await sleep(300);
    await click('[data-chat-mode-button]');
    await wait('[data-mode-panel]'); await sleep(500);
    const state = () => run(`(()=>{
      const row = document.querySelector('[data-mode-fly="tools"]');
      const radios = [...document.querySelectorAll('[data-tool-approaches] [role=radio]')].map(b => ({ id: b.dataset.toolApproach, checked: b.getAttribute('aria-checked'), disabled: b.disabled, text: b.textContent.trim() }));
      const lock = document.querySelector('[data-tool-approach-lock]');
      return { toolsRowMeta: row?.querySelector('.mode-meta')?.textContent ?? null, radios, lock: lock ? { kind: lock.dataset.toolApproachLock, text: lock.textContent.trim() } : null };
    })()`);
    report.notes.panelState = await state();
    check('Tools row present in the Mode panel', report.notes.panelState.toolsRowMeta !== null);
    await shot('1-mode-panel-tools-row', crop([await rectOf('.mode-panel')], 12));
    await shot('1b-tools-row-crop', crop([await rectOf('[data-mode-fly="tools"]')], 24));
    await click('[data-mode-fly="tools"]');
    await wait('[data-tool-approaches]'); await sleep(700);
    report.notes.flyoutState = await state();
    const st = report.notes.flyoutState;
    const code = st.radios.find(r => r.id === 'code'), list = st.radios.find(r => r.id === 'list');
    if (before) {
      check('code mode radio checked and enabled', !!code && code.checked === 'true' && !code.disabled);
      check('Tools row says code mode', /code mode/.test(st.toolsRowMeta ?? ''));
    } else {
      check('both radios disabled, Tool list checked', !!code && !!list && code.disabled && list.disabled && list.checked === 'true' && code.checked === 'false');
      check('claude-agent lock note shown', st.lock?.kind === 'claude-agent' && /Claude Agent chats run Claude Code's own tools/.test(st.lock.text));
      check('Tools row no longer says code mode', !/code mode/.test(st.toolsRowMeta ?? ''));
    }
    await shot('2-tools-flyout-open', crop([await rectOf('.mode-panel'), await rectOf('.mode-fly')], 12));
    await shot('2b-tools-flyout-crop', crop([await rectOf('.mode-fly')], 12));
    report.background = { visible: win.isVisible(), focused: win.isFocused(), bounds: win.getBounds() };
    if (report.background.visible || report.background.focused) throw Error('Unsafe window state');
  } catch (e) { report.errors.push(String(e.stack || e)); }
  finally {
    fs.writeFileSync(path.join(shots, prefix + 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    win.destroy(); app.exit(report.errors.some(e => !/^console:/.test(e)) || report.checks.some(c => !c.value) ? 1 : 0);
  }
});
