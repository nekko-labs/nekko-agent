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
      ctx.fillStyle = `rgba(243, 232, 238, ${a})`;
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
  // The viewport check reads layout, so once a frame at most, and not at all
  // once everything has been revealed.
  let pending = 0;
  const onScroll = () => {
    if (pending) return;
    pending = requestAnimationFrame(() => {
      pending = 0;
      showInView();
      if (reveals.every((el) => el.classList.contains('in'))) window.removeEventListener('scroll', onScroll);
    });
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  showInView();
  window.addEventListener('load', showInView);

  // ---- smart download: default to the visitor's machine, menu for everything else ----
  const RELEASES = 'https://github.com/nekko-labs/nekko-agent/releases/latest';
  // Written by scripts/build-docs.mjs at deploy time, so loading the page asks GitHub nothing.
  const RELEASE = '/release.json';

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

  let assets = null; // name -> browser_download_url, once release.json answers
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
      const src = root.dataset.dlSource || 'section'; // hero or section
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
          // cta slug: <src>-download-item-<os>-<fmt>-<arch>, e.g. hero-download-item-win-exe-x64
          a.setAttribute('data-cta', `${src}-download-item-${b.os}-${b.fmt.replace(/^\./, '')}-${b.arch}`);
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
      all.setAttribute('data-cta', `${src}-download-all-releases`);
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

    fetch(RELEASE)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((rel) => {
        assets = rel.assets || {};
        version = rel.version || '';
        render();
      })
      .catch(() => {
        /* no release.json (local preview, or GitHub was down at build): the static links to /releases/latest still work */
      });
  }
})();

// ---- panel videos: loop only while on screen, so five looping demos cost
//      nothing until scrolled to. preload="none" keeps the page load light;
//      with reduced motion they stay on their poster (the lightbox still plays). ----
(() => {
  const videos = document.querySelectorAll('video[data-autoplay]');
  if (!videos.length || !('IntersectionObserver' in window)) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const io = new IntersectionObserver((entries) => {
    entries.forEach(({ target, isIntersecting }) => {
      if (isIntersecting) target.play().catch(() => { /* autoplay blocked: the poster stays */ });
      else target.pause();
    });
  }, { threshold: 0.4 });
  videos.forEach((v) => io.observe(v));
})();

// ---- panel videos with a light version: each <source> carries data-src-light
//      (and the video data-poster-light). The file and poster follow the look,
//      switching with the theme; dark keeps the sources as written. ----
(() => {
  const toned = [...document.querySelectorAll('video[data-autoplay]')].filter((v) => v.querySelector('source[data-src-light]'));
  if (!toned.length) return;
  toned.forEach((v) => {
    v.dataset.posterDark = v.getAttribute('poster');
    v.querySelectorAll('source').forEach((s) => { s.dataset.srcDark = s.getAttribute('src'); });
  });
  const apply = () => {
    const key = document.documentElement.dataset.theme === 'dark' ? 'Dark' : 'Light';
    toned.forEach((v) => {
      if (v.dataset.tone === key) return;
      const first = v.dataset.tone === undefined;
      v.dataset.tone = key;
      if (first && key === 'Dark') return; // already as written
      const wasPlaying = !v.paused;
      v.poster = v.dataset[`poster${key}`] || v.dataset.posterDark;
      v.querySelectorAll('source').forEach((s) => { s.src = s.dataset[`src${key}`] || s.dataset.srcDark; });
      if (v.readyState > 0 || v.networkState !== HTMLMediaElement.NETWORK_EMPTY) v.load();
      if (wasPlaying) v.play().catch(() => {});
    });
  };
  apply();
  new MutationObserver(apply).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
})();

