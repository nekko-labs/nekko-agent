// Walks the first-run wizard (onboarding-evidence-fixture.tsx) step by step in a
// hidden, non-focusable window and captures each about-you step. No network, nekkod or real data.
// NEKKO_TEST_LABEL=before captures only what main has: the welcome and the next step.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
// Escape code delimiters and line separators before embedding JSON in evaluated code.
const js = v => JSON.stringify(v).replace(/[<>/\u2028\u2029]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const label = process.env.NEKKO_TEST_LABEL || 'head';
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1200, height: 800, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const report = { errors: [], captures: [], checks: {} };
  win.on('show', () => report.errors.push('Window became visible'));
  win.on('focus', () => report.errors.push('Window took focus'));
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) report.checks.consoleErrors = [...(report.checks.consoleErrors || []), message.slice(0, 200)]; });
  const run = s => win.webContents.executeJavaScript(s, true);
  const png = async () => (await win.capturePage(undefined, { stayHidden: true })).toPNG();
  const shot = async name => { await sleep(400); const f = path.join(out, `${name}-${label}.png`); fs.writeFileSync(f, await png()); report.captures.push(f); };
  const click = text => run(`(() => { const b = [...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent.trim() === ${js(text)}); if (!b) return false; b.click(); return true; })()`);
  const type = (sel, value) => run(`(() => { const i = document.querySelector(${js(sel)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${js(value)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const step = () => run("document.querySelector('[role=dialog] section')?.getAttribute('aria-label')");
  try {
    // A hidden window doesn't tick CSS animations, so stills use reduced motion
    // (each animation's last frame). onboarding-evidence-gif.mjs records the motion.
    await win.loadFile(path.join(out, 'index.html'));
    win.webContents.debugger.attach();
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    for (let i = 0; i < 100 && !(await run("!!document.querySelector('[role=dialog]')")); i++) await sleep(100);
    report.checks.theme = await run('document.documentElement.dataset.theme');
    await shot('1-welcome');
    await click(label === 'before' ? 'Next' : "Let's go");
    if (label === 'before') { await shot('2-next'); report.success = report.errors.length === 0; return; }
    await sleep(200);
    report.checks.afterWelcome = await step();
    await type('#setup-name', 'Philip');
    await shot('2-name');
    await click('Next'); await sleep(300);
    await type('#setup-email', 'philip@');
    await click('Next'); await sleep(300);
    report.checks.stayedOnBadEmail = (await step()) === 'Email';
    await shot('3-email-invalid');
    await type('#setup-email', 'philip@example.com');
    await shot('3-email');
    await click('Next'); await sleep(300);
    await run("[...document.querySelectorAll('[role=radio]')].find(b => b.textContent.includes('Developer')).click()");
    await shot('4-work');
    await click('Next'); await sleep(600);
    await shot('5-detail-developer');
    await run("[...document.querySelectorAll('[role=radio]')].find(b => b.textContent.startsWith('Regular')).click()");
    await sleep(2600);
    await shot('5-detail-regular');
    await run("[...document.querySelectorAll('[role=radio]')].find(b => b.textContent.startsWith('Detailed')).click()");
    await click('Next'); await sleep(400);
    report.checks.simple = await run('window.onboardingFixture.simple()');
    await shot('6-look');
    report.checks.themeRowWraps = await run("(() => { const r = document.querySelector('.theme-swatch-row'); const b = [...r.children]; return new Set(b.map(x => x.offsetTop)).size > 1; })()");
    // Through the existing steps to the end.
    for (let i = 0; i < 6 && (await step()) !== 'All set'; i++) { await click('Skip step') || await click('Next'); await sleep(300); }
    await shot('7-done');
    report.checks.settings = await run('(({ userName, userEmail, workProfile, theme, commandWall }) => ({ userName, userEmail, workProfile, theme, dock: commandWall?.dock && { show: commandWall.dock.show, simpleShow: commandWall.dock.simpleShow } }))(window.onboardingFixture.settings)');
    report.checks.joined = await run('window.onboardingFixture.joined');
    if (win.isVisible() || win.isFocused()) report.errors.push('visible or focused');
    report.success = report.errors.length === 0 && report.checks.stayedOnBadEmail && report.checks.themeRowWraps === false;
  } catch (e) { report.errors.push(String(e.stack || e)); report.success = false; }
  finally {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2)); win.destroy(); app.exit(report.success ? 0 : 1);
  }
});
