/**
 * Presenter mode: for screen recordings and demos. Every piece of text the
 * app draws outside Settings is passed through `maskPersonal`, so account
 * emails (the model picker's "Claude · you@…"), home-directory paths, the
 * OS user and machine name, and API key fragments read as neutral
 * placeholders. Settings is left alone so the presenter can still check what
 * is configured.
 *
 * It masks the page, not the data: nothing is changed in the engine, in
 * settings or in what models receive. Text typed into inputs is not touched.
 *
 * Turned on by `NEKKO_PRESENTER=1` in the desktop app (the preload passes it
 * on with the user, home and host names to mask) or `?presenter=1` in the
 * Local Web UI. Neither is remembered: the next launch, or the same page
 * without the flag, is the normal app.
 */

/** What the preload exposes as `window.nekkoPresenter` when the env var is set. */
export interface PresenterInfo {
  user?: string;
  home?: string;
  host?: string;
}

const EXEMPT = '[data-presenter-exempt]';
const ATTRS = ['title', 'aria-label', 'placeholder', 'alt'] as const;

export const PLACEHOLDER = { email: 'you@example.com', user: 'demo', host: 'workstation', key: 'sk-••••' } as const;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// C:\Users\name, /Users/name, /home/name: the name is learned so it is masked anywhere else too.
const HOME_PATH = /(?:[A-Za-z]:[\\/]+Users[\\/]+|\/Users\/|\/home\/)([^\\/\s"'`<>:|]+)/g;
// Key-shaped tokens: Anthropic/OpenAI, GitHub, Slack and Google keys.
const KEY = /\b(?:sk-(?:ant-)?|ghp_|gho_|github_pat_|xox[bp]-|AIza)[A-Za-z0-9_-]{4,}/g;

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A masker for one machine: its user, home and host names, plus any user names it learns from paths. */
export function createMasker(info: PresenterInfo = {}) {
  const names = new Set<string>();
  const hosts = new Set<string>();
  const add = (set: Set<string>, v?: string) => { if (v && v.length >= 3) set.add(v); };
  add(names, info.user);
  add(names, info.home?.split(/[\\/]/).filter(Boolean).pop());
  add(hosts, info.host);
  add(hosts, info.host?.split('.')[0]);

  return function maskPersonal(text: string): string {
    if (!text) return text;
    // Reserved example domains are already safe, and demo scripts type them on purpose.
    let out = text.replace(EMAIL, (m) => (/@example\.(com|org|net)$/i.test(m) ? m : PLACEHOLDER.email));
    if (info.home) out = out.split(info.home).join('~');
    out = out.replace(HOME_PATH, (_m, name: string) => { add(names, name); return '~'; });
    out = out.replace(KEY, PLACEHOLDER.key);
    // Hosts first: a machine name often contains the user's name.
    for (const h of hosts) out = out.replace(new RegExp(`\\b${escape(h)}\\b`, 'gi'), PLACEHOLDER.host);
    for (const n of names) out = out.replace(new RegExp(`\\b${escape(n)}\\b`, 'gi'), PLACEHOLDER.user);
    return out;
  };
}

/** Whether this window asked for presenter mode, and what to mask. */
export function presenterRequest(): PresenterInfo | null {
  const fromPreload = (window as { nekkoPresenter?: PresenterInfo }).nekkoPresenter;
  if (fromPreload) return fromPreload;
  return new URLSearchParams(location.search).get('presenter') === '1' ? {} : null;
}

/** Mask everything under `root` now and on every later change, skipping Settings. Returns a stop function. */
export function startPresenterMode(info: PresenterInfo, root: Node = document.body): () => void {
  const mask = createMasker(info);
  const exempt = (el: Element | null) => !!el?.closest(EXEMPT);

  const fixText = (node: Text) => {
    const parent = node.parentElement;
    // Never rewrite what is being typed: it would move the caret mid-word.
    if (!parent || exempt(parent) || parent.isContentEditable || parent.closest('script, style, textarea')) return;
    const next = mask(node.data);
    if (next !== node.data) node.data = next;
  };
  const fixAttrs = (el: Element) => {
    if (exempt(el)) return;
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v) { const next = mask(v); if (next !== v) el.setAttribute(a, next); }
    }
  };
  const sweep = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) return fixText(node as Text);
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    if (exempt(el)) return;
    fixAttrs(el);
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.nodeType === Node.ELEMENT_NODE && (n as Element).matches(EXEMPT) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === Node.TEXT_NODE) fixText(n as Text); else fixAttrs(n as Element);
    }
  };

  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'characterData') fixText(r.target as Text);
      else if (r.type === 'attributes') fixAttrs(r.target as Element);
      else r.addedNodes.forEach(sweep);
    }
  });
  sweep(root);
  observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: [...ATTRS] });
  const title = () => { const t = mask(document.title); if (t !== document.title) document.title = t; };
  title();
  document.documentElement.dataset.presenter = '';
  return () => { observer.disconnect(); delete document.documentElement.dataset.presenter; };
}
