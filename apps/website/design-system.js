// nekkoagent.com/design-system: the live parts. Tokens come from /ds/tokens.css
// and the marks (icons, status glyphs, window badges) from /ds/marks.js, both
// generated from the desktop renderer by scripts/build-design-system.mjs.
(function () {
  'use strict';
  const root = document.documentElement;
  const marks = window.DS_MARKS || { icons: {}, glyphs: {}, badges: {} };
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const css = (name) => getComputedStyle(root).getPropertyValue(name).trim();
  const slow = () => (root.hasAttribute('data-slow') ? 5 : 1);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const store = (key, value) => { try { localStorage.setItem(key, value); } catch { /* private mode */ } };

  const icon = (name) => (marks.icons[name] ? `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">${marks.icons[name]}</svg>` : '');
  const glyph = (status) => `<svg viewBox="0 0 24 24" aria-hidden="true">${marks.glyphs[status] || ''}</svg>`;

  // ---- Tabs: words on a wash pill that slides to the selected one.
  const tabSets = [];
  function initTabs(el, value, onChange) {
    const pill = document.createElement('span');
    pill.className = 'tabs-pill instant';
    pill.setAttribute('aria-hidden', 'true');
    el.prepend(pill);
    const tabs = $$('.tab', el);
    const place = (instant) => {
      const sel = tabs.find((t) => t.getAttribute('aria-selected') === 'true');
      if (!sel) return;
      pill.classList.toggle('instant', !!instant);
      pill.style.width = `${sel.offsetWidth}px`;
      pill.style.height = `${sel.offsetHeight}px`;
      pill.style.transform = `translate(${sel.offsetLeft}px, ${sel.offsetTop}px)`;
    };
    const select = (v, fire) => {
      for (const t of tabs) {
        const on = t.dataset.value === v;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
      }
      place(false);
      if (fire) onChange?.(v);
    };
    tabs.forEach((t, i) => {
      t.addEventListener('click', () => select(t.dataset.value, true));
      t.addEventListener('keydown', (e) => {
        const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (!step) return;
        e.preventDefault();
        const next = tabs[(i + step + tabs.length) % tabs.length];
        next.focus();
        select(next.dataset.value, true);
      });
    });
    select(value, false);
    requestAnimationFrame(() => place(true));
    const set = { place, select };
    tabSets.push(set);
    return set;
  }
  const replaceAll = () => tabSets.forEach((s) => s.place(true));
  addEventListener('resize', replaceAll);
  document.fonts?.ready.then(replaceAll);

  // ---- Theme, input and the motion switches.
  initTabs($('[data-tabs="theme"]'), root.dataset.dsTheme || 'light', (v) => {
    root.dataset.dsTheme = v;
    store('nekko-ds-theme', v);
    requestAnimationFrame(renderColours);
  });
  initTabs($('[data-tabs="input"]'), matchMedia('(pointer: coarse)').matches ? 'finger' : 'pointer', (v) => {
    root.dataset.input = v;
    requestAnimationFrame(replaceAll);
  });
  for (const sw of $$('.switch')) {
    if (sw.dataset.switch === 'reduce') sw.setAttribute('aria-checked', String(root.hasAttribute('data-reduce')));
    sw.addEventListener('click', (e) => {
      e.preventDefault();
      const on = sw.getAttribute('aria-checked') !== 'true';
      sw.setAttribute('aria-checked', String(on));
      const attr = { slowmo: 'data-slow', reduce: 'data-reduce' }[sw.dataset.switch];
      if (attr) root.toggleAttribute(attr, on);
    });
  }

  // ---- Separating things.
  initTabs($('[data-tabs="separating"]'), 'quiet', (v) => { $('[data-compare]').dataset.compare = v; });

  // ---- Spacing.
  const SPACING = [
    [4, '--q-tight', 'Tightly coupled pairs: a title and its subtext, an icon and its label, a value and its unit'],
    [8, '--q-inline', 'Row padding, name to meta, group label to its rows'],
    [16, '', 'Between controls in a bar, inside a field'],
    [20, '--q-group', 'Panel padding, page gutter, group to group'],
    [24, '', 'Inside large components'],
    [40, '--q-section', 'Section to section'],
  ];
  $('[data-spacing]').innerHTML = SPACING.map(([px, token, use]) => `
    <div class="row static">
      <span class="num">${px}</span>
      <span class="space-cell"><span class="space-bar" style="width: ${token ? `var(${token})` : `${px}px`}"></span></span>
      <span class="row-text"><span class="row-title">${token ? `<span class="mono">${token}</span>` : `${px}px`}</span><span class="row-detail">${esc(use)}</span></span>
    </div>`).join('');

  // ---- Type ladder, with an editable sample.
  const TYPE = [
    ['Page title', 20, 600, 'ink'],
    ['Section heading', 16, 600, 'ink'],
    ['Row title, page', 14, 500, 'ink'],
    ['Row title, popover', 12, 500, 'ink'],
    ['Group label', 12, 500, 'ink-soft'],
    ['Detail, meta', 12, 400, 'ink-faint'],
    ['Small meta', 11, 400, 'ink-faint'],
    ['Code, paths, numbers', 12, 400, 'ink-soft', true],
  ];
  const typeList = $('[data-type]');
  const sample = $('[data-sample]');
  const renderType = () => {
    const text = esc(sample.value || 'Model library');
    typeList.innerHTML = TYPE.map(([role, size, weight, ink, mono]) => `
      <div class="row static">
        <span class="type-sample" style="font-size: ${size}px; font-weight: ${weight}; color: var(--${ink});${mono ? ' font-family: var(--font-mono);' : ''}">${text}</span>
        <span class="meta">${role} · <span class="mono">${size} / ${weight} · ${ink}</span></span>
      </div>`).join('');
  };
  sample.addEventListener('input', renderType);
  renderType();

  // ---- Colour: every swatch reads the live token; selecting one copies it.
  const COLOURS = [
    ['Neutrals build the screen', [
      ['--paper', 'Page'],
      ['--surface', 'Popovers, menus, tooltips'],
      ['--surface-2', 'Raised: a secondary button on hover'],
      ['--line', 'The one hairline'],
      ['--ink', 'Titles, what you scan for', true],
      ['--ink-soft', 'Supporting text, icons at rest', true],
      ['--ink-faint', 'Metadata and help', true],
    ]],
    ['Plum marks intent', [
      ['--accent', 'The one primary button, focus, selection, links, a toggle that is on', true],
      ['--accent-soft', 'Behind a selected row'],
      ['--ring', 'The focus halo'],
    ]],
    ['Petrol is information', [
      ['--info', 'Notices, "New", tips, chart series three', true],
      ['--accent-2', 'Chart series two'],
    ]],
  ];
  const STATES = [
    ['success', 'Success', 'Working, done, connected'],
    ['warning', 'Warning', 'Expiring, best so far'],
    ['danger', 'Danger', 'Errors and removal'],
    ['attention', 'Attention', 'An agent waiting on you'],
    ['neutral', 'Neutral', 'Watching, offline'],
  ];
  const probe = document.createElement('span');
  probe.style.display = 'none';
  document.body.append(probe);
  const rgb = (token) => {
    probe.style.color = `var(${token})`;
    const m = getComputedStyle(probe).color.match(/[\d.]+/g) || [];
    // rgb(r, g, b) is 0-255; color(srgb r g b) is 0-1.
    const scale = getComputedStyle(probe).color.startsWith('color(') ? 255 : 1;
    return m.slice(0, 3).map((n) => Number(n) * scale);
  };
  const luminance = ([r, g, b]) => {
    const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const contrast = (a, b) => {
    const [x, y] = [luminance(rgb(a)), luminance(rgb(b))].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const shown = (token) => {
    const v = css(token);
    // A soft token resolves to color-mix(in srgb, <base> 13%, transparent).
    const mix = v.match(/^color-mix\(in srgb, (.+) (\d+)%, transparent\)$/);
    return mix ? `${mix[1].replace(/^var\((--[\w-]+)\)$/, '$1')} at ${mix[2]}%` : v;
  };
  const ratio = (token) => {
    const r = contrast(token, '--paper');
    return `<span class="contrast ${r >= 4.5 ? 'pass' : 'fail'}" title="Contrast on --paper">${r.toFixed(1)}:1</span>`;
  };
  function renderColours() {
    const groups = COLOURS.map(([label, rows]) => `
      <div class="group">
        <div class="group-label">${label}</div>
        ${rows.map(([token, use, text]) => `
          <button class="row swatch-row" type="button" data-copy="${token}" aria-label="Copy var(${token})">
            <span class="swatch" style="--c: var(${token})"></span>
            <span class="row-text"><span class="row-title mono">${token}</span><span class="row-detail">${esc(use)}</span></span>
            <span class="meta mono">${esc(shown(token))}</span>
            ${text ? ratio(token) : ''}
          </button>`).join('')}
      </div>`);
    groups.push(`
      <div class="group">
        <div class="group-label">State: a base for glyphs and dots, -text for words, -soft only when you must act</div>
        ${STATES.map(([key, name, use]) => `
          <div class="row" data-quiet-row>
            <span class="row-text"><span class="row-title">${name}</span><span class="row-detail">${use}</span></span>
            <button class="icon-btn" type="button" data-copy="--${key}" data-tip="--${key}: ${esc(css(`--${key}`))}" aria-label="Copy var(--${key})"><span class="swatch" style="--c: var(--${key})"></span></button>
            ${key === 'neutral' ? '' : `<button class="icon-btn" type="button" data-copy="--${key}-text" data-tip="--${key}-text: ${esc(css(`--${key}-text`))}" aria-label="Copy var(--${key}-text)"><span class="swatch" style="--c: var(--${key}-text)"></span></button>`}
            <button class="icon-btn" type="button" data-copy="--${key}-soft" data-tip="--${key}-soft: ${esc(shown(`--${key}-soft`))}" aria-label="Copy var(--${key}-soft)"><span class="swatch" style="--c: var(--${key}-soft)"></span></button>
            ${key === 'neutral' ? '<span class="contrast fail" style="visibility: hidden">0.0:1</span>' : ratio(`--${key}-text`)}
          </div>`).join('')}
      </div>`);
    $('[data-colours]').innerHTML = groups.join('');
  }
  renderColours();
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-copy]');
    if (!el) return;
    const text = `var(${el.dataset.copy})`;
    navigator.clipboard?.writeText(text).then(() => toast(`Copied ${text}`), () => toast(text));
  });

  // ---- Agent status: the glyph in a list, Nekko with a badge on a window.
  const WORDS = { working: 'Working', input: 'Needs you', error: 'Stopped on an error', idle: 'Watching', done: 'Done' };
  const MOODS = { done: 'happy', idle: 'sleeping' };
  const head = `
    <svg viewBox="0 0 32 32" width="20" height="20" shape-rendering="crispEdges" aria-hidden="true">
      <path d="M4 5H6V7H8V9H11V10H21V9H24V7H26V5H28V19H27V22H25V24H22V26H10V24H7V22H5V19H4Z" fill="#16161c" stroke="#f3e8ee" stroke-width="2" />
      <path class="eyes-open" d="M11 15H13V18H11Z M20 15H22V18H20Z" fill="#ffffff" />
      <path class="eyes-happy" d="M9 17H10V15H11V14H12V15H13V17H12V16H10V17Z M19 17H20V15H21V14H22V15H23V17H22V16H20V17Z" fill="#ffffff" />
      <path class="eyes-closed" d="M10 17H14V18H10Z M19 17H23V18H19Z" fill="#ffffff" />
      <path d="M15 20H17V21H15Z" fill="#854f6c" />
    </svg>`;
  const listGlyph = (s) => `<span class="glyph${s === 'working' ? ' status-rocket' : ''}${['error', 'idle', 'done'].includes(s) ? ' small' : ''}" data-status="${s}" role="img" aria-label="${WORDS[s]}">${glyph(s)}</span>`;
  const mascot = (s) => {
    const b = marks.badges[s] || { tint: '--neutral', path: '' };
    return `<span class="wall-mascot" data-mood="${MOODS[s] || ''}" role="img" aria-label="${WORDS[s]}">${head}<span class="wall-mascot-badge" style="--badge: var(${b.tint})"><svg viewBox="0 0 24 24"><path d="${b.path}" /></svg></span></span>`;
  };
  // Status change: the word, glyph and badge crossfade (out, swap, back in).
  const agentWord = $('[data-agent-word]');
  const paintStatus = (s) => {
    $('[data-agent-glyph]').outerHTML = listGlyph(s).replace('class="glyph', 'data-agent-glyph class="glyph swap out');
    $('[data-agent-mascot]').outerHTML = mascot(s).replace('class="wall-mascot', 'data-agent-mascot class="wall-mascot swap out');
    agentWord.textContent = WORDS[s];
    requestAnimationFrame(() => requestAnimationFrame(() => {
      for (const el of [agentWord, $('[data-agent-glyph]'), $('[data-agent-mascot]')]) el.classList.remove('out');
    }));
  };
  let statusTimer;
  initTabs($('[data-tabs="status"]'), 'working', (s) => {
    for (const el of [agentWord, $('[data-agent-glyph]'), $('[data-agent-mascot]')]) el.classList.add('out');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => paintStatus(s), 200 * slow());
  });
  paintStatus('working');

  const statusGroup = document.createElement('div');
  statusGroup.className = 'group status-table';
  statusGroup.innerHTML = `<div class="group-label">Each state, in a list and on a window</div>${Object.keys(WORDS).map((s) => `
    <div class="row static">${listGlyph(s)}<span class="row-text"><span class="row-title">${WORDS[s]}</span></span><span class="meta">${mascot(s)}</span></div>`).join('')}`;
  $('[data-tabs="status"]').after(statusGroup);

  // ---- Icons.
  $('[data-icons]').innerHTML = Object.keys(marks.icons).map((name) =>
    `<button class="icon-btn" type="button" aria-pressed="false" data-tip="${name}" aria-label="${name}">${icon(name)}</button>`).join('');
  $('[data-icons]').addEventListener('click', (e) => {
    const b = e.target.closest('.icon-btn');
    if (b) b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
  });
  for (const el of $$('[data-icon]')) el.innerHTML = icon(el.dataset.icon);

  // ---- Tooltip: fades in and moves 4px out from its anchor; none when sliding between tips.
  const tip = $('#tip');
  let tipTimer;
  let lastHidden = 0;
  const showTip = (el, now) => {
    tip.textContent = el.dataset.tip;
    tip.hidden = false;
    tip.classList.remove('entering');
    const r = el.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const left = Math.min(Math.max(8, r.left + r.width / 2 - t.width / 2), innerWidth - t.width - 8);
    tip.style.transform = `translate(${left}px, ${r.top - t.height - 8}px)`;
    el.setAttribute('aria-describedby', 'tip');
    if (!now) { void tip.offsetWidth; tip.classList.add('entering'); }
  };
  const hideTip = (el) => {
    clearTimeout(tipTimer);
    if (!tip.hidden) lastHidden = performance.now();
    tip.hidden = true;
    el?.removeAttribute('aria-describedby');
  };
  const onEnter = (e) => {
    const el = e.target.closest?.('[data-tip]');
    if (!el) return;
    clearTimeout(tipTimer);
    const sliding = !tip.hidden || performance.now() - lastHidden < 300;
    if (sliding) showTip(el, true);
    else tipTimer = setTimeout(() => showTip(el, false), e.type === 'focusin' ? 0 : 500);
  };
  const onLeave = (e) => { const el = e.target.closest?.('[data-tip]'); if (el) hideTip(el); };
  document.addEventListener('pointerover', onEnter);
  document.addEventListener('pointerout', onLeave);
  document.addEventListener('focusin', onEnter);
  document.addEventListener('focusout', onLeave);
  addEventListener('scroll', () => hideTip(), { passive: true });

  // ---- Toast: rises 8px and fades in, fades out after 4s.
  const toastEl = $('.toast');
  const toastText = $('[data-toast-text]');
  const toastUndo = $('[data-toast-undo]');
  let toastTimer;
  let undoFn = null;
  function toast(text, undo) {
    clearTimeout(toastTimer);
    toastEl.classList.remove('closing');
    toastEl.hidden = true;
    void toastEl.offsetWidth;
    toastText.textContent = text;
    undoFn = undo || null;
    toastUndo.hidden = !undo;
    toastEl.hidden = false;
    toastTimer = setTimeout(closeToast, 4000);
  }
  function closeToast() {
    toastEl.classList.add('closing');
    toastEl.addEventListener('animationend', () => { if (toastEl.classList.contains('closing')) toastEl.hidden = true; }, { once: true });
  }
  toastUndo.addEventListener('click', () => { undoFn?.(); undoFn = null; closeToast(); });
  $('[data-toast-demo]').addEventListener('click', () => toast('Saved'));

  // ---- Expand.
  const expandBtn = $('[data-expand]');
  expandBtn.addEventListener('click', () => {
    const box = $('.expand');
    const open = box.dataset.expanded !== 'true';
    box.dataset.expanded = String(open);
    expandBtn.setAttribute('aria-expanded', String(open));
    expandBtn.textContent = open ? 'Hide details' : 'Show details';
  });

  // ---- Add and remove rows, with Undo.
  const rowsEl = $('[data-rows]');
  const FOLDERS = ['~/code/nekko-agent', '~/Documents/notes', '~/Desktop/receipts', '~/code/website', '~/Pictures/trips', '~/code/dotfiles'];
  let folderN = 0;
  const folderRow = (path) => {
    const wrap = document.createElement('div');
    wrap.className = 'rm-row';
    wrap.innerHTML = `<div class="row" data-quiet-row><span class="lead">${icon('folder-open')}</span><span class="row-text"><span class="row-title mono">${esc(path)}</span></span><button class="btn row-action danger" type="button">Remove</button></div>`;
    $('button', wrap).addEventListener('click', () => removeRow(wrap, path));
    return wrap;
  };
  const addRow = (path, before) => {
    const row = folderRow(path);
    row.classList.add('adding');
    rowsEl.insertBefore(row, before || null);
    row.addEventListener('animationend', () => row.classList.remove('adding'), { once: true });
  };
  function removeRow(row, path) {
    const next = row.nextElementSibling;
    row.classList.add('gone');
    setTimeout(() => {
      row.remove();
      toast(`Removed ${path}`, () => addRow(path, next && next.isConnected ? next : null));
    }, 320 * slow());
  }
  $('[data-add-row]').addEventListener('click', () => addRow(FOLDERS[folderN++ % FOLDERS.length]));
  addRow(FOLDERS[folderN++]);
  addRow(FOLDERS[folderN++]);

  // ---- Popover menu: 200ms in, 150ms out.
  const menuBtn = $('[data-menu-button]');
  const menu = $('[data-menu]');
  const openMenu = () => {
    menu.classList.remove('closing');
    menu.hidden = false;
    menuBtn.setAttribute('aria-expanded', 'true');
    $('[aria-checked="true"]', menu)?.focus();
  };
  const closeMenu = (refocus) => {
    if (menu.hidden || menu.classList.contains('closing')) return;
    menuBtn.setAttribute('aria-expanded', 'false');
    menu.classList.add('closing');
    menu.addEventListener('animationend', () => { if (menu.classList.contains('closing')) menu.hidden = true; }, { once: true });
    if (refocus) menuBtn.focus();
  };
  menuBtn.addEventListener('click', () => (menu.hidden || menu.classList.contains('closing') ? openMenu() : closeMenu()));
  menu.addEventListener('click', (e) => {
    const item = e.target.closest('[role="menuitemradio"]');
    if (!item) return;
    for (const i of $$('[role="menuitemradio"]', menu)) i.setAttribute('aria-checked', String(i === item));
    menuBtn.textContent = `Effort · ${$('.row-title', item).textContent}`;
    closeMenu(true);
  });
  menu.addEventListener('keydown', (e) => {
    const items = $$('[role="menuitemradio"]', menu);
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
    }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(true); });
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.anchor')) closeMenu(false); });

  // ---- Meter.
  const meter = $('[data-meter]');
  meter.addEventListener('click', () => meter.style.setProperty('--fill', `${15 + Math.round(Math.random() * 80)}%`));

  // ---- Example tabs.
  initTabs($('[data-tabs="example"]'), 'chat');

  // ---- Checklist.
  const CHECKS = [
    'No card, border or tile inside a view or popover, except the allowed objects.',
    'Spacing is 8 or 20 (4 only for coupled pairs); groups separated by --q-group and a label.',
    'At most one hairline, between sections of a different kind.',
    'Every size on the type ladder; no tracked caps; no third line on a row.',
    'One line of help at most; detail behind a tap or tooltip.',
    'Only controls that apply to the current context are shown.',
    'One primary button; plum only for intent; information in Petrol.',
    'Agent status uses StatusIcon or WallMascot; other status is a dot and a word with -text words.',
    'No hex, rgb(), Tailwind palette colour, white/black or token fallback in components.',
    'Control icons are Gentleface and play once on hover, focus or press.',
    'Every action has a motion from the table; removals offer Undo.',
    'Checked in Light Nekko and Dusk, at 360px and desktop width.',
  ];
  const checklist = $('[data-checklist]');
  checklist.innerHTML = CHECKS.map((c, i) => `<label class="check"><input type="checkbox" data-i="${i}" /><span>${esc(c)}</span></label>`).join('');
  const count = $('[data-checklist-count]');
  checklist.addEventListener('change', () => {
    const n = $$('input:checked', checklist).length;
    count.textContent = n === CHECKS.length ? 'Every item checked. Ship it.' : `${n} of ${CHECKS.length} checked.`;
  });
  $('[data-copy-checklist]').addEventListener('click', () => {
    const boxes = $$('input', checklist);
    const md = CHECKS.map((c, i) => `- [${boxes[i].checked ? 'x' : ' '}] ${c}`).join('\n');
    navigator.clipboard?.writeText(md).then(() => toast('Copied the checklist'), () => toast('Could not reach the clipboard'));
  });

  // ---- On this page: the section in view.
  const links = new Map($$('.toc a').map((a) => [a.getAttribute('href').slice(1), a]));
  const seen = new Set();
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) (e.isIntersecting ? seen.add(e.target.id) : seen.delete(e.target.id));
    const first = [...links.keys()].find((id) => seen.has(id));
    for (const [id, a] of links) a.setAttribute('aria-current', String(id === first));
  }, { rootMargin: '-76px 0px -55% 0px' });
  for (const id of links.keys()) { const s = document.getElementById(id); if (s) io.observe(s); }
})();
