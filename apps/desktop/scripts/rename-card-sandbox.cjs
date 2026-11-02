// Hidden synthetic desktop evidence: renaming a chat from its card in the
// agents list (#1522), by the pencil beside the X and by the right-click menu.
// No user profile, host, model or network.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Use layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
app.setPath('sessionData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((r, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(r.url) }));
  session.defaultSession.setPermissionRequestHandler((_c, _p, done) => done(false));
  const report = { checks: [], errors: [] };
  const check = (name, passed) => report.checks.push({ name, passed: !!passed });
  const win = new BrowserWindow({ width: 1280, height: 860, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: Math.min(...screen.getAllDisplays().map(d => d.bounds.x)) - 3000, y: -2000, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  const run = js => win.webContents.executeJavaScript(js, true);
  const capture = async name => {
    await sleep(400);
    fs.writeFileSync(path.join(out, name + '.png'), (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG());
  };
  const cardTitle = title => title;
  const centreByTitle = async (title) => run(`(() => { const el = [...document.querySelectorAll('div[role="button"]')].find(c => c.getAttribute('title') === ${JSON.stringify(title)}); const r = el?.getBoundingClientRect(); return r ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null; })()`);
  const key = async (keyCode) => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode }); await sleep(250); };
  const field = `document.querySelector('input[aria-label="Chat title"]')`;
  try {
    await win.loadFile(path.join(out, 'index.html'));
    await sleep(1600);
    await run(`document.querySelector('.zones-intro button[aria-label="Close"]')?.click()`);
    await sleep(1500);
    await run(`(() => { const f = layoutFixture; window.renames = []; f.bridge.setSessionOptions = async (id, p) => { renames.push({ id, ...p }); const s = f.records.find(s => s.id === id); Object.assign(s, p); return { ...s }; }; })()`);

    // The pencil shows beside the X on hover.
    const first = await centreByTitle(cardTitle('Persist quota history'));
    check('the chat cards are listed', first);
    if (first) win.webContents.sendInputEvent({ type: 'mouseMove', x: first.x, y: first.y });
    await capture('rename-hover');
    const pencil = `document.querySelector('[aria-label="Rename Persist quota history"]')`;
    check('a pencil sits before the X on the card', await run(`(() => { const p = ${pencil}, x = document.querySelector('[aria-label="Complete Persist quota history"]'); return !!p && !!x && !!(p.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_FOLLOWING); })()`));

    // Pencil: the title becomes a field; typing and Enter save it.
    await run(`${pencil}?.click()`);
    await sleep(300);
    check('the pencil turns the title into a field', await run(`${field}?.value === 'Persist quota history'`));
    await capture('rename-editing');
    await run(`(() => { const f = ${field}; f?.focus(); f?.select(); })()`);
    win.webContents.insertText('Quota history, persisted');
    await sleep(150);
    await key('Enter');
    await sleep(600);
    check('Enter saves the typed title', await run(`JSON.stringify(renames) === JSON.stringify([{ id: 'a', title: 'Quota history, persisted' }])`));
    check('the card shows the new title', await run(`!!${card('Quota history, persisted')} && !${field}`));
    await capture('rename-saved');

    // Right-click: the menu offers Rename; Escape gives it up.
    const second = await centre(card('Diagnose failed build'));
    if (second) await run(`(${card('Diagnose failed build')}).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: ${second.x}, clientY: ${second.y} }))`);
    await sleep(300);
    const rename = `[...document.querySelectorAll('button, [role="menuitem"]')].find(b => b.textContent.trim() === 'Rename')`;
    check('the right-click menu offers Rename', await run(`!!${rename}`));
    await capture('rename-menu');
    await run(`${rename}?.click()`);
    await sleep(300);
    check('Rename turns the title into a field', await run(`${field}?.value === 'Diagnose failed build'`));
    await run(`(() => { const f = ${field}; f?.focus(); f?.select(); })()`);
    win.webContents.insertText('Something else');
    await sleep(150);
    await key('Escape');
    check('Escape keeps the title and saves nothing', await run(`renames.length === 1 && !!${card('Diagnose failed build')} && !${field}`));

    // Clicking away keeps what was typed.
    await run(`[...document.querySelectorAll('[aria-label="Rename Audit sandbox policy"]')][0]?.click()`);
    await sleep(300);
    await run(`(() => { const f = ${field}; f?.focus(); f?.select(); })()`);
    win.webContents.insertText('Sandbox policy audit');
    await sleep(150);
    // A hidden, non-focusable window never has page focus, so blur() and a
    // click elsewhere fire nothing: send the focusout a click away would.
    await run(`${field}?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))`);
    await sleep(600);
    check('clicking away saves the typed title', await run(`renames.length === 2 && renames[1].title === 'Sandbox policy audit' && !!${card('Sandbox policy audit')}`));
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.errors.length || report.checks.some(c => !c.passed) ? 1 : 0);
});
