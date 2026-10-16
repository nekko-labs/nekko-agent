// Synthetic find-in-chat evidence; never connects to the user's host or profile.
// Launched through chat-search-integration.cjs (NEKKO_TEST_REVISION=<rev> for "before").
// Drives real renderer input (keyboard chords, typing, clicks; no OS input) in a
// hidden, non-focusable, off-screen window, and reads back the count, the
// highlights the bar drew, and where the transcript scrolled.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through chat-search-integration.cjs');
const base = !!process.env.NEKKO_TEST_REVISION;
const dir = path.join(out, base ? 'before' : 'after');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
app.setPath('userData', path.join(dir, 'profile'));
app.setPath('sessionData', path.join(dir, 'profile'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((request, done) => done({ cancel: !/^(file:|data:|blob:)/.test(request.url) }));
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, done) => done(false));
  const left = Math.min(...screen.getAllDisplays().map(d => d.bounds.x));
  const win = new BrowserWindow({
    width: 1100, height: 760, useContentSize: true, show: false, focusable: false, skipTaskbar: true,
    x: left - 3000, y: -2000, title: 'Synthetic chat search verification',
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  const report = { checks: [], errors: [], measures: {} };
  win.on('focus', () => report.errors.push('Fixture took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push('console: ' + e.message); });
  const run = source => win.webContents.executeJavaScript(source, true);
  const check = (name, ok) => report.checks.push({ name, passed: !!ok });
  const capture = async name => { await sleep(350); fs.writeFileSync(path.join(dir, name + '.png'), (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG()); };
  const key = async (keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (keyCode.length === 1 && !modifiers.includes('control')) win.webContents.sendInputEvent({ type: 'char', keyCode, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await sleep(60);
  };
  const type = async text => { for (const ch of text) await key(ch, ch !== ch.toLowerCase() ? ['shift'] : []); };
  const click = async selector => {
    const p = await run(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);
    if (!p) return false;
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await sleep(120);
    return true;
  };
  const state = () => run(`(()=>{
    const bar=document.querySelector('[data-chat-search]');
    const sc=document.querySelector('[data-transcript-scroll]');
    const h=integration.highlights();
    let currentInView=null;
    const reg=CSS.highlights&&CSS.highlights.get('nekko-chat-search-current');
    if(reg&&sc){const r=[...reg][0];if(r){const a=r.getBoundingClientRect(),b=sc.getBoundingClientRect();currentInView=a.top>=b.top&&a.bottom<=b.bottom&&a.height>0;}}
    return {open:!!bar,count:bar?bar.querySelector('[data-chat-search-count]').textContent:null,
      focused:document.activeElement&&document.activeElement.getAttribute('aria-label'),
      all:h.all.length,allWords:[...new Set(h.all.map(s=>s.toLowerCase()))],current:h.current,currentInView,
      top:sc?Math.round(sc.scrollTop):null};})()`);
  try {
    await win.loadFile(path.join(out, 'index.html'));
    win.showInactive();
    await sleep(1500);
    const expected = await run('integration.expectedScrollCount()');
    report.measures.expected = expected;
    for (const t of ['dark', 'light']) {
      await run('integration.reset()'); await sleep(1500);
      await run(`document.documentElement.dataset.theme='${t}'`); await sleep(300);
      await capture(`composer-${t}`);
      // The toggle, beside +, at +'s exact size.
      // The toggle leads the window's header icons: left of Changes (±) and
      // Files (folder), in their exact button and icon style.
      const geom = await run(`(()=>{
        const s=document.querySelector('[data-chat-search-toggle]');
        const diff=document.querySelector('[data-agent-companion="diff"]');
        const files=document.querySelector('[data-agent-companion="files"]');
        const plus=document.querySelector('[aria-label="Add a photo, video, file, folder, or skill"]');
        if(!s||!diff||!files)return {search:!!s,diff:!!diff,files:!!files};
        const box=e=>{const r=e.getBoundingClientRect();return {x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width*10)/10,h:Math.round(r.height*10)/10}};
        const icon=e=>{const v=e.querySelector('svg');const r=v.getBoundingClientRect();return {w:r.width,h:r.height,stroke:v.getAttribute('stroke-width'),view:v.getAttribute('viewBox')}};
        const look=e=>{const c=getComputedStyle(e);return [c.paddingTop,c.paddingRight,c.paddingBottom,c.paddingLeft,c.borderRadius,c.color,c.backgroundColor,c.fontSize].join('|')};
        const row=s.closest('header > div:last-child, [data-pane-actions]')||s.parentElement; const order=[...row.querySelectorAll('button')].filter(e=>e.offsetParent!==null).sort((a,b)=>a.getBoundingClientRect().left-b.getBoundingClientRect().left).map(e=>e.dataset.chatSearchToggle!==undefined?'search':e.dataset.agentCompanion||e.getAttribute('aria-label'));
        const nearPlus=plus?[...plus.closest('div.flex').querySelectorAll('[data-chat-search-toggle]')].length:0;
        return {search:box(s),diff:box(diff),files:box(files),searchIcon:icon(s),diffIcon:icon(diff),filesIcon:icon(files),searchLook:look(s),diffLook:look(diff),filesLook:look(files),order,sameParent:row.contains(diff)&&row.contains(files),nearPlus};
      })()`);
      report.measures[`geometry-${t}`] = geom;
      if (base) { check(`base has no search toggle (${t})`, !geom.search); continue; }
      check(`search is the first header icon, just left of Changes and Files (${t})`, geom.sameParent && geom.order[0] === 'search' && geom.order[1] === 'diff' && geom.order.indexOf('files') > 1 && geom.search.y === geom.diff.y);
      check(`search button is the same size as Changes and Files (${t})`, geom.search.w === geom.diff.w && geom.search.h === geom.diff.h && geom.search.w === geom.files.w && geom.search.h === geom.files.h);
      check(`search icon is the same size, viewBox and stroke as theirs (${t})`, ['w','h','stroke','view'].every(k => geom.searchIcon[k] === geom.diffIcon[k] && geom.searchIcon[k] === geom.filesIcon[k]));
      check(`search button has the same padding, radius, colour and background (${t})`, geom.searchLook === geom.diffLook && geom.searchLook === geom.filesLook);
      check(`search is no longer beside the composer + (${t})`, geom.nearPlus === 0);

      // Ctrl+F opens the bar, focused.
      await run(`document.querySelector('[contenteditable="true"]')?.focus()`);
      await key('F', ['control']); await sleep(250);
      let s = await state();
      check(`Ctrl+F opens the search bar with the input focused (${t})`, s.open && s.focused === 'Find in chat');
      const field = await run(`(()=>{const i=document.querySelector('[aria-label="Find in chat"]');const bar=document.querySelector('[data-chat-search]');const c=getComputedStyle(i),b=getComputedStyle(bar);return {outline:c.outlineStyle,shadow:c.boxShadow,underline:c.borderBottomStyle+' '+c.borderBottomWidth,top:c.borderTopWidth,left:c.borderLeftWidth,right:c.borderRightWidth,bg:c.backgroundColor,barBorder:b.borderTopColor,lineColor:getComputedStyle(document.documentElement).getPropertyValue('--line').trim()}})()`);
      report.measures[`field-${t}`] = field;
      check(`focused search field has no ring or fill, only a line under it (${t})`, field.outline === 'none' && field.shadow === 'none' && /^solid (0\.\d+|1)px$/.test(field.underline) && field.top === '0px' && field.left === '0px' && field.right === '0px' && field.bg === 'rgba(0, 0, 0, 0)');
      check(`Ctrl+K still opens the command palette, not search (${t})`, true);

      // Whole word, any case: typed in mixed case.
      await type('ScRoLl'); await sleep(400);
      s = await state();
      report.measures[`typed-${t}`] = s;
      const m = /^(\d+) of (\d+)$/.exec(s.count || '');
      check(`count is the whole-word case-insensitive total, ${expected} (${t})`, m && Number(m[2]) === expected);
      check(`a new search always starts at 1 of ${expected} (${t})`, s.count === `1 of ${expected}`);
      check(`every highlight is exactly the word, ignoring case (${t})`, s.all > 0 && s.allWords.length === 1 && s.allWords[0] === 'scroll');
      check(`partial words (scroller, autoscroll, scrolled) are not highlighted (${t})`, s.allWords.every(w => w === 'scroll'));
      check(`one current match, shown in view (${t})`, s.current.length === 1 && s.currentInView === true);
      await capture(`search-${t}`);

      // Enter / Shift+Enter / the arrows step and wrap.
      const startIdx = Number(m && m[1]);
      await key('Return'); await sleep(350);
      const afterNext = await state();
      await key('Return', ['shift']); await sleep(350);
      const afterPrev = await state();
      check(`Enter goes to the next match, Shift+Enter back (${t})`, afterNext.count === `${startIdx % expected + 1} of ${expected}` && afterPrev.count === `${startIdx} of ${expected}`);
      await click('[aria-label="Next match"]'); await sleep(350);
      const afterDown = await state();
      check(`down arrow button steps forward (${t})`, afterDown.count === `${startIdx % expected + 1} of ${expected}`);

      // Up from the first match wraps to the last, then jump to the very first
      // match, far above (its row was never rendered), and show it.
      await run(`(()=>{const i=document.querySelector('[aria-label="Find in chat"]');i.focus();})()`);
      for (let i = 0; i < expected + 2; i++) { const c = await state(); if (c.count === `1 of ${expected}`) break; await key('Up'); await sleep(200); }
      const first = await state();
      report.measures[`first-${t}`] = first;
      check(`reaches the first match, near the top of the chat (${t})`, first.count === `1 of ${expected}` && first.current.length === 1 && first.currentInView === true);
      await capture(`first-match-${t}`);
      await click('[aria-label="Previous match"]'); await sleep(450);
      const wrapped = await state();
      check(`up from the first wraps to the last (${t})`, wrapped.count === `${expected} of ${expected}` && wrapped.currentInView === true);

      // A word that is not there.
      await run(`(()=>{const i=document.querySelector('[aria-label="Find in chat"]');i.select();})()`);
      await type('scrollbarzz'); await sleep(300);
      const none = await state();
      check(`no results shows "No results" and no highlight (${t})`, none.count === 'No results' && none.all === 0 && none.current.length === 0);
      await capture(`no-results-${t}`);

      // Esc closes and clears every highlight; the close button does the same.
      await key('Escape'); await sleep(250);
      const closed = await state();
      check(`Esc closes the bar and clears highlights (${t})`, !closed.open && closed.all === 0 && closed.current.length === 0);
      await click('[data-chat-search-toggle]'); await sleep(250);
      const reopened = await state();
      check(`the search icon opens the bar, empty and focused (${t})`, reopened.open && reopened.focused === 'Find in chat' && reopened.count === '');
      await type('scroll'); await sleep(300);
      await click('[aria-label="Close search"]'); await sleep(250);
      const xClosed = await state();
      check(`the close button closes the bar and clears highlights (${t})`, !xClosed.open && xClosed.all === 0);

      // Ctrl+K is unchanged.
      await key('K', ['control']); await sleep(250);
      const palette = await run('integration.paletteOpen()');
      report.checks.find(c => c.name === `Ctrl+K still opens the command palette, not search (${t})`).passed = palette === true && !(await state()).open;
      await key('Escape'); await sleep(200);
    }
    report.success = !report.errors.some(e => /focus/.test(e)) && (base || report.checks.every(c => c.passed));
  } catch (error) {
    report.errors.push(String(error && error.stack || error)); report.success = false;
  } finally {
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ dir, success: report.success, failed: report.checks.filter(c => !c.passed).map(c => c.name), passed: report.checks.filter(c => c.passed).length, total: report.checks.length, errors: [...new Set(report.errors)].slice(0, 6), measures: { expected: report.measures.expected, geometry: report.measures['geometry-dark'] } }, null, 2));
    win.destroy(); app.exit(report.success ? 0 : 1);
  }
});
