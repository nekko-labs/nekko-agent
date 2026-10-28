// Nekko Agent marketing site: starfield backdrop, scroll reveals, OS highlight.
(function () {
  // ---- drifting starfield (space-travel feel, honors reduced motion) ----
  const canvas = document.getElementById('stars');
  const ctx = canvas.getContext('2d');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let w, h, stars;

  function resize() {
    w = canvas.width = window.innerWidth;
    h = canvas.height = window.innerHeight;
    const count = Math.min(320, Math.floor((w * h) / 6500));
    stars = Array.from({ length: count }, () => spawn(true));
  }
  function spawn(anywhere) {
    return {
      // travel outward from a vanishing point slightly above center
      x: (Math.random() - 0.5) * w,
      y: (Math.random() - 0.55) * h,
      z: anywhere ? Math.random() * 1 : 1, // depth 0 (near) .. 1 (far)
      s: 0.4 + Math.random() * 1.4,
    };
  }
  function frame() {
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2;
    const cy = h * 0.42;
    for (const st of stars) {
      if (!reduced) {
        st.z -= 0.0009 * st.s; // drift toward the viewer
        if (st.z <= 0.02) Object.assign(st, spawn(false), { z: 1 });
      }
      const k = 1 / st.z;
      const x = cx + st.x * k * 0.08;
      const y = cy + st.y * k * 0.08;
      if (x < -10 || x > w + 10 || y < -10 || y > h + 10) {
        Object.assign(st, spawn(false), { z: 1 });
        continue;
      }
      const r = Math.min(1.8, st.s * k * 0.045);
      const a = Math.min(0.9, 0.15 + (1 - st.z) * 0.9);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(226, 238, 248, ${a})`;
      ctx.fill();
    }
    if (!reduced) requestAnimationFrame(frame);
  }
  if (!canvas.hidden) {
    resize();
    window.addEventListener('resize', resize);
    frame();
  }

  // ---- scroll-driven reveals (IO + a viewport check so the hero shows even
  // where IO/rAF are throttled, e.g. embedded webviews) ----
  const reveals = [...document.querySelectorAll('.reveal')];
  function showInView() {
    const vh = window.innerHeight;
    reveals.forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.top < vh * 0.92 && r.bottom > 0) el.classList.add('in');
    });
  }
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && e.target.classList.add('in')),
      { threshold: 0.12 },
    );
    reveals.forEach((el) => io.observe(el));
  }
  window.addEventListener('scroll', showInView, { passive: true });
  showInView();
  window.addEventListener('load', showInView);

  // ---- smart download: default to the visitor's machine, menu for everything else ----
  const RELEASES = 'https://github.com/nekko-labs/nekko-agent/releases/latest';
  const API = 'https://api.github.com/repos/nekko-labs/nekko-agent/releases/latest';

  // Each build we publish, with the pattern that finds it in a release's assets.
  // `pick` is what the primary button chooses for a detected os+arch.
  const BUILDS = [
    { os: 'win', label: 'Windows', fmt: '.exe', hint: 'x64 installer', arch: 'x64', match: /-x64\.exe$/i, pick: true },
    { os: 'win', label: 'Windows', fmt: '.msi', hint: 'x64 installer', arch: 'x64', match: /-x64\.msi$/i },
    { os: 'win', label: 'Windows', fmt: '.zip', hint: 'x64 portable', arch: 'x64', match: /-x64\.zip$/i },
    { os: 'mac', label: 'macOS', fmt: '.dmg', hint: 'Apple Silicon', arch: 'arm64', match: /-arm64\.dmg$/i, pick: true },
    { os: 'mac', label: 'macOS', fmt: '.dmg', hint: 'Intel', arch: 'x64', match: /-x64\.dmg$/i, pick: true },
    { os: 'mac', label: 'macOS', fmt: '.zip', hint: 'Apple Silicon', arch: 'arm64', match: /-arm64\.zip$/i },
    { os: 'linux', label: 'Linux', fmt: '.AppImage', hint: 'x86_64, any distro', arch: 'x64', match: /\.AppImage$/i, pick: true },
    { os: 'linux', label: 'Linux', fmt: '.deb', hint: 'Debian, Ubuntu', arch: 'x64', match: /\.deb$/i },
  ];
  const OS_ORDER = ['win', 'mac', 'linux'];
  const OS_NAME = { win: 'Windows', mac: 'macOS', linux: 'Linux' };

  // The same one-liner the button downloads, in the shell that visitor actually
  // has: fetch the exact release asset, then launch it.
  const CMD = {
    win: (u) => `iwr ${u} -OutFile nekko-agent-setup.exe; .\\nekko-agent-setup.exe`,
    mac: (u) => `curl -L ${u} -o NekkoAgent.dmg && open NekkoAgent.dmg`,
    linux: (u) =>
      `curl -L ${u} -o NekkoAgent.AppImage && chmod +x NekkoAgent.AppImage && ./NekkoAgent.AppImage`,
  };
  const SHELL = { win: 'PowerShell', mac: 'Terminal', linux: 'a shell' };

  const note = document.getElementById('dlNote');
  const term = document.getElementById('dlTerm');
  const termCmd = document.getElementById('dlCmd');
  const termShell = document.getElementById('dlTermShell');
  const copyBtn = document.getElementById('dlCopy');
  const copyLabel = copyBtn?.querySelector('.dl-copy-t');

  // ---- who's visiting ----
  const uaStr = navigator.userAgent;
  const uaPlat = navigator.userAgentData?.platform || '';
  const touchMac = /Mac/.test(uaStr) && navigator.maxTouchPoints > 1; // iPadOS lies about being a Mac
  const mobile = /Android/i.test(uaStr) || /iPhone|iPad|iPod/i.test(uaStr) || touchMac;
  let os = null;
  if (!mobile) {
    if (/Win/i.test(uaPlat) || /Windows/i.test(uaStr)) os = 'win';
    else if (/mac/i.test(uaPlat) || /Mac OS X/i.test(uaStr)) os = 'mac';
    else if (/linux/i.test(uaPlat) || /Linux|X11|CrOS/i.test(uaStr)) os = 'linux';
  }
  // Apple Silicon is the safe default on modern Macs; refined below where the
  // browser will tell us (Chromium high-entropy hints), or by the WebGL renderer.
  let arch = os === 'mac' ? 'arm64' : 'x64';

  function macIsAppleSilicon() {
    try {
      const gl = document.createElement('canvas').getContext('webgl');
      const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
      const r = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
      if (/Apple\s?(M\d|GPU)/i.test(r)) return true;
      if (/Intel|AMD|Radeon/i.test(r)) return false;
    } catch (_) {}
    return null; // unknown, keep the default
  }

  let assets = null; // name -> browser_download_url, once the API answers
  let version = '';

  function urlFor(build) {
    if (!assets) return RELEASES;
    const hit = Object.keys(assets).find((name) => build.match.test(name));
    return hit ? assets[hit] : null;
  }

  function chosen() {
    if (!os) return null;
    const forOs = BUILDS.filter((b) => b.pick && b.os === os);
    return forOs.find((b) => b.arch === arch) || forOs[0] || null;
  }

  // ---- one picker: primary button for this machine, caret menu for the rest.
  //      Wired per .dl-pick, so the hero and the download section behave the same. ----
  function setupPick(root) {
    const main = root.querySelector('[data-dl-main]');
    const mainTitle = root.querySelector('[data-dl-title]');
    const mainVer = root.querySelector('[data-dl-ver]');
    const caret = root.querySelector('[data-dl-caret]');
    const menu = root.querySelector('[data-dl-menu]');
    const isOpen = () => !menu.hidden;

    // Label + version chip only; the format and arch ride along as the link's
    // tooltip and in the caption under the download-section button.
    function renderMain() {
      const b = chosen();
      mainVer.textContent = version;
      if (!b) {
        mainTitle.textContent = 'Download Nekko Agent';
        main.href = RELEASES;
        main.title = mobile ? 'Install on your computer, then pair this phone' : 'All builds on GitHub Releases';
        return;
      }
      mainTitle.textContent = `Download for ${OS_NAME[b.os]}`;
      main.href = urlFor(b) || RELEASES;
      main.title = `${b.fmt} · ${b.hint}`;
    }

    function renderMenu() {
      menu.textContent = '';
      const current = chosen();
      let wrote = false;
      for (const key of OS_ORDER) {
        const builds = BUILDS.filter((b) => b.os === key).filter((b) => !assets || urlFor(b));
        if (!builds.length) continue;
        const head = document.createElement('div');
        head.className = 'dl-group';
        head.textContent = OS_NAME[key];
        menu.appendChild(head);
        for (const b of builds) {
          const a = document.createElement('a');
          a.className = 'dl-item';
          a.href = urlFor(b) || RELEASES;
          a.setAttribute('role', 'menuitem');
          if (b === current) a.setAttribute('aria-current', 'true');
          a.innerHTML =
            `<span class="dl-fmt">${b.fmt}</span><span class="dl-hint">${b.hint}</span>`;
          menu.appendChild(a);
          wrote = true;
        }
      }
      if (wrote) {
        const sep = document.createElement('div');
        sep.className = 'dl-sep';
        menu.appendChild(sep);
      }
      const all = document.createElement('a');
      all.className = 'dl-item';
      all.href = RELEASES;
      all.setAttribute('role', 'menuitem');
      all.innerHTML = `<span class="dl-fmt">All downloads</span><span class="dl-hint">GitHub Releases</span>`;
      menu.appendChild(all);
    }

    // Drop the menu below the button, or flip it above when the page bottom (and
    // the footer) is closer than the menu is tall. Cap it to the room it has.
    function place() {
      menu.classList.remove('up');
      menu.style.maxHeight = '';
      const gap = 24;
      const r = root.getBoundingClientRect();
      const below = window.innerHeight - r.bottom - gap;
      const navBottom = document.querySelector('.nav')?.getBoundingClientRect().bottom || 0;
      const above = r.top - Math.max(gap, navBottom + 12);
      const needed = menu.offsetHeight;
      const up = needed > below && above > below;
      menu.classList.toggle('up', up);
      const room = up ? above : below;
      if (needed > room) menu.style.maxHeight = `${Math.max(200, room)}px`;
    }

    function setOpen(open) {
      if (open) closeOtherMenus(root);
      menu.hidden = !open;
      root.classList.toggle('open', open);
      caret.setAttribute('aria-expanded', String(open));
      if (open) {
        place();
        menu.querySelector('.dl-item')?.focus();
      }
    }

    caret.addEventListener('click', (e) => {
      e.stopPropagation();
      setOpen(!isOpen());
    });
    document.addEventListener('click', (e) => {
      if (isOpen() && !root.contains(e.target)) setOpen(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isOpen()) {
        setOpen(false);
        caret.focus();
      }
    });
    menu.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const items = [...menu.querySelectorAll('.dl-item')];
      const i = items.indexOf(document.activeElement);
      const next = e.key === 'ArrowDown' ? i + 1 : i - 1;
      items[(next + items.length) % items.length].focus();
    });
    menu.addEventListener('click', () => setOpen(false));
    const reflow = () => isOpen() && place();
    window.addEventListener('resize', reflow);
    window.addEventListener('scroll', reflow, { passive: true });

    return {
      root,
      close: () => setOpen(false),
      isOpen,
      render: () => {
        renderMain();
        renderMenu();
        if (isOpen()) place();
      },
    };
  }

  const picks = [...document.querySelectorAll('[data-dl-pick]')].map(setupPick);
  function closeOtherMenus(except) {
    picks.forEach((p) => p.root !== except && p.isOpen() && p.close());
  }

  function renderNote() {
    if (!note) return;
    const b = chosen();
    if (b) {
      note.textContent = `${b.fmt} · ${b.hint}. Not your machine? Use the arrow for every other build.`;
    } else {
      note.textContent = mobile
        ? 'Nekko Agent runs on your computer. Choose a desktop build from the menu.'
        : 'Pick a build from the menu, or see them all on GitHub Releases.';
    }
  }

  // Only shown once the real asset URL is known, so the command is never a guess.
  function renderTerm() {
    if (!term) return;
    const b = chosen();
    const url = b && assets ? urlFor(b) : null;
    if (!url || !CMD[b.os]) {
      term.hidden = true;
      return;
    }
    termCmd.textContent = CMD[b.os](url);
    termShell.textContent = SHELL[b.os];
    term.hidden = false;
  }

  function copyFallback(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (_) {}
    ta.remove();
    return ok;
  }

  let copyTimer;
  copyBtn?.addEventListener('click', async () => {
    const text = termCmd.textContent;
    let ok = true;
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      ok = copyFallback(text);
    }
    if (!ok) window.getSelection()?.selectAllChildren(termCmd); // let them hit copy themselves
    copyBtn.classList.toggle('done', ok);
    copyLabel.textContent = ok ? 'Copied' : 'Select all';
    copyBtn.setAttribute('aria-label', ok ? 'Command copied to clipboard' : 'Command selected, copy it with your keyboard');
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      copyBtn.classList.remove('done');
      copyLabel.textContent = 'Copy';
      copyBtn.setAttribute('aria-label', 'Copy command to clipboard');
    }, 1900);
  });

  function render() {
    picks.forEach((p) => p.render());
    renderNote();
    renderTerm();
  }

  if (picks.length) {
    render();

    // refine the Mac arch guess, then swap in real asset URLs when they arrive
    if (os === 'mac') {
      const hints = navigator.userAgentData?.getHighEntropyValues?.(['architecture']);
      if (hints) {
        hints
          .then((v) => {
            if (v.architecture) arch = /arm/i.test(v.architecture) ? 'arm64' : 'x64';
            render();
          })
          .catch(() => {});
      } else {
        const silicon = macIsAppleSilicon();
        if (silicon !== null) arch = silicon ? 'arm64' : 'x64';
      }
    }

    fetch(API, { headers: { Accept: 'application/vnd.github+json' } })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((rel) => {
        assets = Object.fromEntries(
          (rel.assets || []).map((a) => [a.name, a.browser_download_url]),
        );
        version = rel.tag_name || '';
        render();
      })
      .catch(() => {
        /* offline or rate-limited: the static links to /releases/latest still work */
      });
  }
})();

// ---- media slots: click a feature GIF or product image to see it large ----
(() => {
  const box = document.getElementById('lightbox');
  if (!box) return;
  const stage = box.querySelector('.lightbox-stage');
  const close = box.querySelector('.lightbox-close');
  let opener = null;
  const shut = () => {
    box.hidden = true; stage.replaceChildren(); document.body.style.overflow = '';
    if (opener) opener.focus();
  };
  document.querySelectorAll('.media').forEach((el) => {
    el.addEventListener('click', () => {
      opener = el;
      const src = el.querySelector('img, video');
      let big;
      if (src) {
        big = src.cloneNode(true);
        if (big.tagName === 'VIDEO') { big.controls = true; big.autoplay = true; big.muted = true; big.loop = true; }
      } else {
        big = document.createElement('div');
        big.className = 'media-placeholder';
        big.textContent = el.querySelector('.media-joke')?.textContent || 'Coming soon';
      }
      stage.replaceChildren(big);
      box.hidden = false; document.body.style.overflow = 'hidden';
      close.focus();
    });
  });
  close.addEventListener('click', shut);
  box.addEventListener('click', (e) => { if (e.target === box || e.target === stage) shut(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !box.hidden) shut(); });
})();

// ---- look switch: Colourful by default, then Dark, then White. The choice is
//      remembered once made; the icon shows where the next click goes. ----
(() => {
  const btn = document.querySelector('.theme-toggle');
  if (!btn) return;
  const root = document.documentElement;
  const LOOKS = ['dark', 'white', 'colour'];
  const NAME = { dark: 'Dark', white: 'White', colour: 'Colourful' };
  const THEME_COLOR = { dark: '#0d0b18', white: '#f3effe', colour: '#9d8ce6' };
  const current = () => (LOOKS.includes(root.dataset.theme) ? root.dataset.theme : 'colour');
  const sync = () => {
    const now = current();
    const next = LOOKS[(LOOKS.indexOf(now) + 1) % LOOKS.length];
    btn.setAttribute('aria-label', `${NAME[now]} look. Switch to the ${NAME[next]} look`);
    btn.title = `Switch to the ${NAME[next]} look`;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = THEME_COLOR[now];
  };
  sync();
  btn.addEventListener('click', () => {
    const next = LOOKS[(LOOKS.indexOf(current()) + 1) % LOOKS.length];
    root.dataset.theme = next;
    sync();
    try { localStorage.setItem('nekko-theme', next); } catch (e) { /* private mode: the choice lasts this page only */ }
  });
})();

// ---- phone menu: the nav links fold behind a button below 900px ----
(() => {
  const nav = document.querySelector('.nav');
  const btn = document.querySelector('.nav-menu');
  if (!nav || !btn) return;
  const set = (open) => {
    nav.classList.toggle('nav-open', open);
    btn.setAttribute('aria-expanded', String(open));
    btn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  };
  btn.addEventListener('click', () => set(!nav.classList.contains('nav-open')));
  nav.querySelectorAll('.nav-links a').forEach((a) => a.addEventListener('click', () => set(false)));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && nav.classList.contains('nav-open')) { set(false); btn.focus(); } });
  document.addEventListener('click', (e) => { if (!nav.contains(e.target)) set(false); });
})();

// ---- beta sign-up, hosted by Nekko: she peeks over the card and reacts.
//      idle: blinks now and then · watching: eyes follow the typing ·
//      eager: happy eyes over the button · confused: a bad email ·
//      celebrate: hop and sparkles once signed up ----
(() => {
  const stage = document.querySelector('[data-beta]');
  if (!stage) return;
  const form = stage.querySelector('[data-beta-form]');
  const input = form.querySelector('input[type="email"]');
  const button = form.querySelector('button[type="submit"]');
  const peek = stage.querySelector('.nekko-peek');
  const look = stage.querySelector('.np-look');
  const bubble = stage.querySelector('[data-bubble]');
  const note = form.querySelector('.beta-note');
  const lines = {
    idle: "Psst… want to see what's next?",
    watching: 'Ooh, keep going…',
    eager: 'Do it, do it!',
    confused: 'Hmm, that email looks a bit off.',
    celebrate: "Yay! You're in!",
  };
  let mood = 'idle';
  const setMood = (m) => {
    if (mood === 'celebrate') return; // signed up: stay happy
    mood = m;
    peek.dataset.mood = m;
    bubble.textContent = lines[m];
  };
  // eyes follow the text: left at the start of the box, right as it fills, a little down towards it
  const follow = () => {
    const t = Math.min(input.value.length / 24, 1);
    look.setAttribute('transform', `translate(${(-1 + 2 * t).toFixed(2)} 1)`);
  };
  input.addEventListener('focus', () => { if (mood !== 'confused') setMood('watching'); follow(); });
  input.addEventListener('input', () => { if (mood === 'confused') setMood('watching'); follow(); });
  input.addEventListener('blur', () => { look.removeAttribute('transform'); if (mood === 'watching') setMood('idle'); });
  button.addEventListener('mouseenter', () => { if (mood !== 'confused') setMood('eager'); });
  button.addEventListener('mouseleave', () => { if (mood === 'eager') setMood(document.activeElement === input ? 'watching' : 'idle'); });
  // idle blink every few seconds
  setInterval(() => {
    if (mood !== 'idle') return;
    peek.classList.add('blink');
    setTimeout(() => peek.classList.remove('blink'), 160);
  }, 3800);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!input.checkValidity()) { setMood('confused'); input.focus(); return; }
    const endpoint = form.dataset.endpoint;
    if (!endpoint) {
      // No sign-up service connected yet: say so rather than claim a sign-up that went nowhere.
      note.textContent = "Beta sign-ups aren't open yet. Follow along on GitHub to hear about the first builds.";
      setMood('idle'); // sets the idle line, so the bubble's own text goes after it
      bubble.textContent = 'Almost ready! Check back soon.';
      return;
    }
    {
      try {
        const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ email: input.value }) });
        if (!res.ok) throw new Error(String(res.status));
      } catch (err) {
        note.textContent = "That didn't go through. Please try again in a moment.";
        setMood('confused');
        bubble.textContent = 'Oops, something went wrong. Try again?';
        return;
      }
    }
    look.removeAttribute('transform');
    setMood('celebrate');
    form.querySelector('.beta-ask').hidden = true;
    form.querySelector('.beta-done').hidden = false;
  });
})();

// ---- dot-matrix swell background: a fine grid of pixel dots that mostly
//      sits invisible, with a soft wave of brightness drifting through it.
//      The grid is fixed to the screen and ignores scrolling, so the wave
//      keeps one steady pace however the page moves. Brand gradient (indigo to
//      lavender, left to right) on the white version, white on the colourful
//      one, and lavender to aqua on the dark one. ~20 fps, pauses when the tab is hidden, and holds still for
//      reduced-motion visitors. ----
(() => {
  const c = document.getElementById('pixelwave');
  if (!c || !c.getContext) return;
  const ctx = c.getContext('2d');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const CELL = 9; // small dots, high density
  let W = 0, H = 0, dpr = 1, t = 0, last = 0, raf = 0;
  const size = () => {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
  };
  const look = () => document.documentElement.dataset.theme;
  const draw = () => {
    const theme = look();
    ctx.clearRect(0, 0, W, H);
    for (let y = 0; y < H; y += CELL) {
      for (let x = 0; x < W; x += CELL) {
        const w = Math.sin(x / 110 - t * 1.4 + Math.sin(y / 150 + t * 0.5) * 1.6);
        const a = Math.max(0, w) ** 3 * 0.34;
        if (a < 0.025) continue;
        const s = a > 0.18 ? 3 : 2;
        const k = x / W;
        if (theme === 'dark' || theme === 'colour') {
          // 0 = lavender #9D8CE6, 1 = aqua #8AE4F2: glowing on the dark ground, tinted on the lilac one
          ctx.fillStyle = `rgba(${Math.round(157 - 19 * k)},${Math.round(140 + 88 * k)},${Math.round(230 + 12 * k)},${(a * 1.1).toFixed(3)})`;
        } else {
          // 0 = indigo #453A92, 1 = lavender #9D8CE6
          ctx.fillStyle = `rgba(${Math.round(69 + 88 * k)},${Math.round(58 + 82 * k)},${Math.round(146 + 84 * k)},${a.toFixed(3)})`;
        }
        ctx.fillRect(Math.round(x + (CELL - s) / 2), Math.round(y + (CELL - s) / 2), s, s);
      }
    }
  };
  const loop = (now) => {
    raf = requestAnimationFrame(loop);
    if (now - last < 50) return;
    t += (now - last) / 1000 * 0.72; // 20% slower than the original 0.9
    last = now;
    draw();
  };
  const start = () => { if (!raf && !reduced) { last = performance.now(); raf = requestAnimationFrame(loop); } };
  const stop = () => { cancelAnimationFrame(raf); raf = 0; };
  size(); draw();
  window.addEventListener('resize', () => { size(); draw(); });
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  new MutationObserver(draw).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  start();
})();
