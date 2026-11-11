// Privacy Shield composer polish evidence (marks in the draft, Shield glyph, Incognito warning,
// locked internet globe, code-mode savings in the cost chip). Real ChatPane via the layout fixture's
// showFolderComposer; synthetic bridge only. Hidden, off-screen, non-focusable; renderer input only.
//   NEKKO_LAYOUT_SANDBOX=privacy-polish-sandbox.cjs NEKKO_TEST_LABEL=after node apps/desktop/scripts/layout-evidence-integration.cjs
// Baseline: add NEKKO_TEST_SOURCE=<base worktree> NEKKO_TEST_LABEL=before. PNGs land in .shots/privacy-polish.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const writeGif = require('./evidence-gif.cjs');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Use layout-evidence-integration.cjs');
const before = !!process.env.NEKKO_TEST_SOURCE;
const prefix = before ? 'before-' : 'after-';
const shots = path.resolve(out, '../../../.shots/privacy-polish');
fs.mkdirSync(shots, { recursive: true });
app.setPath('userData', path.join(out, 'profile'));
app.setPath('sessionData', path.join(out, 'profile'));
app.disableHardwareAcceleration();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const js = (v) => JSON.stringify(v).replace(/[<>/\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const report = { before, checks: [], captures: [], errors: [], notes: {} };
const DRAFT = 'Email jane@acme.com about the invoice';
// The engine preview the Shield uses, for a draft that holds the address; honest about the chat's own mode.
const PREVIEW = `(() => { const f = layoutFixture; f.bridge.previewPrivacy = async (id, draft) => ({
  enabled: f.records[0].privacy?.mode === 'redact', reach: 'cloud', draft, allowed: [], disabledKinds: [], terms: [], kinds: ['email'],
  findings: draft.includes('jane@acme.com') ? [{ kind: 'email', value: 'jane@acme.com', token: '[PII_EMAIL_1]', count: 1, inDraft: true, inChat: false }] : [] }); })()`;
const stats = n => ({ providerId: 'fixture', modelId: 'gpt-fixture', inputTokens: 1000, outputTokens: 200, wallMs: 4000, calls: 3, stop: 'complete',
  codeMode: { toolsWrapped: 30, schemaTokensPerCall: 2000, schemaTokensSaved: 6000, resultTokensSaved: n - 6000 + 1000, searchTokens: 1000, tokensSaved: n } });

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1100, height: 720, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -10000, y: -10000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('show', () => report.errors.push('Became visible'));
  win.on('focus', () => report.errors.push('Took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push('console: ' + String(e.message).slice(0, 300)); });
  const run = code => win.webContents.executeJavaScript(code, true);
  const has = sel => run(`!!document.querySelector(${js(sel)})`);
  const wait = async sel => { for (let i = 0; i < 80; i++) { if (await has(sel)) return; await sleep(100); } throw Error('Missing ' + sel); };
  const check = (name, value) => { report.checks.push({ name, value }); };
  const rectOf = sel => run(`(()=>{const e=document.querySelector(${js(sel)});if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`);
  // Union of rects, padded, clamped to the viewport.
  const crop = (rects, pad = 8) => {
    const r = rects.filter(Boolean);
    const x0 = Math.max(0, Math.floor(Math.min(...r.map(a => a.x)) - pad)), y0 = Math.max(0, Math.floor(Math.min(...r.map(a => a.y)) - pad));
    const x1 = Math.ceil(Math.max(...r.map(a => a.x + a.width)) + pad), y1 = Math.ceil(Math.max(...r.map(a => a.y + a.height)) + pad);
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  };
  const shot = async (name, rect) => {
    await sleep(150);
    await win.capturePage(rect, { stayHidden: true }); // first capture can be stale on a hidden window
    await sleep(100);
    const file = path.join(shots, prefix + name + '.png');
    fs.writeFileSync(file, (await win.capturePage(rect, { stayHidden: true })).toPNG());
    report.captures.push(file);
  };
  // Renderer input into the hidden window: sendInputEvent first, the DevTools protocol if :hover did not take.
  const hoverAt = async (x, y) => {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: x - 6, y: y - 6 });
    await sleep(80);
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    await sleep(350);
  };
  const hover = async (sel) => {
    const r = await rectOf(sel); if (!r) return false;
    const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
    await hoverAt(x, y);
    let how = 'sendInputEvent';
    if (!(await run(`document.querySelector(${js(sel)}).matches(':hover')`))) {
      how = 'cdp';
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x - 6, y: y - 6 });
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await sleep(350);
    }
    report.notes.hoverVia = report.notes.hoverVia || {}; report.notes.hoverVia[sel] = how + ':' + (await run(`document.querySelector(${js(sel)}).matches(':hover')`));
    return true;
  };
  const unhover = async () => { win.webContents.sendInputEvent({ type: 'mouseMove', x: 4, y: 4 }); if (win.webContents.debugger.isAttached()) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 }); await sleep(250); };
  // Each scene reloads the fixture, seeds the chat, and mounts the real expert composer.
  const scene = async (seedBody, draft = '') => {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 100 && !(await run('!!window.layoutFixture')); i++) await sleep(100);
    await run(`(()=>{const h=document.documentElement;const off=()=>h.removeAttribute('data-app-inactive');off();new MutationObserver(off).observe(h,{attributes:true,attributeFilter:['data-app-inactive']})})()`);
    await sleep(900);
    await run(PREVIEW);
    await run(`layoutFixture.composerSeed = (r) => { delete layoutFixture.settings.themePreset; ${seedBody} }; 0`);
    await run(`layoutFixture.showFolderComposer(false, true, 'full', ${js(draft)})`);
    await wait('.composer'); await wait('[data-composer-details]'); await sleep(900);
    // Tag the strip's Shield button by its label: the base branch has no data-privacy-shield-button hook.
    await run(`[...document.querySelectorAll('.composer button.ctl-toggle')].find(b => /^Shield/.test(b.textContent.trim()))?.setAttribute('data-evidence-shield', '')`);
  };
  const viewport = async (w, h = 720) => { win.setContentSize(w, h); await sleep(600); };
  const composerRect = () => rectOf('.composer');
  try {
    win.setContentSize(1100, 720);
    await win.loadURL('about:blank');
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await viewport(1100);

    // 1. Marks in the draft (Shield on, cloud model).
    await scene(`r.privacy = { mode: 'redact' };`, DRAFT);
    await sleep(1600); // the 750ms preview debounce
    const marks = await run(`[...document.querySelectorAll('.composer-privacy-mark')].map(m => ({ text: m.textContent, token: m.dataset.privacyToken, open: m.hasAttribute('data-privacy-open'), after: getComputedStyle(m, '::after').content, bg: getComputedStyle(m).backgroundColor }))`);
    report.notes.marks = marks;
    check('composer has the draft text unchanged', await run(`document.querySelector('.composer').innerText.includes(${js(DRAFT)}) || document.querySelector('.composer').textContent.includes(${js(DRAFT)})`));
    if (!before) check('one mark wraps jane@acme.com with its token', marks.length === 1 && marks[0].text === 'jane@acme.com' && marks[0].token === '[PII_EMAIL_1]');
    else check('baseline has no marks', marks.length === 0);
    await shot('1-composer-marks-1100', crop([await composerRect()], 10));
    check('mark text is not in the draft value', await run(`!/PII_EMAIL/.test(document.querySelector('.composer').textContent)`));
    await viewport(360);
    report.notes.overflow360 = await run(`document.documentElement.scrollWidth <= innerWidth`);
    await shot('1b-composer-marks-360', crop([await composerRect()], 6));
    await viewport(1100);

    // 3. Incognito in the strip and in the Approvals menu.
    await scene(`r.incognito = true;`, '');
    // The base branch has no data-incognito-toggle hook: find the strip's Incognito button by its label in both.
    await run(`[...document.querySelectorAll('.composer button.ctl-toggle')].find(b => b.textContent.trim() === 'Incognito')?.setAttribute('data-evidence-incognito', '')`);
    const inc = await run(`(()=>{const b=document.querySelector('[data-evidence-incognito]');if(!b)return null;const c=getComputedStyle(b);return {pressed:b.getAttribute('aria-pressed'),color:c.color,bg:c.backgroundColor,title:b.title}})()`);
    report.notes.incognitoStrip = inc;
    await shot('3-incognito-strip-and-composer', crop([await composerRect()], 10));
    const strip = await rectOf('[data-evidence-incognito]');
    if (strip) await shot('3b-incognito-strip-crop', crop([strip, await rectOf('[data-evidence-shield]')], 60));
    else report.notes.incognitoStripMissing = true;
    if (await has('[data-asks-first]')) {
      await run(`document.querySelector('[data-asks-first]').click()`); await sleep(500);
      const row = await run(`(()=>{const b=document.querySelector('[data-asks-toggle="incognito"]');if(!b)return null;const c=getComputedStyle(b);const g=b.querySelector('.permission-glyph')||b;return {color:c.color,bg:c.backgroundColor,glyphColor:getComputedStyle(g).color,checked:b.getAttribute('aria-checked'),text:b.textContent.trim()}})()`);
      report.notes.incognitoMenuRow = row;
      const menu = await rectOf('[data-asks-menu]');
      if (menu) await shot('3c-incognito-approvals-menu', crop([menu, await rectOf('[data-asks-first]')], 12));
      await run(`document.querySelector('[data-asks-first]').click()`); await sleep(200);
    } else report.notes.incognitoMenuRow = 'no [data-asks-first]';

    // 4. The locked internet globe, hovered.
    await scene(``, '');
    await unhover();
    const globe = async () => run(`(()=>{const b=document.querySelector('.agent-internet-toggle');if(!b)return null;const c=getComputedStyle(b);return {title:b.title,disabled:b.disabled,ariaDisabled:b.getAttribute('aria-disabled'),cursor:c.cursor,opacity:c.opacity,bg:c.backgroundColor,hovered:b.matches(':hover'),hoverMedia:matchMedia('(hover: hover)').matches}})()`);
    report.notes.globeIdle = await globe();
    await shot('4c-internet-globe-idle', crop([await rectOf('.agent-internet-toggle'), await rectOf('[data-agent-footer-controls]')], 40));
    await hover('.agent-internet-toggle');
    report.notes.globeHover = await globe();
    await shot('4-internet-globe-hover', crop([await rectOf('.agent-internet-toggle'), await rectOf('[data-agent-footer-controls]')], 40));
    await shot('4b-internet-globe-hover-composer', crop([await composerRect()], 10));
    await unhover();

    // 5. Cost chip popover with code-mode savings in the chat.
    await scene(`const t = Date.now(); r.messages = [
      { id: 'u1', role: 'user', content: 'Audit the tools.', createdAt: t - 9000 },
      { id: 'a1', role: 'assistant', content: 'Done, first pass.', createdAt: t - 8000, turnStats: ${js(stats(9000))} },
      { id: 'u2', role: 'user', content: 'And the second pass.', createdAt: t - 5000 },
      { id: 'a2', role: 'assistant', content: 'Done, second pass.', createdAt: t - 4000, turnStats: ${js(stats(3000))} }];`, '');
    await unhover();
    await run(`[...document.querySelectorAll('[data-composer-details] .group')].find(g => /Subscription limits|Session cost/.test(g.querySelector('[role=tooltip]')?.textContent ?? ''))?.setAttribute('data-evidence-cost', '')`);
    const chip = '[data-evidence-cost] > button.chip';
    check('cost chip is in the details row', await has(chip));
    await hover(chip);
    const tip = await run(`(()=>{const t=document.querySelector('[data-evidence-cost] [role=tooltip]');return t?{visible:getComputedStyle(t).display!=='none',text:t.innerText}:null})()`);
    report.notes.costPopover = tip;
    if (!before) check('popover shows Saved by code mode · this chat ≈12k tokens', !!tip && /Saved by code mode/.test(tip.text) && /12k/.test(tip.text));
    else check('baseline popover has no code-mode row', !!tip && !/code mode/i.test(tip.text));
    await shot('5-cost-chip-popover', crop([await rectOf('[data-evidence-cost] [role=tooltip]'), await composerRect()], 10));
    await unhover();

    // 2. The Shield glyph, then the switch-on motion (after only: the baseline has no sweep or halo).
    await scene(``, '');
    await shot('2-shield-button-off', crop([await rectOf('[data-evidence-shield]')], 70));
    if (!before) {
      await run(`document.querySelector('[data-evidence-shield]').click()`); await sleep(400);
      const frames = [], times = [];
      const btn = await rectOf('[data-evidence-shield]');
      const region = crop([btn], 56);
      const grab = async () => { frames.push((await win.capturePage(region, { stayHidden: true })).toPNG()); times.push(Date.now()); };
      await grab(); await grab();
      await run(`document.querySelector('[role=switch][aria-label="Shield this chat"]').click()`);
      await sleep(20);
      await run(`document.querySelector('[data-evidence-shield]').click()`); // close the panel
      const t0 = Date.now();
      while (Date.now() - t0 < 4600) { await grab(); await sleep(30); }
      const span = (times.at(-1) - times[0]) / (times.length - 1);
      const gif = path.join(shots, 'after-2-shield-switch-on.gif');
      writeGif(gif, frames, Math.max(2, Math.round(span / 10)));
      report.captures.push(gif);
      report.notes.gif = { frames: frames.length, meanFrameMs: Math.round(span) };
      const glyph = await run(`(()=>{const b=document.querySelector('[data-evidence-shield]');const g=b.querySelector('.privacy-shield-glyph');return {on:b.hasAttribute('data-shield-on'),arming:b.hasAttribute('data-shield-arming'),color:getComputedStyle(g).color,halo:getComputedStyle(g,'::after').animationName,haloBorder:getComputedStyle(g,'::after').borderTopColor}})()`);
      report.notes.shieldGlyph = glyph;
      check('shield is on, glyph accent, halo animation running', glyph.on && glyph.halo === 'shield-halo');
      // Peak of a halo cycle: seek the running animation for a still.
      await run(`document.getAnimations().filter(a=>a.animationName==='shield-halo').forEach(a=>{a.pause();a.currentTime=0})`);
      await sleep(150);
      await shot('2b-shield-button-on-halo', crop([btn], 70));
    } else {
      // Baseline "on" state for the same chat: the glyph without accent or halo.
      await scene(`r.privacy = { mode: 'redact' };`, '');
      await sleep(800);
      await shot('2b-shield-button-on', crop([await rectOf('[data-evidence-shield]')], 70));
      report.notes.shieldGlyph = await run(`(()=>{const b=document.querySelector('[data-evidence-shield]');return {pressed:b.getAttribute('aria-pressed'),color:getComputedStyle(b.querySelector('svg')).color}})()`);
    }
    report.background = { visible: win.isVisible(), focused: win.isFocused(), bounds: win.getBounds() };
    if (report.background.visible || report.background.focused) throw Error('Unsafe window state');
  } catch (e) { report.errors.push(String(e.stack || e)); }
  finally {
    fs.writeFileSync(path.join(shots, prefix + 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    win.destroy(); app.exit(report.errors.some(e => !/^console:/.test(e)) ? 1 : 0);
  }
});
