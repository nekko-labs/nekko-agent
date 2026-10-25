// Hidden renderer-only evidence for chat artifact cards: a reply linking an
// HTML prototype, a localhost preview server and an image, in dark and light.
// Launch through layout-evidence-integration.cjs with
// NEKKO_LAYOUT_SANDBOX=chat-artifacts-evidence-sandbox.cjs. Never shows or
// focuses a window, never reads host files (readFile is stubbed in the page).
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Use layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'chat-artifacts-profile'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { source: process.env.NEKKO_TEST_SOURCE || 'worktree', captures: [], metrics: {}, errors: [] };

const html = `<!doctype html><html><head><style>
body{margin:0;font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0}
nav{display:flex;justify-content:space-between;padding:28px 64px;font-weight:600}
.hero{padding:96px 64px 48px;max-width:900px}.hero h1{font-size:64px;line-height:1.05;margin:0 0 20px}
.hero p{font-size:22px;color:#94a3b8;margin:0 0 32px}.cta{display:inline-block;background:#f97316;color:#111;padding:16px 28px;border-radius:12px;font-weight:700}
.tiers{display:grid;grid-template-columns:repeat(3,1fr);gap:24px;padding:24px 64px}.tier{background:#1e293b;border-radius:18px;padding:28px;font-size:18px}
.tier b{display:block;font-size:40px;margin:12px 0}
</style></head><body><nav><span>Acme Cloud</span><span>Pricing · Docs · Sign in</span></nav>
<section class="hero"><h1>Simple pricing for every team</h1><p>Start free, scale when you need to. No surprises on your bill.</p><span class="cta">Start free trial</span></section>
<section class="tiers"><div class="tier">Starter<b>$0</b>For side projects</div><div class="tier">Team<b>$24</b>Per seat, per month</div><div class="tier">Scale<b>Custom</b>For large orgs</div></section>
<script>document.body.style.background='red'</script></body></html>`;
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="400" viewBox="0 0 960 400"><defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#f97316"/><stop offset="1" stop-color="#7c3aed"/></linearGradient></defs><rect width="960" height="400" fill="url(#g)"/><text x="60" y="220" font-family="sans-serif" font-size="64" font-weight="700" fill="#fff">Hero render</text></svg>';
const reply = [
  'The pricing page prototype is ready: [Pricing page prototype](C:/demo/prototypes/pricing/index.html).',
  '',
  'The dev server is running, so you can click around the live version at [Pricing on the dev server](http://localhost:5173/pricing).',
  '',
  'I also exported the hero illustration:',
  '',
  '![Hero render](C:/demo/prototypes/pricing/hero.svg)',
].join('\n');

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:|about:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const displays = screen.getAllDisplays();
  const win = new BrowserWindow({ width: 1440, height: 1100, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: Math.min(...displays.map(d => d.bounds.x)) - 1700, y: Math.min(...displays.map(d => d.bounds.y)) - 1200, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const run = code => win.webContents.executeJavaScript(code, true);
  win.on('focus', () => report.errors.push('Window received focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 300)); });
  const capture = async name => {
    if (win.isVisible() || win.isFocused()) report.errors.push(`${name}: window visible or focused`);
    // A hidden window can hand back its last frame; ask for a fresh one first.
    win.webContents.invalidate();
    await wait(400);
    const file = path.join(out, `${name}.png`);
    fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG());
    report.captures.push(file);
  };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 80 && !await run('!!window.layoutFixture && !!document.querySelector("[data-command-wall]")'); i++) await wait(100);
    await wait(500);
    await run(`(() => {
      const f = window.layoutFixture;
      const files = { 'C:/demo/prototypes/pricing/index.html': ${JSON.stringify(html)}, 'C:/demo/prototypes/pricing/hero.svg': ${JSON.stringify(svg)} };
      // The desktop preload's isolated-preview bridge, stubbed so the Interactive action shows.
      window.nekkoPreview = { open: async () => {} };
      f.bridge.readFile = async p => files[p] != null ? { content: files[p], binary: false, truncated: false } : Promise.reject(new Error('missing'));
      const s = f.records[0];
      s.messages = [
        { id: 'u1', role: 'user', content: 'Build a pricing page prototype and start the dev server.', createdAt: Date.now() - 60000 },
        { id: 'a1', role: 'assistant', content: ${JSON.stringify(reply)}, createdAt: Date.now() - 30000 },
      ];
      f.putCachedSession(s);
      f.store.getState().openChatPane(s.id);
      // Room for the chat: no Monitors dock beside it.
      const st = f.store.getState();
      f.store.setState({ settings: { ...st.settings, commandWall: { ...(st.settings.commandWall || {}), dock: { ...((st.settings.commandWall || {}).dock || {}), show: false } } } });
    })()`);
    await wait(500);
    // The Focused wall shows one agent: pick this chat from its list (a DOM click, not OS input).
    report.metrics.picked = await run(`(() => {
      const hit = [...document.querySelectorAll('button,[role="button"],a,[tabindex]')].find(e => e.textContent.includes('Persist quota history') || e.textContent.includes('Persist qu'));
      if (hit) hit.click();
      return hit ? hit.tagName + ' ' + hit.className.slice(0, 80) : null;
    })()`);
    for (let i = 0; i < 50 && !await run('!!document.querySelector(\'[aria-label="Response artifacts"]\')'); i++) await wait(100);
    await wait(3000);
    // Animations and transitions stay paused in a hidden window (the wall's entry, the theme switch); settle them.
    await win.webContents.insertCSS('*,*::before,*::after{animation:none!important;transition:none!important}');
    await wait(300);
    report.metrics.fade = await run(`(() => { const out = []; for (let e = document.querySelector('[aria-label="Response artifacts"]'); e; e = e.parentElement) { const c = getComputedStyle(e); if (c.opacity !== '1' || c.transform !== 'none' || c.filter !== 'none' || c.animationName !== 'none') out.push({ tag: e.tagName, cls: String(e.className).slice(0, 90), opacity: c.opacity, transform: c.transform, filter: c.filter, anim: c.animationName, state: c.animationPlayState }); } return out; })()`);
    // The first frame after the settle can still be the paused animation's; discard one.
    await win.capturePage(undefined, { stayHidden: true });
    await wait(600);
    for (const theme of ['dark', 'light']) {
      await run(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
      await wait(600);
      report.metrics[theme] = await run(`(() => {
        const cards = [...document.querySelectorAll('[aria-label="Response artifacts"] > *')].map(e => ({ cls: e.className.slice(0, 60), text: e.textContent.slice(0, 80), h: Math.round(e.getBoundingClientRect().height) }));
        const frame = document.querySelector('[data-render-thumb] iframe');
        return { cards, thumbnail: frame ? { sandbox: frame.getAttribute('sandbox'), w: frame.getBoundingClientRect().width } : null };
      })()`);
      await capture(`chat-artifacts-${theme}`);
    }
  } catch (e) { report.errors.push(String(e && e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.captures.length ? 0 : 1);
});
