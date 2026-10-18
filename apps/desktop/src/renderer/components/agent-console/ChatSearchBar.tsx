import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDownIcon, ChevronUpIcon, CloseIcon } from '../../icons.js';
import type { TranscriptRow } from './transcript.js';
import type { VirtualTranscriptHandle } from './VirtualTranscript.js';
import { findChatMatches, matchRanges, searchPattern, startMatch, stepMatch } from './chatSearch.js';

/**
 * Find in this chat: a small bar over the top of the transcript with the
 * query, how many times it appears, up/down to step through them, and close.
 *
 * Highlights are drawn with the CSS Custom Highlight API (`::highlight()`),
 * so the message DOM is never rewritten: React keeps its nodes, selection and
 * copy are untouched, and rows that scroll into view are highlighted as they
 * render. Only the text a reader sees is searched, never the bar itself, code
 * buttons or tool steps.
 */

const ALL = 'nekko-chat-search';
const CURRENT = 'nekko-chat-search-current';

type HighlightRegistry = { set(name: string, h: unknown): void; delete(name: string): void };
type HighlightCtor = new (...ranges: Range[]) => unknown;

function highlightApi(): { registry: HighlightRegistry; Highlight: HighlightCtor } | null {
  const registry = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS?.highlights;
  const Highlight = (globalThis as { Highlight?: HighlightCtor }).Highlight;
  return registry && Highlight ? { registry, Highlight } : null;
}

/**
 * The rendered message text of a row (MessageBubble marks it): the same text
 * `rowSearchText` counts, so the highlights and the count agree. Tool steps,
 * reasoning, the Done line and the hover actions sit outside it.
 */
const TEXT_ROOTS = '[data-chat-search-text]';
/** Inside message text, controls that are not part of the message (a code block's Copy button). */
const SKIP = 'button:not([title^="Open "]), [aria-hidden="true"]';

/** Ranges for every match in one rendered row, in reading order. */
function rowRanges(row: HTMLElement, pattern: RegExp): Range[] {
  const out: Range[] = [];
  for (const root of row.querySelectorAll<HTMLElement>(TEXT_ROOTS)) {
    // Concatenate the row's visible text so a match split across formatting
    // (`**scr**oll` would still be one word on screen) is found the same way
    // the count found it in the source.
    const nodes: Text[] = [];
    const starts: number[] = [];
    let text = '';
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        const skip = n.parentElement?.closest(SKIP);
        return skip && root.contains(skip) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      nodes.push(n as Text);
      starts.push(text.length);
      text += (n as Text).data;
    }
    const at = (offset: number, end: boolean): [Text, number] => {
      let i = 0;
      while (i + 1 < nodes.length && (end ? starts[i + 1] < offset : starts[i + 1] <= offset)) i++;
      return [nodes[i], offset - starts[i]];
    };
    for (const [s, e] of matchRanges(text, pattern)) {
      const range = document.createRange();
      const [sn, so] = at(s, false);
      const [en, eo] = at(e, true);
      range.setStart(sn, so);
      range.setEnd(en, eo);
      out.push(range);
    }
  }
  return out;
}

