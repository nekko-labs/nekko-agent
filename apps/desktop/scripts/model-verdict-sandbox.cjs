// Real Chromium/Electron renderer, isolated from the user profile, engine and network.
// Captures the Models page's library for one machine under three engines (see model-verdict-fixture.tsx).
const { app, BrowserWindow, session, screen } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
const baseline = process.env.NEKKO_TEST_LABEL === 'model-verdict-before';
app.setPath('userData', fs.mkdtempSync(path.join(out, 'profile-')));
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  const report = { captures: [], checks: [], errors: [] };
  session.defaultSession.webRequest.onBeforeRequest((req, done) => done({ cancel: !/^(file:|data:|blob:)/.test(req.url) }));
  session.defaultSession.setPermissionRequestHandler((_c, _p, done) => done(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  const x = Math.min(...screen.getAllDisplays().map(d => d.bounds.x));
  const y = Math.min(...screen.getAllDisplays().map(d => d.bounds.y));
  const win = new BrowserWindow({ width: 1280, height: 980, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: x - 3000, y: y - 1600, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('Fixture took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const run = source => win.webContents.executeJavaScript(source);
  const wait = async (source) => { for (let i = 0; i < 80; i++) { if (await run(source)) return; await sleep(100); } throw Error(`Timed out: ${source}`); };
  const capture = async (name, theme) => {
    win.setContentSize(1280, 1050);
    await run(`fixture.theme('${theme}')`);
    await sleep(450);
    await run(`(() => { const w = document.querySelector('.models-workspace'); const t = document.querySelector('[data-models-section=library]'); w.scrollTo({ top: w.scrollTop + t.getBoundingClientRect().top - w.getBoundingClientRect().top, behavior: 'instant' }); })()`);
    await sleep(450);
    const img = await win.capturePage(undefined, { stayHidden: true });
    assert(!img.isEmpty(), 'Empty capture');
    const file = path.join(out, `${name}.png`);
    fs.writeFileSync(file, img.toPNG());
    report.captures.push({ file, size: img.getSize() });
  };
  const text = () => run("document.querySelector('[data-models-section=library]').innerText.replace(/\\s+/g,' ')");
  try {
    await win.loadFile(path.join(out, 'index.html'));
    // The offer scenarios run on both revisions: the same data, with and without part C's line.
    for (const scenario of baseline ? ['before', 'offerOld', 'offerCurrent'] : ['managed', 'external', 'offerOld', 'offerCurrent']) {
      await run(`fixture.mount('${scenario}')`);
      await wait("!!document.querySelector('[data-model-family=ternarybonsai227b]')");
      // The family list says what the Bonsai family can do; then its rows say why.
      await capture(`${scenario}-families-dark`, 'dark');
      await run("document.querySelector('[data-model-family=ternarybonsai227b]').click()");
      await wait("!!document.querySelector('[data-library-row=ptq1]')");
      if (!baseline && scenario.startsWith('offer')) await wait("!!document.querySelector('[data-runnable-alternative]')");
      if (!scenario.startsWith('offer')) report.checks.push({ scenario, offerShown: !!(await run("document.querySelector('[data-runnable-alternative]')")) });
      await capture(`${scenario}-rows-dark`, 'dark');
      await capture(`${scenario}-rows-light`, 'light');
      report.checks.push({ scenario, text: await text() });
      if (!baseline && scenario === 'offerOld') {
        // The Variants list: opening the page read nothing (size-based fit), then opening two builds reads just those.
        const variants = "[...document.querySelectorAll('h2')].find(h => h.textContent.trim() === 'Variants')";
        const scrollToVariants = async () => { await run(`(() => { const h = ${variants}; h.scrollIntoView({ block: 'start' }); })()`); await sleep(450); };
        await scrollToVariants();
        const shot = async name => { const img = await win.capturePage(undefined, { stayHidden: true }); const file = path.join(out, `${name}.png`); fs.writeFileSync(file, img.toPNG()); report.captures.push({ file, size: img.getSize() }); };
        report.checks.push({ variants: 'unread', badges: await run("[...document.querySelectorAll('[data-build-check]')].length") });
        await shot('variants-unread-light');
        for (const label of ['PTQ1_0', 'Q2_0']) {
          await run(`[...document.querySelectorAll('h2')].find(h => h.textContent.trim() === 'Variants').parentElement.querySelectorAll('.divide-y > div').forEach(r => { if (r.querySelector('span.font-mono')?.textContent === '${label}') r.click(); })`);
          await sleep(500);
        }
        await scrollToVariants();
        report.checks.push({ variants: 'read', badges: await run("[...document.querySelectorAll('[data-build-check]')].map(b => b.textContent)") });
        await shot('variants-read-light');
      }
    }
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  win.destroy(); app.exit(report.errors.length ? 1 : 0);
});
