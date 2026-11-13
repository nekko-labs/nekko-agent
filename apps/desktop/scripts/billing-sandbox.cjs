// Hidden, isolated evidence for Plan & billing in Settings > Sync (#2724):
// billing off, Free with billing on for a team account (Upgrade and the team
// switch), and Pro (Manage billing). Never contacts a host; Stripe is never opened.
// NEKKO_LAYOUT_SANDBOX=billing-sandbox.cjs node apps/desktop/scripts/layout-evidence-integration.cjs
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const js = (v) => JSON.stringify(v).replace(/[<>/\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], checks: [], errors: [] };
const sync = { phase: 'needs-plan', enabled: false, includeLocalOnly: false, recoveryConfirmed: false, keyEpoch: null, lastSyncAt: null, error: null, progress: null, chats: 0, pushed: 0, pulled: 0, skipped: {}, fingerprint: null, joinCode: null, devices: [], usage: null };
const status = (account) => ({ signedIn: true, account: { email: 'philip@nekkolabs.com', canSync: account.plan !== 'free', ...account }, oauthPending: false, keysStoredIn: 'macOS Keychain', orgs: null, sync: { ...sync, phase: account.plan === 'free' ? 'needs-plan' : 'off' } });
const scenarios = [
  ['billing-off', status({ plan: 'free', staff: false, features: { billing: false } })],
  ['billing-team-free', status({ plan: 'free', staff: true, features: { billing: true } })],
  ['billing-pro', status({ plan: 'pro', staff: false, features: { billing: true } })],
];
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1200, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') console.error(e.message.slice(0, 500)); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const shot = async name => { const f = path.join(out, `${name}.png`); fs.writeFileSync(f, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(f); };
  const check = async (name, expression) => { const ok = await run(expression); report.checks.push({ name, ok }); if (!ok) throw Error(name); };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 100 && !(await run('!!window.layoutFixture')); i++) await sleep(100);
    for (const [name, s] of scenarios) {
      await run(`(() => { const f = layoutFixture; const s = ${js(s)};
        f.bridge.cloudStatus = async () => s; f.bridge.cloudRefresh = async () => s;
        f.bridge.cloudBillingPlans = async () => ({ plans: [{ id: 'pro', amount: 1200, currency: 'usd', interval: 'month' }] });
        f.bridge.cloudTeamFeatures = async () => ({ features: { billing: 'team' }, available: ['billing'] });
        f.bridge.cloudBillingCheckout = async () => { window.checkout = true; return { url: 'https://checkout.stripe.com/c/test' }; };
        f.bridge.openPath = async (u) => { window.opened = u; };
        f.store.setState({ view: 'chat' }); })()`);
      await sleep(300);
      await run("layoutFixture.store.setState({ view: 'settings' })");
      await sleep(1200);
      await run("document.querySelector('#sync').scrollIntoView({ block: 'start' })"); await sleep(300);
      await shot(name);
      if (name === 'billing-off') {
        await check('no plan row or team switch while billing is off', "!document.querySelector('[data-testid=billing-plan]') && !document.querySelector('[data-testid=team-switches]')");
      }
      if (name === 'billing-team-free') {
        await check('price shown', "document.querySelector('[data-testid=billing-price]')?.textContent === '$12 a month'");
        await check('team switch on Team only', "document.querySelector('[data-testid=team-switches] [aria-checked=true]')?.textContent === 'Team only'");
        await run("document.querySelector('[data-testid=billing-upgrade]').click()"); await sleep(300);
        await check('Upgrade opens Stripe Checkout in the browser', "window.checkout === true && window.opened === 'https://checkout.stripe.com/c/test'");
      }
      if (name === 'billing-pro') {
        await check('Manage billing on a paid plan, no team switch', "!!document.querySelector('[data-testid=billing-manage]') && !document.querySelector('[data-testid=team-switches]')");
      }
    }
    report.bounds = win.getBounds(); report.visible = win.isVisible();
    if (report.visible) throw Error('fixture became visible');
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.errors.length ? 1 : 0);
});