// ---- the hero's speed replay: its file and end-frame poster follow the look
//      (dark files for Dark, light for White), switching with the theme. It
//      autoplays muted and loops; with reduced motion only the poster loads. ----
(() => {
  const video = document.querySelector('video[data-replay]');
  if (!video) return;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const key = () => (document.documentElement.dataset.theme === 'dark' ? 'Dark' : 'Light');
  let loaded = null;
  const load = () => {
    const k = key();
    if (k === loaded) return;
    loaded = k;
    video.poster = video.dataset[`poster${k}`];
    if (reduced) return; // poster only
    video.autoplay = true;
    video.preload = 'auto';
    video.src = video.dataset[`src${k}`];
    video.play().catch(() => { /* autoplay blocked: the poster stays */ });
  };
  load();
  new MutationObserver(load).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
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
      // the visible one: the hero holds a dark and a light shot, one hidden per look
      const src = [...el.querySelectorAll('img, video')].find((m) => m.getClientRects().length);
      let big;
      if (src) {
        big = src.cloneNode(true);
        if (big.tagName === 'IMG' && big.srcset) big.sizes = '100vw';
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

// ---- look switch: Dark or White. Until the visitor picks one the page follows
//      the system's light or dark setting (the inline script in <head> applies
//      it before first paint); a pick is remembered. The icon shows where the
//      next click goes. ----
(() => {
  const btn = document.querySelector('.theme-toggle');
  if (!btn) return;
  const root = document.documentElement;
  const NAME = { dark: 'Dark', white: 'White' };
  const THEME_COLOR = { dark: '#0c0c11', white: '#fbf6f8' };
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  const saved = () => { try { return localStorage.getItem('nekko-theme'); } catch (e) { return null; } };
  const current = () => (root.dataset.theme === 'dark' ? 'dark' : 'white');
  const sync = () => {
    const now = current();
    const next = now === 'dark' ? 'white' : 'dark';
    btn.setAttribute('aria-label', `${NAME[now]} look. Switch to the ${NAME[next]} look`);
    btn.title = `Switch to the ${NAME[next]} look`;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = THEME_COLOR[now];
  };
  sync();
  // No pick yet: keep following the system if it changes while the page is open.
  system.addEventListener('change', () => {
    const pick = saved();
    if (pick === 'dark' || pick === 'white') return;
    root.dataset.theme = system.matches ? 'dark' : 'white';
    sync();
  });
  btn.addEventListener('click', () => {
    const next = current() === 'dark' ? 'white' : 'dark';
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
  const note = form.querySelector('#beta-note');
  const askEmail = form.querySelector('.beta-ask');
  const askName = form.querySelector('[data-beta-name]');
  const nameInput = askName.querySelector('input');
  const done = form.querySelector('.beta-done');
  let body = null; // the saved signup, re-sent with the name in step two
  const lines = {
    idle: "Psst… want to see what's next?",
    watching: 'Ooh, keep going…',
    eager: 'Do it, do it!',
    confused: 'Hmm, that email looks a bit off.',
    celebrate: "Yay! You're in!",
    name: 'Saved! What should I call you?',
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
  // The API's machine sleeps when idle; wake it once someone starts on the form
  // (not on page load, so just reading the page contacts nothing but this site).
  input.addEventListener('focus', () => {
    if (form.dataset.endpoint) fetch(new URL('/healthz', form.dataset.endpoint), { mode: 'no-cors' }).catch(() => {});
  }, { once: true });
  // idle blink every few seconds
  setInterval(() => {
    if (mood !== 'idle') return;
    peek.classList.add('blink');
    setTimeout(() => peek.classList.remove('blink'), 160);
  }, 3800);

  const finish = () => {
    askName.hidden = true;
    done.hidden = false;
    bubble.textContent = lines.celebrate;
  };
  form.querySelector('[data-beta-skip]').addEventListener('click', finish);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (body) {
      // Step two. The API fills in a name on the existing signup; a failure here
      // loses nothing, since the email was saved in step one.
      const name = nameInput.value.trim();
      if (name) fetch(form.dataset.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ ...body, name }) }).catch(() => {});
      finish();
      return;
    }
    if (!input.checkValidity()) { setMood('confused'); input.focus(); return; }
    const endpoint = form.dataset.endpoint;
    if (!endpoint) {
      // No sign-up service connected: say so rather than claim a sign-up that went nowhere.
      note.textContent = "Beta sign-ups aren't open yet. Follow along on GitHub to hear about the first builds.";
      setMood('idle'); // sets the idle line, so the bubble's own text goes after it
      bubble.textContent = 'Almost ready! Check back soon.';
      return;
    }
    // What the API keeps: the page path (never the full URL) and any utm_* tags.
    const params = new URLSearchParams(location.search);
    const utm = {};
    for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']) {
      const v = params.get(key);
      if (v) utm[key] = v;
    }
    const signup = {
      email: input.value.trim(),
      list: 'beta',
      source: location.pathname,
      utm,
      website: form.elements.website?.value || '',
      // Product updates are their own unticked choice; the API records which policy text was agreed to.
      marketing: Boolean(form.elements.marketing?.checked),
      policyVersion: '2026-11-08',
    };
    button.disabled = true;
    let res;
    try {
      res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(signup) });
    } catch (err) {
      res = null;
    }
    button.disabled = false;
    if (!res || !res.ok) {
      if (res && res.status === 429) {
        note.textContent = "That's a lot of sign-ups from here in a short time. Please try again in an hour.";
        bubble.textContent = 'Whoa, slow down! Try again later.';
      } else if (res && res.status === 400) {
        note.textContent = 'Please check your email address and try again.';
        bubble.textContent = lines.confused;
      } else {
        note.textContent = "That didn't go through. Please try again in a moment.";
        bubble.textContent = 'Oops, something went wrong. Try again?';
      }
      peek.dataset.mood = mood = 'confused';
      return;
    }
    body = signup;
    look.removeAttribute('transform');
    setMood('celebrate');
    bubble.textContent = lines.name;
    askEmail.hidden = true;
    askName.hidden = false;
    nameInput.focus();
  });

  // ---- the tour video beside the form. Its file follows the look (dark files
  //      for Dark, light for White) and nothing, poster included,
  //      loads until the section nears the screen. It plays while at least half
  //      of it is in view, never on its own with reduced motion, and when it
  //      ends it hands over to the form. ----
  const tour = document.querySelector('[data-tour]');
  if (!tour) return;
  const video = tour.querySelector('video');
  const end = tour.querySelector('[data-tour-end]');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const tone = () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  let loaded = null; // the tone whose file is in the player
  let inView = false;
  const load = () => {
    const t = tone();
    if (t === loaded) return;
    const at = video.currentTime;
    const wasPlaying = !video.paused;
    const key = t === 'dark' ? 'Dark' : 'Light';
    video.poster = video.dataset[`poster${key}`];
    video.src = video.dataset[`src${key}`];
    loaded = t;
    if (at > 0) {
      video.addEventListener('loadedmetadata', () => {
        video.currentTime = at;
        if (wasPlaying) video.play().catch(() => {});
      }, { once: true });
      video.load();
    }
  };
  new MutationObserver(() => { if (loaded !== null) load(); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  new IntersectionObserver(([e], io) => {
    if (e.isIntersecting) { load(); io.disconnect(); }
  }, { rootMargin: '200px 0px' }).observe(tour);
  if (!reduced) {
    new IntersectionObserver(([e]) => {
      inView = e.intersectionRatio >= 0.5;
      if (inView && end.hidden) { load(); video.play().catch(() => {}); } else if (!inView) video.pause();
    }, { threshold: [0, 0.5] }).observe(video);
  }
  video.addEventListener('ended', () => {
    end.hidden = false;
    setMood('eager');
    if (mood === 'eager') bubble.textContent = 'Liked the tour? Pop your email in!';
  });
  video.addEventListener('play', () => { end.hidden = true; });
  tour.querySelector('[data-tour-join]').addEventListener('click', () => {
    stage.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'nearest' });
    input.focus({ preventScroll: true });
  });
  tour.querySelector('[data-tour-again]').addEventListener('click', () => {
    end.hidden = true;
    video.currentTime = 0;
    video.play().catch(() => {});
  });
})();

