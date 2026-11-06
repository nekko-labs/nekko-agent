// Real renderer, synthetic terminal metadata. Hidden isolated Electron, no host/network.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Use layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'terminal-profile'));
app.on('window-all-closed', () => {});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const baseline = !!process.env.NEKKO_TERMINAL_BASELINE;
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const run = s => win.webContents.executeJavaScript(s, true);
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 100 && !await run('!!window.layoutFixture'); i++) await sleep(100);
    await sleep(900);
    await run(`(async () => {
      const f = layoutFixture;
      const settings = await window.nekko.updateSettings({firstPromptIntroSeen:true,showTips:false});
      const terminals = [
        {id:'term-claude',title:'zsh',shell:'/bin/zsh',cwd:'/projects/example',running:true,createdAt:Date.now(),activity:{title:'Fix login redirect',state:'running',detail:'Claude Code · Edit',pullRequestUrl:'https://github.com/example/project/pull/42'}},
        {id:'term-tests',title:'Tests',shell:'/bin/zsh',cwd:'/projects/example',running:false,exitCode:1,createdAt:Date.now()},
      ];
      f.terminals = terminals;
      f.bridge.listTerminals = async () => structuredClone(terminals);
      f.bridge.terminalSnapshot = async id => ({info:terminals.find(t=>t.id===id),buffer:'$ claude\\r\\nWorking on login redirect…\\r\\n',cols:100,rows:30});
      f.bridge.getPrInfo = async () => ({url:terminals[0].activity.pullRequestUrl,number:42,title:'Fix login redirect',state:'open',checks:'passing',source:'gh'});
      f.store.setState({settings,terminals:structuredClone(terminals)});
      f.store.getState().openTerminalPane('term-claude');
    })()`);
    await sleep(1200);
    for (let i = 0; i < 4; i++) { await run("document.querySelector('[role=dialog] [aria-label=Close]')?.click()"); await sleep(200); }
    await run("document.querySelector('[aria-label=\"Show agents in a column\"]')?.click()");
    await sleep(700);
    await run("document.querySelector('[data-terminal-row=\"term-claude\"]')?.click() || document.querySelector('.agent-chip[title=\"zsh\"]')?.click()");
    await sleep(800);
    fs.writeFileSync(path.join(out, 'terminal-rows.png'), (await win.capturePage(undefined, { stayHidden: true })).toPNG());
    await run("document.querySelector('[aria-label=\"Show agents in a row\"]')?.click()"); await sleep(500);
    fs.writeFileSync(path.join(out, 'terminal-horizontal-working.png'), (await win.capturePage(undefined, {stayHidden:true})).toPNG());
    await run("document.querySelector('[aria-label=\"Show agents in a column\"]')?.click()"); await sleep(500);
    const report = { baseline, checks: [] };
    if (!baseline) {
      const rows = await run("[...document.querySelectorAll('[data-terminal-row]')].map(e=>e.dataset.terminalRow)");
      assert.deepEqual(rows.sort(), ['term-claude','term-tests']); report.checks.push('Exactly one row per terminal, including unanchored exited terminal');
      await run("document.querySelector('[data-terminal-row=\"term-claude\"]').click()"); await sleep(350);
      assert(await run("document.querySelector('[data-terminal-row=\"term-claude\"]').hasAttribute('data-agent-active')")); report.checks.push('Click focuses and selects terminal');
      assert(await run("!!document.querySelector('[data-terminal-context]')"));
      await run("document.querySelector('[aria-label=\"Refresh pull request status\"]').click()"); await sleep(200);
      assert((await run("document.querySelector('[data-terminal-context]').textContent")).includes('passing')); report.checks.push('Explicit PR lookup displays fetched state/checks');
      await run("layoutFixture.terminals[0] = {...layoutFixture.terminals[0],activity:{...layoutFixture.terminals[0].activity,state:'attention',detail:'Claude Code needs permission'}}");
      const frames = [];
      for (let i = 0; i < 20; i++) {
        frames.push((await win.capturePage({x:55,y:65,width:1100,height:255}, {stayHidden:true})).resize({width:1100}).toPNG());
        await sleep(200);
      }
      require('./evidence-gif.cjs')(path.join(out, 'terminal-status.gif'), frames, 20);
      for (let i = 0; i < 60 && !(await run("document.querySelector('[data-terminal-context]')?.textContent")).includes('Needs attention'); i++) await sleep(100);
      assert((await run("document.querySelector('[data-terminal-context]').textContent")).includes('Needs attention')); report.checks.push('Metadata updates without remount');
      fs.writeFileSync(path.join(out, 'terminal-attention.png'), (await win.capturePage(undefined, { stayHidden: true })).toPNG());
      await run("document.querySelector('[aria-label=\"Show agents in a row\"]')?.click()"); await sleep(500);
      fs.writeFileSync(path.join(out, 'terminal-horizontal.png'), (await win.capturePage(undefined, { stayHidden: true })).toPNG());
      await run(`(() => {
        const f = layoutFixture;
        f.bridge.createTerminal = async () => {
          const t = {id:'term-new',title:'New shell',shell:'/bin/zsh',cwd:'/projects/example',running:true,createdAt:Date.now()};
          f.terminals.push(t); return structuredClone(t);
        };
        f.bridge.closeTerminal = async id => { const i = f.terminals.findIndex(t=>t.id===id); if(i>=0) f.terminals.splice(i,1); };
        f.store.setState({settings:{...f.store.getState().settings,skipDeleteConfirmation:false}});
      })()`);
      await run("layoutFixture.store.getState().newTerminalWorkspace()"); await sleep(300);
      assert(await run("!!document.querySelector('[data-terminal-row=\"term-new\"]')"));
      report.checks.push('Creating a terminal through the real store produces its own row');
      await run("document.querySelector('[data-terminal-row=\"term-new\"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))"); await sleep(300);
      assert(await run("document.querySelector('[data-terminal-row=\"term-new\"]').hasAttribute('data-agent-active')"));
      report.checks.push('Enter selects the terminal');
      await run("document.querySelector('[aria-label=\"Close New shell\"]').click()"); await sleep(150);
      assert(await run("!!document.querySelector('#delete-confirm-title')"));
      await run("[...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent==='Cancel').click()"); await sleep(150);
      assert(await run("!!document.querySelector('[data-terminal-row=\"term-new\"]')"));
      await run("document.querySelector('[aria-label=\"Close New shell\"]').click()"); await sleep(150);
      await run("[...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent==='Delete').click()"); await sleep(300);
      assert(await run("!document.querySelector('[data-terminal-row=\"term-new\"]')"));
      report.checks.push('Running terminal close can be canceled; confirmation removes the row');

    }
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report,null,2));
    console.log(JSON.stringify(report));
  } finally { win.destroy(); app.quit(); }
}).catch(e => { console.error(e); app.exit(1); });
