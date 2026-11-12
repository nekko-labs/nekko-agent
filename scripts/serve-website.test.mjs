import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createWebsiteServer } from './serve-website.mjs';
import { write } from './build-docs.mjs';

test('marketing preview serves only static website files and read requests', async (t) => {
  write(); // the docs pages are gitignored build output
  const server = createWebsiteServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const get = (path, method = 'GET') => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
  const page = await get('/');
  assert.equal(page.status, 200);
  assert.match(page.body, /Nekko Agent/);
  // The launch claim must retain its workload, timing direction and method link.
  assert.match(page.body, /Local code edits\. 5× faster than Ollama\./);
  // The hero's proof is the speed replay under the headline: one video per look,
  // end-frame posters, the claim as its label and caption, and the method link beside it.
  const replay = page.body.slice(page.body.indexOf('<figure class="hero-replay'), page.body.indexOf('</figure>', page.body.indexOf('<figure class="hero-replay')));
  assert.ok(page.body.indexOf('class="tagline') < page.body.indexOf('<figure class="hero-replay'));
  assert.match(replay, /<video[^>]*\bautoplay muted loop playsinline\b/);
  assert.match(replay, /data-src-dark="media\/hero-v2\.mp4"/);
  assert.match(replay, /data-src-light="media\/hero-v2-light\.mp4"/);
  assert.match(replay, /data-poster-dark="media\/hero-v2-poster\.webp"/);
  assert.match(replay, /aria-label="Meet Nekko\. Built in Rust\. It’s fast\. Like, really fast\. Local code edits\. 5× faster than Ollama\. 2\.5 s vs 13\.9 s, whole-file rename benchmark\."/);
  assert.match(replay, /<figcaption[^>]*><strong>Local code edits\. 5× faster than Ollama\.<\/strong> 2\.5 s vs 13\.9 s, whole-file rename benchmark\./);
  assert.match(replay, /href="\/docs\/benchmarks"/);
  assert.doesNotMatch(page.body, /class="hero-proof/);
  for (const f of ['hero-v2.mp4', 'hero-v2-light.mp4', 'hero-v2-poster.webp', 'hero-v2-light-poster.webp']) assert.equal((await get(`/media/${f}`)).status, 200, f);
  assert.doesNotMatch(page.body, /Time to complete reply/);
  // Why Nekko is the five-pillar tour: a vertical tablist beside one demo, the
  // speed pillar titled without a superlative it cannot prove.
  assert.match(page.body, /data-pillar-tour/);
  assert.equal((page.body.match(/role="tab"/g) ?? []).length, 5);
  assert.match(page.body, /Fast\. Really fast\./);
  for (const id of ['local', 'speed', 'privacy', 'fleet', 'anywhere']) {
    for (const f of [`pillar-${id}.mp4`, `pillar-${id}-light.mp4`, `pillar-${id}-poster.jpg`, `pillar-${id}-light-poster.jpg`]) {
      assert.equal((await get(`/media/${f}`)).status, 200, f);
    }
  }
  // Profiles: the spot claims separation of chats, notes and connectors, and
  // its footnote keeps the two things a profile is not.
  const profiles = page.body.slice(page.body.indexOf('id="profiles"'), page.body.indexOf('id="why"'));
  assert.ok(profiles.length > 200, 'profiles spot present');
  assert.match(profiles, /cannot read another profile&rsquo;s chats, notes or connectors/);
  assert.match(profiles, /do not lock the app against someone using your unlocked computer/);
  assert.match(profiles, /a terminal command can still reach files anywhere your computer account can/);
  assert.doesNotMatch(profiles, /cannot (read|reach|access) another profile&rsquo;s (files|folders)/);
  // The benchmark summary keeps the result, its conditions, the measured losses
  // and the link to the full method, so the headline never hides them.
  const bench = page.body.slice(page.body.indexOf('id="benchmarks"'), page.body.indexOf('panels-foot', page.body.indexOf('id="benchmarks"')));
  assert.ok(bench.length > 200, 'benchmark summary present');
  assert.match(bench, /Whole-file rename benchmark/);
  assert.match(bench, /Ollama 0\.40\.11/);
  assert.match(bench, /cool-chip medians, 8 requests per server/);
  assert.match(bench, /534/);
  assert.match(bench, /256/);
  assert.match(bench, /LM Studio 2\.46\.0/);
  assert.match(bench, /30 September 2026/);
  assert.match(bench, /Where we are not ahead: MLX decodes plain text faster/);
  assert.match(bench, /Ollama starts a fresh long chat faster/);
  assert.match(bench, /inference replies, not a complete agent workflow/);
  assert.match(bench, /href="\/docs\/benchmarks"/);
  assert.doesNotMatch(page.body, /Maybe the fastest|data-demo="fast"/);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.match((await get('/styles.css?v=5')).headers['content-type'], /text\/css/);
  const styles = (await get('/styles.css')).body;
  assert.ok(styles.includes('.bench { grid-column: 1 / -1; min-width: 0;'));
  assert.ok(styles.includes('.bench-legend { display: inline-flex; flex-wrap: wrap;'));
  assert.ok(styles.includes('.panel-fast .panel-copy { order: 0; min-width: 0; }'));
  assert.ok(styles.includes(":root[data-theme='dark'] .media .why-video-dark { display: block; }"));
  assert.equal((await get('/site.js')).status, 200);
  // Clean URLs, as vercel.json serves them.
  assert.match((await get('/docs')).body, /<html/i);
  assert.match((await get('/docs/')).body, /<html/i);
  assert.equal((await get('/docs/cli')).status, 200);
  assert.equal((await get('/docs/index.md')).status, 200);
  assert.equal((await get('/missing')).status, 404);
  assert.equal((await get('/docs/missing')).status, 404);
  assert.equal((await get('/%2e%2e%2fpackage.json')).status, 403);
  assert.equal((await get('/%2e%2e%2fpackage')).status, 403);
  assert.equal((await get('/%')).status, 400);
  assert.equal((await get('/', 'POST')).status, 405);
  const head = await get('/', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
});

// The pillar tour's timing, run in a small stand-in DOM: the video is the only
// clock. The tour advances on the video's `ended`, the progress line is drawn
// from currentTime / duration, the hold pauses the video, and a picked pillar
// starts from 0.
function pillarTour({ reduced = false } = {}) {
  const src = readFileSync(fileURLToPath(new URL('../apps/website/site.js', import.meta.url)), 'utf8');
  const from = src.indexOf('// ---- why Nekko: the pillar tour.');
  const code = src.slice(from, src.indexOf('})();', from) + 5);
  const target = () => {
    const on = {};
    return {
      addEventListener: (e, f, o) => { (on[e] ??= []).push({ f, once: o?.once }); },
      fire(e, ev = {}) { const list = on[e] ?? []; on[e] = list.filter((l) => !l.once); for (const l of list) l.f(ev); },
    };
  };
  const classes = (init = []) => {
    const set = new Set(init);
    return { add: (c) => set.add(c), toggle: (c, v) => (v ? set.add(c) : set.delete(c)), contains: (c) => set.has(c) };
  };
  const attrs = () => { const a = {}; return { setAttribute: (k, v) => { a[k] = String(v); }, getAttribute: (k) => a[k] ?? null }; };
  const ids = ['local', 'speed', 'privacy', 'fleet', 'anywhere'];
  const items = ids.map((id, i) => {
    const bar = { style: {} };
    const item = { classList: classes(i === 0 ? ['is-active'] : []), querySelector: () => bar, bar };
    item.tab = { ...target(), ...attrs(), id: `pillar-tab-${id}`, dataset: { pillar: id, alt: id }, closest: () => item, focus() {}, tabIndex: 0 };
    return item;
  });
  const video = {
    ...target(), ...attrs(), poster: '', currentTime: 0, duration: NaN, paused: true, ended: false,
    set src(v) { this.setAttribute('src', v); this.currentTime = 0; this.duration = NaN; this.ended = false; this.paused = true; },
    play() { if (this.paused) { this.paused = false; this.fire('play'); } return Promise.resolve(); },
    pause() { if (!this.paused) { this.paused = true; this.fire('pause'); } },
    load() {},
    // Test helpers: metadata arrives, time passes, the file ends.
    ready() { this.duration = 8; this.fire('loadedmetadata'); if (!this.paused) this.fire('playing'); },
    advance(s) { if (!this.paused) { this.currentTime = Math.min(8, this.currentTime + s); this.fire('timeupdate'); } },
    end() { this.currentTime = 8; this.ended = true; this.paused = true; this.fire('pause'); this.fire('ended'); },
  };
  const pauseBtn = { ...target(), ...attrs(), hidden: true };
  const enlargeBtn = { ...target(), ...attrs(), hidden: true };
  const box = { ...target(), opened: null, dispatchEvent(e) { this.fire(e.type, e); } };
  box.addEventListener('lightbox:open', (e) => { box.opened = e.detail; });
  const panel = attrs();
  const tour = {
    ...target(), classList: classes(),
    querySelectorAll: () => items.map((i) => i.tab),
    querySelector: (s) => ({ '[role="tabpanel"]': panel, '.pillar-video': video, '[data-pillar-pause]': pauseBtn, '[data-pillar-enlarge]': enlargeBtn })[s],
    contains: () => false,
  };
  const doc = { ...target(), hidden: false, documentElement: { dataset: { theme: 'dark' } }, querySelector: (s) => (s === '[data-pillar-tour]' ? tour : null), getElementById: (id) => (id === 'lightbox' ? box : null),
    createElement: () => ({ ...target(), ...attrs(), currentTime: 0, play: () => Promise.resolve() }) };
  let io;
  let mo;
  const IntersectionObserver = class { constructor(cb) { io = cb; } observe() {} };
  const env = {
    document: doc,
    window: { matchMedia: () => ({ matches: reduced }), IntersectionObserver },
    IntersectionObserver,
    MutationObserver: class { constructor(cb) { mo = cb; } observe() {} },
    requestAnimationFrame: () => 1,
    Event: class { constructor(type) { this.type = type; } },
    CustomEvent: class { constructor(type, o) { this.type = type; this.detail = o.detail; } },
  };
  new Function(...Object.keys(env), code)(...Object.values(env));
  const active = () => items.findIndex((i) => i.classList.contains('is-active'));
  const line = () => Number(/scaleX\(([\d.]+)\)/.exec(items[active()].bar.style.transform)?.[1] ?? 0);
  return {
    tour, video, items, pauseBtn, enlargeBtn, box, doc, line, active,
    show: (on = true) => io([{ isIntersecting: on }]),
    theme: (name) => { doc.documentElement.dataset.theme = name; mo(); },
  };
}

test('pillar tour: the line tracks the video and the tour advances only on ended', () => {
  const t = pillarTour();
  t.show();
  assert.equal(t.video.getAttribute('src'), 'media/pillar-local.mp4');
  assert.equal(t.line(), 0, 'the line waits while the file loads');
  t.video.ready();
  t.video.advance(2);
  assert.equal(t.line(), 0.25);
  t.video.advance(5.9);
  assert.equal(t.active(), 0, 'no timer of its own: still on the first pillar near the end');
  t.video.end();
  assert.equal(t.active(), 1);
  assert.equal(t.video.getAttribute('src'), 'media/pillar-speed.mp4');
  assert.equal(t.video.currentTime, 0);
  assert.equal(t.line(), 0);
});

test('pillar tour: hover, keyboard focus, Pause, off screen and a hidden tab pause the video', () => {
  const t = pillarTour();
  t.show(); t.video.ready(); t.video.advance(3);
  t.tour.fire('pointerenter', { pointerType: 'mouse' });
  assert.equal(t.video.paused, true);
  t.video.advance(4);
  assert.equal(t.video.currentTime, 3);
  assert.equal(t.line(), 3 / 8);
  t.tour.fire('pointerleave');
  assert.equal(t.video.paused, false);
  assert.equal(t.video.currentTime, 3, 'resumes where it stopped, not from the top');
  t.tour.fire('focusin', { target: { matches: () => true } });
  assert.equal(t.video.paused, true);
  t.tour.fire('focusout', { relatedTarget: null });
  assert.equal(t.video.paused, false);
  t.pauseBtn.fire('click');
  assert.equal(t.video.paused, true);
  t.pauseBtn.fire('click');
  t.show(false);
  assert.equal(t.video.paused, true);
  t.show(true);
  t.doc.hidden = true; t.doc.fire('visibilitychange');
  assert.equal(t.video.paused, true);
  t.doc.hidden = false; t.doc.fire('visibilitychange');
  assert.equal(t.video.paused, false);
  assert.equal(t.video.currentTime, 3);
});

test('pillar tour: clicking a pillar starts its video from 0; a demo ending under the hold waits', () => {
  const t = pillarTour();
  t.show(); t.video.ready(); t.video.advance(5);
  t.tour.fire('pointerenter', { pointerType: 'mouse' });
  t.items[3].tab.fire('click');
  assert.equal(t.active(), 3);
  assert.equal(t.video.getAttribute('src'), 'media/pillar-fleet.mp4');
  assert.equal(t.video.currentTime, 0);
  assert.equal(t.video.paused, false, 'a picked pillar plays under the pointer');
  t.video.ready(); t.video.advance(4);
  t.items[3].tab.fire('click');
  assert.equal(t.video.currentTime, 0, 'picking the same pillar again restarts it');
  t.video.end();
  assert.equal(t.active(), 3, 'still under the pointer: wait on the last frame');
  assert.equal(t.line(), 1);
  t.tour.fire('pointerleave');
  assert.equal(t.active(), 4);
});

test('pillar tour: a look change swaps the file at the same time without resetting the line', () => {
  const t = pillarTour();
  t.show(); t.video.ready(); t.video.advance(5);
  t.theme('light');
  assert.equal(t.video.getAttribute('src'), 'media/pillar-local-light.mp4');
  assert.equal(t.line(), 5 / 8, 'the line holds while the new file loads');
  t.video.ready();
  assert.equal(t.video.currentTime, 5);
  assert.equal(t.video.paused, false);
});

test('pillar tour: reduced motion loads posters only and never advances', () => {
  const t = pillarTour({ reduced: true });
  t.show();
  assert.equal(t.video.getAttribute('src'), null);
  assert.equal(t.video.poster, 'media/pillar-local-poster.jpg');
  assert.equal(t.pauseBtn.hidden, true);
  assert.equal(t.tour.classList.contains('is-timed'), false);
  t.video.fire('ended');
  assert.equal(t.active(), 0);
});

test('pillar tour: Enlarge opens the active demo in the lightbox at the same frame and holds the tour', () => {
  const t = pillarTour();
  assert.equal(t.enlargeBtn.hidden, false);
  t.show(); t.video.ready(); t.video.advance(3);
  t.enlargeBtn.fire('click');
  const big = t.box.opened.node;
  assert.equal(t.box.opened.opener, t.enlargeBtn);
  assert.equal(big.src, 'media/pillar-local.mp4');
  assert.equal(big.controls, true);
  big.fire('loadedmetadata');
  assert.equal(big.currentTime, 3);
  assert.equal(t.video.paused, true, 'the tour holds while the lightbox is open');
  t.box.fire('lightbox:close');
  assert.equal(t.video.paused, false);
  assert.equal(t.video.currentTime, 3);
});
