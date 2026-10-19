// Captures the workflow editor in a hidden, non-focusable, off-screen window
// with its own profile and every non-local request cancelled.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const dir = process.env.NEKKO_EVIDENCE_DIR, kind = process.env.NEKKO_EVIDENCE_KIND;
const profile = fs.mkdtempSync(path.join(dir, 'profile-'));
app.setPath('userData', profile); app.setPath('sessionData', profile);
const report = { kind, checks: [], errors: [], captures: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((r, done) => done({ cancel: !/^(file:|data:|blob:)/.test(r.url) }));
  session.defaultSession.setPermissionRequestHandler((w, p, d) => d(false));
  const left = Math.min(...screen.getAllDisplays().map((d) => d.bounds.x));
  const win = new BrowserWindow({ width: 1280, height: 1500, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: left - 5000, y: -3000, webPreferences: { contextIsolation: true, sandbox: true } });
  win.on('focus', () => report.errors.push('OS focus taken'));
  win.webContents.on('console-message', (e) => { if (e.level === 'error') report.errors.push(e.message); });
  const run = (s) => win.webContents.executeJavaScript(s, true);
  const settle = async () => { await run('document.fonts.ready'); await sleep(400); };
  const capture = async (name) => { await settle(); const img = await win.capturePage(undefined, { stayHidden: true }); const file = path.join(dir, name + '.png'); fs.writeFileSync(file, img.toPNG()); report.captures.push(file); };
  const check = async (name, s) => { try { report.checks.push({ name, passed: !!(await run(s)) }); } catch (e) { report.checks.push({ name, passed: false, error: String(e) }); } };
  try {
    await win.loadFile(path.join(dir, 'index.html')); win.showInactive(); await settle();
    for (const theme of ['light', 'dark']) {
      await run(`document.documentElement.dataset.theme='${theme}'`);
      await run(`document.querySelector('.card').scrollTop=0`);
      await capture(`${kind}-editor-${theme}`);
      if (kind === 'after') {
        await check(theme + ' run settings section', `!!document.querySelector('[data-wf-run-settings]')`);
        await check(theme + ' local only toggle on', `document.querySelector('[data-wf-local-only]').checked`);
        await check(theme + ' tool access select', `document.querySelector('[data-wf-tool-access]').value==='read'`);
        await check(theme + ' auto-deny note', `document.body.innerText.includes('Approvals are denied automatically')`);
        await check(theme + ' non-local step warns', `document.body.innerText.includes('is not local')`);
        await check(theme + ' canvas names the override', `document.querySelector('[data-step-model]')?.innerText.includes('Claude Sonnet')||document.querySelector('[data-step-model]')?.innerText.includes('claude-sonnet')`);
        await run(`document.querySelector('[data-wf-steps]').scrollIntoView()`);
        await capture(`${kind}-steps-${theme}`);
      }
    }
    if (kind === 'after') {
      // Allowlist: switch access and confirm the per-step field appears.
      await run(`(()=>{const s=document.querySelector('[data-wf-tool-access]');const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;set.call(s,'allowlist');s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
      await settle();
      await check('allowlist shows allowed tools field', `document.querySelectorAll('[data-step-allowed-tools]').length===2`);
      await run(`document.querySelector('[data-step-allowed-tools]').scrollIntoView({block:'center'})`);
      await capture(`${kind}-allowlist-dark`);
    }
    report.background = { focused: win.isFocused(), bounds: win.getBounds() };
  } catch (e) { report.errors.push(String(e)); }
  finally { fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(report, null, 2)); console.log(kind, JSON.stringify({ failed: report.checks.filter((c) => !c.passed), passed: report.checks.filter((c) => c.passed).length, errors: report.errors })); win.destroy(); app.exit(report.errors.length ? 1 : 0); }
});