// ---- dot-matrix swell background: a fine grid of pixel dots that mostly
//      sits invisible, with a soft wave of brightness drifting through it.
//      The grid is fixed to the screen and ignores scrolling, so the wave
//      keeps one steady pace however the page moves. Brand gradient (plum to
//      light plum, left to right) on the white version,
//      and light plum to rose on the dark one. ~20 fps, pauses when the tab is hidden, and holds still for
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
        if (theme === 'dark') {
          // 0 = light plum #c084b5, 1 = rose #854f6c: glowing on the dark ground
          ctx.fillStyle = `rgba(${Math.round(192 - 59 * k)},${Math.round(132 - 53 * k)},${Math.round(181 - 73 * k)},${(a * 1.1).toFixed(3)})`;
        } else {
          // 0 = plum #5a2352, 1 = light plum #c084b5
          ctx.fillStyle = `rgba(${Math.round(90 + 102 * k)},${Math.round(35 + 97 * k)},${Math.round(82 + 99 * k)},${a.toFixed(3)})`;
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
  // The wave keeps moving down the whole page; the panels over it are solid,
  // so redrawing behind them stays cheap. Only a hidden tab stops it.
  const start = () => { if (!raf && !reduced && !document.hidden) { last = performance.now(); raf = requestAnimationFrame(loop); } };
  const stop = () => { cancelAnimationFrame(raf); raf = 0; };
  size(); draw();
  // A phone's URL bar showing or hiding fires resize with only the height
  // changed a little: keep the canvas rather than reallocating it.
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (window.innerWidth === W && Math.abs(window.innerHeight - H) < 120) return;
      size(); draw();
    }, 150);
  });
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  new MutationObserver(draw).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  start();
})();

