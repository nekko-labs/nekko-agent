import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { runInNewContext } from 'node:vm';
import { analyticsConfig, build } from './build-docs.mjs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const analyticsSource = read('apps/website/analytics.js');

class FakeStorage {
  constructor(values = {}, broken = false) {
    this.values = new Map(Object.entries(values));
    this.broken = broken;
  }
  get length() { return this.values.size; }
  getItem(key) { if (this.broken) throw new Error('blocked'); return this.values.get(key) ?? null; }
  setItem(key, value) { if (this.broken) throw new Error('blocked'); this.values.set(key, String(value)); }
  removeItem(key) { if (this.broken) throw new Error('blocked'); this.values.delete(key); }
  key(index) { return [...this.values.keys()][index] ?? null; }
}

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.hidden = false;
    this.id = '';
    this.className = '';
    this.type = '';
    this.rel = '';
    this.href = '';
    this.src = '';
    this.async = false;
    this.crossOrigin = '';
    this._text = '';
  }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  insertBefore(child) { return this.appendChild(child); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((node) => node !== this); }
  setAttribute(name, value = '') { this.attributes.set(name, String(value)); if (name === 'id') this.id = String(value); if (name === 'class') this.className = String(value); }
  getAttribute(name) { if (name === 'id') return this.id || null; if (name === 'class') return this.className || null; return this.attributes.get(name) ?? null; }
  addEventListener(name, fn) { this.listeners.set(name, fn); }
  focus() { this.focused = true; }
  closest(selector) {
    let node = this;
    while (node) {
      if (selector.split(',').some((part) => node.matches(part.trim()))) return node;
      node = node.parentNode;
    }
    return null;
  }
  matches(selector) {
    if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
    if (selector.startsWith('[') && selector.endsWith(']')) return this.attributes.has(selector.slice(1, -1));
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }
  querySelector(selector) {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
  set textContent(value) { this._text = String(value); if (value === '') this.children = []; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
  set innerHTML(value) {
    this.children = [];
    if (!String(value).includes('privacy-panel')) return;
    const panel = this.appendChild(new FakeElement('section'));
    panel.className = 'privacy-panel';
    const close = panel.appendChild(new FakeElement('button'));
    close.className = 'privacy-close'; close.setAttribute('data-privacy-close');
    const kicker = panel.appendChild(new FakeElement('p')); kicker.className = 'privacy-kicker';
    const title = panel.appendChild(new FakeElement('h2')); title.id = 'nekko-privacy-title'; title.setAttribute('data-privacy-title');
    const copy = panel.appendChild(new FakeElement('p')); copy.setAttribute('data-privacy-copy');
    const note = panel.appendChild(new FakeElement('p')); note.className = 'privacy-note'; note.setAttribute('data-privacy-note');
    const actions = panel.appendChild(new FakeElement('div')); actions.className = 'privacy-actions'; actions.setAttribute('data-privacy-actions');
    const link = panel.appendChild(new FakeElement('a')); link.className = 'privacy-policy-link'; link.href = '/privacy#website-analytics';
    const manage = this.appendChild(new FakeElement('button')); manage.className = 'privacy-manage'; manage.hidden = true;
  }
}

function fakeDocument() {
  const document = {
    head: new FakeElement('head'),
    body: new FakeElement('body'),
    listeners: new Map(),
    cookie: '',
    createElement: (tag) => new FakeElement(tag),
    addEventListener(name, fn) { this.listeners.set(name, fn); },
    getElementById(id) { return this.head.querySelector(`#${id}`) || this.body.querySelector(`#${id}`); },
  };
  const scriptParent = new FakeElement('head');
  const anchor = scriptParent.appendChild(new FakeElement('script'));
  document.getElementsByTagName = (name) => name === 'script' ? [anchor] : [];
  const originalMatches = FakeElement.prototype.matches;
  FakeElement.prototype.matches = function (selector) {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    return originalMatches.call(this, selector);
  };
  document.insertedScripts = scriptParent.children;
  return document;
}

function runAnalytics({ choice, gpc = false, dnt = '0', hostname = 'nekkoagent.com', brokenStorage = false, extraStorage = {} } = {}) {
  const values = { ...extraStorage };
  if (choice) values['nekko-website-analytics-consent-v1'] = choice;
  const localStorage = new FakeStorage(values, brokenStorage);
  const document = fakeDocument();
  const location = { hostname, origin: `https://${hostname}`, href: `https://${hostname}/docs?secret=no#part`, pathname: '/docs' };
  const windowListeners = new Map();
  const window = {
    document,
    navigator: { globalPrivacyControl: gpc, doNotTrack: dnt },
    localStorage,
    location,
    NekkoAnalyticsConfig: { projectToken: 'phc_test_only', apiHost: 'https://us.i.posthog.com' },
    URL,
    addEventListener(name, fn) {
      const listeners = windowListeners.get(name) || [];
      listeners.push(fn);
      windowListeners.set(name, listeners);
    },
    dispatchEvent(event) {
      for (const listener of windowListeners.get(event.type) || []) listener.call(this, event);
    },
  };
  const context = { window, document, navigator: window.navigator, location, localStorage, Element: FakeElement, URL, console };
  runInNewContext(analyticsSource, context, { filename: 'analytics.js' });
  return { window, document, localStorage, root: document.body.querySelector('.privacy-controls') };
}

test('deploy analytics config uses the existing public telemetry constants without env vars', () => {
  const telemetry = read('crates/nekkod/src/telemetry.rs');
  const projectToken = /const PROJECT_KEY: &str = "([^"]+)";/.exec(telemetry)?.[1];
  const apiHost = /const HOST: &str = "([^"]+)";/.exec(telemetry)?.[1];
  assert.ok(projectToken?.startsWith('phc_'));
  assert.equal(apiHost, 'https://us.i.posthog.com');
  assert.equal(
    analyticsConfig(),
    `window.NekkoAnalyticsConfig = ${JSON.stringify({ projectToken, apiHost })};\n`,
  );
  assert.doesNotMatch(analyticsConfig(), /secret|private/i);
});

