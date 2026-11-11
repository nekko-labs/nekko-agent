// Hidden, isolated renderer evidence. No OS input or external side effects.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
const baseline = process.env.NEKKO_CI_BASELINE === '1';
const profile = fs.mkdtempSync(path.join(out, 'profile-'));
app.setPath('userData', profile); app.setPath('sessionData', profile);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const js = v => JSON.stringify(v).replace(/[<>\/\u2028\u2029]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
app.whenReady().then(async () => {
  const report = { checks: [], errors: [], captures: [] };
  session.defaultSession.webRequest.onBeforeRequest((r, done) => done({ cancel: !/^(file:|data:|blob:)/.test(r.url) }));
  session.defaultSession.setPermissionRequestHandler((_c, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1000, height: 1100, useContentSize: true, show: false, focusable: false, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('show', () => report.errors.push('window shown')); win.on('focus', () => report.errors.push('window focused'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const check = async (name, s) => { const passed = !!await run(s); report.checks.push({ name, passed }); if (!passed) throw Error(name); };
  const click = async (text, scope = 'button') => { await run(`[...document.querySelectorAll(${js(scope)})].find(e=>e.textContent.trim()===${js(text)})?.click()`); await sleep(150); };
  const capture = async name => { win.webContents.invalidate(); await sleep(150); const file = path.join(out, name + '.png'); fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(file); };
  try {
    await win.loadFile(path.join(out, 'index.html')); await sleep(700);
    for (const width of [1000, 390]) {
      win.setContentSize(width, 1100); await sleep(300);
      await capture(`automations-${width}`);
      await check(`no horizontal overflow at ${width}`, 'document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll("main section")].every(e=>e.scrollWidth<=e.clientWidth+1)');
    }
    await run('integration.full()'); await sleep(400);
    // The runners are their own page in the Automations sub-navigation; a baseline without it shows them in the list.
    await click('CI runners', '[data-workflows-subnav] button'); await sleep(300);
    for (const width of [1000, 390]) {
      win.setContentSize(width, 1100); await sleep(250);
      await run("document.querySelector('[data-ci-runners]').scrollIntoView({block:'start',behavior:'instant'})"); await sleep(800);
      report.checks.push({ name: `full view position ${width}`, top: await run("document.querySelector('[data-ci-runners]').getBoundingClientRect().top") });
      await capture(`runners-${width}`);
    }
    await run('integration.show()'); await sleep(250);
    if (!baseline) {
      await check('VMs and all job groups visible', "['nekko-mac-01','nekko-mac-02','Queued','In progress','Completed','View CI runners'].every(s=>document.body.textContent.includes(s))");
      await click('Live log', '[data-runner-vm="nekko-mac-02"] button');
      await check('ready VM log uses its identity', "integration.calls.some(c=>c[0]==='log'&&c[2]==='nekko-mac-02') && document.body.innerText.includes('Listening for jobs')");
      await click('Accept now');
      await check('accept targets queued job', "integration.calls.some(c=>c[0]==='r1'&&c[1]==='accept'&&c[3]===43)");
      await click('Cancel', '[data-running-job] button');
      await check('cancel needs confirmation', "document.body.innerText.includes('Cancel the whole workflow run on GitHub?') && !integration.calls.some(c=>c[1]==='cancel')");
      await click('Cancel run');
      await check('confirmed cancel targets running job', "integration.calls.some(c=>c[1]==='cancel'&&c[3]===42)");
      await run("document.querySelector('[data-recent-job] button').click()"); await sleep(200);
      await check('completed log opens', "document.querySelector('[data-log=job]')?.textContent==='Tests passed'");
      await run("document.querySelector('[role=switch]').click()"); await sleep(200);
      await check('runner switch uses existing bridge', "integration.calls.some(c=>c[0]==='enabled'&&c[2]===false)");
      await run('integration.show()'); await sleep(250);
      const frames = [];
      for (let i = 0; i < 12; i++) {
        if (i === 3) await click('View CI runners');
        frames.push((await win.capturePage(undefined, { stayHidden: true })).resize({ width: 390 }).toPNG());
        await sleep(200);
      }
      require('./evidence-gif.cjs')(path.join(out, 'view-ci-runners.gif'), frames, 20);
      await check('full view navigation', "document.body.innerText.includes('Connect GitHub') && !!document.querySelector('[data-ci-runners]')");
      await check('navigation focuses CI section', "document.activeElement?.hasAttribute('data-ci-runners') && document.activeElement.getBoundingClientRect().top >= 0 && document.activeElement.getBoundingClientRect().top < 200");
      await run('integration.show()'); await sleep(200);
      await run('integration.pushEmpty()'); await sleep(200);
      await check('push removes runner cards', "!document.querySelector('[data-runner-card]')");
      win.setContentSize(1000, 1100);
      await run("localStorage.setItem('nekko.chatMode','simple'); integration.show(); integration.full()"); await sleep(400);
      await check('Simple keeps CI runners while this Mac is a runner', "!!document.querySelector('[data-workflows-subnav]') && document.body.innerText.includes('CI runners')");
      await capture('simple-subnav-1000');
      await run("integration.show('empty'); integration.full()"); await sleep(400);
      await check('Simple leaves CI runners out with no runner', "![...document.querySelectorAll('[data-workflows-subnav] button')].some(b=>b.textContent.includes('CI runners')) && !document.querySelector('[data-ci-runners]')");
      await run("localStorage.setItem('nekko.chatMode','expert')");
      for (const scene of ['empty', 'error', 'unsupported']) {
        await run(`integration.show(${js(scene)})`); await sleep(250);
        await check(scene, scene === 'empty' ? "document.body.innerText.includes('No CI runners connected')" : scene === 'error' ? "document.body.innerText.includes('Service disconnected')" : "!document.querySelector('[data-ci-runners]')");
        if (scene === 'unsupported') {
          await run('integration.full()'); await sleep(300);
          await check('no runner channel keeps the sub-navigation', "!!document.querySelector('[data-workflows-subnav]')");
          await run("[...document.querySelectorAll('[data-workflows-subnav] button')].find(b=>b.textContent.includes('CI runners')).click()"); await sleep(300);
          await check('no runner channel explains where runners live', "!!document.querySelector('[data-ci-runners-elsewhere]') && document.body.innerText.includes('Needs a Mac with Apple silicon') && document.querySelector('[data-runner-option=macos]')?.getAttribute('aria-disabled')==='true'");
          await capture('unsupported-ci-page-1000');
          await run("localStorage.setItem('nekko.chatMode','simple'); integration.show('unsupported'); integration.full()"); await sleep(400);
          await check('Simple keeps the explanation too', "!!document.querySelector('[data-workflows-subnav]')");
          await run("localStorage.setItem('nekko.chatMode','expert'); integration.show('unsupported'); integration.full()"); await sleep(400);
        }
        await check(`${scene} subscriptions cleaned up`, 'integration.listenerCount()===1');
      }
    }
  } catch (e) { report.errors.push(String(e.stack || e)); process.exitCode = 1; }
  finally {
    report.bounds = win.getBounds(); report.visible = win.isVisible();
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    win.destroy(); app.exit(report.errors.length ? 1 : 0);
  }
});
app.on('will-quit', () => fs.rmSync(profile, { recursive: true, force: true }));
