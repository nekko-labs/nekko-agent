const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch with layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const baseline = process.env.NEKKO_CTA_BASELINE === '1';
const report = { captures: [], checks: [], errors: [] };
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ title: 'Nekko CTA/question verification — isolated', width: 1100, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('Window took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const check = async (name, expression) => { const value = await run(expression); report.checks.push({ name, value }); if (!baseline && !value) throw Error(name); };
  const shot = async name => { const file = path.join(out, name + '.png'); fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG()); report.captures.push(file); };
  const load = async (theme = 'dark') => {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 100 && !(await run('!!window.layoutFixture && !!window.ctaQuestionFixture')); i++) await sleep(100);
    await sleep(300);
    if (theme !== 'dark' && theme !== 'light') throw Error('Unsupported fixture theme');
    await run(theme === 'dark' ? "document.documentElement.dataset.theme='dark'" : "document.documentElement.dataset.theme='light'");
  };
  const motion = [];
  let recordMotion = false;
  const click = async selector => {
    // Keep selectors as data: never construct executable source from input.
    const targets = await run(`(() => {
      const selectors = ['[role="radio"]', '[role="checkbox"]', '[data-question-next]', '[data-question-back]', '[data-question-skip]', '[data-question-submit]'];
      return Object.fromEntries(selectors.map(selector => {
        const element = document.querySelector('#question-fixture ' + selector);
        if (!element) return [selector, null];
        const r = element.getBoundingClientRect();
        return [selector, { x: Math.round(r.x + 3), y: Math.round(r.y + r.height / 2) }];
      }));
    })()`);
    const p = targets[selector];
    if (!p) throw Error(`Missing fixture target: ${selector}`);
    if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...p });
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...p });
    await sleep(120);
    if (recordMotion) motion.push((await win.capturePage(undefined, { stayHidden: true })).toPNG());
  };
  try {
    for (const width of [1100, 390]) for (const theme of ['dark', 'light']) {
      win.setContentSize(width, 900);
      await load(theme);
      await shot(`board-${width}-${theme}`);
      await run('layoutFixture.showComposer("window")'); await sleep(400);
      await shot(`composer-${width}-${theme}`);
      report.composerTargets ??= [];
      report.composerTargets.push({ width, theme, targets: await run(`Array.from(document.querySelectorAll('[data-composer-action], [aria-label="Start listening"], [aria-label="Add a photo, video, file, folder, or skill"]')).map(e=>({label:e.getAttribute('aria-label'),rect:e.getBoundingClientRect().toJSON()}))`) });
      await check(`composer targets ${width} ${theme}`, `Array.from(document.querySelectorAll('[data-composer-action], [aria-label="Start listening"], [aria-label="Add a photo, video, file, folder, or skill"]')).every(e=>{const r=e.getBoundingClientRect();return r.width>=44&&r.height>=44&&r.left>=0&&r.right<=innerWidth})`);
      await load(theme); await run('ctaQuestionFixture.showAnswer(true)'); await sleep(400);
      await shot(`answer-live-${width}-${theme}`);
      await check(`live answer visible ${width} ${theme}`, `document.body.innerText.includes('Keep icons the same size.')`);
      await load(theme); await run('ctaQuestionFixture.showQuestion()'); await sleep(250);
      await shot(`question-${width}-${theme}`);
      await check(`CTA target bounds ${width} ${theme}`, `Array.from(document.querySelectorAll('#question-fixture button')).every(e=>{const r=e.getBoundingClientRect();return r.width>=44&&r.height>=44})`);
      await check(`one question ${width} ${theme}`, `document.querySelectorAll('#question-fixture [role="radiogroup"]').length===1&&!document.querySelector('#question-fixture').innerText.includes('Which checks should I run?')`);
      if (!baseline) {
        recordMotion = width === 1100 && theme === 'dark';
        if (recordMotion) motion.push((await win.capturePage(undefined, { stayHidden: true })).toPNG());
        await click('[role="radio"]');
        await click('[data-question-next]');
        await check('second page', `document.body.innerText.includes('Which checks should I run?')`);
        await click('[data-question-back]');
        await check('Back retains pick', `document.querySelector('#question-fixture [role="radio"]').getAttribute('aria-checked')==='true'`);
        await click('[data-question-next]');
        await click('[role="checkbox"]');
        await click('[data-question-skip]');
        await check('Skip advances to third page', `document.body.innerText.includes('Which theme should I check?')`);
        await shot(`question-last-${width}-${theme}`);
        await click('[data-question-skip]');
        await check('Skip clears only current answer and submits once', `ctaQuestionFixture.answers.length===1&&ctaQuestionFixture.answers[0].length===1&&ctaQuestionFixture.answers[0][0].labels[0]==='Composer'`);
      }
      await check(`no horizontal overflow ${width} ${theme}`, `document.querySelector('#question-fixture').scrollWidth<=innerWidth`);
    }
    if (!baseline) {
      recordMotion = false;
      const file = path.join(out, 'question-navigation.gif');
      require('./evidence-gif.cjs')(file, motion, 65);
      report.captures.push(file);
      await load(); await run('ctaQuestionFixture.showQuestion(); ctaQuestionFixture.failNext = true'); await sleep(200);
      await click('[role="radio"]'); await click('[data-question-next]'); await click('[data-question-skip]');
      await click('[role="radio"]'); await click('[data-question-next]');
      await check('Failed send retains card and choices', `!!document.querySelector('#question-fixture [role="alert"]')&&document.querySelector('#question-fixture [role="radio"]').getAttribute('aria-checked')==='true'&&ctaQuestionFixture.answers.length===0`);
      await click('[data-question-next]'); await click('[data-question-next]');
      await check('Retry submits once without losing earlier answers', `ctaQuestionFixture.answers.length===1&&ctaQuestionFixture.answers[0].length===2`);
    }
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.errors.length ? 1 : 0);
});