test('all public pages use one consent controller and no Vercel Analytics loader', () => {
  const staticPages = ['index.html', 'beta.html', 'status.html', 'pricing.html', 'privacy.html', 'download.html'];
  for (const page of staticPages) {
    const html = read(`apps/website/${page}`);
    assert.match(html, /analytics-config\.js\?v=1/, page);
    assert.match(html, /analytics\.js\?v=4/, page);
    assert.doesNotMatch(html, /_vercel\/insights|window\.vaq?\s*=/, page);
  }
  const generated = build();
  for (const [path, body] of generated) {
    if (!path.endsWith('.html')) continue;
    assert.match(String(body), /analytics-config\.js\?v=1/, path);
    assert.match(String(body), /analytics\.js\?v=4/, path);
    assert.doesNotMatch(String(body), /_vercel\/insights|window\.vaq?\s*=/, path);
  }
  const design = read('scripts/design-system/page.html');
  assert.match(design, /analytics\.js\?v=4/);
  assert.doesNotMatch(design, /_vercel\/insights|window\.vaq?\s*=/);
});

test('undecided visitors get equal reject and allow controls without loading PostHog', () => {
  const page = runAnalytics();
  assert.equal(page.window.NekkoAnalytics.choice(), 'undecided');
  assert.equal(page.document.insertedScripts.length, 1, 'only the test anchor script exists');
  assert.equal(page.root.querySelector('[data-privacy-copy]').textContent, 'We never sell or share this data for advertising.');
  assert.equal(page.root.querySelector('[data-privacy-note]').hidden, true);
  const actions = page.root.querySelector('[data-privacy-actions]');
  assert.deepEqual(actions.children.map((button) => button.textContent), ['Reject analytics', 'Allow analytics']);
  assert.ok(actions.children.every((button) => button.className === 'privacy-choice'));
  assert.equal(page.root.querySelector('.privacy-panel').hidden, false);
});