// ---- why Nekko: the pillar tour. A vertical tablist; the active pillar's 8 s
//      demo plays beside it (files follow the look: -light for White and
//      Colourful). The visible video is the only clock: the progress line is
//      drawn from its currentTime / duration, and the next pillar becomes active
//      on its `ended`. Two stacked videos double-buffer the demos: the visible
//      one plays while the next file loads into the hidden one, and they swap
//      (a short crossfade) only once the hidden one is playing, so a change
//      never blanks the box. While a demo plays the next pillar's file preloads
//      into the hidden video; a look change loads the other look's file there at
//      the same time. Only the videos' sources change: .pillar-media and
//      everything around it stay the same nodes. The video pauses (and the line
//      with it) while the pointer is over the tour, while keyboard focus is in
//      it, while it is off screen or the tab is hidden, and after Pause;
//      resuming continues from the same frame. A pillar the visitor picks
//      starts from 0 and plays even under the pointer or keyboard hold; a demo
//      that ends during a hold waits on its last frame and the tour moves on
//      once the hold lifts. Under reduced motion nothing advances and only
//      posters load. Video loads only once the tour is first on screen. ----
(() => {
  const tour = document.querySelector('[data-pillar-tour]');
  if (!tour) return;
  const tabs = [...tour.querySelectorAll('.pillar-tab')];
  const items = tabs.map((t) => t.closest('.pillar-item'));
  const bars = items.map((item) => item.querySelector('.pillar-line i'));
  const panel = tour.querySelector('[role="tabpanel"]');
  const vids = [...tour.querySelectorAll('.pillar-video')];
  const pauseBtn = tour.querySelector('[data-pillar-pause]');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const tone = () => (document.documentElement.dataset.theme === 'dark' ? '' : '-light');
  const file = (i, poster) => `media/pillar-${tabs[i].dataset.pillar}${tone()}${poster ? '-poster.jpg' : '.mp4'}`;
  const next = () => (active + 1) % tabs.length;
  let front = vids[0]; // the visible video: the clock
  let back = vids[1]; // hidden: preloads or loads the next file
  let active = 0;
  let userPaused = false;
  let pointer = false;
  let keyboard = false;
  let onScreen = false;
  let seen = false;
  let chosen = false; // the visitor picked this pillar: it plays through the pointer/keyboard hold
  let waiting = false; // ended during a hold: advance once the hold lifts
  let pending = null; // { at, follow } while the back video loads the file that will replace the front
  let frame = 0;
  let gen = 0; // bumps on each new load, so a slow file's late events are ignored
  // The crossfade (keep in step with .pillar-video in styles.css). The outgoing
  // video stays visible under the incoming one until it ends, so nothing loads
  // into it before then.
  const FADE = 400;
  let fadeEnds = 0; // performance.now() when the current crossfade is over
  let settle = 0; // the fallback timer for the end of a fade
  let settleId = 0; // which fade the pending preload belongs to

  tour.classList.add('is-js');
  if (!reduced) {
    tour.classList.add('is-timed');
    pauseBtn.hidden = false;
  }

  const held = () => pointer || keyboard;
  const running = () => !reduced && !userPaused && onScreen && !document.hidden;
  const shouldPlay = () => running() && (!held() || chosen);

  const draw = () => {
    const d = front.duration;
    // While the next file loads the line waits: at 0 for a new pillar, at the
    // swap time for a look change.
    const t = pending && !pending.follow ? pending.at : front.currentTime;
    const p = (!pending || pending.follow) && front.ended ? 1 : d > 0 && Number.isFinite(d) ? Math.min(1, t / d) : 0;
    bars.forEach((bar, j) => { bar.style.transform = `scaleX(${j === active ? p : 0})`; });
  };
  const tick = () => {
    draw();
    frame = front.paused ? 0 : requestAnimationFrame(tick);
  };
  const play = (v) => v.play().catch(() => { /* autoplay blocked: the poster stays */ });

  // Hidden video: preload the pillar after this one, so an automatic advance is seamless.
  const preload = () => {
    if (reduced || !seen || pending) return;
    const src = file(next(), false);
    // No poster on the hidden video: a poster is a frame from the middle of
    // a demo, and it must never show for a pillar that is not active.
    back.removeAttribute('poster');
    if (back.getAttribute('src') !== src) { gen++; back.preload = 'auto'; back.src = src; back.load(); }
  };
  // Show the back video: one step, so exactly one video is shown at any time.
  const swap = () => {
    const old = front;
    front = back;
    back = old;
    pending = null;
    front.classList.add('is-shown');
    back.classList.remove('is-shown');
    front.removeAttribute('aria-hidden');
    back.setAttribute('aria-hidden', 'true');
    front.setAttribute('aria-label', tabs[active].dataset.alt);
    back.pause();
    fadeEnds = performance.now() + FADE;
    draw();
    if (!front.paused && !frame) frame = requestAnimationFrame(tick);
    sync();
    // Preload only once the outgoing video has really faded out (its own
    // opacity transition has ended, not a guess at the time): loading into it
    // earlier shows another demo under the fade. The timer is only a fallback
    // for when no transition runs.
    const id = ++settleId;
    const out = back;
    const done = (e) => {
      if (e && (e.target !== out || e.propertyName !== 'opacity')) return;
      if (id !== settleId) return;
      settleId++;
      out.removeEventListener('transitionend', done);
      clearTimeout(settle);
      preload();
    };
    out.addEventListener('transitionend', done);
    clearTimeout(settle);
    settle = setTimeout(done, FADE + 600);
  };
  // A new load needs the back video while it may still be fading out: finish
  // the fade at once (incoming fully shown, outgoing gone) rather than show the
  // reload under it.
  const cutFade = () => {
    if (performance.now() >= fadeEnds) return;
    clearTimeout(settle);
    settleId++; // the cut ends the fade; that fade's preload is dropped
    tour.classList.add('is-cut');
    void front.offsetWidth; // apply the end state without a transition
    tour.classList.remove('is-cut');
    fadeEnds = 0;
  };
  // Load pillar `active` into the back video at `at` seconds, then swap once it
  // is playing (or, when it should not play, once its frame is ready). With
  // `follow` (a look change) the front keeps playing meanwhile and the back
  // starts from wherever the front has got to.
  const stage = (at, follow = false) => {
    const src = file(active, false);
    const mine = ++gen;
    cutFade();
    pending = { at, follow };
    back.poster = file(active, true);
    const ready = () => {
      if (mine !== gen || !pending) return;
      // Playing: swap on `playing`. Held or paused: swap once the frame at
      // `at` is decoded, so the box never shows an empty video.
      back.addEventListener('seeked', () => { if (mine === gen && pending && !shouldPlay()) swap(); }, { once: true });
      back.currentTime = follow ? front.currentTime : at;
      if (shouldPlay()) play(back);
    };
    if (back.getAttribute('src') === src && back.readyState >= 1) ready();
    else {
      back.preload = 'auto';
      back.src = src;
      back.addEventListener('loadedmetadata', ready, { once: true });
      back.load();
    }
    draw();
  };

  vids.forEach((v) => {
    v.addEventListener('playing', () => {
      if (v === back && pending) {
        // Swap once the incoming video has painted its first frame, not just
        // started: otherwise the fade can begin over an empty video.
        const mine = gen;
        const go = () => { if (mine === gen && pending && v === back) swap(); };
        if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(go);
        else go();
      }
      else if (v === front && !frame) frame = requestAnimationFrame(tick);
    });
    for (const e of ['pause', 'timeupdate', 'seeked', 'loadedmetadata']) v.addEventListener(e, () => { if (v === front) draw(); });
    v.addEventListener('ended', () => {
      if (v !== front || reduced) return;
      if (pending && !pending.follow) return;
      if (pending) { gen++; pending = null; back.pause(); } // the look change lost the race: just move on
      draw();
      if (running() && !held()) select(next());
      else waiting = true;
    });
  });

  const sync = () => {
    tour.classList.toggle('is-held', !shouldPlay());
    tour.classList.toggle('is-paused', userPaused);
    if (reduced || !seen) return;
    if (waiting && running() && !held()) { select(next()); return; }
    if (pending && !pending.follow) {
      // Loading a new file: the front stays paused on its frame; the back plays
      // into the swap when it may.
      front.pause();
      if (shouldPlay() && back.readyState >= 1) play(back);
      else back.pause();
      return;
    }
    if (pending && shouldPlay() && back.readyState >= 1) play(back);
    else if (pending) back.pause();
    if (shouldPlay() && !front.ended) play(front);
    else front.pause();
  };
  function select(i, focus, byUser) {
    active = (i + tabs.length) % tabs.length;
    chosen = Boolean(byUser);
    waiting = false;
    tabs.forEach((t, j) => {
      const on = j === active;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      items[j].classList.toggle('is-active', on);
    });
    panel.setAttribute('aria-labelledby', tabs[active].id);
    if (focus) tabs[active].focus();
    if (reduced || !seen) {
      front.poster = file(active, true);
      front.setAttribute('aria-label', tabs[active].dataset.alt);
      draw();
      return;
    }
    front.pause();
    stage(0);
    sync();
  }

  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => select(i, false, true));
    tab.addEventListener('keydown', (e) => {
      const to = { ArrowDown: active + 1, ArrowRight: active + 1, ArrowUp: active - 1, ArrowLeft: active - 1, Home: 0, End: tabs.length - 1 }[e.key];
      if (to === undefined) return;
      e.preventDefault();
      select(to, true, true);
    });
  });

  tour.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') { pointer = true; sync(); } });
  tour.addEventListener('pointerleave', () => { pointer = false; if (!keyboard) chosen = false; sync(); });
  // Only keyboard focus holds the tour: a mouse click leaves its button focused.
  tour.addEventListener('focusin', (e) => { keyboard = e.target.matches(':focus-visible'); sync(); });
  tour.addEventListener('focusout', (e) => { if (!tour.contains(e.relatedTarget)) { keyboard = false; if (!pointer) chosen = false; sync(); } });
  pauseBtn.addEventListener('click', () => {
    userPaused = !userPaused;
    pauseBtn.setAttribute('aria-label', userPaused ? 'Play the tour' : 'Pause the tour');
    sync();
  });
  document.addEventListener('visibilitychange', sync);

  // First time on screen: the active file goes straight into the visible video.
  const start = () => {
    seen = true;
    front.poster = file(active, true);
    if (reduced) return; // posters only
    front.preload = 'auto';
    front.src = file(active, false);
    front.poster = file(active, true);
    sync();
    preload();
  };
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([entry]) => {
      onScreen = entry.isIntersecting;
      if (onScreen && !seen) start();
      else sync();
    }, { threshold: 0.35 }).observe(tour);
  } else {
    onScreen = true;
    start();
  }
  // A look change: posters follow at once; the playing file is replaced by the
  // other look's at the same time, through the back video.
  new MutationObserver(() => {
    front.poster = file(active, true);
    if (reduced || !seen) return;
    const at = front.currentTime;
    if (pending && !pending.follow) { stage(pending.at); return; }
    if (front.getAttribute('src') !== file(active, false)) stage(at, true);
    sync();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  front.setAttribute('aria-label', tabs[active].dataset.alt);
  draw();
})();

