const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through agent-chrome-integration.cjs');
const before = !!process.env.NEKKO_TEST_REVISION;
const runDir = path.join(out, new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(runDir, { recursive: true });
app.setPath('userData', path.join(runDir, 'profile'));
app.setPath('sessionData', path.join(runDir, 'profile'));
const report = { checks: [], errors: [], captures: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_wc, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1200, height: 860, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -10000, y: -10000, title: 'Synthetic agent chrome verification', webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  win.webContents.on('console-message', (e) => { if (e.level === 'error') report.errors.push(e.message); });
  const run = (s) => win.webContents.executeJavaScript(s, true);
  const check = async (name, expr) => { await sleep(200); if (!(await run(expr))) throw Error(name); report.checks.push(name); };
  const capture = async (name, rect) => { await sleep(400); const img = await win.webContents.capturePage(rect); const file = path.join(runDir, name + '.png'); fs.writeFileSync(file, img.toPNG()); report.captures.push(file); };
  const rectOf = async (sel, pad = 8) => run(`(()=>{const r=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();return {x:Math.max(0,Math.floor(r.x-${pad})),y:Math.max(0,Math.floor(r.y-${pad})),width:Math.ceil(r.width+${pad * 2}),height:Math.ceil(r.height+${pad * 2})};})()`);
  const selectAgent = () => run("document.querySelector('[data-wall-pane] .panel')?.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))");
  try {
    await win.loadFile(path.join(out, 'index.html')); win.showInactive(); await sleep(1200);
    await check('wall mounted', "!!document.querySelector('[data-command-wall]')");
    for (const theme of ['light', 'dark']) {
      await run(`document.documentElement.dataset.theme='${theme}'`);
      await run('integration.reset()'); await sleep(600); await selectAgent(); await sleep(600);
      await capture(`full-${theme}`);
      await capture(`title-strip-${theme}`, await rectOf('[data-wall-pane] .panel > div', 2));
      await capture(`effort-${theme}`, await rectOf('[data-wall-pane] .effort-slider', 12));
      if (!before) {
        await check(`${theme}: status dot leads the title, no status text`, "(()=>{const strip=document.querySelector('[data-wall-pane] .panel > div');const dot=strip.querySelector('[data-pane-status]');return !!dot&&dot.nextElementSibling.textContent==='Refactor wall chrome'&&!strip.querySelector('.pane-strip-badge').textContent.trim();})()");
        await check(`${theme}: subagents chip`, "document.querySelector('[data-subagents-running]')?.textContent==='2 subagents running'");
        await capture(`subagents-${theme}`, await rectOf('[data-subagents-running]', 40));
        await check(`${theme}: effort slider Low leftmost`, "(()=>{const i=document.querySelector('[data-wall-pane] #composer-effort');return i.max==='4'&&i.value==='1'&&i.getAttribute('aria-valuetext')==='Default · Medium';})()");
        await check(`${theme}: folder chip after +`, "(()=>{const c=document.querySelector('[data-wall-composer] [data-composer-access]');return !!c&&c.previousElementSibling?.querySelector('[aria-label^=\"Add a photo\"]')&&c.textContent.includes('2 folders · 1 file');})()");
        await run("document.querySelector('[data-wall-composer] [data-composer-access] button').click()"); await sleep(300);
        await check(`${theme}: dropdown lists all with toggles`, "document.querySelectorAll('[aria-label=\"Folder access\"] [role=switch]').length===3");
        await capture(`folder-dropdown-${theme}`, await run("(()=>{const a=document.querySelector('[data-wall-composer] [data-composer-access]').getBoundingClientRect();const d=document.querySelector('[aria-label=\"Folder access\"]').getBoundingClientRect();const x=Math.floor(Math.min(a.x,d.x)-12),y=Math.floor(d.y-12);return {x,y,width:Math.ceil(Math.max(a.right,d.right)-x+60),height:Math.ceil(a.bottom-y+12)};})()"));
        if (theme === 'light') {
          await check('switches enabled while the agent itself is idle', "[...document.querySelectorAll('[aria-label=\"Folder access\"] [role=switch]')].every(s=>!s.disabled)");
          await run("document.querySelectorAll('[aria-label=\"Folder access\"] [role=switch]')[1].click()"); await sleep(400);
          await check('removing docs updates only supporting folders', "(()=>{const s=integration.records()[0];return s.workspaceId==='ws-a'&&s.supportingWorkspaceIds.length===0&&s.attachedPaths.length===1;})()");
          await check('removed row stays listed, switched off', "document.querySelectorAll('[aria-label=\"Folder access\"] [role=switch]').length===3&&document.querySelectorAll('[aria-label=\"Folder access\"] [role=switch][aria-checked=false]').length===1");
          await capture('folder-dropdown-removed-light', await run("(()=>{const a=document.querySelector('[data-wall-composer] [data-composer-access]').getBoundingClientRect();const d=document.querySelector('[aria-label=\"Folder access\"]').getBoundingClientRect();const x=Math.floor(Math.min(a.x,d.x)-12),y=Math.floor(d.y-12);return {x,y,width:Math.ceil(Math.max(a.right,d.right)-x+60),height:Math.ceil(a.bottom-y+12)};})()"));
          await run("document.querySelectorAll('[aria-label=\"Folder access\"] [role=switch]')[1].click()"); await sleep(400);
          await check('re-including restores the folder', "integration.records()[0].supportingWorkspaceIds.join()==='ws-b'");
        }
        await run("document.body.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))"); await sleep(200);
      } else {
        await capture(`composer-${theme}`, await rectOf('[data-wall-composer]', 2));
      }
      if (!before) await capture(`composer-${theme}`, await rectOf('[data-wall-composer]', 2));
    }
    report.success = true;
  } catch (e) { report.errors.push(String(e && e.stack || e)); report.success = false; process.exitCode = 1; }
  finally { fs.writeFileSync(path.join(runDir, 'status.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ runDir, ...report }, null, 2)); win.destroy(); app.exit(report.success ? 0 : 1); }
});