test('acceptance initializes minimized sessions and vitals, marks consent, and drops revoked events', () => {
  const page = runAnalytics();
  page.window.NekkoAnalytics.accept();
  assert.equal(page.localStorage.getItem('nekko-website-analytics-consent-v1'), 'accepted');
  assert.equal(page.document.insertedScripts.length, 2);
  assert.equal(page.document.insertedScripts[1].src, 'https://us-assets.i.posthog.com/static/array.js');
  const [token, config] = page.window.posthog._i[0];
  assert.equal(token, 'phc_test_only');
  assert.equal(config.opt_out_capturing_by_default, true);
  assert.equal(config.person_profiles, 'never');
  assert.equal(config.autocapture, false);
  assert.equal(config.advanced_disable_flags, true);
  assert.equal(config.capture_performance.web_vitals, true);
  assert.deepEqual([...config.capture_performance.web_vitals_allowed_metrics], ['CLS', 'FCP', 'INP', 'LCP']);
  assert.equal(config.capture_performance.network_timing, false);
  assert.equal(config.disable_session_recording, true);
  assert.equal('session_recording' in config, false);
  assert.equal('enable_recording_console_log' in config, false);
  const calls = [];
  config.loaded({
    opt_in_capturing: () => calls.push(['opt-in']),
    opt_out_capturing: () => calls.push(['opt-out']),
    register: (props) => calls.push(['register', props]),
    capture: (event) => calls.push(['capture', event]),
  });
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['opt-in'], ['register', { site: 'nekkoagent.com' }], ['capture', '$pageview']]);
  const minimized = config.before_send({
    event: '$web_vitals',
    properties: {
      $current_url: 'https://nekkoagent.com/docs?email=x#token',
      $referrer: 'https://example.com/a?b=c',
      $web_vitals_LCP_event: { url: 'https://nekkoagent.com/docs?email=vital#target', value: 12 },
    },
  });
  assert.equal(minimized.properties.$current_url, 'https://nekkoagent.com/docs');
  assert.equal(minimized.properties.$referrer, 'https://example.com/a');
  assert.equal(minimized.properties.$web_vitals_LCP_event.url, 'https://nekkoagent.com/docs');
  assert.equal(minimized.properties.$geoip_disable, true);
  assert.equal(minimized.properties.analytics_consent, 'accepted');
  assert.equal(minimized.properties.analytics_schema_version, 2);
  page.window.NekkoAnalytics.reject();
  assert.equal(config.before_send({ event: 'queued_before_withdrawal', properties: {} }), false);
});

test('rejection and withdrawal stop capture, clear analytics identity and remain reversible', () => {
  const page = runAnalytics({ extraStorage: { ph_old_identity: 'old' } });
  page.window.NekkoAnalytics.reject();
  assert.equal(page.window.NekkoAnalytics.choice(), 'rejected');
  assert.equal(page.window.NekkoAnalytics.capture('must_not_send'), false);
  assert.equal(page.localStorage.getItem('ph_old_identity'), null);
  assert.equal(page.document.insertedScripts.length, 1);
  page.window.NekkoAnalytics.accept();
  assert.equal(page.window.NekkoAnalytics.choice(), 'accepted');
  page.window.NekkoAnalytics.reject();
  assert.equal(page.window.NekkoAnalytics.choice(), 'rejected');
  assert.deepEqual(page.window.posthog.filter((call) => call[0] === 'reset').length, 1);
  assert.equal(page.window.posthog.some((call) => /record/i.test(call[0])), false);
  assert.ok(page.window.posthog.filter((call) => call[0] === 'opt_out_capturing').length >= 1);
});

test('same-page acceptance after withdrawal reactivates the loaded SDK once', () => {
  const page = runAnalytics();
  page.window.NekkoAnalytics.accept();
  const config = page.window.posthog._i[0][1];
  const calls = [];
  const sdk = {
    opt_in_capturing: () => calls.push('opt-in'),
    opt_out_capturing: () => calls.push('opt-out'),
    register: () => calls.push('register'),
    capture: (event) => calls.push(event),
    reset: () => calls.push('reset'),
  };
  page.window.posthog = sdk;
  config.loaded(sdk);
  page.window.NekkoAnalytics.reject();
  page.window.NekkoAnalytics.accept();
  assert.equal(calls.filter((call) => call === 'opt-in').length, 2);
  assert.equal(calls.filter((call) => call === '$pageview').length, 2);
  assert.equal(page.window.NekkoAnalytics.capture('after_reaccept'), true);
  assert.equal(calls.at(-1), 'after_reaccept');
});

