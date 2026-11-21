// Build the docs hub at nekkoagent.com/docs from the Markdown in this repo.
//
// docs/hub/nav.json lists the pages; each renders from one Markdown file.
// Vercel runs this as the website's build command (vercel.json), so these are
// generated at deploy time and gitignored:
//   apps/website/docs/<slug>.html   the page (cleanUrls serves it at /docs/<slug>)
//   apps/website/docs/<slug>.md     the same page as Markdown, for agents
//   apps/website/docs/search.json   the client-side search index
//   apps/website/docs/media/        images the pages use
//   apps/website/llms-full.txt      every page in one file
//   apps/website/release.json       the latest release, for the download buttons
//   apps/website/whatsnew.html      the What's new page, from docs/hub/whats-new.json
// (Committed, they made every docs PR conflict with every other one in the
// merge queue.) It also rewrites the generated docs section in llms.txt and the
// docs URLs in sitemap.xml. Those two are committed: they change only with
// nav.json, and the Docs site workflow commits them when they do.
//
//   node scripts/build-docs.mjs          write the output
//   node scripts/build-docs.mjs --check  exit 1 if llms.txt or sitemap.xml is stale
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked } from 'marked';
import { writeContributors } from './build-contributors.mjs';
import { writeDesignSystem } from './build-design-system.mjs';