export function ChatSearchBar({ rows, scrollRoot, transcript, onClose, initialQuery = '' }: {
  rows: readonly TranscriptRow[];
  /** The transcript's scroller, found from the pane. */
  scrollRoot: () => HTMLElement | null;
  transcript: React.RefObject<VirtualTranscriptHandle | null>;
  onClose: () => void;
  /** Text to search for at once (a chat opened from a Search chats message match). */
  initialQuery?: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [current, setCurrent] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const matches = useMemo(() => findChatMatches(rows, query), [rows, query]);
  const pattern = useMemo(() => searchPattern(query), [query]);
  const total = matches.length;
  const active = current >= 0 && current < total ? matches[current] : null;

  useLayoutEffect(() => { input.current?.focus(); input.current?.select(); }, []);

  // A new query always starts at the first match in the chat: 1 of N.
  useEffect(() => {
    setCurrent(startMatch(matches));
    // Only when the query changes, not when rows stream in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  // Keep the index in range as the chat changes under an open search.
  useEffect(() => {
    if (current >= total) setCurrent(total ? total - 1 : -1);
  }, [current, total]);

  /**
   * Draw every rendered match and the current one on top. Returns the current
   * match's range when its row is rendered, so the caller can reveal it.
   */
  const paint = useCallback((): Range | null => {
    const api = highlightApi();
    const sc = scrollRoot();
    if (!api) return null;
    if (!sc || !pattern) { api.registry.delete(ALL); api.registry.delete(CURRENT); return null; }
    const all: Range[] = [];
    let currentRange: Range | null = null;
    for (const row of sc.querySelectorAll<HTMLElement>('[data-vt-key]')) {
      const ranges = rowRanges(row, pattern);
      all.push(...ranges);
      if (active && row.dataset.vtKey === active.rowKey) currentRange = ranges[active.nth] ?? null;
    }
    api.registry.set(ALL, new api.Highlight(...all));
    if (currentRange) api.registry.set(CURRENT, new api.Highlight(currentRange));
    else api.registry.delete(CURRENT);
    return currentRange;
  }, [scrollRoot, pattern, active]);

  // Moving to a match: render its row (jumping there if it is far away), then
  // centre the match. A far row renders a frame after the jump and its real
  // height may move it once more as it is measured, so this re-checks each
  // frame, a few times at most, until the match sits inside the view.
  useEffect(() => {
    if (!active) { paint(); return; }
    let id = 0;
    let tries = 0;
    const settle = () => {
      const sc = scrollRoot();
      if (!sc) return;
      const range = paint();
      if (!range) {
        if (tries++ < 8) { transcript.current?.scrollToKey(active.rowKey); id = requestAnimationFrame(settle); }
        return;
      }
      const r = range.getBoundingClientRect();
      const box = sc.getBoundingClientRect();
      const inView = r.top >= box.top + 24 && r.bottom <= box.bottom - 24;
      if (!inView) transcript.current?.scrollByPx(r.top - box.top - box.height / 2 + r.height / 2);
      if (!inView && tries++ < 8) id = requestAnimationFrame(settle);
    };
    settle();
    return () => cancelAnimationFrame(id);
  }, [active, paint, scrollRoot, transcript]);

  // Rows come and go as the reader scrolls; repaint what is rendered.
  useEffect(() => {
    const sc = scrollRoot();
    if (!sc || !pattern) return;
    let id = 0;
    const again = () => { cancelAnimationFrame(id); id = requestAnimationFrame(() => { paint(); }); };
    sc.addEventListener('scroll', again, { passive: true });
    const mo = new MutationObserver(again);
    mo.observe(sc, { childList: true, subtree: true, characterData: true });
    return () => { cancelAnimationFrame(id); sc.removeEventListener('scroll', again); mo.disconnect(); };
  }, [scrollRoot, pattern, paint]);

  // Closing (or unmounting) leaves no highlight behind.
  useEffect(() => () => { const api = highlightApi(); api?.registry.delete(ALL); api?.registry.delete(CURRENT); }, []);

  const step = (dir: 1 | -1) => setCurrent((c) => stepMatch(c, total, dir));

  return (
    <div className="chat-search" role="search" aria-label="Find in this chat" data-chat-search
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
        else if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); step(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
      }}
    >
      <input
        ref={input}
        className="chat-search-input"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Find in chat"
        aria-label="Find in chat"
        spellCheck={false}
      />
      <span className="chat-search-count tabular-nums" aria-live="polite" data-chat-search-count>
        {!pattern ? '' : total === 0 ? 'No results' : `${current + 1} of ${total}`}
      </span>
      <button type="button" className="chat-search-btn" onClick={() => step(-1)} disabled={!total} title="Previous match (Shift+Enter)" aria-label="Previous match">
        <ChevronUpIcon className="h-4 w-4" />
      </button>
      <button type="button" className="chat-search-btn" onClick={() => step(1)} disabled={!total} title="Next match (Enter)" aria-label="Next match">
        <ChevronDownIcon className="h-4 w-4" />
      </button>
      <button type="button" className="chat-search-btn" onClick={onClose} title="Close (Esc)" aria-label="Close search">
        <CloseIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