test('cross-tab storage withdrawal stops a loaded SDK and rejects later capture', () => {
  const page = runAnalytics({ choice: 'accepted' });
  const config = page.window.posthog._i[0][1];
  const calls = [];
  const sdk = {
    opt_in_capturing: () => calls.push('opt-in'),
    opt_out_capturing: () => calls.push('opt-out'),
    register: () => calls.push('register'),
    capture: (event) => calls.push(event),
    reset: () => calls.push('reset'),
  };
  page.window.posthog = sdk;
  config.loaded(sdk);
  page.localStorage.setItem('nekko-website-analytics-consent-v1', 'rejected');
  page.window.dispatchEvent({
    type: 'storage',
    key: 'nekko-website-analytics-consent-v1',
    newValue: 'rejected',
    storageArea: page.localStorage,
  });
  assert.equal(page.window.NekkoAnalytics.choice(), 'rejected');
  assert.equal(calls.filter((call) => call === 'reset').length, 1);
  assert.equal(calls.filter((call) => call === 'opt-out').length, 1);
  assert.equal(page.window.NekkoAnalytics.capture('after_cross_tab_withdrawal'), false);
});

test('GPC and DNT override stored acceptance without loading the SDK', () => {
  for (const signal of [{ gpc: true }, { dnt: '1' }]) {
    const page = runAnalytics({ choice: 'accepted', extraStorage: { ph_old_identity: 'old' }, ...signal });
    assert.equal(page.window.NekkoAnalytics.choice(), 'signal');
    assert.equal(page.document.insertedScripts.length, 1);
    assert.equal(page.localStorage.getItem('ph_old_identity'), null);
    assert.match(page.root.querySelector('[data-privacy-copy]').textContent, /keep analytics off/);
  }
});

test('privacy disclosures match consent, session identity, disabled recording, retention and no-sale behavior', () => {
  const policy = read('apps/website/privacy.html');
  for (const claim of [
    /Before you choose, we do not load PostHog/,
    /Global Privacy Control/,
    /Do Not Track/,
    /four Core Web Vitals \(FCP, LCP, INP and CLS\)/,
    /random identity and session details/,
    /Session recording is disabled/,
    /84 months/,
    /never sell personal information or share it for cross-context behavioural advertising/,
  ]) assert.match(policy, claim);
  assert.match(read('apps/website/site.js'), /policyVersion: '2026-11-26'/);
  const css = read('apps/website/privacy-controls.css');
  assert.doesNotMatch(css, /privacy-choice:(?:first|last)-child/);
  assert.match(css, /min-height: 44px/);
});

test('website hosting has no CSP that blocks the PostHog SDK or ingest host', () => {
  const vercel = JSON.parse(read('vercel.json'));
  const policies = vercel.headers.flatMap((rule) =>
    rule.headers.filter((header) => header.key.toLowerCase() === 'content-security-policy')
      .map((header) => ({ source: rule.source, value: header.value })),
  );
  const publicPolicies = policies.filter((policy) => policy.source !== '/console');
  for (const policy of publicPolicies) {
    assert.match(policy.value, /script-src[^;]*https:\/\/us-assets\.i\.posthog\.com/);
    assert.match(policy.value, /connect-src[^;]*https:\/\/us\.i\.posthog\.com/);
  }
  assert.deepEqual(policies.filter((policy) => policy.source === '/console').map((policy) => policy.value), ["frame-ancestors 'none'"]);
});

function decodePostHogPayload(buffer) {
  if (!buffer?.length) return [];
  let value;
  const payload = buffer[0] === 0x1f && buffer[1] === 0x8b ? gunzipSync(buffer) : buffer;
  const raw = payload.toString('utf8');
  try {
    value = JSON.parse(raw);
  } catch {
    const form = new URLSearchParams(raw);
    value = Object.fromEntries(form);
  }
  if (typeof value?.data === 'string') {
    let bytes = Buffer.from(value.data, 'base64');
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
    value = JSON.parse(bytes.toString('utf8'));
  }
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.batch)) return value.batch;
  return value?.event ? [value] : [];
}