// ---- why Nekko: Nekko peeks over the pillar demos. One Nekko for the whole
//      tour: her drawing is cloned from the beta card's peek so the two stay
//      identical. She blinks now and then; when the active pillar changes she
//      blinks once and glances toward the list (left, or down when the demo is
//      stacked above it). Under reduced motion she stays still. Only her eyes
//      change: the frame and the videos around her are never touched. ----
(() => {
  const host = document.querySelector('[data-pillar-peek]');
  const art = document.querySelector('[data-beta] .nekko-peek-svg');
  if (!host || !art) return;
  const svg = art.cloneNode(true);
  svg.querySelector('.np-look')?.removeAttribute('transform');
  host.appendChild(svg);
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const look = svg.querySelector('.np-look');
  const stacked = window.matchMedia('(max-width: 900px)');
  const blink = () => {
    host.classList.add('blink');
    setTimeout(() => host.classList.remove('blink'), 160);
  };
  setInterval(blink, 4100);
  let back = 0;
  const glance = () => {
    blink();
    look.setAttribute('transform', stacked.matches ? 'translate(0 1)' : 'translate(-1 0)');
    clearTimeout(back);
    back = setTimeout(() => look.removeAttribute('transform'), 700);
  };
  const seen = new MutationObserver((records) => {
    if (records.some((r) => r.target.getAttribute('aria-selected') === 'true')) glance();
  });
  document.querySelectorAll('[data-pillar-tour] .pillar-tab').forEach((tab) => seen.observe(tab, { attributes: true, attributeFilter: ['aria-selected'] }));
})();
