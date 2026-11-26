import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, parseFragment, serialize } from 'parse5';

const root = fileURLToPath(new URL('../../', import.meta.url));
export const site = join(root, 'apps/website');
export const catalogDir = join(root, 'docs/hub/translations');
export const locales = ['ja', 'es', 'ko', 'zh-Hans', 'zh-Hant', 'ru', 'fr', 'it', 'de'];
export const sourcePages = ['index', 'download', 'pricing', 'beta', 'privacy', 'status'];
const origin = 'https://nekkoagent.com';
const copyAttributes = new Set(['alt', 'title', 'aria-label', 'aria-description', 'aria-roledescription', 'placeholder', 'data-alt']);
const excluded = new Set(['code', 'pre', 'kbd', 'samp', 'var', 'script', 'style', 'svg', 'link']);
const notCopy = /^(?:https?:\/\/|\/[\w-]+\/|[@][\w-]+$|(?:\d+[.,]?)\S*$|[\w-]+\.(?:md|txt|json|js|exe|dmg)$|(?:bash|sh|zsh|powershell|typescript|ts|rust|json|xml|toml|cmd|Nekko Agent|NEKKO AGENT|GitHub|macOS|Windows|Linux|NekkoLabs|Nekko Labs|Ctrl K)$)/i;
const technical = /\{[a-z][\w]*\}|https?:\/\/[^\s<>]+|\b(?:Nekko Agent|Nekko Cloud|Nekko Labs|NekkoLabs|GitHub|PowerShell|macOS|Windows|Linux|PostHog|Tailscale|Cloudflare|MCP|Ollama|llama\.cpp|MLX|(?:v\d+\.)\d+(?:\.\d+)*)\b/g;
const utf = 'utf8';
export const textKey = (text) => createHash('sha256').update(text).digest('base64url').slice(0, 16);
export const normalize = (text) => text.replace(/[\t\n\r\f ]+/g, ' ').trim();
const eligible = (text) => /[A-Za-z]{2}/.test(text) && !notCopy.test(text);
const attr = (node, name) => node.attrs?.find((a) => a.name === name)?.value;
function setAttr(node, name, value) {
  const a = node.attrs.find((a) => a.name === name);
  if (a) a.value = value;
  else node.attrs.push({ name, value });
}
const byClass = (node, name) => (attr(node, 'class') || '').split(/\s+/).includes(name);
const route = (file) => '/' + file.replace(/(?:^|\/)index\.html$/, '').replace(/\.html$/, '');
const prefix = (locale, path) => `/l/${locale}${path === '/' ? '' : path}`;
const exactRoute = (path) => path.replace(/(?:\/index)?\.html$/, '').replace(/\/$/, '') || '/';
const escapeScript = (data) => JSON.stringify(data).replace(/</g, '\\u003c');
const isCopyMeta = (node) => /^(?:description|(?:og|twitter):(?:title|description|image:alt))$/.test(attr(node, 'name') || attr(node, 'property') || '');

function append(node, html) {
  const { childNodes } = parseFragment(html);
  for (const child of childNodes) {
    child.parentNode = node;
    node.childNodes.push(child);
  }
}
function find(node, predicate) {
  if (predicate(node)) return node;
  for (const child of node.childNodes ?? []) {
    const result = find(child, predicate);
    if (result) return result;
  }
}
function visit(node, callback) {
  if (callback(node) === false) return;
  for (const child of node.childNodes ?? []) visit(child, callback);
  if (node.content) visit(node.content, callback);
}

export function protect(text) {
  const saved = [];
  const source = text.replace(technical, (match) => `⟦P${saved.push(match) - 1}⟧`);
  return { source, saved };
}
export function unprotect(text, saved) {
  const used = new Set();
  const restored = text.replace(/⟦P(\d+)⟧/g, (_, i) => {
    used.add(Number(i));
    return saved[i] ?? '';
  });
  return used.size === saved.length && [...used].every((i) => i < saved.length) ? restored : null;
}

export function decorateEnglish(html) {
  if (html.includes('/website-language.js')) return html;
  return html.replace('</head>', '  <link rel="stylesheet" href="/website-language.css">\n    <script src="/website-language.js"></script>\n  </head>');
}

