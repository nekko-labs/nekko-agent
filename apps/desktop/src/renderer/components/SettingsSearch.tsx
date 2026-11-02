import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDownIcon, ChevronUpIcon, CloseIcon, SearchIcon } from '../icons.js';

/**
 * Search within Settings. The search icon in the Appearance header turns into
 * a floating search box in the same spot. It stays put on screen while the page
 * scrolls under it. One second after the user stops typing (or at once on
 * Enter), the page scrolls to the first match and highlights it. The up/down
 * buttons, the ArrowUp/ArrowDown keys and Enter / Shift+Enter step through
 * further matches, wrapping at the ends. The X or Escape closes it.
 *
 * Highlights use the CSS Custom Highlight API, so the settings DOM is never
 * rewritten (same approach as find-in-chat).
 */

export const SEARCH_DELAY_MS = 1000;
const ALL = 'nekko-settings-search';
const CURRENT = 'nekko-settings-search-current';

type HighlightRegistry = { set(name: string, h: unknown): void; delete(name: string): void };
type HighlightCtor = new (...ranges: Range[]) => unknown;

function highlightApi(): { registry: HighlightRegistry; Highlight: HighlightCtor } | null {
  const registry = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS?.highlights;
  const Highlight = (globalThis as { Highlight?: HighlightCtor }).Highlight;
  return registry && Highlight ? { registry, Highlight } : null;
}

/** Every [start, end) where `query` appears in `text`, case-insensitively. */
export function findOffsets(text: string, query: string): Array<[number, number]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hay = text.toLowerCase();
  const out: Array<[number, number]> = [];
  for (let i = hay.indexOf(q); i !== -1; i = hay.indexOf(q, i + q.length)) out.push([i, i + q.length]);
  return out;
}

/** Ranges for every visible match under `root`, skipping the search box itself. */
function findRanges(root: HTMLElement, query: string): Range[] {
  const out: Range[] = [];
  if (!query.trim()) return out;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      const el = n.parentElement;
      if (!el || el.closest('[data-settings-search], option, script, style')) return NodeFilter.FILTER_REJECT;
      if (!el.getClientRects().length) return NodeFilter.FILTER_REJECT; // hidden
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const node = n as Text;
    for (const [s, e] of findOffsets(node.data, query)) {
      const r = document.createRange();
      r.setStart(node, s);
      r.setEnd(node, e);
      out.push(r);
    }
  }
  return out;
}

/** The nearest ancestor that actually scrolls vertically. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return document.scrollingElement as HTMLElement | null;
}

/** Scroll so the match sits about a third of the way down its scroller. */
function reveal(range: Range, root: HTMLElement) {
  const sc = scrollParent(root);
  if (!sc) return;
  const box = sc.getBoundingClientRect();
  const r = range.getBoundingClientRect();
  const top = sc.scrollTop + (r.top - box.top) - sc.clientHeight / 3;
  sc.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

export function SettingsSearch({ root }: { root: React.RefObject<HTMLElement | null> }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  /** The query actually searched: follows `query` after the typing pause. */
  const [applied, setApplied] = useState('');
  const [current, setCurrent] = useState(0);
  const [total, setTotal] = useState(0);
  /** Where the icon was when opened; the floating box is pinned there. */
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const clear = () => { const api = highlightApi(); api?.registry.delete(ALL); api?.registry.delete(CURRENT); };

  const close = useCallback(() => { setOpen(false); setQuery(''); setApplied(''); setTotal(0); clear(); }, []);

  const openBox = () => {
    const r = anchor.current?.getBoundingClientRect();
    // Keep the bar on screen even if the header is partly scrolled out of view.
    if (r) setPos({ top: Math.max(8, r.top), right: Math.max(8, window.innerWidth - r.right) });
    setOpen(true);
  };

  useLayoutEffect(() => { if (open) input.current?.focus(); }, [open]);

  // Wait for a 1 s pause in typing before searching.
  useEffect(() => {
    if (query === applied) return;
    const t = window.setTimeout(() => { setApplied(query); setCurrent(0); }, SEARCH_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [query, applied]);

  // Search, paint and scroll when the searched query or selected match changes.
  useEffect(() => {
    if (!open || !root.current) return;
    const ranges = findRanges(root.current, applied);
    setTotal(ranges.length);
    if (!ranges.length) { clear(); return; }
    const idx = ((current % ranges.length) + ranges.length) % ranges.length;
    const api = highlightApi();
    if (api) {
      api.registry.set(ALL, new api.Highlight(...ranges));
      api.registry.set(CURRENT, new api.Highlight(ranges[idx]));
    }
    reveal(ranges[idx], root.current);
  }, [open, applied, current, root]);

  useEffect(() => () => clear(), []);

  /** Move to the previous/next match; searches at once if the pause has not elapsed yet. */
  const step = (d: 1 | -1) => {
    if (query !== applied) { setApplied(query); setCurrent(0); }
    else setCurrent((c) => c + d);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
  };

  const pending = query.trim() !== '' && query !== applied;
  const shown = total ? (((current % total) + total) % total) + 1 : 0;

  return (
    <div ref={anchor} className="ml-auto" data-settings-search>
      {!open ? (
        <button type="button" className="settings-search-btn" aria-label="Search settings" title="Search settings" onClick={openBox}>
          <SearchIcon className="h-4 w-4" />
        </button>
      ) : (
        // Placeholder keeps the header height while the box floats above it.
        <div className="h-7 w-7" />
      )}
      {open && createPortal(
        <div
          className="settings-search-pop"
          role="search"
          aria-label="Search settings"
          data-settings-search
          style={pos ? { top: pos.top, right: pos.right } : { top: 16, right: 16 }}
        >
          <input
            ref={input}
            className="settings-search-input"
            placeholder="Search settings…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
          />
          {query.trim() && (
            <span className="shrink-0 text-2xs tabular-nums text-ink-faint" aria-live="polite">
              {pending ? '…' : total ? `${shown} of ${total}` : 'No results'}
            </span>
          )}
          <button type="button" className="settings-search-btn" aria-label="Previous match" title="Previous match" disabled={!query.trim() || (!pending && total < 2)} onClick={() => step(-1)}>
            <ChevronUpIcon className="h-3.5 w-3.5" />
          </button>
          <button type="button" className="settings-search-btn" aria-label="Next match" title="Next match" disabled={!query.trim() || (!pending && total < 2)} onClick={() => step(1)}>
            <ChevronDownIcon className="h-3.5 w-3.5" />
          </button>
          <button type="button" className="settings-search-btn" aria-label="Close search" title="Close (Esc)" onClick={close}>
            <CloseIcon className="h-3.5 w-3.5" />
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}
