// Settings/Skills/Connectors panel-surface evidence for PR #1661: before/after
// screenshots that show the Settings view adopting the Agents wall's --paper
// background with floating --win cards. Three themes (nekko-dark, light,
// nebula) at 1440x900 cover enough palette space to prove the restyle is
// token-driven, not theme-specific. Run through layout-evidence-integration.cjs
// (NEKKO_TEST_SOURCE=<main checkout> for "before"). Hidden, non-focusable,
// off-screen; captures with stayHidden so no pixels reach any display.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
app.setPath('sessionData', path.join(out, 'profile'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { captures: [], errors: [] };
const THEMES = [
  { id: 'nekko-dark', mode: 'dark' },
  { id: 'light', mode: 'light' },
  { id: 'nebula', mode: 'dark' },
];
const VIEWS = ['settings', 'skills', 'connectors'];
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const minX = Math.min(...screen.getAllDisplays().map((d) => d.bounds.x));
  const minY = Math.min(...screen.getAllDisplays().map((d) => d.bounds.y));
  // Far off-screen in the "up-left" direction: even if a display is at 0,0 the
  // window sits well outside its rect; show:false keeps it hidden regardless.
  const win = new BrowserWindow({
    width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true,
    x: minX - 4000, y: minY - 4000,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  win.on('show', () => report.errors.push('Window became visible'));
  win.on('focus', () => report.errors.push('Window took focus'));
  win.webContents.on('console-message', (e) => { if (e.level === 'error') report.errors.push(e.message.slice(0, 300)); });
  const run = (s) => win.webContents.executeJavaScript(s, true);
  // Double-capture pattern: the first capturePage forces a paint; the second
  // (after a short sleep) is the one we keep. Without this, the first shot in
  // a theme/view loop can land on the previous frame.
  const shot = async (name) => {
    await win.capturePage(undefined, { stayHidden: true });
    await sleep(250);
    const file = path.join(out, name + '.png');
    fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG());
    report.captures.push(file);
  };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    // Mount check: the fixture's App renders the sidebar rail and command wall.
    for (let i = 0; i < 60 && !(await run("!!document.querySelector('.rail') && !!document.querySelector('[data-command-wall]')")); i++) await sleep(200);
    // Seed the stubs the Settings page wants: unseeded, several sections throw
    // from undefined inputs and render their ErrorBoundary fallback, which
    // would wash the panel surface change out of the shot.
    await run(`(async () => {
      const b = layoutFixture.bridge;
      b.getRemoteStatus = async () => ({ enabled: false, online: false, devices: [], connected: [] });
      b.listConnectors = async () => [];
      b.getMessagingStatus = async () => ({ telegram: {}, discord: {}, slack: {} });
      b.telemetryStatus = async () => ({ configured: false });
      b.oauthStatus = async () => ({ connected: false });
      b.listModelsStatus = async () => ({ models: [] });
      b.testProvider = async () => ({ ok: true });
      b.listProviderModels = async () => [];
      await b.updateSettings({ guardrails: [], hooks: [] });
    })()`);
    await sleep(300);
    // Settings destinations need Skills/Connectors visible in the nav chips: the
    // fixture's stub bridge is OK, and setView('skills'|'connectors') routes
    // through the same SettingsDestination wrapper either way.
    for (const theme of THEMES) {
      // Route through updateSettings so the stub's backing object mirrors the
      // new theme too: SettingsView re-fetches via getSettings on mount, which
      // would otherwise restore the original 'dark' and erase the preset.
      await run(`(async () => {
        await layoutFixture.bridge.updateSettings({ theme: ${JSON.stringify(theme.mode)}, themePreset: ${JSON.stringify(theme.id)} });
        const s = layoutFixture.store.getState();
        layoutFixture.store.setState({ settings: { ...s.settings, theme: ${JSON.stringify(theme.mode)}, themePreset: ${JSON.stringify(theme.id)} } });
        s.applyTheme();
      })()`);
      await sleep(400);
      // Sanity: confirm --paper resolved AND the DOM painted it on the surface.
      report[`probe-${theme.id}`] = await run(`(() => {
        const cs = getComputedStyle;
        const r = document.documentElement;
        return {
          dataTheme: r.getAttribute('data-theme'),
          dataPreset: r.getAttribute('data-preset'),
          paper: cs(r).getPropertyValue('--paper').trim(),
          win: cs(r).getPropertyValue('--win').trim(),
          bodyBg: cs(document.body).backgroundColor,
          mainBg: cs(document.querySelector('main') || document.body).backgroundColor,
        };
      })()`);
      for (const view of VIEWS) {
        await run(`layoutFixture.store.getState().setView(${JSON.stringify(view)})`);
        // Wait for the store AND for the destination's lazy content to settle;
        // 700ms was too fast on cold loads and the first shot of a theme could
        // land on the previous frame.
        for (let i = 0; i < 20; i++) {
          const ok = await run(`layoutFixture.store.getState().view === ${JSON.stringify(view)}`);
          if (ok) break;
          await sleep(100);
        }
        await sleep(900);
        const label = view === 'settings' ? 'settings-general' : view;
        await shot(`settings-panel-surface__${label}__${theme.id}`);
      }
    }
    // Bonus: Models workspace on nekko-dark, since the same CSS rule covers it.
    await run(`(() => {
      const s = layoutFixture.store.getState();
      layoutFixture.store.setState({ settings: { ...s.settings, theme: 'dark', themePreset: 'nekko-dark' } });
      s.applyTheme();
    })()`);
    await sleep(300);
    await run(`layoutFixture.store.getState().setView('models')`);
    await sleep(1000);
    await shot(`settings-panel-surface__models__nekko-dark`);
    report.bounds = win.getBounds();
    report.hidden = !win.isVisible();
    report.focused = win.isFocused();
    if (!report.hidden || report.focused) throw Error('Isolation failed: window became visible or focused');
    report.success = true;
  } catch (e) {
    report.errors.push(String((e && e.stack) || e));
    report.success = false;
  } finally {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    try { win.destroy(); } catch {}
    app.exit(report.success && report.captures.length ? 0 : 1);
  }
});
