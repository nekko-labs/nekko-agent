// nekkoagent.com/design-system: the live parts. The page is complete without this
// file (every value and glyph is baked in at build); this makes the counter work.
(function () {
  'use strict';
  const root = document.documentElement;
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const marks = JSON.parse($('#ds-marks')?.textContent || '{"icons":{},"glyphs":{},"badges":{}}');
  const WORDS = { working: 'Working', input: 'Needs you', error: 'Stopped on an error', idle: 'Watching', done: 'Done' };
  const MOODS = { done: 'happy', idle: 'sleeping' };
  const store = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

  const glyph = (s) => `<span class="glyph${s === 'working' ? ' status-rocket' : ''}${['error', 'idle', 'done'].includes(s) ? ' small' : ''}" data-status="${s}" role="img" aria-label="${WORDS[s]}"><svg viewBox="0 0 24 24" aria-hidden="true">${marks.glyphs[s] || ''}</svg></span>`;
  // Build-baked markup becomes nodes through the parser, never through innerHTML/outerHTML.
  const parse = (markup) => new DOMParser().parseFromString(`<body>${markup}`, 'text/html').body.firstElementChild;
  const head = $('.wall-mascot svg')?.outerHTML || '';
  const mascot = (s) => {
    const b = marks.badges[s] || { tint: '--neutral', path: '' };
    return `<span class="wall-mascot" data-mood="${MOODS[s] || ''}" role="img" aria-label="${WORDS[s]}">${head}<span class="wall-mascot-badge" style="--badge: var(${b.tint})"><svg viewBox="0 0 24 24"><path d="${b.path}" /></svg></span></span>`;
  };

  // ---- Toast.
  const toastEl = $('.toast');
  let toastTimer;
  function toast(text) {
    clearTimeout(toastTimer);
    toastEl.hidden = true;
    void toastEl.offsetWidth;
    toastEl.textContent = text;
    toastEl.hidden = false;
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 4000);
  }

  // ---- Colourway: the swatches on the counter and the plans' buttons re-dress the page.
  const NAMES = { light: 'Light Nekko', dusk: 'Dusk' };
  const themeName = $('[data-theme-name]');
  const paintPicker = () => {
    const t = root.dataset.dsTheme;
    for (const b of $$('.swatch-btn')) b.setAttribute('aria-checked', String(b.dataset.themePick === t));
    if (themeName) themeName.textContent = NAMES[t];
  };
  function setTheme(t) {
    if (t === root.dataset.dsTheme) return;
    const apply = () => { root.dataset.dsTheme = t; store('nekko-ds-theme', t); paintPicker(); };
    if (document.startViewTransition && !reduced) document.startViewTransition(apply);
    else apply();
  }
  for (const b of $$('[data-theme-pick]')) b.addEventListener('click', () => setTheme(b.dataset.themePick));
  paintPicker();

  // ---- Switches.
  for (const sw of $$('.switch')) {
    sw.addEventListener('click', (e) => {
      e.preventDefault();
      const on = sw.getAttribute('aria-checked') !== 'true';
      sw.setAttribute('aria-checked', String(on));
      if (sw.hasAttribute('data-slow')) root.toggleAttribute('data-slow', on);
    });
  }

  // ---- The window on the counter.
  const AGENTS = [
    { status: 'working', title: 'Fix the flaky upload test', log: ['The upload test fails about one run in five. Find out why.', 'It races the progress callback. I am waiting for the last chunk before asserting.', ['terminal', 'Edited upload.test.ts', '+12 −3']] },
    { status: 'input', title: 'Review the migration plan', log: ['Check the plan before we run it on staging.', 'Step four drops the old sessions table. Shall I keep a backup first?', ['hand', 'Waiting for your answer', '']] },
    { status: 'done', title: 'Write tests for checkout', log: ['Cover coupons, tax and empty carts.', 'Added 18 cases. Every one passes.', ['terminal', 'npm test', '18 passed']] },
    { status: 'idle', title: 'Watch the nightly build', log: ['Wake me if the nightly build breaks.', 'Watching. I will speak up if anything changes.', ['server', 'Last build 02:00', 'green']] },
  ];
  const win = $('[data-win]');
  if (win) {
    const rows = $$('.wrow', win);
    const chatHead = $('.chat-head', win);
    const word = $('[data-chat-word]', win);
    const title = $('[data-chat-title]', win);
    const log = $('[data-chat-log]', win);
    let selected = 0;
    const icon = (n) => `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">${marks.icons[n] || ''}</svg>`;
    const el = (tag, cls, ...kids) => { const e = document.createElement(tag); if (cls) e.className = cls; e.append(...kids); return e; };
    const paintRow = (i) => { $('.glyph', rows[i]).replaceWith(parse(glyph(AGENTS[i].status))); };
    const paintChat = (fade) => {
      const a = AGENTS[selected];
      const swap = () => {
        $('.wall-mascot', chatHead).replaceWith(parse(mascot(a.status)));
        title.textContent = a.title;
        word.textContent = WORDS[a.status];
        const [you, agent, [ic, tool, diff]] = a.log;
        log.replaceChildren(
          el('p', 'msg-you', you),
          el('p', 'msg-agent', agent),
          el('p', 'msg-tool', parse(icon(ic)), el('span', '', tool), el('span', 'msg-diff', diff)),
        );
        word.style.opacity = log.style.opacity = '';
      };
      if (!fade) return swap();
      word.style.opacity = log.style.opacity = '0';
      setTimeout(swap, 200);
    };
    rows.forEach((r, i) => r.addEventListener('click', () => {
      if (i === selected) return;
      selected = i;
      rows.forEach((x, j) => x.setAttribute('aria-pressed', String(j === i)));
      paintChat(true);
    }));
    // The agents get on with it: every few seconds one finishes or starts again.
    const SCRIPT = [[0, 'done'], [2, 'working'], [1, 'working'], [0, 'working'], [2, 'done'], [1, 'input']];
    let step = 0;
    let ticker;
    const tick = () => {
      const [i, s] = SCRIPT[step++ % SCRIPT.length];
      AGENTS[i].status = s;
      paintRow(i);
      if (i === selected) {
        $('.wall-mascot', chatHead).replaceWith(parse(mascot(s)));
        word.textContent = WORDS[s];
      }
    };
    const start = () => { if (!ticker) ticker = setInterval(tick, 4500); };
    const stop = () => { clearInterval(ticker); ticker = null; };
    new IntersectionObserver(([e]) => (e.isIntersecting && !document.hidden ? start() : stop())).observe(win);
    document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));

    for (const tab of $$('.win-tabs .tab', win)) {
      tab.addEventListener('click', () => $$('.win-tabs .tab', win).forEach((t) => t.setAttribute('aria-selected', String(t === tab))));
    }

    // The model menu: 200ms in, 150ms out.
    const menuBtn = $('[data-menu-button]', win);
    const menu = $('[data-menu]', win);
    const open = () => { menu.classList.remove('closing'); menu.hidden = false; menuBtn.setAttribute('aria-expanded', 'true'); $('[aria-checked="true"]', menu).focus(); };
    const close = (refocus) => {
      if (menu.hidden || menu.classList.contains('closing')) return;
      menuBtn.setAttribute('aria-expanded', 'false');
      menu.classList.add('closing');
      menu.addEventListener('animationend', () => { if (menu.classList.contains('closing')) menu.hidden = true; }, { once: true });
      if (refocus) menuBtn.focus();
    };
    menuBtn.addEventListener('click', () => (menu.hidden || menu.classList.contains('closing') ? open() : close()));
    menu.addEventListener('click', (e) => {
      const item = e.target.closest('.mitem');
      if (!item) return;
      for (const m of $$('.mitem', menu)) m.setAttribute('aria-checked', String(m === item));
      menuBtn.textContent = item.firstChild.textContent;
      close(true);
    });
    menu.addEventListener('keydown', (e) => {
      const items = $$('.mitem', menu);
      const i = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus(); }
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(true); });
    document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.anchor')) close(false); });
    $('.cicon', win).addEventListener('click', () => toast('This window is a demo. The real one is in Nekko Agent.'));
  }

  // ---- The board: one open row at a time.
  const board = $('[data-board]');
  board?.addEventListener('click', (e) => {
    const row = e.target.closest('.brow');
    if (!row) return;
    const opening = row.getAttribute('aria-expanded') !== 'true';
    for (const r of $$('.brow', board)) r.setAttribute('aria-expanded', String(r === row && opening));
  });

  // ---- Motion: the four lines do what they say, once on arrival and on demand.
  const motion = $('[data-motion]');
  const steps = $$('.step', motion);
  const play = () => {
    const k = root.hasAttribute('data-slow') ? 5 : 1;
    steps.forEach((s, i) => {
      s.classList.remove('play');
      void s.offsetWidth;
      setTimeout(() => s.classList.add('play'), i * 700 * k);
    });
  };
  $('[data-replay]')?.addEventListener('click', play);
  new IntersectionObserver(([e], io) => { if (e.isIntersecting) { play(); io.disconnect(); } }, { threshold: 0.4 }).observe(motion);

  // ---- Questions: one card open at a time.
  const cards = $('[data-cards]');
  cards?.addEventListener('click', (e) => {
    const tab = e.target.closest('.card-tab');
    if (!tab) return;
    const card = tab.parentElement;
    const opening = !card.classList.contains('open');
    for (const c of $$('.card', cards)) {
      const on = c === card && opening;
      c.classList.toggle('open', on);
      $('.card-tab', c).setAttribute('aria-expanded', String(on));
    }
  });

  // ---- Take it home: the band copies a prompt for your agent (without script it opens the Markdown).
  const PROMPT = 'Follow the Nekko Agent quiet design system for every interface you build or change. Read https://nekkoagent.com/design-system.md first, and take values from https://nekkoagent.com/design-system.json by token name: never hard-code a colour. Check each screen against the checklist at the end of the Markdown, in both colourways (Light Nekko and Dusk), at 360px and desktop width.';
  $('[data-copy-prompt]')?.addEventListener('click', (e) => {
    if (!navigator.clipboard) return;
    e.preventDefault();
    navigator.clipboard.writeText(PROMPT).then(() => toast('Copied. Paste it into your agent.'), () => { location.href = '/design-system.md'; });
  });

  // ---- The colourway films play while they are on screen.
  if (!reduced) {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const v = e.target;
        if (e.isIntersecting) { v.preload = 'auto'; v.play().catch(() => {}); } else v.pause();
      }
    }, { threshold: 0.35 });
    $$('.plan-shot video').forEach((v) => io.observe(v));
  }

  // ---- Entrances: each section's parts rise in turn as it arrives. Only what starts below the fold waits.
  const groups = [
    ['.board-wrap', 'h2, .board-intro, .brow'],
    ['.rules', '.zigzag span, .rules-foot, .rules-list li'],
    ['.spec', '.spec-head > *, .spec-table'],
    ['.colourways', '.plan h2, .plan-for, .plan-shot, .plan-in, .plan-foot'],
    ['.faq', 'h2, .card'],
    ['.foot', '.foot-invite > *, .foot-links li'],
  ];
  if (!reduced && 'IntersectionObserver' in window) {
    const reveal = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); reveal.unobserve(e.target); }
    }, { rootMargin: '0px 0px -8% 0px' });
    for (const [scope, parts] of groups) {
      const s = $(scope);
      if (!s) continue;
      $$(parts, s).forEach((el, i) => {
        if (el.getBoundingClientRect().top < innerHeight) return;
        el.dataset.reveal = '';
        el.style.setProperty('--d', String(i % 8));
        reveal.observe(el);
      });
    }
  }
})();