// Keep the original English build as the source of structure and route IDs.
// Replace only copy, not markup, so code fences, anchors, controls and data stay intact.
function processPage(html, file, apply, locale = 'en', paths = new Set(), runtime = {}) {
  const document = parse(html);
  const thisRoute = route(file);
  const base = new URL(thisRoute, origin);
  const translate = (value) => {
    const text = normalize(value);
    if (!eligible(text)) return value;
    const next = apply(text);
    return next === text ? value : value.match(/^\s*/)[0] + next + value.match(/\s*$/)[0];
  };
  visit(document, (node) => {
    if (node.nodeName === '#text') {
      node.value = translate(node.value);
      return;
    }
    if (!node.tagName) return;
    if (locale !== 'en' && node.tagName === 'html') setAttr(node, 'lang', locale);
    const localUrl = (value, navigation = false) => {
      if (!value || value.startsWith('#')) return value;
      try {
        const parsed = new URL(value, base);
        if (parsed.origin !== origin) return value;
        const path = exactRoute(parsed.pathname);
        if (navigation && paths.has(path)) return prefix(locale, path) + parsed.search + parsed.hash;
        return value.startsWith('/') || /^[a-z][\w+.-]*:/i.test(value) ? value : parsed.pathname + parsed.search + parsed.hash;
      } catch { return value; }
    };
    if (locale !== 'en') {
      for (const a of node.attrs) {
        if (['href', 'src', 'poster', 'action'].includes(a.name) || /^data-(?:src|poster)(?:-|$)/.test(a.name)) {
          if (node.tagName === 'link' && attr(node, 'rel') === 'canonical') a.value = origin + prefix(locale, thisRoute);
          else a.value = localUrl(a.value, a.name === 'href' && node.tagName === 'a');
        }
        if (a.name === 'srcset' && !a.value.includes('data:')) {
          a.value = a.value.split(',').map((part) => part.trim().replace(/^\S+/, (value) => localUrl(value))).join(', ');
        }
        if (a.name === 'content' && attr(node, 'property') === 'og:url') a.value = origin + prefix(locale, thisRoute);
      }
    }
    if (node.tagName === 'script' && attr(node, 'type') === 'application/ld+json') {
      const text = node.childNodes[0];
      if (text) {
        try {
          const data = JSON.parse(text.value);
          for (const entry of [data, ...(data['@graph'] ?? [])]) {
            for (const prop of ['headline', 'description', 'featureList']) {
              if (typeof entry[prop] === 'string') entry[prop] = translate(entry[prop]);
              else if (Array.isArray(entry[prop])) entry[prop] = entry[prop].map(translate);
            }
            if (locale !== 'en') {
              if (entry.inLanguage === 'en') entry.inLanguage = locale;
              if (entry.url === origin + thisRoute) entry.url = origin + prefix(locale, thisRoute);
            }
          }
          text.value = escapeScript(data);
        } catch { /* Leave unrelated structured data untouched. */ }
      }
    }
    if (excluded.has(node.tagName) || byClass(node, 'code-lang') || byClass(node, 'anchor') || attr(node, 'translate') === 'no') return false;
    for (const a of node.attrs) {
      if (copyAttributes.has(a.name) || (a.name === 'content' && isCopyMeta(node))) a.value = translate(a.value);
    }
  });
  if (locale !== 'en') {
    const head = find(document, (node) => node.tagName === 'head');
    const alternate = (tag, url) => `<link rel="alternate" hreflang="${tag}" href="${origin}${url}">`;
    const alternatives = alternate('en', thisRoute) + alternate('x-default', thisRoute) + locales.map((tag) => alternate(tag, prefix(tag, thisRoute))).join('');
    append(head, alternatives);
    if (Object.keys(runtime).length) {
      const script = parseFragment(`<script>window.NekkoWebsiteMessages=${escapeScript(runtime)}</script>`).childNodes[0];
      const i = head.childNodes.findIndex((n) => attr(n, 'src') === '/website-language.js');
      head.childNodes.splice(i < 0 ? 0 : i, 0, script);
    }
  }
  return document;
}

function contents(node) {
  if (node.nodeName === '#text') return node.value;
  if (node.tagName === 'button' || byClass(node, 'anchor') || byClass(node, 'code-lang')) return '';
  return (node.childNodes ?? []).map(contents).join('');
}
function searchEntries(document, url) {
  const article = find(document, (n) => n.tagName === 'article' && byClass(n, 'prose'));
  if (!article) return [];
  const page = normalize(contents(find(article, (n) => n.tagName === 'h1')));
  const section = normalize(contents(find(article, (n) => byClass(n, 'kicker'))));
  const entries = [{ url, page, section, heading: '', text: '' }];
  for (const n of article.childNodes) {
    const id = attr(n, 'id');
    if (/^h[2-6]$/.test(n.tagName || '') && id) entries.push({ url: `${url}#${id}`, page, section, heading: normalize(contents(n)), text: '' });
    else if (n.tagName !== 'h1' && n.tagName !== 'footer' && !byClass(n, 'kicker') && !byClass(n, 'page-tools')) entries.at(-1).text += ' ' + normalize(contents(n));
  }
  for (const entry of entries) entry.text = entry.text.trim();
  return entries;
}

export function pageSources(generated) {
  const pages = new Map(sourcePages.map((name) => [`${name}.html`, readFileSync(join(site, `${name}.html`), utf)]));
  for (const [name, html] of generated) if (name.endsWith('.html')) pages.set(name, html);
  return pages;
}

export function loadCatalog(locale) {
  const path = join(catalogDir, `${locale}.json`);
  return existsSync(path) ? JSON.parse(readFileSync(path, utf)) : {};
}

export function extract(pages, messages = []) {
  const source = new Map();
  const add = (text) => { source.set(textKey(text), text); return text; };
  for (const [name, html] of pages) processPage(html, name, add);
  for (const text of messages) add(text);
  return source;
}

export function localize(pages, options = {}) {
  const files = new Map();
  const paths = new Set([...pages.keys()].map(route));
  for (const locale of options.locales ?? locales) {
    const catalog = options.catalog?.(locale) ?? loadCatalog(locale);
    const translate = (text) => Object.hasOwn(catalog, textKey(text)) ? catalog[textKey(text)] : text;
    const runtime = Object.fromEntries((options.messages ?? []).map((message) => [message, translate(message)]));
    const search = [];
    for (const [name, html] of pages) {
      const document = processPage(decorateEnglish(html), name, translate, locale, paths, runtime);
      const path = name === 'index.html' ? `l/${locale}.html`
        : `l/${locale}/${name === 'docs/index.html' ? 'docs.html' : name}`;
      files.set(path, serialize(document));
      if (name.startsWith('docs/')) search.push(...searchEntries(document, prefix(locale, route(name))));
    }
    files.set(`l/${locale}/docs/search.json`, JSON.stringify(search));
  }
  return files;
}
