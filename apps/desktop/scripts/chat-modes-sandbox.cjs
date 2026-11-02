// Synthetic Simple / Expert evidence for the desktop chat; never connects to the user's host or profile.
// Run: NEKKO_FIXTURE=chat-modes-fixture.tsx NEKKO_SANDBOX=chat-modes-sandbox.cjs node chat-search-integration.cjs
// (NEKKO_TEST_REVISION=<rev> for "before"). Hidden, non-focusable, off-screen; renderer input only.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through chat-search-integration.cjs');
const dir = path.join(out, process.env.NEKKO_TEST_REVISION ? 'before' : 'after');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
app.setPath('userData', path.join(dir, 'profile'));
app.setPath('sessionData', path.join(dir, 'profile'));
const js = (v) => JSON.stringify(v).replace(/[<>/\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((request, done) => done({ cancel: !/^(file:|data:|blob:)/.test(request.url) }));
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, done) => done(false));
  const left = Math.min(...screen.getAllDisplays().map(d => d.bounds.x));
  const win = new BrowserWindow({
    width: 1100, height: 720, useContentSize: true, show: false, focusable: false, skipTaskbar: true,
    x: left - 3000, y: -2000, title: 'Synthetic chat modes verification',
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  const report = { checks: [], errors: [], bounds: null };
  win.on('focus', () => report.errors.push('Fixture took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push('console: ' + e.message.slice(0, 300)); });
  const run = source => win.webContents.executeJavaScript(source, true);
  const check = (name, ok) => report.checks.push({ name, passed: !!ok });
  const capture = async name => { await sleep(500); fs.writeFileSync(path.join(dir, name + '.png'), (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG()); };
  const click = async selector => {
    const p = await run(`(()=>{const e=document.querySelector(${js(selector)});if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);
    if (!p) return false;
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await sleep(250);
    return true;
  };
  const clickAt = async (x, y) => { for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 }); await sleep(250); };
  const has = selector => run(`!!document.querySelector(${js(selector)})`);
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 50 && !(await has('[data-session-id="alpha"] textarea')); i++) await sleep(200);
    await sleep(1200);
    report.bounds = win.getBounds();
    report.focusAtLoad = await run('document.activeElement && document.activeElement.tagName');
    const text = sel => run(`[...document.querySelectorAll(${js(sel)})].map(e => e.textContent.trim()).join(' | ')`);
    // The refresh's scenes: each one reloads the fixture into its situation. Hidden, off-screen, like the rest.
    const scene = async (o) => {
      await run(`localStorage.setItem('nekko.chatMode', ${js(o.mode)}); localStorage.setItem('fixture.scene', ${js(JSON.stringify(o))}); localStorage.setItem('nekko.planRail', ${js(o.rail === false ? '0' : '1')}); location.reload()`).catch(() => {});
      await sleep(300);
      for (let i = 0; i < 50 && !(await has('[data-session-id="alpha"] textarea')); i++) await sleep(200);
      await sleep(1400);
    };
    const overlap = (a, b) => run(`(()=>{const A=document.querySelector(${js(a)})?.getBoundingClientRect(),B=[...document.querySelectorAll(${js(b)})];if(!A)return false;return B.some(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.left<A.right&&r.right>A.left&&r.top<A.bottom&&r.bottom>A.top})})()`);
    const row = () => text('[data-composer-details]');
    await scene({ mode: 'simple', local: false, changes: 0, long: false });
    check('clean Simple: no strip above the message box', !(await has('[data-chat-mode-button]')) && !(await has('.composer .ctl-toggle-neutral')) && !/Automate/.test(await text('.composer')));
    check('clean Simple: the row is folder, model, asks first and the ring', (await has('[data-composer-details] [data-asks-first]')) && (await has('[data-composer-details] .context-bar')) && (await has('[data-composer-details] button[aria-haspopup="listbox"]')));
    check('clean Simple: no effort, Tools, MCP, globe, arrow or cost in the row', !(await has('[data-effort-index]')) && !(await has('.composer-details-toggle')) && !/Tools|MCP|Effort/.test(await row()));
    check('clean Simple: the ring has no token count', !/\d+k/.test(await text('.context-bar')));
    check('clean Simple: no hardware strip, Changes, Agent Monitor or getting-long note', !(await has('[data-expert-monitor]')) && !(await has('[data-agent-companion="diff"]')) && !(await has('[data-plan-toggle]')) && !(await has('[data-chat-long]')));
    await capture('a1-simple-clean');
    await scene({ mode: 'simple', local: true, changes: 3, long: false });
    for (let i = 0; i < 30 && !(await has('[data-expert-monitor]')); i++) await sleep(200);
    check('Simple with a local model: the hardware strip shows', await has('[data-expert-monitor]'));
    check('Simple with changes: Changes says 3 files changed', /3 files changed/.test(await text('[data-agent-companion="diff"]')));
    await capture('a2-simple-local-3-changes');
    await scene({ mode: 'simple', local: false, changes: 0, long: false, remote: true });
    for (let i = 0; i < 30 && !(await has('[data-expert-monitor]')); i++) await sleep(200);
    check('Simple: a local model on a connected computer brings the strip', await has('[data-expert-monitor]'));
    await sleep(600);
    check('The strip names that computer and its model count, not this one\'s', /1\s*Loaded on Studio/.test(await text('[data-expert-monitor]')));
    await capture('a2b-simple-remote-model');
    await scene({ mode: 'expert', local: false, changes: 0, long: false });
    check('Expert with no local model: no hardware strip, no Changes', !(await has('[data-expert-monitor]')) && !(await has('[data-agent-companion="diff"]')));
    check('Expert: effort, Mode, strip and arrow stay where they were', (await has('[data-effort-index]')) && (await has('[data-chat-mode-button]')) && (await has('.composer-details-toggle')) && /Incognito/.test(await text('.composer')));
    await capture('a3-expert-no-local');
    await scene({ mode: 'expert', local: true, changes: 0, long: false });
    for (let i = 0; i < 30 && !(await has('[data-expert-monitor]')); i++) await sleep(200);
    check('Expert with a local model: the hardware strip shows', await has('[data-expert-monitor]'));
    await capture('a4-expert-local');
    await scene({ mode: 'simple', local: false, changes: 0, long: false });
    await sleep(1600);
    await click('button[aria-label="Add a photo, video, file, folder, or skill"]');
    check('the + menu holds Incognito and Automate', (await has('[data-plus-incognito]')) && (await has('[data-plus-automate]')));
    await capture('a5-simple-plus-menu');
    await click('[data-plus-incognito]');
    await sleep(300);
    check('Incognito from the + menu is on and stays in sight', await has('[data-incognito-on]'));
    await capture('a5b-simple-incognito-on');
    await scene({ mode: 'simple', local: false, changes: 0, long: true });
    check('the getting-long note starts clear of the cat', !(await overlap('[data-chat-mascot]', '[data-chat-long] span')));
    await capture('a6-simple-getting-long');
    await scene({ mode: 'simple', local: false, changes: 0, long: false, agents: 2, many: true, rail: false });
    check('Simple with background tasks: the Agent Monitor button shows', await has('[data-plan-toggle]'));
    // Bring a right-aligned prompt up under the top of the transcript, where the floating button sat.
    for (let i = 0; i < 80; i++) {
      const placed = await run(`(()=>{const s=document.querySelector('[data-transcript-scroll]');const t=s.getBoundingClientRect().top;const hit=[...document.querySelectorAll('.msg-user')].some(u=>{const y=u.getBoundingClientRect().top-t;return y>=2&&y<=30});if(!hit)s.scrollTop-=24;return hit})()`);
      if (placed) break;
      await sleep(40);
    }
    await sleep(400);
    report.agentMonitorOverPrompt = await overlap('[data-plan-toggle]', '.msg-user');
    check('the Agent Monitor button covers no message', !report.agentMonitorOverPrompt);
    await capture('a7-agent-monitor-scrolled');
    await run(`(()=>{const s=document.querySelector('[data-transcript-scroll]');s.scrollTop=s.scrollHeight})()`);
    await sleep(400);
    check('the cat leaves the last transcript row clear', !(await overlap('[data-chat-mascot]', '[data-claude-background]')));
    await capture('a7b-transcript-end-clear-of-cat');
    await scene({ mode: 'simple', local: false, changes: 0, long: false, pr: true });
    check('Simple with a pull request: the PR deck shows', await has('.pr-action-deck'));
    await capture('a8-simple-with-pr');
    await scene({ mode: 'simple', local: false, changes: 0, long: false });
    await sleep(1600);
    await click('[data-composer-details] button[aria-haspopup="listbox"]');
    await sleep(300);
    check('effort is inside the model menu in Simple', await has('[data-effort-in-model-menu] [data-effort]'));
    await capture('a9-simple-model-menu');
    await scene({ mode: 'simple', local: false, changes: 0, long: false });
    await click('[data-asks-first]');
    check('the selector offers the plain choices and no Plan', /Asks first.*Asks when it matters.*Works on its own/.test(await text('[data-asks-menu]')) && !/Plan/.test(await text('[data-asks-menu]')));
    await capture('a10-simple-asks-menu');
    await run(`[...document.querySelectorAll('[data-asks-menu] button')].at(-1).click()`);
    await sleep(300);
    check('choosing Works on its own sets the existing tool policy', (await run(`document.querySelector('[data-asks-first]').dataset.asksFirst`)) === 'yolo');
    await scene({ mode: 'simple', local: false, changes: 0, long: false, wall: true });
    await sleep(1600);
    check('a wall window in Simple has no details row, and Automate left its foot', !(await has('[data-composer-details]')) && !(await has('[data-composer-automate]')));
    await click('[data-composer-foot] button[aria-haspopup="listbox"]');
    await sleep(300);
    check('a wall window in Simple offers effort in the model menu', await has('[data-effort-in-model-menu] [data-effort]'));
    await capture('a11-simple-wall-window-model-menu');
    // Back to the original evidence: a nearly full chat with models resident.
    await run(`localStorage.removeItem('fixture.scene'); localStorage.setItem('nekko.chatMode','simple'); localStorage.removeItem('nekko.planRail'); location.reload()`).catch(() => {});
    await sleep(300);
    for (let i = 0; i < 50 && !(await has('[data-session-id="alpha"] textarea')); i++) await sleep(200);
    await sleep(1200);
    check('starts in Simple', await run(`document.querySelector('[data-chat-mode]')?.dataset.chatMode === 'simple'`));
    check('Simple: details panel sits inside the composer card', await has('.composer [data-composer-details]'));
    for (let i = 0; i < 30 && !(await has('[data-expert-monitor]')); i++) await sleep(200);
    check('Simple: the hardware strip shows while a local model is loaded', await has('[data-expert-monitor]'));
    check('Simple: a nearly full chat says what starting fresh saves', /Starting fresh saves about 162k tokens/.test(await text('[data-chat-long]')));
    check('Simple: the turn\'s steps fold to one line', /Took 2 steps/.test(await text('[data-simple-steps]')));
    await capture('1-simple');
    await run(`[...document.querySelectorAll('[data-simple-steps] button')].find(b => b.textContent === 'Show steps')?.click()`); await sleep(300);
    check('Show steps opens that turn\'s steps', (await run(`document.querySelector('[data-simple-steps] button').getAttribute('aria-expanded')`)) === 'true');
    await capture('1b-simple-steps-shown');
    await run(`document.querySelector('[data-simple-steps] button').click()`); await sleep(200);
    await click('[data-chat-mode] button[aria-label^="Expert"]');
    for (let i = 0; i < 20 && !(await has('[data-dial="GPU"]')); i++) await sleep(200);
    check('Expert: no getting-long note', !(await has('[data-chat-long]')));
    check('Expert: steps are not folded to one line', !(await has('[data-simple-steps]')));
    check('Expert: effort, context, Mode, tools and the strip are shown', (await has('[data-effort-index]')) && (await has('.context-bar')) && (await has('[data-chat-mode-button]')) && (await has('[data-expert-monitor]')));
    await sleep(800);
    await capture('3-expert');
    await click('.composer-details-toggle');
    check('Expert shrunk keeps the model only', !(await has('[data-effort-index]')) && !(await has('.context-bar')) && (await has('[data-composer-details] button[aria-haspopup="listbox"]')));
    await capture('4-expert-shrunk');
    await click('.composer-details-toggle');
    win.setContentSize(760, 720); await sleep(600);
    await capture('5-expert-narrow');
    check('no horizontal page overflow at 760px', await run(`document.documentElement.scrollWidth <= innerWidth`));
    win.setContentSize(1100, 720);
    // Settings > Simple mode, back in Simple.
    await run(`localStorage.setItem('nekko.chatMode','simple'); location.hash = '#settings'; location.reload()`);
    for (let i = 0; i < 50 && !(await has('[data-simple-mode-settings]')); i++) await sleep(200);
    await sleep(800);
    check('settings list every desktop area', (await run(`document.querySelectorAll('[data-simple-area]').length`)) === 7);
    check('Simple preview dashes the Mode panel', await run(`document.querySelector('[data-simple-area="Chat · message box"] [data-mock-item="mode"]').dataset.shown === 'false'`));
    check('a monitor offers When running, Always and Hide', /When running.*Always.*Hide/.test(await text('[data-simple-item="hardware"] .sm-choice')));
    await capture('6-settings-simple-preview');
    await run(`document.querySelector('[data-simple-item="mode"]').scrollIntoView({block:'center'})`); await sleep(300);
    await click('[data-simple-item="mode"] button[role="radio"]:first-child');
    check('choosing Show for the Mode panel draws it in the Simple preview', await run(`document.querySelector('[data-mock-item="mode"]').dataset.shown === 'true'`));
    await run(`document.querySelector('[data-simple-area="Chat · message box"]').scrollIntoView({block:'start'})`);
    await run(`document.querySelector('[data-simple-item="context"]').dispatchEvent(new MouseEvent('mouseover', {bubbles:true}))`);
    await sleep(300);
    await capture('7-settings-mode-shown');
    await run(`document.querySelector('[aria-label="Preview Expert"]').click()`); await sleep(300);
    check('Expert preview shows the context ring', await run(`document.querySelector('[data-mock-item="context"]').dataset.shown === 'true'`));
    await capture('8-settings-expert-preview');
    await run(`location.hash = ''; location.reload()`);
    for (let i = 0; i < 50 && !(await has('[data-session-id="alpha"] textarea')); i++) await sleep(200);
    await sleep(1000);
    check('the chat honours the choice: the Mode panel shows in Simple', (await run(`document.querySelector('[data-chat-mode]')?.dataset.chatMode`)) === 'simple' && (await has('[data-chat-mode-button]')));
    await capture('9-simple-with-mode');
    report.text = await text('[data-composer-details]');
  } catch (e) { report.errors.push(String(e && e.stack || e)); }
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.checks.every(c => c.passed) ? 0 : 1);
});
