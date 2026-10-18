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
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); else if (process.env.NEKKO_WALL_EVIDENCE) console.log(e.message); });
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
  const reset = async () => {
    await run('window.integration.reset()');
    // Reset remounts cold ChatPanes. Hidden macOS rendering can finish loading
    // later than a fixed sleep; wait for the controls the next step needs.
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await run("!!document.querySelector('[data-wall-composer] .ctl-menu')")) return;
      await sleep(100);
    }
    throw Error('Reset did not finish mounting shared composer controls');
  };
  const open = async category => { await run("document.querySelector('[data-wall-add-button]').click()");await sleep(180); if (category) { await run(`[...document.querySelectorAll('.agent-window-picker__option')].find(b=>b.querySelector('strong')?.textContent===${JSON.stringify(category)}).click()`); await sleep(180); } };
  const image = async () => { await open('Media'); await run("[...document.querySelectorAll('.agent-window-picker button')].find(b=>b.textContent.includes('Create image session')).click()"); await sleep(200); };
  const capture = async name => { await sleep(350); fs.writeFileSync(path.join(runDir, name + '.png'), (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG()); report.captures.push(path.join(runDir, name + '.png')); };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    // macOS can move resized mapped windows back onto a display; keep this fixture hidden.
    if (!process.env.NEKKO_COMPOSER_ROW && !process.env.NEKKO_FOCUS_ADD && (process.platform !== 'darwin' || !process.env.NEKKO_GRID_BUGS)) win.showInactive();
    await sleep(900);
    await check('mounted full CommandCenterView', "(document.body.textContent.includes('Agents') || document.body.textContent.includes('Command Center')) && !!document.querySelector('[data-command-wall]')");
    const current = !process.env.NEKKO_TEST_REVISION;
    if (process.env.NEKKO_COMPOSER_EVIDENCE) {
      // The wall composer with a selected agent: the bar above it, its top
      // controls strip and its bottom bar, in both themes at two widths.
      const tag = current ? 'after' : 'before';
      await win.loadFile(path.join(out, 'index.html'), { search: 'multi' }); await sleep(900);
      for (const theme of ['dark', 'light']) for (const width of [1400, 760]) {
        win.setContentSize(width, 900);
        await reset();
        await run(`document.documentElement.dataset.theme='${theme}'`);
        await sleep(600);
        const facts = await run(`(() => {
          const c = document.querySelector('[data-wall-composer]');
          const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
          const card = c?.querySelector('.composer');
          const plus = c?.querySelector('[aria-label="Add a photo, file, folder, or skill"]');
          const mode = [...(c?.querySelectorAll('button') ?? [])].find((b) => b.textContent.includes('Mode'));
          const incog = [...(c?.querySelectorAll('button') ?? [])].find((b) => b.textContent.includes('Incognito'));
          const title = c?.querySelector('[data-composer-title]');
          const automate = c?.querySelector('[aria-label^="Automate"]');
          return {
            barAboveCard: !!(card && title && title.getBoundingClientRect().bottom <= card.getBoundingClientRect().top + 1),
            titleInsideCard: !!(card && title && card.contains(title)),
            automateInHeadRow: !!(title && automate && Math.abs(title.getBoundingClientRect().top - automate.getBoundingClientRect().top) < 12),
            modeBesidePlus: !!(plus && mode && Math.abs(plus.getBoundingClientRect().top - mode.getBoundingClientRect().top) < 14 && mode.getBoundingClientRect().left > plus.getBoundingClientRect().left),
            incognitoBesidePlus: !!(plus && incog && Math.abs(plus.getBoundingClientRect().top - incog.getBoundingClientRect().top) < 14),
            composer: r(c), card: r(card), plus: r(plus), mode: r(mode), incognito: r(incog),
          };
        })()`);
        report.checks.push({ name: `${tag} ${theme} ${width}`, facts });
        await capture(`composer-${tag}-${theme}-${width}`);
      }
      fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2));
      app.quit();
      return;
    }
    if (process.env.NEKKO_POLISH_EVIDENCE) {
      // Two chats on a Dynamic wall, the first one working; the Agents panel in
      // each orientation and collapsed; hover states on the grips and pills.
      const tag = current ? 'after' : 'before';
      await win.loadFile(path.join(out, 'index.html'), { search: 'multi' }); await sleep(900);
      const setPanel = (show, orientation) => run(`(() => { const st = integration.state(); const s = st.settings; const cw = { ...s.commandWall, layout: { ...s.commandWall.layout, mode: 'grid' }, agentPanel: { show: ${show}, orientation: '${orientation}' } }; window.__setWall?.(cw); })()`);
      const work = () => run("window.__work?.()");
      const facts = () => run(`(() => {
        const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
        const composer = document.querySelector('[data-wall-composer]');
        const wand = document.querySelector('.wall-auto-arrange > button');
        const filter = document.querySelector('[role="tablist"][aria-label="Show"]');
        return {
          titlebarPanelButtons: [...document.querySelectorAll('[data-wall-toolbar] button')].filter(b => /agent panel|agents in a/i.test(b.getAttribute('aria-label') || '')).length,
          panelControls: [...document.querySelectorAll('.agent-panel-pill')].map(b => b.getAttribute('aria-label')),
          stacked: !!document.querySelector('.agent-panel-controls[data-stacked]'),
          composer: r(composer), leftGrip: r(document.querySelector('.wall-composer-side[data-edge="left"]')), rightGrip: r(document.querySelector('.wall-composer-side[data-edge="right"]')),
          wand: r(wand), filter: r(filter), wandOverlapsFilter: !!(wand && filter && wand.getBoundingClientRect().right > filter.getBoundingClientRect().left + 0.5),
          workingBeams: document.querySelectorAll('.wall-window-beam').length,
          agentIcons: document.querySelectorAll('.command-wall-window .numbered-agent-icon').length,
          chatIcons: document.querySelectorAll('.command-wall-window .numbered-chat-icon').length,
        };
      })()`);
      for (const theme of ['dark', 'light']) for (const width of [1400, 760]) {
        win.setContentSize(width, 900);
        await run(`document.documentElement.dataset.theme='${theme}'`);
        for (const [show, orientation, label] of [[true, 'vertical', 'column'], [true, 'horizontal', 'row'], [false, 'vertical', 'collapsed']]) {
          await setPanel(show, orientation); await sleep(500); await work(); await sleep(700);
          report.checks.push({ name: `${tag} ${theme} ${width} ${label}`, facts: await facts() });
          await capture(`polish-${tag}-${theme}-${width}-${label}`);
        }
      }
      // Hover states (after only): a grip and an expanded pill, dark 1400.
      if (current) {
        win.setContentSize(1400, 900); await run("document.documentElement.dataset.theme='dark'");
        await setPanel(true, 'vertical'); await sleep(500); await work(); await sleep(500);
        const hover = async (selector, name) => {
          const p = await run(`(() => { const b = document.querySelector('${selector}').getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; })()`);
          win.webContents.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y }); await sleep(450); await capture(name);
        };
        await hover('.agent-panel-pill', 'polish-after-dark-1400-pill-hover');
        await hover('.wall-composer-side[data-edge="right"]', 'polish-after-dark-1400-grip-hover');
        // Orientation switch frames for the motion check.
        win.webContents.sendInputEvent({ type: 'mouseMove', x: 5, y: 5 });
        await run("document.querySelectorAll('.agent-panel-pill')[1].click()");
        for (let i = 0; i < 6; i++) { await capture(`polish-after-dark-1400-switch-${i}`.replace('capture', '')); }
      }
      fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2));
      app.quit();
      return;
    }
    if (process.env.NEKKO_QUOTA_EVIDENCE) {
      // Signed-out ChatGPT subscription, its saved model gone, Utilization open,
      // replies with persisted stats. Same synthetic data before and after.
      const tag = current ? 'after' : 'before';
      await win.loadFile(path.join(out, 'index.html'), { search: 'quota' });
      for (const theme of ['dark', 'light']) for (const width of [1400, 700]) {
        win.setContentSize(width, 900);
        await reset().catch(() => sleep(900));
        await run(`document.documentElement.dataset.theme='${theme}'`);
        // Select the first wall window, as a click would.
        await run("document.querySelector('.command-wall-window')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))");
        await run("document.querySelector('.command-wall-window [data-chat-surface]')?.click()");
        await sleep(900);
        const facts = await run(`(() => {
          const text = (el) => el ? el.textContent.replace(/\\s+/g, ' ').trim() : null;
          const wins = [...document.querySelectorAll('.command-wall-window')];
          return {
            utilization: text(document.querySelector('.monitors-dock__utilization')),
            limitsProblem: document.querySelector('[data-limits-problem]')?.getAttribute('data-limits-problem') ?? null,
            tooltips: document.querySelectorAll('[role="tooltip"]').length,
            unavailableChips: document.querySelectorAll('[data-model-unavailable]').length,
            notesPerWindow: wins.map((w) => w.querySelectorAll('[data-model-note]').length),
            selectedWindow: wins.findIndex((w) => w.hasAttribute('data-wall-selected')),
            turnStats: [...document.querySelectorAll('[data-turn-stats]')].map(text),
            replyStatsLabel: document.body.textContent.includes('Reply stats'),
          };
        })()`);
        report.checks.push({ name: `${tag} ${theme} ${width}`, facts });
        await capture(`quota-${tag}-${theme}-${width}`);
      }
      fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2));
      app.quit();
      return;
    }
    if (process.env.NEKKO_THEME_EVIDENCE) {
      // Tinted presets on the wall with the plan panel open. Accents are the
      // values a user who picked each preset before the retune has saved.
      const tag = current ? 'after' : 'before';
      const saved = { nebula: ['#a78bfa', '#f472b6'], terminal: ['#22c55e', '#84cc16'], nord: ['#88c0d0', '#81a1c1'], dark: ['#8b7dff', '#22d3ee'] };
      for (const [preset, [accent, accent2]] of Object.entries(saved)) for (const width of [1400, 600]) {
        win.setContentSize(width, 900);
        await run(`(() => { const r = integration.records()[0]; r.agentPlan = [
          { id: 'a', title: 'Validate paired warm profiles, routes, and gate results', status: 'done', note: 'Paired quick diagnostics are separate.' },
          { id: 'b', title: 'Compare warm CPU stacks and trace layout work', status: 'active', note: 'Matched caller stacks and renderer trace events.' },
          { id: 'c', title: 'Map remaining hotspots to current source', status: 'pending' } ];
          sessionStorage.setItem('fixture-record', JSON.stringify(r)); })()`);
        await reset();
        await run(`integration.theme(${JSON.stringify({ theme: 'dark', themePreset: preset, accent, accent2 })})`);
        await run("document.querySelector('.command-wall-window')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))");
        await sleep(500);
        const surfaces = await run(`(() => { const bg = el => el ? getComputedStyle(el).backgroundColor : null;
          const rail = document.querySelector('[aria-label="Plan and sub-agents"]');
          return { window: bg(document.querySelector('.command-wall-window > .panel')), composer: bg(document.querySelector('[data-wall-composer]')),
            composerCard: bg(document.querySelector('[data-wall-composer] .composer')), rail: bg(rail), accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() }; })()`);
        // Whatever paints just below the composer card: it must be the wall field, not a band.
        surfaces.belowCard = await run(`(() => { const c = document.querySelector('[data-wall-composer] .composer'); if (!c) return null; const r = c.getBoundingClientRect();
          const out = []; for (let el = document.elementFromPoint(r.left + r.width / 2, r.bottom + 4); el; el = el.parentElement) { const bg = getComputedStyle(el).backgroundColor; if (bg !== 'rgba(0, 0, 0, 0)') { out.push((el.className || el.tagName).toString().slice(0, 90) + ' ' + bg + ' h=' + Math.round(el.getBoundingClientRect().height)); break; } }
          return out; })()`);
        report.checks.push({ name: `${tag} ${preset} ${width} surfaces`, surfaces });
        await capture(`theme-${tag}-${preset}-${width}`);
      }
      fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2));
      app.quit();
      return;
    }
    if (process.env.NEKKO_VIEW_CONTROLS) {
      await win.loadFile(path.join(out, 'index.html'), { search: 'multi' }); await sleep(900);
      for (const theme of ['light', 'dark']) for (const width of [1200, 400]) {
        win.setContentSize(width, 900); await reset();
        await run(`document.documentElement.dataset.theme='${theme}'`);
        await capture(`controls-${theme}-${width}-dynamic`);
        await click('Focused');
        await run("document.querySelector('.command-wall-window:not(.command-wall-deck-window) [contenteditable]')?.focus()");
        await capture(`controls-${theme}-${width}-focus`);
        await run("document.querySelector('[aria-label=\"Show agents in a row\"]')?.click()");
        await capture(`controls-${theme}-${width}-row`);
        if (process.env.NEKKO_VIEW_AFTER) {
          await check('horizontal orientation control remains visible', "(()=>{const e=document.querySelector('[aria-label=\"Show agents in a column\"]');return !!e && e.getBoundingClientRect().width>0})()");
          await check('focus chat has no glow', "getComputedStyle(document.querySelector('.command-wall-window[data-wall-selected] > .panel')).boxShadow==='none'");
          await check('focus composer has no glow', "getComputedStyle(document.querySelector('.command-wall-window:not(.command-wall-deck-window) .composer')).boxShadow==='none'");
          await check('magic is hidden outside Dynamic', "getComputedStyle(document.querySelector('.wall-auto-arrange')).visibility==='hidden' && document.querySelector('[aria-label=\"Auto-arrange\"]').disabled");
          await click('Dynamic');
          await check('magic is available in Dynamic', "getComputedStyle(document.querySelector('.wall-auto-arrange')).visibility==='visible' && !document.querySelector('[aria-label=\"Auto-arrange\"]').disabled");
        }
      }
      if (process.env.NEKKO_VIEW_AFTER) {
        win.setContentSize(1200, 900); await reset(); await click('Focused');
        const frames = path.join(runDir, 'motion'); fs.mkdirSync(frames);
        for (let i = 0; i < 40; i++) {
          if (i === 5 || i === 23) await run("[...document.querySelectorAll('.wall-layout-segments button')].find(b=>b.textContent==='Dynamic').click()");
          if (i === 15 || i === 33) await run("[...document.querySelectorAll('.wall-layout-segments button')].find(b=>b.textContent==='Focused').click()");
          fs.writeFileSync(path.join(frames, String(i).padStart(3, '0') + '.png'), (await win.capturePage(undefined, { stayHidden: true })).toPNG()); await sleep(60);
        }
        await click('Dynamic');
        await run("document.querySelector('[aria-label=\"Auto-arrange\"]').focus()");
        await check('tooltip appears on keyboard focus', "getComputedStyle(document.querySelector('#wall-auto-arrange-tip')).visibility==='visible'");
        await capture('controls-tooltip');
      }
      if (process.env.NEKKO_VIEW_AFTER && process.env.NEKKO_VIEW_CHROME) {
        await check('wide desktop controls use titlebar', "!!document.querySelector('#command-titlebar-slot [data-wall-toolbar]')");
        win.setContentSize(400, 900); await sleep(350);
        await check('narrow desktop controls leave titlebar', "!document.querySelector('#command-titlebar-slot [data-wall-toolbar]') && !!document.querySelector('[data-wall-toolbar]')");
        await check('narrow layout buttons stay inside viewport', "[...document.querySelectorAll('.wall-layout-segments button')].every(b=>b.getBoundingClientRect().right<=innerWidth)");
      }
      report.success = true;
      return;
    }
    if (process.env.NEKKO_COMPOSER_ROW) {
      const fixed = !process.env.NEKKO_TEST_REVISION;
      for (const theme of ['light','dark']) for (const width of [1400,400]) {
        win.setContentSize(width,900);await reset();await run(`document.documentElement.dataset.theme='${theme}'`);await sleep(400);
        await capture(`composer-${theme}-${width}-rest`);
        if(fixed) await check('Add lives in the toolbar '+width,"!!document.querySelector('[data-wall-toolbar] .wall-add-bar [data-wall-add-button]') && !document.querySelector('[data-wall-composer-row] [data-wall-add-button], .wall-composer-row [data-wall-add-button]')");
        for(let i=0;i<4;i++) {
          await run("integration.route('chat')");await sleep(200);
          await run("integration.route('command')");await sleep(300);
          const connected=await run("(()=>{const t=document.querySelector('[data-wall-toolbar]');return !!t && t.isConnected && (innerWidth<1100 || !!document.querySelector('#command-titlebar-slot [data-wall-toolbar]'))})()");
          report.checks.push({name:'toolbar after navigation '+width+' '+i,passed:connected});
          if(fixed&&!connected)throw Error('Toolbar disappeared');
        }
        if(width===1400) {
          await run("(()=>{const slot=document.getElementById('command-titlebar-slot');const replacement=slot.cloneNode(false);slot.replaceWith(replacement)})()");await sleep(300);
          const recovered=await run("!!document.querySelector('#command-titlebar-slot [data-wall-toolbar]')");
          report.checks.push({name:'replaced portal host recovery',passed:recovered});
          if(fixed&&!recovered)throw Error('Detached titlebar toolbar');
        }
        await capture(`composer-${theme}-${width}-returned`);
        await run("(()=>{const s=document.querySelector('.wall-composer-side[data-edge=right]');s.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))})()");await sleep(200);
        if(fixed)await check('resized composer leaves Add in the toolbar',"!!document.querySelector('[data-wall-toolbar] .wall-add-bar [data-wall-add-button]') && !document.querySelector('[data-wall-composer-row] [data-wall-add-button], .wall-composer-row [data-wall-add-button]')");
        await run("document.querySelector('[data-wall-add-button]').click()");await sleep(180);await check('same-row Add opens picker',"!!document.querySelector('.agent-window-picker')");
        await run("document.querySelector('.agent-window-picker').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");await sleep(200);
        await run("document.querySelector('[data-wall-composer] .wall-composer-side').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}))");
        for (const nextWidth of [1000,1200,width]) {win.setContentSize(nextWidth,900);await sleep(250);if(fixed)await check('toolbar follows viewport '+nextWidth,"(()=>{const t=document.querySelector('[data-wall-toolbar]');return !!t && (innerWidth<1100 ? !t.closest('#command-titlebar-slot') : !!t.closest('#command-titlebar-slot'))})()");}

      }
      win.setContentSize(1400,900);await reset();await run("integration.dock('top')");await sleep(400);
      if(fixed)await check('top dock leaves Add in the toolbar',"!!document.querySelector('[data-wall-toolbar] .wall-add-bar [data-wall-add-button]') && !document.querySelector('[data-wall-composer-row] [data-wall-add-button], .wall-composer-row [data-wall-add-button]')");
      await reset();await sleep(400);
      const frames=path.join(runDir,'motion');fs.mkdirSync(frames);
      for(let i=0;i<24;i++){if(i===4)await run("integration.route('chat')");if(i===12)await run("integration.route('command')");fs.writeFileSync(path.join(frames,String(i).padStart(3,'0')+'.png'),(await win.capturePage(undefined,{stayHidden:true})).toPNG());await sleep(80);}
      report.success=true;return;
    }
    if (process.env.NEKKO_FOCUS_ADD) {
      const fixed = !process.env.NEKKO_TEST_REVISION;
      const mode = () => run("document.querySelector('[data-command-wall]').dataset.wallLayout");
      for (const theme of ['light', 'dark']) for (const width of [1200, 400]) {
        win.setContentSize(width, 900); await reset();
        await run(`document.documentElement.dataset.theme='${theme}'`);
        await click('Focused'); await sleep(400);
        await capture(`focus-${theme}-${width}-rest`);
        if (fixed) await check('heading precedes version', "(()=>{const h=document.querySelector('.titlebar h1'),v=document.querySelector('.titlebar .update-version');return !!h && !!v && !!(h.compareDocumentPosition(v)&Node.DOCUMENT_POSITION_FOLLOWING)})()");
        await run("document.querySelector('.command-wall-window:not([aria-hidden=true]) button[aria-label=\"Add a window beside this one\"]').dispatchEvent(new MouseEvent('mouseover',{bubbles:true}))");
        await sleep(200);
        if (await mode() !== 'focus') throw Error('Hover left Focus');
        await run("document.querySelector('.command-wall-window:not([aria-hidden=true]) button[aria-label=\"Add a window beside this one\"]').click()"); await sleep(500);
        if (await mode() !== (fixed ? 'grid' : 'focus')) throw Error('Wrong compass mode');
        if (fixed) await check('compass directions enabled', "[...document.querySelectorAll('[role=dialog][aria-label=\"Add a window\"] button[aria-disabled]')].every(b=>b.getAttribute('aria-disabled')==='false')");
        await capture(`focus-${theme}-${width}-compass`);
        await run("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
        await click('Focused'); await sleep(300); await run("document.querySelector('[data-wall-add-button]').click()");await sleep(180); await sleep(500);
        if (await mode() !== (fixed ? 'grid' : 'focus')) throw Error('Wrong toolbar mode');
        await check('picker opens', "!!document.querySelector('.agent-window-picker')");
        await capture(`focus-${theme}-${width}-picker`);
        report.checks.push(`Focus add routes ${theme} ${width}`);
      }
      win.setContentSize(1200,900); await reset(); await click('Focused'); await sleep(400);
      const frames=path.join(runDir,'motion');fs.mkdirSync(frames);
      for(let i=0;i<30;i++) {
        if(i===5)await run("document.querySelector('.command-wall-window:not([aria-hidden=true]) button[aria-label=\"Add a window beside this one\"]').click()");
        fs.writeFileSync(path.join(frames,String(i).padStart(3,'0')+'.png'),(await win.capturePage(undefined,{stayHidden:true})).toPNG());await sleep(70);
      }
      report.success=true;
      if(process.env.NEKKO_EVIDENCE_HOLD){fs.writeFileSync(path.join(runDir,'gallery.html'),'<html><body style="margin:0;background:#888;display:grid;grid-template-columns:repeat(4,1fr)">'+report.captures.map(p=>'<div><small>'+path.basename(p)+'</small><img style="width:100%" src="'+path.basename(p)+'"></div>').join('')+'</body></html>');await win.loadFile(path.join(runDir,'gallery.html'));win.setContentSize(1600,1500);console.log('EVIDENCE_GALLERY '+runDir);await sleep(90000);}
      return;
    }
    if (process.env.NEKKO_LAYOUT_FIXES) {
      await win.loadFile(path.join(out, 'index.html'), {search:'multi'}); await sleep(900);
      const fixed = !process.env.NEKKO_TEST_REVISION;
      for (const theme of ['light','dark']) for (const width of [1200,400]) {
        win.setContentSize(width,900); await reset(); await run(`document.documentElement.dataset.theme='${theme}'`); await sleep(500);
        await capture(`layout-${theme}-${width}-rest`);
        if (fixed) {
          await check('no counts subtitle', "!document.body.textContent.includes('on the wall')");
          await check('Agents shares brand row', "!!document.querySelector('.titlebar h1') && !document.querySelector('[data-command-wall]').closest('main').querySelector('h1:not(.titlebar h1)')");
          await check('handle follows composer width', "(()=>{const c=document.querySelector('[data-wall-composer]').getBoundingClientRect(),s=document.querySelector('.wall-composer-split').getBoundingClientRect();return Math.abs(c.width-s.width)<3 && Math.abs(c.top-s.bottom)<5})()");
          for (const edge of ['left','right']) {
            const before=await run("document.querySelector('[data-wall-composer]').offsetWidth");
            await run(`document.querySelector('.wall-composer-side[data-edge="${edge}"]').dispatchEvent(new KeyboardEvent('keydown',{key:'${edge==='left'?'ArrowRight':'ArrowLeft'}',bubbles:true}))`);
            await check('side keyboard shrinks '+edge, `document.querySelector('[data-wall-composer]').offsetWidth < ${before}`);
            await run(`document.querySelector('.wall-composer-side[data-edge="${edge}"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}))`);
          }
          const pointerWidth = await run("document.querySelector('[data-wall-composer]').offsetWidth");
          const c=await run("(()=>{const r=document.querySelector('.wall-composer-side[data-edge=right]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
          await win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(c.x),y:Math.round(c.y)});
          await win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:Math.round(c.x),y:Math.round(c.y)});
          await win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(c.x-45),y:Math.round(c.y)});
          await win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:Math.round(c.x-45),y:Math.round(c.y)}); await sleep(350);
          await check('pointer side drag shrinks composer', `document.querySelector('[data-wall-composer]').offsetWidth < ${pointerWidth}`);
          await capture(`layout-${theme}-${width}-resized`);
          await run("document.querySelector('.wall-composer-side').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}))");
          const states=[];for(let i=0;i<40;i++){states.push(await run("(()=>{const e=document.querySelector('[data-command-wall]');return [e.clientWidth,e.clientHeight,e.scrollWidth,e.scrollHeight].join(',')})()"));await sleep(30);}
          if(new Set(states.slice(10)).size!==1)throw Error('Scrollbar geometry failed to settle: '+states);report.checks.push('stable scrollbar frames '+theme+' '+width);
        }
        await run("(document.querySelector('[data-wall-add-button]')||[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Add window')).click()"); await sleep(450); await capture(`layout-${theme}-${width}-clicked`);
      }
      win.setContentSize(1200,900);await reset();await run("document.documentElement.dataset.theme='dark'");await sleep(500);
      const frames=path.join(runDir,'motion');fs.mkdirSync(frames);
      for(let i=0;i<35;i++) { if(fixed&&i>=5&&i<20)await run("document.querySelector('.wall-composer-side[data-edge=right]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}))");if(i===23)await run("(document.querySelector('[data-wall-add-button]')||[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Add window')).click()");fs.writeFileSync(path.join(frames,String(i).padStart(3,'0')+'.png'),(await win.capturePage(undefined,{stayHidden:true})).toPNG());await sleep(65); }
      report.success=true;
      if(process.env.NEKKO_EVIDENCE_HOLD){fs.writeFileSync(path.join(runDir,'gallery.html'),'<html><body style="margin:0;background:#888;display:grid;grid-template-columns:repeat(4,1fr)">'+report.captures.map(p=>'<div><small>'+path.basename(p)+'</small><img style="width:100%" src="'+path.basename(p)+'"></div>').join('')+'</body></html>');await win.loadFile(path.join(runDir,'gallery.html'));win.setContentSize(1600,1500);console.log('EVIDENCE_GALLERY '+runDir);await sleep(90000);}
      return;
    }
    if (process.env.NEKKO_CHROME_FIXES) {
      await win.loadFile(path.join(out, 'index.html'), { search: 'multi' }); await sleep(900);
      const fixed = !process.env.NEKKO_TEST_REVISION;
      for (const theme of ['light', 'dark']) for (const width of [1200, 400]) {
        win.setContentSize(width, 900); await reset();
        await run(`document.documentElement.dataset.theme='${theme}'`); await sleep(500);
        await capture(`chrome-${theme}-${width}-rest`);
        const rects = "JSON.stringify([...document.querySelectorAll('.command-wall-window')].map(e=>{const r=e.getBoundingClientRect();return [r.x,r.y,r.width,r.height]}))";
        const before = await run(rects);
        await run("document.querySelector('.command-wall-add-rail-right')?.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}))"); await sleep(400);
        const after = await run(rects);
        if (fixed && before !== after) throw Error('Hover changed wall geometry');
        report.checks.push({ name: `hover keeps geometry ${theme} ${width}`, passed: before === after });
        await capture(`chrome-${theme}-${width}-hover`);
        await run("(document.querySelector('[data-wall-add-button]')||[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Add window')).click()"); await sleep(400);
        await check('click opens insertion card', "!!document.querySelector('.command-wall-add-tile .agent-window-picker')");
        await capture(`chrome-${theme}-${width}-clicked`);
        await reset(); await run(`document.documentElement.dataset.theme='${theme}'`); await sleep(300);
        if (fixed) {
          await check('composer wrapper is transparent', "getComputedStyle(document.querySelector('[data-wall-composer]')).backgroundColor==='rgba(0, 0, 0, 0)'");
          await check('composer wrapper has no shadow', "getComputedStyle(document.querySelector('[data-wall-composer]')).boxShadow==='none'");
          await check('send cat has right inset', "parseFloat(getComputedStyle(document.querySelector('.send-avatar')).marginRight)>=4");
        }
      }
      win.setContentSize(1200, 900); await reset(); await sleep(400);
      const frames = path.join(runDir, 'motion'); fs.mkdirSync(frames);
      await run("document.querySelector('.command-wall-add-rail-right')?.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}))");
      for (let i=0; i<25; i++) {
        if (i===10) await run("(document.querySelector('[data-wall-add-button]')||[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Add window')).click()");
        fs.writeFileSync(path.join(frames, `${String(i).padStart(3,'0')}.png`), (await win.capturePage(undefined, {stayHidden:true})).toPNG()); await sleep(60);
      }
      report.success = true;
      if (process.env.NEKKO_EVIDENCE_HOLD) {
        fs.writeFileSync(path.join(runDir, 'gallery.html'), '<html><body style="margin:0;background:#888;display:grid;grid-template-columns:repeat(3,1fr)">'+report.captures.map(p=>'<div><small>'+path.basename(p)+'</small><img style="width:100%" src="'+path.basename(p)+'"></div>').join('')+'</body></html>');
        await win.loadFile(path.join(runDir, 'gallery.html')); win.setContentSize(1500, 1300); console.log('EVIDENCE_GALLERY '+runDir); await sleep(90000);
      }
      return;
    }
    if (process.env.NEKKO_GRID_BUGS) {
      const clearEditor = async () => {
        await run("(()=>{const e=document.querySelector('.composer [contenteditable]');if(e){e.textContent='';e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContentBackward'}))}})()");
        await sleep(100);
      };
      const assertFixed = !process.env.NEKKO_TEST_REVISION;
      const hit = async target => {
        const commands = {
          grid: ["integration.pointerTarget('grid',true)","integration.pointerTarget('grid',false)"],
          mode: ["integration.pointerTarget('mode',true)","integration.pointerTarget('mode',false)"],
          ask: ["integration.pointerTarget('ask',true)","integration.pointerTarget('ask',false)"],
          item: ["integration.pointerTarget('item',true)","integration.pointerTarget('item',false)"],
        };
        const command=commands[target];if(!command)throw Error('Unknown pointer target');
        await run(command[0]); await sleep(100);
        const point=await run(command[1]);
        if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3');
        await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {type:'mousePressed',button:'left',clickCount:1,...point});
        await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {type:'mouseReleased',button:'left',clickCount:1,...point});
        await sleep(180);
      };
      for (const theme of ['light','dark']) for (const [width,label] of [[1200,'desktop'],[400,'narrow']]) {
        win.setContentSize(width,900);
        await clearEditor(); await run('integration.blank()'); await sleep(600);
        await run(`document.documentElement.dataset.theme='${theme}'`);
        await run("document.querySelector('.command-wall-window button[aria-haspopup=listbox]').click()"); await sleep(300);
        await run("[...document.querySelectorAll('[role=listbox] button')].find(b=>b.textContent.includes('Fast fixture')).click()"); await sleep(450);
        await capture(`grid-model-${theme}-${label}`);
        await run("(()=>{const e=document.querySelector('[data-wall-composer] [contenteditable]');e.textContent='Hello';e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'Hello'}))})()");
        await run("document.querySelector('[data-wall-composer] button[title^=Send]').click()"); await sleep(200);
        const sent = await run("integration.calls.some(c=>c.method==='send'&&c.options.sessionId==='existing'&&c.options.providerId==='fixture'&&c.options.modelId==='fixture-fast')");
        report.checks.push({name: 'Grid model choice reaches send '+theme+' '+label, passed:sent});
        if(assertFixed && !sent) throw Error('Grid composer did not receive selected model');
        await run("sessionStorage.removeItem('fixture-record')"); await clearEditor(); await reset();
        await run(`document.documentElement.dataset.theme='${theme}'`);
        await hit('grid');
        // Mode now sits in the composer's bottom bar. In macOS's hidden CI
        // window a synthetic press that low does not always reach the page
        // (Windows does). The button must still be the thing under that point,
        // so nothing covers it; only then is it opened directly, and the menu
        // clipping check below stays strict either way.
        if (!(await run("!!document.querySelector('[data-mode-panel] [data-chat-mode]')"))) {
          const exposed = await run(`(() => { const b = document.querySelector('[data-wall-composer] [data-chat-mode-button]'); if (!b) return false; const r = b.getBoundingClientRect(); return b.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)); })()`);
          report.checks.push({ name: 'Grid mode button is uncovered ' + theme + ' ' + label, passed: exposed, note: 'synthetic press did not open the menu; opened by DOM click' });
          if (assertFixed && !exposed) throw Error('Grid mode button covered');
          await run(`document.querySelector('[data-wall-composer] [data-chat-mode-button]').click()`); await sleep(180);
        }
        await capture(`grid-mode-${theme}-${label}`);
        const reachable = await run("(()=>{const e=document.querySelector('[data-mode-panel] [data-chat-mode]');if(!e)return false;e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))})()");
        report.checks.push({name:'Grid guardrails menu receives pointer '+theme+' '+label,passed:reachable});
        if(assertFixed && !reachable) throw Error('Grid mode menu clipped');
        if(reachable) {
          await hit('item');
          await check('mode saves owning session',"integration.calls.some(c=>c.method==='options'&&c.id==='existing'&&c.options.mode==='ask')");
          if(assertFixed) await check('mode selection keeps focus in the panel',"!!document.activeElement?.closest('[data-mode-panel]')");
        }
        await run("sessionStorage.removeItem('fixture-record')"); await clearEditor(); await reset(); if(width<720)win.setContentSize(width,1400); await click('Focused');
        await run("document.querySelector('.composer-summary-chip')?.click()");
        if(width<720) {
          await run("document.querySelector('[data-chat-mode-button]').focus()");
          await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32});
          await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});
          await sleep(180);
        } else await hit('mode');
        await capture(`focus-mode-${theme}-${label}`);
        if(assertFixed) {
          await hit('item');
          await check('Focus mode still saves',"integration.calls.some(c=>c.method==='options'&&c.id==='existing'&&c.options.mode==='ask')");
          await run("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
          await check('Escape dismisses mode panel',"!document.querySelector('[data-mode-panel]')");
        }
      }
      for (const kind of ['anthropic','llamacpp']) {
        await clearEditor(); await run('integration.blank()'); await sleep(500);
        await run(`integration.providerKind('${kind}')`); await sleep(200);
        await run("document.querySelector('.command-wall-window button[aria-haspopup=listbox]').click()"); await sleep(300);
        await run("[...document.querySelectorAll('[role=listbox] button')].find(b=>b.textContent.includes('Fast fixture')).click()"); await sleep(350);
        await run("(()=>{const e=document.querySelector('[data-wall-composer] [contenteditable]');e.textContent='Hello';e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'Hello'}))})()");
        await run("document.querySelector('[data-wall-composer] button[title=Send]').click()"); await sleep(200);
        const sent=await run("integration.calls.some(c=>c.method==='send'&&c.options.sessionId==='existing'&&c.options.modelId==='fixture-fast')");
        report.checks.push({name:'fresh Grid '+kind+' sends selected model',passed:sent});
        if(assertFixed&&!sent)throw Error(kind+' model was not sent');
      }
      report.background={hidden:!win.isVisible(),focused:win.isFocused(),offscreen:win.getBounds().x+win.getBounds().width<=Math.min(...screen.getAllDisplays().map(d=>d.bounds.x))};
      if(report.background.focused || (!report.background.hidden && !report.background.offscreen)) throw Error('Background invariant failed');
      report.success=true; return;
    }
    if (process.env.NEKKO_WALL_REALTIME) {
      await sleep(500);
      const motion = path.join(runDir, 'realtime'); fs.mkdirSync(motion);
      await run("document.querySelector('.command-wall-add-rail-right')?.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}))");
      for (let frame=0; frame<20; frame++) {
        fs.writeFileSync(path.join(motion, `${String(frame).padStart(3,'0')}.png`), (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG());
        await sleep(50);
      }
      await check('real-time hover transition finishes', "(()=>{const a=document.querySelector('.command-wall-add[data-preview]');if(!a)return false;const r=a.getBoundingClientRect();return r.height>100&&[...document.querySelectorAll('.command-wall-window')].every(p=>{const s=p.getBoundingClientRect();return Math.min(r.right,s.right)-Math.max(r.left,s.left)<=1||Math.min(r.bottom,s.bottom)-Math.max(r.top,s.top)<=1})})()");
      await capture('sweep-realtime-hover');
      await run("document.querySelector('.command-wall-add-zone').dispatchEvent(new MouseEvent('mouseout',{bubbles:true,relatedTarget:document.body}))");
      await sleep(500);
      await check('real-time pointer exit removes preview', "!document.querySelector('.command-wall-add[data-preview]')");
      const encoded=require('node:child_process').spawnSync('ffmpeg',['-y','-framerate','10','-i',path.join(motion,'%03d.png'),'-vf','pad=ceil(iw/2)*2:ceil(ih/2)*2','-c:v','libx264','-pix_fmt','yuv420p',path.join(runDir,'sweep-realtime-hover.mp4')],{encoding:'utf8',windowsHide:true});
      if(encoded.status!==0) throw Error(encoded.stderr);
      report.captures.push(path.join(runDir,'sweep-realtime-hover.mp4'));
      if(process.env.NEKKO_REALTIME_ONLY) { report.background={visible:win.isVisible(),focused:win.isFocused()}; report.success=win.getBounds().x + win.getBounds().width <= Math.min(...screen.getAllDisplays().map(d => d.bounds.x)) && !win.isFocused() && !report.errors.length; return; }
    }
    if (current && process.env.NEKKO_WALL_EVIDENCE) {
      await run("integration.state().view='command'; document.querySelector('[data-wall-composer] [aria-label=\"Show selected chat in Focus\"]').click()");
      await check('composer Focus selects hero', "document.querySelector('[data-wall-layout]').dataset.wallLayout==='focus'");
      await run("window.dispatchEvent(new KeyboardEvent('keydown',{key:'@',code:'Digit2',ctrlKey:true,shiftKey:true,bubbles:true}))");
      await check('Grid keyboard shortcut', "document.querySelector('[data-wall-layout]').dataset.wallLayout==='grid'");
      await run("window.dispatchEvent(new KeyboardEvent('keydown',{key:'#',code:'Digit3',ctrlKey:true,shiftKey:true,bubbles:true}))");
      await check('Fixed keyboard shortcut', "document.querySelector('[data-wall-layout]').dataset.wallLayout==='fixed'");
      await reset();
    }
    if (process.env.NEKKO_WALL_EVIDENCE) {
      await run("integration.state().view='command'");
      for (const theme of ['light', 'dark']) {
        for (const [width, label] of [[1200, 'desktop'], [400, 'narrow']]) {
          win.setContentSize(width, 900); await reset();
          await run(`document.documentElement.dataset.theme='${theme}'`);
          await capture(`wall-idle-${theme}-${label}`);
          if (current) {
            await check('editor stays inside composer frame', "(()=>{const p=document.querySelector('[data-wall-composer]').getBoundingClientRect(), e=document.querySelector('[data-wall-composer] [contenteditable]').getBoundingClientRect();return e.top>=p.top&&e.bottom<=p.bottom+1})()");
            await run("document.querySelector('.command-wall-add-rail-right')?.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}))");
            await sleep(400);
            // Off-screen Windows compositor can defer CSS transitions. Settle
            // finite transitions for endpoint assertions; motion captures below
            // explicitly sample the timeline rather than treating timeouts as proof.
            await run("document.getAnimations().filter(a=>a instanceof CSSTransition).forEach(a=>a.finish())");
            await check('edge hover opens non-overlapping preview', "(()=>{const a=document.querySelector('.command-wall-add[data-preview]');if(!a||a.hasAttribute('data-solid'))return false;const r=a.getBoundingClientRect();return [...document.querySelectorAll('.command-wall-window')].every(p=>{const s=p.getBoundingClientRect();return Math.min(r.right,s.right)-Math.max(r.left,s.left)<=1||Math.min(r.bottom,s.bottom)-Math.max(r.top,s.top)<=1})})()");
            if (width < 720) await run("document.querySelector('.command-wall-add').scrollIntoView({block:'nearest'})");
            await capture(`wall-liquid-${theme}-${label}`);
            await run("document.querySelector('.command-wall-add-zone').dispatchEvent(new MouseEvent('mouseout',{bubbles:true,relatedTarget:document.body}))");
            await sleep(100);
            await check('pointer exit restores compact strips', "!document.querySelector('.command-wall-add[data-preview]')");
            await run("document.querySelector('.command-wall-add-rail-right')?.focus(); document.querySelector('.command-wall-add-rail-right')?.dispatchEvent(new FocusEvent('focusin',{bubbles:true}))"); await sleep(100);
            await check('keyboard focus previews Add', "!!document.querySelector('.command-wall-add[data-preview]')");
            await run("document.querySelector('.command-wall-add-fill').click()");
            await check('click solidifies add slot', "!!document.querySelector('.command-wall-add[data-solid] #wall-window-picker')");
            await run("document.getAnimations().filter(a=>a instanceof CSSTransition).forEach(a=>a.finish())");
            await capture(`wall-solid-${theme}-${label}`);
            await run("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
          }
          // Grid has no toolbar button since #741; Ctrl+Shift+3 selects it.
          await run("document.dispatchEvent(new KeyboardEvent('keydown',{code:'Digit3',key:'#',ctrlKey:true,shiftKey:true,bubbles:true}))"); await capture(`wall-fixed-hint-${theme}-${label}`);
          await run("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
        }
      }
      if (process.env.NEKKO_WALL_HOLD) {
        win.setContentSize(1200,900); await reset(); await run("document.documentElement.dataset.theme='dark'");
        console.log('Evidence sandbox ready for native capture');
        await new Promise(resolve => setTimeout(resolve, 110000));
      }
    }
    await check('cold session model hydrates', "document.querySelector('.command-wall-window').textContent.includes('Fixture model')");
    await run("document.querySelector('.command-wall-window button[aria-haspopup=listbox]').click()"); await sleep(500);
    await run("[...document.querySelectorAll('[role=listbox] button')].find(b=>b.textContent.includes('Auto')).click()"); await sleep(500);
    await check('Auto saved to bridge', "JSON.parse(sessionStorage.getItem('fixture-record')).autoModel===true");
    if (current) {
      await check('model change explains next-request context', "!!document.querySelector('[role=dialog]') && document.body.textContent.includes('open a new chat')");
      await capture('model-context-notice');
      await run("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true}))");
      await check('context notice traps keyboard focus', "document.querySelector('[role=dialog]').contains(document.activeElement)");
      await run("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
      await check('context notice dismisses with Escape', "!document.querySelector('[role=dialog]')");
      await check('context notice returns focus to model control', "document.activeElement===document.querySelector('.command-wall-window button[aria-haspopup=listbox]')");
    }
    await win.reload(); await sleep(1400);
    await check('Auto restores after cold reload', "document.querySelector('.command-wall-window').textContent.includes('Auto')");
    if (current) {
      await check('no model picker in shared composer', "!document.querySelector('[data-wall-composer] [role=listbox]') && !document.querySelector('[data-wall-composer]').textContent.includes('No model') && !document.querySelector('[data-wall-composer]').textContent.includes('Auto �')");
      await run('integration.ask()'); await sleep(500);
      await check('pending question has no interruption notice', "!document.querySelector('.command-wall-window [role=alert]')?.textContent.includes('Reply interrupted')");
      await check('question belongs to agent window', "!!document.querySelector('.command-wall-window .composer-question') && !document.querySelector('[data-wall-composer] .composer-question')");
      await run("document.querySelector('.command-wall-window .composer-question [role=group]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))"); await sleep(500);
      await check('question answer targets owning session', "integration.calls.some(c=>c.method==='answer'&&c.id==='existing'&&c.callId==='ask-fixture')");
      await run("window.startEditor=document.querySelector('[data-wall-composer] [contenteditable]').getBoundingClientRect().height; document.querySelector('[aria-label=\"Resize composer versus wall\"]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}))"); await sleep(500);
      await check('resize grows editor', "document.querySelector('[data-wall-composer] [contenteditable]').getBoundingClientRect().height>window.startEditor");
      if (!process.env.NEKKO_TEST_REVISION) {
      await run("window.copiedChat=null; Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copiedChat=text}}}); document.querySelector('.command-wall-window [data-chat-surface]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:150,clientY:150}))");
      await check('transcript menu contains copy and export', "document.querySelector('[role=menu]').textContent.includes('Copy chat') && document.querySelector('[role=menu]').textContent.includes('Export as Markdown')");
      await click('Copy chat', '[role=menu]');
      await check('copy writes Markdown transcript', "window.copiedChat.startsWith('# Existing conversation') && !document.querySelector('[role=menu]')");
      await run("window.exportedName=null; window.exportedBlob=null; URL.createObjectURL=blob=>{window.exportedBlob=blob;return 'blob:fixture'}; URL.revokeObjectURL=()=>{}; HTMLAnchorElement.prototype.click=function(){window.exportedName=this.download}; document.querySelector('.command-wall-window [data-chat-surface]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:150,clientY:150}))");
      await click('Export as Markdown', '[role=menu]');
      await check('export uses same Markdown payload', "(async()=>window.exportedName==='Existing-conversation.md' && await window.exportedBlob.text()===window.copiedChat)()");
      await run("document.querySelector('[data-wall-composer] [contenteditable]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:150,clientY:150}))");
      await check('editor excludes transcript actions', "![...document.querySelectorAll('[role=menu]')].some(m=>m.textContent.includes('Copy chat')||m.textContent.includes('Export as Markdown'))");
      await run("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
      await check('transcript exposes subtle inline reply measurements', "(()=>{const e=document.querySelector('.command-wall-window [data-chat-surface] [role=status]');return e?.classList.contains('text-ink-faint') && e.textContent.includes('tok/s') && e.textContent.includes('total tokens') && e.textContent.includes('Time unavailable')})()");
      await check('fixed footer excludes reply measurements', "!document.querySelector('.command-wall-window [aria-label=\"Chat actions and information\"] [role=status]')");
    }
      }
    if (current) {
      await reset(); await run('integration.fail()'); await sleep(350);
      await check('failed request offers one non-destructive retry', "(()=>{const a=document.querySelector('[role=alert]');return a&&[...a.querySelectorAll('button')].filter(b=>b.textContent.trim()==='Retry').length===1&&!a.textContent.includes('Start over')})()");
      await check('estimate uses the assembled included context', "document.querySelector('[role=alert]').textContent.includes(integration.contextBundle().totalTokens.toLocaleString())");
      await run("window.savedTranscript=JSON.stringify(integration.records()[0].messages)");
      await click('Retry','[role=alert]');
      await check('retry sends resume and retains saved transcript', "integration.calls.some(c=>c.method==='send'&&c.options.sessionId==='existing'&&c.options.resume===true&&c.options.text==='')&&JSON.stringify(integration.records()[0].messages)===window.savedTranscript");
    }
    if (current) {
      await run('integration.noProgress()'); await sleep(400); await run('integration.fail()');
      await check('no-progress failure describes saved-conversation retry', "document.querySelector('[role=alert]').textContent.includes('No resumable progress')");
      await click('Retry','[role=alert]');
      await check('no-progress retry preserves user turn', "integration.calls.some(c=>c.method==='send'&&c.options.resume===true&&c.options.text==='')&&integration.records()[0].messages.length===1");
      await run("sessionStorage.removeItem('fixture-record')");
    }
    for (const theme of ['light', 'dark']) {
      await run(`document.documentElement.dataset.theme='${theme}'`);
      for (const [width, label] of [[1200, 'desktop'], [400, 'narrow']]) {
        win.setContentSize(width, 900); await run("sessionStorage.removeItem('fixture-record')"); await reset(); await capture(`full-grid-${theme}-${label}`);
        await run('integration.fail()'); await sleep(250); await run("document.querySelector('[role=alert]')?.scrollIntoView({block:'end'})"); await capture(`retry-${theme}-${label}`);
        await run('integration.ask()'); await capture(`waiting-${theme}-${label}`);
        await reset();
        await run("document.querySelector('.command-wall-window button[aria-haspopup=listbox]').focus();document.querySelector('.command-wall-window button[aria-haspopup=listbox]').click()"); await sleep(250);
        await run("[...document.querySelectorAll('[role=listbox] button')].find(b=>b.textContent.includes('Auto')).click()"); await sleep(300);
        await capture(`context-${theme}-${label}`);
        if (current) { await run("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"); }
        await reset();
        await run("document.querySelector('.command-wall-window [data-chat-surface]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:180,clientY:200}))"); await capture(`chat-menu-${theme}-${label}`);
        await run("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
        await run("document.querySelector('[aria-label=\"Git checkout options\"]')?.click()"); await capture(`checkout-modal-${theme}-${label}`);
        await run("document.querySelector('[aria-label=\"Close checkout notice\"]')?.click()");
        await run('integration.ask()'); await sleep(350); await run("document.querySelector('.composer-question')?.scrollIntoView({block:'nearest'})"); await capture(`question-${theme}-${label}`); await reset();
        await run("document.querySelector('.command-wall-window button[aria-haspopup=listbox]').click()"); await capture(`full-picker-${theme}-${label}`);
        await run("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"); await click('Focused'); await capture(`full-focus-${theme}-${label}`);
        await run("integration.route('workspace')"); await sleep(500);
        await run("(()=>{const b=document.querySelector('[title=\"New agent with a terminal\"]'); b.focus(); b.dispatchEvent(new FocusEvent('focusin',{bubbles:true}));})()"); await capture(`workspace-image-menu-${theme}-${label}`);
      }
    }
    if (process.env.NEKKO_WALL_EVIDENCE && current) {
      win.setContentSize(1200,900); await reset(); await run("document.documentElement.dataset.theme='dark'");
      const motion = path.join(runDir, 'liquid-motion'); fs.mkdirSync(motion);
      for (let frame = 0; frame < 48; frame++) {
        if (frame === 5) await run("document.querySelector('.command-wall-add-rail-right')?.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}))");
        if (frame === 31) await run("document.querySelector('.command-wall-add-fill').click()");
        await run(`document.getAnimations().filter(a=>a instanceof CSSTransition).forEach(a=>{a.currentTime=${frame < 31 ? Math.max(0, frame - 5) * 100 : (frame - 31) * 100}})`);
        fs.writeFileSync(path.join(motion, `${String(frame).padStart(3, '0')}.png`), (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG()); await sleep(100);
      }
      const encoded = require('node:child_process').spawnSync('ffmpeg', ['-y','-framerate','10','-i',path.join(motion,'%03d.png'),'-vf','pad=ceil(iw/2)*2:ceil(ih/2)*2','-c:v','libx264','-pix_fmt','yuv420p',path.join(runDir,'liquid-add-motion.mp4')],{encoding:'utf8',windowsHide:true});
      if (encoded.status !== 0) throw Error(encoded.stderr);
      report.captures.push(path.join(runDir,'liquid-add-motion.mp4'));
    }
    if (process.env.NEKKO_WALL_EVIDENCE && current) {
      await win.loadFile(path.join(out,'index.html'),{query:{multi:'1'}}); win.setContentSize(1200,900); await sleep(800);
      await run("document.documentElement.dataset.theme='dark'");
      await run("(()=>{const i=document.querySelector('[data-wall-composer] [contenteditable]'); i.focus(); const dt=new DataTransfer();dt.items.add(new File([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='),c=>c.charCodeAt(0))],'fixture.png',{type:'image/png'}));i.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:dt}))})()");
      await check('pasted image attachment renders', "!!document.querySelector('[data-wall-composer] img[alt=\"Pending attachment 1\"]')");
      await check('attachment editor remains inside frame', "(()=>{const p=document.querySelector('[data-wall-composer]').getBoundingClientRect(),e=document.querySelector('[data-wall-composer] [contenteditable]').getBoundingClientRect();return e.bottom<=p.bottom+1})()");
      await capture('wall-multi-attachment');
      await check('multi-chat selection hint', "document.querySelector('[data-wall-composer]').textContent.includes('selects a window')");
      await run("document.querySelector('.command-wall-add-rail-bottom')?.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}))"); await sleep(150);
      await run("document.getAnimations().filter(a=>a instanceof CSSTransition).forEach(a=>a.finish())");
      await capture('wall-multi-hover');
      await run("document.querySelector('.command-wall-add-fill').click()"); await sleep(200);
      await capture('wall-multi-solid');
      await win.loadFile(path.join(out,'index.html')); await sleep(600);
    }
    // Timed PNG frames form a portable motion recording without screen permissions.
    win.setContentSize(1200, 900); await reset(); await run("document.documentElement.dataset.theme='light'");
    const motion = path.join(runDir, 'motion'); fs.mkdirSync(motion);
    for (let frame = 0; frame < 36; frame++) {
      if (frame === 4 || frame === 16) await run("document.querySelector('[aria-label=\"Resize composer versus wall\"]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}))");
      if (frame === 22) await click('Focused');
      if (frame === 29) await click('Dynamic');
      fs.writeFileSync(path.join(motion, `${String(frame).padStart(3, '0')}.png`), (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG());
      await sleep(100);
    }
    const encoded = require('node:child_process').spawnSync('ffmpeg', ['-y', '-framerate', '10', '-i', path.join(motion, '%03d.png'), '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(runDir, 'full-view-motion.mp4')], { encoding: 'utf8', windowsHide: true });
    if (encoded.status !== 0) throw Error(encoded.stderr);
    report.captures.push(path.join(runDir, 'full-view-motion.mp4'));
    if (current) {
      win.setContentSize(900,480); await reset();
      await check('short grid remains scrollable', "(()=>{const stage=document.querySelector('.command-wall-stage');return stage && stage.scrollHeight>0 && document.querySelector('[data-wall-composer] [contenteditable]').clientHeight>=36})()");
      await run("document.dispatchEvent(new KeyboardEvent('keydown',{code:'Digit3',key:'#',ctrlKey:true,shiftKey:true,bubbles:true}))"); await sleep(180);
      await check('short fixed layout retains accessible editor', "document.querySelector('[data-wall-composer] [contenteditable]').clientHeight>=36 && document.documentElement.scrollWidth<=innerWidth");
    }
    if (win.isFocused() || screen.getAllDisplays().some(d => { const b=win.getBounds(); return b.x < d.bounds.x+d.bounds.width && b.x+b.width > d.bounds.x && b.y < d.bounds.y+d.bounds.height && b.y+b.height > d.bounds.y; }) || report.errors.some(e => /Verification window/.test(e))) throw Error('Background verification visibility/focus invariant failed');
    report.background = { visible: win.isVisible(), focused: win.isFocused(), offscreen: win.getBounds().x + win.getBounds().width <= Math.min(...screen.getAllDisplays().map(d => d.bounds.x)) };
    report.success = true;
    if (process.env.NEKKO_INSPECT_HOLD) {
      win.setContentSize(1200, 900); await reset();
      await run("document.querySelector('.command-wall-window button[aria-haspopup=listbox]').click()"); await sleep(300);
      await run("[...document.querySelectorAll('[role=listbox] button')].find(b=>b.textContent.includes('Auto')).click()");
      await sleep(120000);
    }
  } catch (e) { report.errors.push(String(e)); report.success = false; process.exitCode = 1; }
  finally { fs.writeFileSync(path.join(runDir, 'status.json'), JSON.stringify(report, null, 2)); fs.writeFileSync(path.join(out, 'latest-run.txt'), runDir); console.log(JSON.stringify({ runDir, ...report }, null, 2)); win.destroy(); app.exit(report.success ? 0 : 1); }
});