test('real PostHog SDK emits marked sanitized vitals and handles reacceptance plus cross-tab withdrawal', {
  skip: process.env.NEKKO_VERIFY_REAL_POSTHOG !== '1' && 'set NEKKO_VERIFY_REAL_POSTHOG=1 for isolated intercepted SDK verification',
  timeout: 45_000,
}, async (t) => {
  const { chromium } = await import('playwright');
  const sdkResponse = await fetch('https://us-assets.i.posthog.com/static/array.js');
  assert.equal(sdkResponse.ok, true, `PostHog SDK fetch: ${sdkResponse.status}`);
  const sdkSource = await sdkResponse.text();
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());

  const configSource = analyticsConfig();
  assert.doesNotMatch(analyticsSource, /opt_out_useragent_filter/);
  const browserAnalyticsSource = analyticsSource.replace(
    'api_host: config.apiHost,',
    'api_host: config.apiHost, opt_out_useragent_filter: true,',
  );
  const testPage = '<!doctype html><html><head><meta charset="utf-8"><title>Analytics test</title></head><body>' +
    '<main><a href="/privacy" data-cta="privacy">Privacy</a></main>' +
    '<script src="/analytics-config.js?v=1" defer></script><script src="/analytics.js?v=4" defer></script>' +
    '</body></html>';

  async function routedContext({ gpc = false, accepted = false } = {}) {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    });
    const traffic = { assets: [], ingest: [] };
    if (gpc || accepted) {
      await context.addInitScript(({ gpc, accepted }) => {
        if (gpc) Object.defineProperty(navigator, 'globalPrivacyControl', { configurable: true, value: true });
        if (accepted) localStorage.setItem('nekko-website-analytics-consent-v1', 'accepted');
      }, { gpc, accepted });
    }
    await context.route('https://nekkoagent.com/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/analytics.js') return route.fulfill({ contentType: 'text/javascript', body: browserAnalyticsSource });
      if (path === '/analytics-config.js') return route.fulfill({ contentType: 'text/javascript', body: configSource });
      if (path === '/privacy-controls.css') return route.fulfill({ contentType: 'text/css', body: read('apps/website/privacy-controls.css') });
      return route.fulfill({ contentType: 'text/html', body: testPage });
    });
    await context.route('https://us-assets.i.posthog.com/**', async (route) => {
      const url = route.request().url();
      traffic.assets.push(url);
      if (new URL(url).pathname === '/static/array.js') {
        await route.fulfill({ status: 200, contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' }, body: sdkSource });
      } else {
        await route.continue();
      }
    });
    await context.route('https://us.i.posthog.com/**', async (route) => {
      const request = route.request();
      traffic.ingest.push({
        url: request.url(),
        method: request.method(),
        body: request.postDataBuffer(),
      });
      await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"status":1}' });
    });
    return { context, traffic };
  }

  const eventsFrom = (traffic) => traffic.ingest.flatMap((request) => decodePostHogPayload(request.body));
  const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail(`timed out waiting for ${label}`);
  };

  const run = await routedContext();
  t.after(() => run.context.close());
  const page = await run.context.newPage();
  const browserDiagnostics = [];
  page.on('console', (message) => browserDiagnostics.push(`console:${message.type()}:${message.text()}`));
  page.on('pageerror', (error) => browserDiagnostics.push(`pageerror:${error.message}`));
  await page.goto('https://nekkoagent.com/?campaign=private#hero');
  await page.waitForTimeout(300);
  assert.equal(run.traffic.assets.length, 0, 'SDK is not requested before consent');
  assert.equal(run.traffic.ingest.length, 0, 'no ingestion request is made before consent');

  await page.getByRole('button', { name: 'Allow analytics' }).click();
  try {
    await waitFor(() => eventsFrom(run.traffic).filter((event) => event.event === '$pageview').length >= 1, 'first real SDK pageview');
    await waitFor(() => run.traffic.assets.some((url) => /web-vitals[^/]*\.js/.test(new URL(url).pathname)), 'web-vitals SDK extension');
  } catch (error) {
    console.error(JSON.stringify({ assets: run.traffic.assets, ingest: run.traffic.ingest.map((request) => ({ url: request.url, method: request.method, body: request.body?.toString('utf8').slice(0, 500) })), browserDiagnostics }, null, 2));
    throw error;
  }
  await page.waitForTimeout(300);
  assert.equal(eventsFrom(run.traffic).filter((event) => event.event === '$pageview').length, 1, 'initial consent emits one pageview');
  assert.equal(run.traffic.ingest.some((request) => /\/(?:flags|decide)\//.test(new URL(request.url).pathname)), false, 'advanced_disable_flags prevents remote flag loading');

  await page.goto('https://nekkoagent.com/privacy?email=hidden#rights');
  await waitFor(() => eventsFrom(run.traffic).filter((event) => event.event === '$pageview').length >= 2, 'second real SDK pageview');
  await waitFor(() => eventsFrom(run.traffic).some((event) => event.event === '$web_vitals'), 'real web-vitals payload');
  await page.waitForTimeout(300);

  const navigatedEvents = eventsFrom(run.traffic);
  const pageviews = navigatedEvents.filter((event) => event.event === '$pageview');
  assert.equal(pageviews.length, 2, 'each full navigation emits exactly one pageview');
  assert.ok(pageviews[0].properties.$session_id, 'first pageview has a session id');
  assert.equal(pageviews[1].properties.$session_id, pageviews[0].properties.$session_id, 'session id persists across navigation');
  assert.equal(pageviews[1].properties.distinct_id, pageviews[0].properties.distinct_id, 'anonymous identity persists across navigation');
  assert.deepEqual(pageviews.map((event) => event.properties.$current_url), [
    'https://nekkoagent.com/',
    'https://nekkoagent.com/privacy',
  ]);
  for (const event of navigatedEvents) {
    assert.equal(event.properties.analytics_consent, 'accepted', `${event.event} has the consent marker`);
    assert.equal(event.properties.analytics_schema_version, 2, `${event.event} has schema version 2`);
  }
  const vital = navigatedEvents.find((event) => event.event === '$web_vitals');
  const vitalMetrics = Object.entries(vital.properties)
    .filter(([key, value]) => /^\$web_vitals_[A-Z0-9]+_event$/.test(key) && value);
  assert.ok(vitalMetrics.length > 0, 'the real vital payload includes nested metric details');
  for (const [key, value] of vitalMetrics) {
    if (typeof value.url === 'string') assert.doesNotMatch(value.url, /[?#]/, `${key}.url is path-only`);
  }
  assert.equal(navigatedEvents.some((event) => event.event === '$snapshot'), false, 'no recording event is sent');

  const beforeWithdrawal = run.traffic.ingest.length;
  const afterWithdrawalCapture = await page.evaluate(() => {
    window.NekkoAnalytics.reject();
    return window.NekkoAnalytics.capture('must_not_send');
  });
  assert.equal(afterWithdrawalCapture, false);
  assert.equal(await page.evaluate(() => window.posthog.config.before_send({ event: 'queued_before_withdrawal', properties: {} })), false);
  await page.waitForTimeout(500);
  const withdrawalLaterRequests = run.traffic.ingest.length - beforeWithdrawal;
  assert.equal(withdrawalLaterRequests, 0, 'withdrawal sends no later request');
  assert.equal(await page.evaluate(() => localStorage.getItem('nekko-website-analytics-consent-v1')), 'rejected');
  assert.equal(await page.evaluate(() => Object.keys(localStorage).some((key) => key.startsWith('ph_') || key.startsWith('__ph'))), false);
  assert.equal((await run.context.cookies()).some((cookie) => cookie.name.startsWith('ph_') || cookie.name.startsWith('__ph')), false);

  const reacceptedCapture = await page.evaluate(() => {
    window.NekkoAnalytics.accept();
    return window.NekkoAnalytics.capture('after_reaccept');
  });
  assert.equal(reacceptedCapture, true);
  await waitFor(() => eventsFrom(run.traffic).some((event) => event.event === 'after_reaccept'), 'capture after same-page reacceptance');
  await page.waitForTimeout(300);
  const reacceptedEvents = eventsFrom(run.traffic);
  assert.equal(reacceptedEvents.filter((event) => event.event === '$pageview').length, 3, 'reacceptance emits one fresh pageview, not duplicates');
  const afterReaccept = reacceptedEvents.find((event) => event.event === 'after_reaccept');
  assert.equal(afterReaccept.properties.analytics_consent, 'accepted');
  assert.equal(afterReaccept.properties.analytics_schema_version, 2);

  const crossTab = await routedContext({ accepted: true });
  t.after(() => crossTab.context.close());
  const firstTab = await crossTab.context.newPage();
  const secondTab = await crossTab.context.newPage();
  await firstTab.goto('https://nekkoagent.com/');
  await waitFor(() => eventsFrom(crossTab.traffic).filter((event) => event.event === '$pageview').length >= 1, 'first cross-tab pageview');
  await secondTab.goto('https://nekkoagent.com/pricing?plan=private#buy');
  await waitFor(() => eventsFrom(crossTab.traffic).filter((event) => event.event === '$pageview').length >= 2, 'second cross-tab pageview');
  await firstTab.evaluate(() => window.NekkoAnalytics.reject());
  await waitFor(async () => await secondTab.evaluate(() => window.NekkoAnalytics.choice()) === 'rejected', 'cross-tab withdrawal propagation');
  await secondTab.waitForTimeout(300);
  const beforeCrossTabCapture = crossTab.traffic.ingest.length;
  const afterCrossTabCapture = await secondTab.evaluate(() => window.NekkoAnalytics.capture('must_not_send_cross_tab'));
  assert.equal(afterCrossTabCapture, false);
  await secondTab.waitForTimeout(300);
  const crossTabLaterRequests = crossTab.traffic.ingest.length - beforeCrossTabCapture;
  assert.equal(crossTabLaterRequests, 0, 'withdrawn sibling tab sends no later request');

  const blocked = await routedContext({ gpc: true, accepted: true });
  t.after(() => blocked.context.close());
  const blockedPage = await blocked.context.newPage();
  await blockedPage.goto('https://nekkoagent.com/');
  await blockedPage.waitForTimeout(500);
  assert.equal(await blockedPage.evaluate(() => window.NekkoAnalytics.choice()), 'signal');
  assert.equal(blocked.traffic.assets.length, 0, 'GPC prevents the SDK request despite stored acceptance');
  assert.equal(blocked.traffic.ingest.length, 0, 'GPC prevents ingestion despite stored acceptance');

  const evidenceDir = new URL('../.shots/consented-analytics/after/', import.meta.url);
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(new URL('real-sdk-ingestion.json', evidenceDir), JSON.stringify({
    sdkUrl: 'https://us-assets.i.posthog.com/static/array.js',
    sdkBytes: Buffer.byteLength(sdkSource),
    sdkExtensions: run.traffic.assets.filter((url) => /web-vitals[^/]*\.js/.test(new URL(url).pathname)),
    preConsent: { sdkRequests: 0, ingestRequests: 0 },
    productionIngestionRequestsAllowedThrough: 0,
    initialNavigationPageviews: pageviews.map((event) => ({
      event: event.event,
      currentUrl: event.properties.$current_url,
      analyticsConsent: event.properties.analytics_consent,
      analyticsSchemaVersion: event.properties.analytics_schema_version,
      hasSessionId: Boolean(event.properties.$session_id),
      sameSessionAsFirst: event.properties.$session_id === pageviews[0].properties.$session_id,
      sameAnonymousIdentityAsFirst: event.properties.distinct_id === pageviews[0].properties.distinct_id,
    })),
    vital: {
      event: vital.event,
      currentUrl: vital.properties.$current_url,
      analyticsConsent: vital.properties.analytics_consent,
      analyticsSchemaVersion: vital.properties.analytics_schema_version,
      metrics: Object.fromEntries(vitalMetrics.map(([key, value]) => [key, {
        name: value.name,
        value: value.value,
        rating: value.rating,
        url: value.url,
      }])),
    },
    remoteFlagRequests: run.traffic.ingest.filter((request) => /\/(?:flags|decide)\//.test(new URL(request.url).pathname)).length,
    recordingEvents: reacceptedEvents.filter((event) => event.event === '$snapshot').length,
    withdrawal: {
      laterRequests: withdrawalLaterRequests,
      captureAccepted: afterWithdrawalCapture,
      queuedEventAcceptedByBeforeSend: false,
    },
    samePageReacceptance: {
      captureAccepted: reacceptedCapture,
      totalPageviews: reacceptedEvents.filter((event) => event.event === '$pageview').length,
    },
    crossTabWithdrawal: { laterRequests: crossTabLaterRequests, captureAccepted: afterCrossTabCapture },
    gpc: { sdkRequests: blocked.traffic.assets.length, ingestRequests: blocked.traffic.ingest.length },
  }, null, 2) + '\n');
});
