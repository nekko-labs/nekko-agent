import assert from 'node:assert/strict';
import { test } from 'node:test';
import language from '../apps/website/website-language.js';
import handler, { languageForCountry } from '../api/site-country.mjs';
import { build } from './build-docs.mjs';
import { build as design } from './build-design-system.mjs';
import { extract, localize, locales, pageSources, protect, textKey, unprotect } from './site-languages/catalog.mjs';

const { automatic, browserPreference, format, routeFor } = language;

test('first supported browser language wins, including English and both Chinese scripts', () => {
  assert.equal(browserPreference(['pt-BR', 'fr-CA', 'ja']), 'fr');
  assert.equal(browserPreference(['en-GB', 'ja']), 'en');
  assert.equal(browserPreference(['bad_language', 'ko-KR']), 'ko');
  assert.equal(browserPreference(['zh-HK']), 'zh-Hant');
  assert.equal(browserPreference(['zh-TW']), 'zh-Hant');
  assert.equal(browserPreference(['zh-Hans-TW']), 'zh-Hans');
  assert.equal(browserPreference(['zh-Hant-CN']), 'zh-Hant');
  assert.equal(browserPreference(['zh']), 'zh-Hans');
  assert.equal(browserPreference(['sv-SE']), null);
});

test('country is consulted only without a supported browser language; missing hints are English', async () => {
  let calls = 0;
  const country = async () => { calls++; return 'ja'; };
  assert.equal(await automatic(['es-AR'], country), 'es');
  assert.equal(await automatic(['en-US'], country), 'en');
  assert.equal(calls, 0);
  assert.equal(await automatic(['fi-FI'], country), 'ja');
  assert.equal(calls, 1);
  assert.equal(await automatic([], async () => '__proto__'), 'en');
  assert.equal(await automatic([], async () => { throw new Error('no location'); }), 'en');
});

test('route switching preserves path, query, section and existing locale removal', () => {
  assert.equal(routeFor('/l/zh-Hans/docs/cli?q=a+b#setup', 'en'), '/docs/cli?q=a+b#setup');
  assert.equal(routeFor('/privacy#website-analytics', 'de'), '/l/de/privacy#website-analytics');
  assert.equal(routeFor('/#download', 'ja'), '/l/ja#download');
  assert.equal(routeFor('/l/ja', 'en'), '/');
});

test('the country endpoint emits only a locale and must not be cached', () => {
  const headers = {};
  const res = {
    setHeader(key, value) { headers[key] = value; },
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; }, end() {},
  };
  handler({ method: 'GET', headers: { 'x-vercel-ip-country': 'TW' } }, res);
  assert.equal(res.code, 200);
  assert.deepEqual(res.body, { locale: 'zh-Hant' });
  assert.match(headers['Cache-Control'], /no-store/);
  assert.equal(languageForCountry('XX'), null);
  assert.equal(languageForCountry('MX'), 'es');
  assert.equal(languageForCountry('__proto__'), null);
  handler({ method: 'POST', headers: {} }, res);
  assert.equal(res.code, 405);
  assert.equal(headers.Allow, 'GET');
});

test('protected terms and named runtime placeholders survive reordering', () => {
  const source = 'Download Nekko Agent for macOS v5.2.3 from {url}';
  const { source: masked, saved } = protect(source);
  assert.equal(unprotect(masked, saved), source);
  assert.equal(unprotect('⟦P1⟧で⟦P0⟧をダウンロード⟦P2⟧：⟦P3⟧', saved), 'macOSでNekko Agentをダウンロードv5.2.3：{url}');
  assert.equal(unprotect('⟦P0⟧ only', saved), null);
  assert.equal(format({ '{name} runs': '動く：{name}' }, '{name} runs', { name: 'Nekko Agent' }), '動く：Nekko Agent');
  assert.equal(format({}, '{name} runs', { name: 'Nekko Agent' }), 'Nekko Agent runs');
});

test('localized docs keep structure, technical examples, and English artifact links', () => {
  const html = '<!doctype html><html lang="en"><head><title>Getting Started</title></head><body>' +
    '<article class="prose"><p class="kicker">Introduction</p><h1>Getting Started</h1>' +
    '<h2 id="setup">Setup guide</h2><p>Sample paragraph</p><pre><code>nekko --version</code></pre>' +
    '<a href="/docs#setup">Go to setup</a><a href="/docs/index.md">Markdown</a>' +
    '<img src="/docs/media/demo.svg" alt="Sample paragraph"></article></body></html>';
  const pages = new Map([['docs/index.html', html]]);
  const catalog = Object.fromEntries([
    ['Getting Started', 'はじめに'], ['Setup guide', 'セットアップ'], ['Sample paragraph', '例 <code>'],
  ].map(([from, to]) => [textKey(from), to]));
  const source = extract(pages);
  assert.ok(![...source.values()].includes('nekko --version'));
  const files = localize(pages, { locales: ['ja'], catalog: () => catalog });
  const result = files.get('l/ja/docs.html');
  assert.match(result, /<html lang="ja">/);
  assert.match(result, /id="setup">セットアップ</);
  assert.match(result, /<pre><code>nekko --version<\/code><\/pre>/);
  assert.match(result, /<p>例 &lt;code&gt;<\/p>/);
  assert.match(result, /href="\/l\/ja\/docs#setup"/);
  assert.match(result, /href="\/docs\/index\.md"/);
  assert.match(result, /src="\/docs\/media\/demo\.svg"/);
  const search = JSON.parse(files.get('l/ja/docs/search.json'));
  assert.ok(search.some(({ url, heading }) => url === '/l/ja/docs#setup' && heading === 'セットアップ'));
});

test('all first-party public pages are emitted per locale, excluding the console', () => {
  const pages = pageSources(new Map([...build(), ...design()]));
  const files = localize(pages, { catalog: () => ({}) });
  for (const locale of locales) {
    for (const name of ['docs.html', 'docs/search.json', 'download.html', 'pricing.html', 'beta.html', 'privacy.html', 'status.html', 'design-system.html', 'whatsnew.html']) {
      assert.ok(files.has(`l/${locale}/${name}`), `${locale}/${name}`);
    }
    assert.ok(files.has(`l/${locale}.html`));
    assert.ok(!files.has(`l/${locale}/console.html`));
  }
  assert.equal(files.size, locales.length * (pages.size + 1));
});