// The text of a rendered heading: its tags dropped and marked's entities turned
// back into characters, so the layout can escape it once like any other string.
function plainText(html) {
  const chars = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
  return stripHtmlTags(html).replace(/&(amp|lt|gt|quot|#39);/g, (_, name) => chars[name]);
}

function stripHtmlTags(input) {
  let prev;
  let out = input;
  do {
    prev = out;
    out = out.replace(/<[^>]+>/g, '');
  } while (out !== prev);
  return out;
}

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const site = join(repo, 'apps', 'website');
const outDir = join(site, 'docs');
const ORIGIN = 'https://nekkoagent.com';
const GITHUB = 'https://github.com/nekko-labs/nekko-agent';
const ASSET_VERSION = 'docs-1';
// Bump after re-running scripts/make-og-cards.mjs so link previews refetch.
const OG_VERSION = '2';
// A page's own preview card, or the site card until make-og-cards.mjs has drawn one.
const ogImage = (page) =>
  existsSync(join(site, 'og', `docs-${pageFile(page.slug)}.jpg`))
    ? `${ORIGIN}/og/docs-${pageFile(page.slug)}.jpg?v=${OG_VERSION}`
    : `${ORIGIN}/og.png?v=plum-3`;

export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[<>]/g, '')
    .replace(/&[a-z]+;|&#\d+;/g, '')
    .replace(/[`*_~]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s/g, '-'); // one dash per space, as GitHub does ("a & b" -> "a--b")
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function loadNav(root = repo) {
  const nav = JSON.parse(readFileSync(join(root, 'docs', 'hub', 'nav.json'), 'utf8'));
  const pages = [];
  for (const section of nav.sections) {
    for (const page of section.pages) pages.push({ ...page, section: section.title });
  }
  return { sections: nav.sections, pages };
}

const pageUrl = (slug) => (slug ? `/docs/${slug}` : '/docs');
const pageFile = (slug) => slug || 'index';

// Resolve a link written in a source file. Links to another hub page become
// /docs/<slug>; other repo files go to GitHub; local images are copied into
// docs/media. External and same-page links pass through.
function makeResolver(pages, media) {
  const bySource = new Map(pages.map((p) => [posix.normalize(p.source), p]));
  return function resolveHref(href, source, { image = false, absolute = false } = {}) {
    if (!href || /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(href)) return href;
    if (href.startsWith('/')) return absolute ? ORIGIN + href : href;
    const [path, hash = ''] = href.split('#');
    const target = posix.normalize(posix.join(posix.dirname(source), decodeURI(path)));
    if (target.startsWith('..')) return href;
    if (image) {
      const file = join(repo, target);
      if (!existsSync(file)) throw new Error(`${source}: image not found: ${href}`);
      const name = basename(target);
      const taken = media.get(name);
      if (taken && taken !== file) throw new Error(`${source}: two images named ${name}`);
      media.set(name, file);
      const url = `/docs/media/${name}`;
      return absolute ? ORIGIN + url : url;
    }
    const page = bySource.get(target);
    const anchor = hash ? `#${hash}` : '';
    if (page) return (absolute ? ORIGIN : '') + pageUrl(page.slug) + anchor;
    if (!existsSync(join(repo, target))) throw new Error(`${source}: broken link: ${href}`);
    return `${GITHUB}/blob/main/${target}${anchor}`;
  };
}

function render(page, resolveHref) {
  const source = readFileSync(join(repo, page.source), 'utf8').replace(/\r\n/g, '\n');
  const toc = [];
  const used = new Map();
  const headingIds = [];
  let title = page.title;
  const marked = new Marked({ gfm: true });
  marked.use({
    walkTokens(token) {
      if (token.type === 'link') token.href = resolveHref(token.href, page.source);
      if (token.type === 'image') token.href = resolveHref(token.href, page.source, { image: true });
      if (token.type === 'heading') {
        let id = slugify(token.text) || 'section';
        const n = used.get(id) ?? 0;
        used.set(id, n + 1);
        if (n) id = `${id}-${n}`;
        headingIds.push(id);
      }
    },
    hooks: {
      // Wrap tables so a wide one scrolls inside the column instead of the page.
      postprocess: (out) => out.replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, '</table></div>'),
    },
    renderer: {
      heading({ tokens, depth }) {
        const id = headingIds.shift();
        const inner = this.parser.parseInline(tokens);
        if (depth === 1) {
          title = plainText(inner);
          return '';
        }
        // Already escaped by marked: the layout inserts it as HTML.
        if (depth <= 3) toc.push({ depth, id, html: stripHtmlTags(inner) });
        return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true" tabindex="-1">#</a>${inner}</h${depth}>\n`;
      },
      code({ text, lang }) {
        const label = (lang || '').split(/\s/)[0];
        return (
          `<div class="code">${label ? `<span class="code-lang">${escapeHtml(label)}</span>` : ''}` +
          `<button class="copy" type="button" aria-label="Copy code">Copy</button>` +
          `<pre><code${label ? ` class="language-${escapeHtml(label)}"` : ''}>${escapeHtml(text)}</code></pre></div>\n`
        );
      },
      link({ href, title: t, tokens }) {
        const inner = this.parser.parseInline(tokens);
        let external = false;
        if (/^https?:\/\//.test(href)) {
          try {
            const originUrl = new URL(ORIGIN);
            const hrefUrl = new URL(href);
            external = hrefUrl.protocol !== originUrl.protocol || hrefUrl.host !== originUrl.host;
          } catch {
            external = true;
          }
        }
        return `<a href="${escapeHtml(href)}"${t ? ` title="${escapeHtml(t)}"` : ''}${external ? ' rel="noopener"' : ''}>${inner}</a>`;
      },
      image({ href, text }) {
        return `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}" loading="lazy" />`;
      },
    },
  });
  const html = marked.parse(source);

  // The Markdown copy for agents: same text, links made absolute.
  const md = source.replace(/(!?)\[([^\]]*)\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g, (all, bang, text, href, t) => {
    const fixed = resolveHref(href, page.source, { image: bang === '!', absolute: true });
    return `${bang}[${text}](${fixed}${t})`;
  });

  // Plain text for the search index, one entry per section.
  const sections = [];
  let current = { id: '', heading: title, text: '' };
  for (const token of marked.lexer(source)) {
    if (token.type === 'heading') {
      if (current.text.trim() || current.id) sections.push(current);
      current = { id: token.depth === 1 ? '' : slugify(token.text), heading: token.text.replace(/[`*_]/g, ''), text: '' };
    } else if (token.type !== 'space') {
      current.text += ' ' + plain(token.raw);
    }
  }
  sections.push(current);
  return { title, html, toc, md, sections };
}

function plain(raw) {
  return raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[`*_>#|]+/g, ' ')
    .replace(/(^|\s)-+(?=\s|$)/g, ' ') // Markdown separators, not words such as "sub-agents".
    .replace(/\s+/g, ' ')
    .trim();
}

function layout({ page, rendered, sections, prev, next }) {
  const url = pageUrl(page.slug);
  const canonical = ORIGIN + url;
  const fullTitle = page.slug ? `${rendered.title} · Nekko Agent docs` : 'Nekko Agent docs: getting started';
  const sidebar = sections
    .map(
      (s) =>
        `<section><h2>${escapeHtml(s.title)}</h2><ul>` +
        s.pages
          .map((p) => {
            const current = p.slug === page.slug;
            return `<li><a href="${pageUrl(p.slug)}"${current ? ' aria-current="page"' : ''}>${escapeHtml(p.title)}</a></li>`;
          })
          .join('') +
        `</ul></section>`,
    )
    .join('');
  const toc = rendered.toc.length
    ? `<nav class="toc" aria-label="On this page"><h2>On this page</h2><ul>` +
      `<li><a href="#top">${escapeHtml(rendered.title)}</a></li>` +
      rendered.toc
        .map((h) => `<li class="d${h.depth}"><a href="#${h.id}">${h.html}</a></li>`)
        .join('') +
      `</ul></nav>`
    : '';
  const pager = [
    prev
      ? `<a class="prev" href="${pageUrl(prev.slug)}"><span>Previous</span>${escapeHtml(prev.title)}</a>`
      : '<span></span>',
    next
      ? `<a class="next" href="${pageUrl(next.slug)}"><span>Next</span>${escapeHtml(next.title)}</a>`
      : '<span></span>',
  ].join('');
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline: rendered.title,
    description: page.description,
    url: canonical,
    inLanguage: 'en',
    isPartOf: { '@id': 'https://nekkoagent.com/#website' },
    publisher: { '@id': 'https://nekkolabs.com/#organization' },
    about: { '@id': 'https://nekkoagent.com/#app' },
  };
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(fullTitle)}</title>
    <meta name="description" content="${escapeHtml(page.description)}" />
    <link rel="canonical" href="${canonical}" />
    <link rel="alternate" type="text/markdown" href="/docs/${pageFile(page.slug)}.md" />
    <link rel="alternate" type="text/plain" href="/llms.txt" />
    <meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1" />
    <meta name="theme-color" content="#fbf6f8" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg?v=plum-white-2" />
    <meta property="og:type" content="article" />
    <meta property="og:site_name" content="Nekko Agent" />
    <meta property="og:url" content="${canonical}" />
    <meta property="og:title" content="${escapeHtml(fullTitle)}" />
    <meta property="og:description" content="${escapeHtml(page.description)}" />
    <meta property="og:image" content="${ogImage(page)}" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:image:type" content="image/jpeg" />
    <meta property="og:image:alt" content="${escapeHtml(fullTitle)}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escapeHtml(fullTitle)}" />
    <meta name="twitter:description" content="${escapeHtml(page.description)}" />
    <meta name="twitter:image" content="${ogImage(page)}" />
    <link rel="stylesheet" href="/docs.css?v=${ASSET_VERSION}" />
    <link rel="stylesheet" href="/fonts.css?v=1" />
    <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
  </head>
  <body>
    <a class="skip" href="#content">Skip to content</a>
    <header class="topbar">
      <button class="menu" type="button" aria-label="Open the docs menu" aria-controls="sidebar" aria-expanded="false">
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M2 4.5h14M2 9h14M2 13.5h14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
      </button>
      <a class="brand" href="/"><img src="/logo.svg?v=plum-white-2" alt="" width="26" height="20" /> NEKKO AGENT</a>
      <a class="docs-home" href="/docs">Docs</a>
      <button class="search" type="button" aria-label="Search the docs" aria-haspopup="dialog">
        <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m11 11 3.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
        <span>Search</span><kbd>Ctrl K</kbd>
      </button>
      <nav class="top-links" aria-label="Site">
        <a href="https://github.com/nekko-labs/nekko-agent" rel="noopener">GitHub</a>
        <a class="download" href="/#download">Download</a>
      </nav>
    </header>
    <div class="shell">
      <aside class="sidebar" id="sidebar" aria-label="Docs">${sidebar}</aside>
      <main id="content">
        <article class="prose" id="top">
          <p class="kicker">${escapeHtml(page.section)}</p>
          <h1>${escapeHtml(rendered.title)}</h1>
          <p class="page-tools">
            <a href="/docs/${pageFile(page.slug)}.md">View as Markdown</a>
            <a href="/llms.txt">llms.txt</a>
          </p>
${rendered.html}
          <footer class="page-foot">
            <a class="edit" href="${GITHUB}/edit/main/${page.source}" rel="noopener">Edit this page on GitHub</a>
            <div class="pager">${pager}</div>
          </footer>
        </article>
      </main>
      <aside class="toc-col">${toc}</aside>
    </div>
    <dialog class="search-dialog" aria-label="Search the docs">
      <form method="dialog" class="search-box">
        <input type="search" placeholder="Search the docs" aria-label="Search the docs" autocomplete="off" spellcheck="false" />
        <button type="submit" class="esc" aria-label="Close search">Esc</button>
      </form>
      <ul class="results" role="listbox" aria-label="Results"></ul>
    </dialog>
    <script src="/docs.js?v=${ASSET_VERSION}" defer></script>
    <script src="/analytics.js?v=1" defer></script>
    <script>
      window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };
    </script>
    <script defer src="/_vercel/insights/script.js"></script>
  </body>
</html>
`;
}

// The What's new page at /whatsnew (spec/brand/whats-new-page.md). Its data is
// docs/hub/whats-new.json: the highlights of each release line, with the people
// who shipped them.
const LOGIN = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i;
const text = (v) => typeof v === 'string' && v.trim() !== '';
// A highlight's optional `kind`, and how the page labels it.
const KINDS = { improvement: 'Improvements', performance: 'Performance', fix: 'Fixes' };
// The home page's pixel Nekko (apps/website/index.html, .pixel-nekko) with its
// happy eyes, held still: it sits on the headliners card's top edge.
const HEADLINERS_NEKKO = `<svg class="headliners-nekko" viewBox="0 0 32 32" width="56" height="56" shape-rendering="crispEdges" aria-hidden="true"><path d="M4 5H6V7H8V9H11V10H21V9H24V7H26V5H28V19H27V22H25V24H22V26H10V24H7V22H5V19H4Z" style="fill: var(--mascot-face); stroke: var(--mascot-line)" stroke-width="2" /><path d="M9 17H10V15H11V14H12V15H13V17H12V16H10V17Z M19 17H20V15H21V14H22V15H23V17H22V16H20V17Z" style="fill: var(--mascot-eyes)" /><path d="M15 20H17V21H15Z" style="fill: var(--lavender)" /></svg>`;

// Validate the highlights file and list its release lines newest first. Links
// are built from the login, PR number and tag, so each is checked here.
export function parseWhatsNew(data) {
  const lines = [];
  for (const [line, entry] of Object.entries(data)) {
    if (line.startsWith('$')) continue;
    const fail = (why) => {
      throw new Error(`docs/hub/whats-new.json: ${line}: ${why}`);
    };
    if (!/^\d+\.\d+$/.test(line)) fail('a release line is MAJOR.MINOR');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry?.date ?? '') || Number.isNaN(Date.parse(entry.date))) fail('date is YYYY-MM-DD');
    if (!text(entry.tag) || !new RegExp(`^v${line.replace('.', '\\.')}\\.\\d+$`).test(entry.tag)) fail(`tag is v${line}.BUILD`);
    if (!text(entry.intro)) fail('intro is missing');
    if (!Array.isArray(entry.highlights) || !entry.highlights.length) fail('highlights are missing');
    for (const h of entry.highlights) {
      if (!text(h?.title)) fail('a highlight has no title');
      if (!text(h.detail)) fail(`${h.title}: no detail`);
      if (!Number.isInteger(h.pr) || h.pr < 1) fail(`${h.title}: no pull request number`);
      if (!Array.isArray(h.authors) || !h.authors.length) fail(`${h.title}: no author`);
      for (const login of h.authors) if (!LOGIN.test(login ?? '')) fail(`${h.title}: not a GitHub login: ${login}`);
      if ('major' in h && typeof h.major !== 'boolean') fail(`${h.title}: major is true or false`);
      if ('kind' in h && !Object.hasOwn(KINDS, h.kind)) fail(`${h.title}: kind is one of ${Object.keys(KINDS).join(', ')}`);
    }
    // Everyone who merged a pull request in this line; the highlights' authors are among them.
    if (!Array.isArray(entry.contributors) || !entry.contributors.length) fail('contributors are missing');
    for (const login of entry.contributors) if (!LOGIN.test(login ?? '')) fail(`not a GitHub login: ${login}`);
    const known = new Set(entry.contributors.map((login) => login.toLowerCase()));
    if (known.size !== entry.contributors.length) fail('a contributor is listed twice');
    for (const h of entry.highlights) for (const login of h.authors) if (!known.has(login.toLowerCase())) fail(`${h.title}: ${login} is not in contributors`);
    lines.push({ line, ...entry });
  }
  const parts = (l) => l.line.split('.').map(Number);
  return lines.sort((a, b) => parts(b)[0] - parts(a)[0] || parts(b)[1] - parts(a)[1]);
}

export function loadWhatsNew(root = repo) {
  return parseWhatsNew(JSON.parse(readFileSync(join(root, 'docs', 'hub', 'whats-new.json'), 'utf8')));
}

// login (lower case) -> the avatar the contributor wall cached at deploy. Only a
// first-party path named for that login is accepted.
export function avatarsFrom(manifest) {
  const avatars = new Map();
  if (!manifest?.available || !Array.isArray(manifest.contributors)) return avatars;
  for (const person of manifest.contributors) {
    if (!LOGIN.test(person?.login ?? '')) continue;
    if (new RegExp(`^/contributors/${person.login}-[a-f0-9]{16}\\.(png|jpg|webp)$`, 'i').test(person.avatar ?? '')) {
      avatars.set(person.login.toLowerCase(), person.avatar);
    }
  }
  return avatars;
}

const monthYear = (date) => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

// `rng` orders each release's "Everyone who shipped" row: a fresh shuffle on every
// build, so no one is always first. Tests pass their own.
export function whatsNewPage(lines, avatars = new Map(), rng = Math.random) {
  const shuffled = (list) => {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  const title = "What's new · Nekko Agent";
  const description = 'The changes worth knowing in each Nekko Agent release, and the people who shipped them.';
  const canonical = `${ORIGIN}/whatsnew`;
  const og = `${ORIGIN}/og/whatsnew.jpg?v=${OG_VERSION}`;
  const face = (login, size = 28) => {
    const avatar = avatars.get(login.toLowerCase());
    return (
      `<span class="by-avatar" aria-hidden="true">${escapeHtml(login.slice(0, 2).toUpperCase())}` +
      (avatar ? `<img class="by-img" src="${escapeHtml(avatar)}" alt="" width="${size}" height="${size}" loading="lazy" decoding="async" />` : '') +
      `</span>`
    );
  };
  const person = (login) => `<a class="by" href="https://github.com/${login}" rel="noopener">${escapeHtml(login)}</a>`;
  // The rail: every release under its year, newest first. The first is marked as
  // the current one; the script at the foot of the page moves the mark on scroll.
  const month = (date) => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
  const years = [...new Set(lines.map((l) => l.date.slice(0, 4)))];
  const rail = `
      <nav class="rail" aria-label="Releases"${lines.length === 1 ? ' data-solo' : ''}>
${years
  .map(
    (year) => `        <p class="rail-year">${year}</p>
        <ul>
${lines
  .filter((l) => l.date.startsWith(year))
  .map((l) => `          <li><a class="rail-link" href="#${l.line}"${l === lines[0] ? ' aria-current="location"' : ''}>${month(l.date)} <span class="rail-v">${l.line}</span></a></li>`)
  .join('\n')}
        </ul>`,
  )
  .join('\n')}
      </nav>`;
  const pr = (n) => `<a href="${GITHUB}/pull/${n}" rel="noopener">#${n}</a>`;
  const highlight = (h, cls = '') => `          <li${cls}>
            <h3>${escapeHtml(h.title)}</h3>
            <p>${escapeHtml(h.detail)}</p>
            <p class="shipped"><span class="by-faces">${h.authors.map(face).join('')}</span><span>Shipped by ${h.authors.map(person).join(', ')} <span aria-hidden="true">·</span> ${pr(h.pr)}</span></p>
          </li>`;
  const everyone = (l) => `        <p class="everyone-who">Everyone who shipped ${l.line}</p>
        <ul class="everyone">
${shuffled(l.contributors)
  .map((login) => `          <li><a class="by" href="https://github.com/${login}" rel="noopener">${face(login)}${escapeHtml(login)}</a></li>`)
  .join('\n')}
        </ul>`;
  // A one-liner's credit: small faces, then each login, as "Shipped by" does on a headliner.
  // The rest of a release's highlights go under one heading per kind, in KINDS order, then the untagged.
  const oneLinerBy = (authors) => `<span class="more-by"><span class="by-faces">${authors.map((a) => face(a, 20)).join('')}</span><span>${authors.map(person).join(', ')}</span></span>`;
  // A release with major highlights: its people first, the headliners in the
  // soft panel under the pixel Nekko, then the rest as one-liners.
  const headlined = (l, majors) => {
    const rest = l.highlights.filter((h) => !h.major);
    return `${everyone(l)}
        <div class="headliners">
          <p class="headliners-tab">${HEADLINERS_NEKKO}<span class="headliners-word">Headliners</span></p>
          <ul class="headliner-list">
${majors.map((h, i) => highlight(h, i === 0 ? ' class="headliner-lead"' : '')).join('\n')}
          </ul>
        </div>${
          rest.length
            ? `
        <div class="more-all">
${[...Object.keys(KINDS), undefined]
  .map((kind) => [kind ? KINDS[kind] : `Also in ${l.line}`, rest.filter((h) => h.kind === kind)])
  .filter(([, items]) => items.length)
  .map(
    ([heading, items]) => `          <h3 class="more-group">${heading}</h3>
          <ul class="more">
${items.map((h) => `            <li><span class="more-title">${escapeHtml(h.title)}</span>${oneLinerBy(h.authors)}<span class="more-dot" aria-hidden="true">·</span><span class="more-pr">${pr(h.pr)}</span></li>`).join('\n')}
          </ul>`,
  )
  .join('\n')}
        </div>`
            : ''
        }`;
  };
  // A release with none renders as it did before headliners.
  const plain = (l) => `        <ul class="highlights">
${l.highlights.map((h) => highlight(h)).join('\n')}
        </ul>
${everyone(l)}`;
  const sections = lines
    .map((l) => {
      const majors = l.highlights.filter((h) => h.major);
      return `
      <section id="${l.line}" aria-labelledby="release-${l.line}">
        <header class="release-head">
          <h2 id="release-${l.line}">${l.line}</h2>
          <time datetime="${l.date}">${monthYear(l.date)}</time>
        </header>
        <p class="release-intro">${escapeHtml(l.intro)}</p>
${majors.length ? headlined(l, majors) : plain(l)}
        <p class="release-all"><a href="${GITHUB}/releases/tag/${l.tag}" rel="noopener">See every change in ${l.line} on GitHub ↗</a></p>
      </section>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en" data-theme="white">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <link rel="canonical" href="${canonical}" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="Nekko Agent" />
    <meta property="og:url" content="${canonical}" />
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:image" content="${og}" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:image:type" content="image/jpeg" />
    <meta property="og:image:alt" content="${escapeHtml(title)}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escapeHtml(title)}" />
    <meta name="twitter:description" content="${escapeHtml(description)}" />
    <meta name="twitter:image" content="${og}" />
    <meta name="theme-color" content="#fbf6f8" />
    <script>(function(){var t=null;try{t=localStorage.getItem('nekko-theme');}catch(e){}if(t!=='white'&&t!=='dark')t=window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches?'dark':'white';document.documentElement.dataset.theme=t;var m=document.querySelector('meta[name=theme-color]');if(m)m.content=t==='white'?'#fbf6f8':'#0c0c11';})();</script>
    <link rel="icon" type="image/svg+xml" href="/favicon.svg?v=plum-white-2" />
    <link rel="stylesheet" href="/styles.css?v=18" />
    <link rel="stylesheet" href="/fonts.css?v=1" />
    <style>
      .legal { max-width: 720px; margin: 0 auto; padding: 120px 20px 80px; line-height: 1.65; }
      /* The home page's type: a heavy, tight title, the LED face for each release, retro mono for dates. */
      .legal h1 { font-size: clamp(32px, 5vw, 48px); font-weight: 800; letter-spacing: -0.04em; line-height: 1.05; margin: 0 0 8px; }
      .legal h2 { font-family: var(--led); font-size: 44px; font-weight: 600; letter-spacing: 0.01em; line-height: 1; margin: 0; }
      .legal h3 { font: 600 17px/1.4 var(--sans); letter-spacing: -0.01em; margin: 0 0 2px; color: var(--ink); }
      .legal p, .legal li { color: var(--muted); }
      .legal a { color: var(--accent); }
      .legal section { margin-top: 64px; scroll-margin-top: 96px; }
      .release-head { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 4px 20px; }
      .release-head time { font: 12px var(--retro-mono); letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); }
      .release-intro { margin: 8px 0 0; }
      .highlights { list-style: none; padding: 0; margin: 32px 0 0; display: grid; gap: 28px; }
      .highlights p { margin: 0; }
      .highlights .shipped { display: flex; align-items: center; gap: 10px; margin-top: 10px; font-size: 14px; }
      .by-faces { display: inline-flex; flex: none; }
      .by-avatar { position: relative; display: inline-grid; place-items: center; flex: none; width: 28px; height: 28px; border-radius: 50%; overflow: hidden; background: var(--bg-2); color: var(--ink); font: 600 10px var(--mono); }
      .by-avatar + .by-avatar { margin-left: -6px; box-shadow: 0 0 0 2px var(--bg); }
      .by-img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
      @media (min-width: 900px) { .highlights { grid-template-columns: 1fr 1fr; gap: 32px 40px; } }
      .everyone-who { margin: 40px 0 0; font: 12px var(--retro-mono); letter-spacing: 0.1em; text-transform: uppercase; }
      .everyone { list-style: none; padding: 0; margin: 12px 0 0; display: flex; flex-wrap: wrap; gap: 12px 20px; font-size: 14px; }
      .everyone .by { display: inline-flex; align-items: center; gap: 8px; }
      .release-all { margin: 32px 0 0; }
      .earlier { margin: 64px 0 0; }
      /* The release rail. Wide screens: it sits left of the column and stays in view.
         Narrower: a row of links under the lede, and none when there is one release. */
      .rail { font: 12px var(--retro-mono); letter-spacing: 0.06em; }
      .rail ul { list-style: none; padding: 0; margin: 0; }
      .rail-year { margin: 0; color: var(--ink); }
      .legal .rail-link { position: relative; display: inline-block; padding: 6px 0 6px 20px; color: var(--muted); text-decoration: none; }
      .rail-link::before { content: ''; position: absolute; left: 0; top: 50%; width: 6px; height: 6px; border-radius: 3px; background: currentColor; opacity: 0.4; transform: translateY(-50%); transition: height 0.2s ease, opacity 0.2s ease; }
      .legal .rail-link[aria-current] { color: var(--ink); }
      .rail-link[aria-current]::before { height: 18px; opacity: 1; }
      .rail-v { opacity: 0.7; }
      @media (hover: hover) { .legal .rail-link:hover { color: var(--ink); } }
      @media (prefers-reduced-motion: reduce) { .rail-link::before { transition: none; } }
      @media (min-width: 1180px) {
        .rail-wrap { position: absolute; top: 0; bottom: 0; right: 100%; width: 190px; padding: 136px 0 80px; }
        .rail { position: sticky; top: 112px; }
        .rail-year { margin: 20px 0 6px; }
        .rail-year:first-child { margin-top: 0; }
      }
      @media (max-width: 1179px) {
        .rail { display: flex; flex-wrap: wrap; align-items: center; gap: 0 20px; margin-top: 20px; }
        .rail ul { display: flex; flex-wrap: wrap; gap: 0 20px; }
        .rail[data-solo] { display: none; }
      }
      /* A release's headliners: a soft plum panel, no border or offset shadow, with the pixel Nekko peeking over its top edge. Still: no motion. */
      .headliners { position: relative; margin: 64px 0 0; padding: 40px 36px 34px; background: var(--band-peach); border-radius: 18px; }
      :root[data-theme='dark'] .headliners { background: var(--peach-soft); }
      .legal .headliners-tab { position: absolute; top: -34px; left: 28px; display: flex; align-items: flex-end; gap: 10px; margin: 0; }
      .headliners-nekko { flex: none; overflow: visible; }
      .headliners-word { padding-bottom: 6px; color: var(--lavender); font: 700 24px/1 var(--led); letter-spacing: 0.04em; text-transform: uppercase; }
      :root[data-theme='dark'] .headliners-word { color: var(--accent); }
      .headliner-list { list-style: none; padding: 0; margin: 0; display: grid; gap: 28px; }
      .headliner-list p { margin: 0; }
      .headliner-list .shipped { display: flex; align-items: center; gap: 10px; margin-top: 10px; font-size: 14px; }
      .legal .headliner-lead h3 { font-size: 24px; font-weight: 700; letter-spacing: -0.02em; margin-bottom: 4px; }
      @media (min-width: 900px) { .headliner-list { grid-template-columns: 1fr 1fr; gap: 28px 32px; } .headliner-lead, .headliner-list > li:last-child:nth-child(even) { grid-column: 1 / -1; } }
      @media (max-width: 560px) { .headliners { padding: 34px 20px 24px; } .legal .headliners-tab { left: 16px; } }
      /* The other highlights, one heading per kind. Narrow: the title, then who shipped it and the pull request under it.
         From 560px: one grid for every group (title, author, pull request), so the columns line up down the page. */
      .more-all { margin: 44px 0 0; }
      .legal .more-group { margin: 32px 0 12px; font: 12px var(--retro-mono); letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink); }
      .legal .more-group:first-child { margin-top: 0; }
      .more { list-style: none; padding: 0; margin: 0; display: grid; gap: 14px; font-size: 15px; }
      .more li { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; color: var(--ink); }
      .more-title { flex: 1 0 100%; }
      .more-by { display: inline-flex; align-items: center; gap: 6px; font-size: 14px; }
      .more .by-avatar { width: 20px; height: 20px; font-size: 8px; }
      .more .by-avatar + .by-avatar { margin-left: -5px; }
      .more-dot { color: var(--muted); }
      .more-pr { font-size: 14px; font-variant-numeric: tabular-nums; }
      .legal .more-pr a { color: var(--muted); }
      @media (min-width: 560px) {
        .more-all { display: grid; grid-template-columns: minmax(0, 1fr) max-content max-content; column-gap: 28px; }
        .more-all > .more-group { grid-column: 1 / -1; }
        .more-all > .more, .more li { grid-column: 1 / -1; display: grid; grid-template-columns: subgrid; align-items: center; }
        .more { gap: 10px; }
        .more-dot { display: none; }
        .more-pr { justify-self: end; }
      }
    </style>
  </head>
  <body>
    <!-- the home page's dot wave (pixelwave.js): decorative, still under reduced motion, absent without JavaScript -->
    <canvas id="pixelwave" aria-hidden="true"></canvas>
    <header class="nav">
      <a class="brand" href="/" aria-label="Nekko Agent home"><img class="brand-mark" src="/logo.svg?v=plum-white-2" alt="" width="30" height="23" /> NEKKO AGENT</a>
      <nav class="nav-links" aria-label="Main navigation">
        <a href="/#contributors">About us</a>
        <a href="/docs">Docs</a>
        <a href="/whatsnew" aria-current="page">What's new</a>
      </nav>
    </header>

    <main class="legal">
      <h1>What's new</h1>
      <p>The changes worth knowing in each release.</p>
      <div class="rail-wrap">${rail}
      </div>
${sections}

      <p class="earlier"><a href="${GITHUB}/releases" rel="noopener">Earlier releases on GitHub ↗</a></p>
    </main>

    <footer>
      <span class="footer-brand"><img class="brand-mark" src="/logo.svg?v=plum-white-2" alt="" width="26" height="20" /> NEKKO AGENT</span>
      <span class="micro">MIT · Made with ❤️ by the <a href="https://nekkolabs.com/#team" target="_blank" rel="noopener">Nekko Labs team</a></span>
      <a href="/docs">Docs</a>
      <a href="/whatsnew">What's new</a>
      <a href="/beta">Beta</a>
      <a href="/status">Status</a>
      <a href="/privacy">Privacy</a>
    </footer>
    <script>
      window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };
    </script>
    <script defer src="/_vercel/insights/script.js"></script>
    <script src="/pixelwave.js?v=1" defer></script>
    <script>
      // The rail marks the release being read: the last section whose top has passed the nav.
      (function () {
        var links = [].slice.call(document.querySelectorAll('.rail-link'));
        if (links.length < 2) return;
        var sections = links.map(function (a) { return document.getElementById(a.getAttribute('href').slice(1)); });
        function mark() {
          var at = 0;
          sections.forEach(function (s, i) { if (s && s.getBoundingClientRect().top <= 140) at = i; });
          links.forEach(function (a, i) { if (i === at) a.setAttribute('aria-current', 'location'); else a.removeAttribute('aria-current'); });
        }
        addEventListener('scroll', mark, { passive: true });
        mark();
      })();
    </script>
  </body>
</html>
`;
}

function replaceBetween(text, start, end, body) {
  const a = text.indexOf(start);
  const b = text.indexOf(end);
  const block = `${start}\n${body}\n${end}`;
  if (a === -1 || b === -1) return `${text.trimEnd()}\n\n${block}\n`;
  return text.slice(0, a) + block + text.slice(b + end.length);
}

export function build() {
  const { sections, pages } = loadNav();
  const media = new Map();
  const resolveHref = makeResolver(pages, media);
  const files = new Map(); // path relative to apps/website -> content (string or Buffer)
  const index = [];
  const full = [
    '# Nekko Agent documentation',
    '',
    `> Every page of ${ORIGIN}/docs in one file. Generated from the Markdown in ${GITHUB}.`,
    '',
  ];

  const rendered = pages.map((page) => ({ page, rendered: render(page, resolveHref) }));
  rendered.forEach(({ page, rendered: r }, i) => {
    const name = pageFile(page.slug);
    files.set(`docs/${name}.html`, layout({ page, rendered: r, sections, prev: pages[i - 1], next: pages[i + 1] }));
    files.set(`docs/${name}.md`, r.md.trimEnd() + '\n');
    full.push(`<!-- ${ORIGIN}${pageUrl(page.slug)} -->`, '', r.md.trim(), '', '---', '');
    for (const s of r.sections) {
      index.push({
        page: r.title,
        section: page.section,
        url: pageUrl(page.slug) + (s.id ? `#${s.id}` : ''),
        heading: s.id ? s.heading : '',
        // Keep the whole section searchable; the UI bounds result previews.
        text: s.text.trim(),
      });
    }
  });
  files.set('docs/search.json', JSON.stringify(index) + '\n');
  files.set('llms-full.txt', full.join('\n').trimEnd() + '\n');
  for (const [name, file] of media) files.set(`docs/media/${name}`, readFileSync(file));
  // With initials here; the deploy adds avatars once the contributor cache exists.
  files.set('whatsnew.html', whatsNewPage(loadWhatsNew()));

  const docsList = [
    '## Documentation',
    '',
    `Full docs in one file: ${ORIGIN}/llms-full.txt. Each page is also available as Markdown at the .md URL below.`,
    '',
    ...sections.flatMap((s) => [
      `### ${s.title}`,
      '',
      ...s.pages.map((p) => `- [${p.title}](${ORIGIN}/docs/${pageFile(p.slug)}.md): ${p.description}`),
      '',
    ]),
  ]
    .join('\n')
    .trimEnd();
  const llms = readFileSync(join(site, 'llms.txt'), 'utf8').replace(/\r\n/g, '\n');
  files.set('llms.txt', replaceBetween(llms, '<!-- docs:start -->', '<!-- docs:end -->', docsList));

  const sitemap = readFileSync(join(site, 'sitemap.xml'), 'utf8').replace(/\r\n/g, '\n');
  const urls = pages
    .map((p) => `  <url>\n    <loc>${ORIGIN}${pageUrl(p.slug)}</loc>\n    <changefreq>weekly</changefreq>\n    <priority>${p.slug ? '0.7' : '0.9'}</priority>\n  </url>`)
    .join('\n');
  files.set(
    'sitemap.xml',
    replaceBetween(sitemap.replace('</urlset>', '').trimEnd() + '\n', '  <!-- docs:start -->', '  <!-- docs:end -->', urls)
      .trimEnd() + '\n</urlset>\n',
  );
  return files;
}

// The outputs that stay in git. Everything else the build writes is gitignored.
export const COMMITTED = ['llms.txt', 'sitemap.xml'];

const hash = (data) => createHash('sha256').update(data).digest('hex');

export function stale(files = build()) {
  const problems = [];
  for (const path of COMMITTED) {
    const file = join(site, path);
    if (!existsSync(file)) problems.push(`missing ${path}`);
    else {
      const normal = (b) => Buffer.from(b.toString('utf8').replace(/\r\n/g, '\n'));
      if (hash(normal(readFileSync(file))) !== hash(normal(Buffer.from(files.get(path))))) problems.push(`out of date ${path}`);
    }
  }
  return problems;
}

// Write the output into apps/website, replacing whatever docs/ held before.
export function write(files = build()) {
  rmSync(outDir, { recursive: true, force: true });
  for (const [path, content] of files) {
    const file = join(site, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return files;
}

// The download buttons' release info, fetched here at build time so a visitor's
// browser never calls api.github.com. Only the tag and each asset's name and URL.
export function releaseInfo(rel) {
  return {
    version: typeof rel?.tag_name === 'string' ? rel.tag_name : '',
    assets: Object.fromEntries((rel?.assets || []).map((a) => [a.name, a.browser_download_url])),
  };
}

// Writes apps/website/release.json (gitignored). Never fails the build: without
// the file the buttons link to the releases page, as they did when the API was down.
export async function writeRelease() {
  const file = join(site, 'release.json');
  try {
    const headers = { Accept: 'application/vnd.github+json' };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const res = await fetch('https://api.github.com/repos/nekko-labs/nekko-agent/releases/latest', { headers, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const info = releaseInfo(await res.json());
    writeFileSync(file, JSON.stringify(info) + '\n');
    return `release.json: ${info.version}`;
  } catch (e) {
    rmSync(file, { force: true });
    return `release.json skipped (${e.message}); the download buttons link to the releases page`;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = build();
  if (process.argv.includes('--check')) {
    const problems = stale(files);
    if (problems.length) {
      console.error(`${COMMITTED.join(' and ')} are out of date with docs/hub/nav.json. Run \`npm run docs\`.\n  ${problems.join('\n  ')}`);
      process.exit(1);
    }
    console.log(`${COMMITTED.join(' and ')} up to date`);
  } else {
    write(files);
    console.log(`wrote ${files.size} files to apps/website`);
    console.log(writeDesignSystem(site));
    console.log(await writeRelease());
    console.log(await writeContributors(site));
    // The page again, now with the avatars that refresh just cached.
    const avatars = avatarsFrom(JSON.parse(readFileSync(join(site, 'contributors.json'), 'utf8')));
    writeFileSync(join(site, 'whatsnew.html'), whatsNewPage(loadWhatsNew(), avatars));
    console.log(`whatsnew.html: ${avatars.size} cached avatars available`);
  }
}
