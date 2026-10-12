// Docs hub behaviour: the mobile drawer, copy buttons, the "On this page"
// highlight and Ctrl/Cmd+K search over /docs/search.json. Every page works
// without this script; it only adds conveniences.
(() => {
  const body = document.body;

  // ---- mobile drawer ----
  const menu = document.querySelector('.menu');
  const sidebar = document.getElementById('sidebar');
  const setNav = (open) => {
    body.classList.toggle('nav-open', open);
    menu?.setAttribute('aria-expanded', String(open));
    menu?.setAttribute('aria-label', open ? 'Close the docs menu' : 'Open the docs menu');
  };
  menu?.addEventListener('click', () => setNav(!body.classList.contains('nav-open')));
  sidebar?.addEventListener('click', (e) => {
    if (e.target.closest('a')) setNav(false);
  });
  document.addEventListener('click', (e) => {
    if (body.classList.contains('nav-open') && !e.target.closest('.sidebar, .menu')) setNav(false);
  });
  // Keep the current page in view in a long sidebar.
  sidebar?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'center' });

  // ---- copy buttons ----
  document.querySelectorAll('.code .copy').forEach((button) => {
    button.addEventListener('click', async () => {
      const text = button.parentElement.querySelector('code')?.innerText ?? '';
      try {
        await navigator.clipboard.writeText(text.replace(/\n$/, ''));
        button.textContent = 'Copied';
        button.classList.add('done');
      } catch {
        button.textContent = 'Press Ctrl+C';
      }
      setTimeout(() => {
        button.textContent = 'Copy';
        button.classList.remove('done');
      }, 1600);
    });
  });

  // ---- "On this page": highlight the section being read ----
  const tocLinks = [...document.querySelectorAll('.toc a[href^="#"]')].filter((a) => a.hash !== '#top');
  const headings = tocLinks.map((a) => document.getElementById(decodeURIComponent(a.hash.slice(1)))).filter(Boolean);
  if (headings.length) {
    let ticking = false;
    const update = () => {
      ticking = false;
      const line = 120;
      let current = null;
      for (const h of headings) {
        if (h.getBoundingClientRect().top <= line) current = h;
        else break;
      }
      // At the very bottom the last short sections can never reach the line.
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) current = headings.at(-1);
      tocLinks.forEach((a) => a.classList.toggle('active', current != null && a.hash === `#${current.id}`));
    };
    addEventListener('scroll', () => {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(update);
      }
    }, { passive: true });
    update();
  }

  // ---- search ----
  const dialog = document.querySelector('.search-dialog');
  const input = dialog?.querySelector('input');
  const results = dialog?.querySelector('.results');
  const opener = document.querySelector('.search');
  if (!dialog || !input || !results) return;
  if (/Mac|iPhone|iPad/.test(navigator.platform)) opener?.querySelector('kbd')?.replaceChildren('⌘ K');

  let index = null;
  let selected = 0;
  const load = () =>
    (index ??= fetch('/docs/search.json')
      .then((r) => r.json())
      .catch(() => []));

  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const mark = (text, terms) => {
    let out = esc(text);
    for (const t of terms) out = out.replace(new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig'), '<mark>$1</mark>');
    return out;
  };
  const snippet = (text, terms) => {
    const lower = text.toLowerCase();
    const at = Math.max(0, Math.min(...terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0)) - 40);
    return (at > 0 ? '…' : '') + text.slice(at, at + 160);
  };

  const search = async () => {
    const q = input.value.trim().toLowerCase();
    const terms = q.split(/\s+/).filter(Boolean);
    const all = await load();
    if (!terms.length) {
      results.innerHTML = '';
      return;
    }
    const scored = [];
    for (const entry of all) {
      const title = `${entry.page} ${entry.heading}`.toLowerCase();
      const text = entry.text.toLowerCase();
      let score = 0;
      let ok = true;
      for (const t of terms) {
        if (title.includes(t)) score += entry.heading.toLowerCase().includes(t) ? 6 : 4;
        else if (text.includes(t)) score += 1;
        else ok = false;
      }
      if (ok) scored.push({ entry, score: score + (entry.heading ? 0 : 1) });
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, 12);
    selected = 0;
    results.innerHTML = top.length
      ? top
          .map(
            ({ entry }, i) =>
              `<li><a href="${esc(entry.url)}" role="option" aria-selected="${i === 0}">` +
              `<span class="where">${esc(entry.section)}${entry.heading ? ` · ${esc(entry.page)}` : ''}</span>` +
              `<span class="what">${mark(entry.heading || entry.page, terms)}</span>` +
              (entry.text ? `<span class="snip">${mark(snippet(entry.text, terms), terms)}</span>` : '') +
              `</a></li>`,
          )
          .join('')
      : `<li class="empty">No results for “${esc(input.value.trim())}”.</li>`;
  };

  const select = (n) => {
    const items = [...results.querySelectorAll('a')];
    if (!items.length) return;
    selected = (n + items.length) % items.length;
    items.forEach((a, i) => a.setAttribute('aria-selected', String(i === selected)));
    items[selected].scrollIntoView({ block: 'nearest' });
  };

  const open = () => {
    if (dialog.open) return;
    setNav(false);
    dialog.showModal();
    input.select();
    load();
  };
  opener?.addEventListener('click', open);
  input.addEventListener('input', search);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); select(selected + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); select(selected - 1); }
    else if (e.key === 'Enter') {
      const a = results.querySelectorAll('a')[selected];
      if (a) { e.preventDefault(); dialog.close(); location.href = a.href; }
    }
  });
  results.addEventListener('click', (e) => {
    if (e.target.closest('a')) dialog.close();
  });
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
    if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) {
      e.preventDefault();
      open();
    }
  });
})();
