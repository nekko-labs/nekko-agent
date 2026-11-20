import React, { useEffect, useId, useRef, useState } from 'react';
import { NekkoAvatar } from './Mascot.js';
import { useUpdater } from './UpdateBanner.js';
import { Group, Modal, Row } from './primitives/index.js';
import { GfCloseIcon, GfIcon, isGfIconName } from '../gentleface-icons.js';
import { highlightsFor, prUrl, splitHighlights, whatsNewUrl, type Highlight } from '../whatsNew.js';

/** Every row has a glyph: the highlight's own, or this when it names none we bundle. */
const FALLBACK_ICON = 'sparkles';

function HighlightRow({ item, rowRef, className }: { item: Highlight; rowRef?: React.Ref<HTMLDivElement>; className?: string }) {
  const icon = item.icon && isGfIconName(item.icon) ? item.icon : FALLBACK_ICON;

  return (
    <div ref={rowRef} role="listitem" className={className}>
      <Row
        stacked
        leading={<GfIcon name={icon} className="text-ink-soft" />}
        title={item.title}
        detail={item.detail}
        meta={`#${item.pr}`}
        onClick={() => void window.nekko.openPath(prUrl(item.pr))}
        data-whats-new-row={item.pr}
      />
    </div>
  );
}

function Sheet({ version, data, onClose }: { version: string; data?: unknown; onClose: () => void }) {
  const titleId = useId();
  const body = useRef<HTMLDivElement>(null);
  const firstMore = useRef<HTMLDivElement>(null);
  // Set by "Show more": the height the sheet had, which it keeps while the list scrolls inside it.
  const [height, setHeight] = useState<number | null>(null);
  const expanded = height !== null;

  const { top, rest } = splitHighlights(highlightsFor(version, data));

  // The laid-out height, to the fraction: `offsetHeight` rounds, and the sheet would shift by that.
  const showMore = () => {
    if (body.current) setHeight(parseFloat(getComputedStyle(body.current).height));
  };

  useEffect(() => {
    if (!expanded) return;

    // The button that had focus is gone: hand it to the first row it revealed, and bring that row into view.
    const row = firstMore.current?.querySelector('button');
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    row?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: 'nearest', behavior: still ? 'auto' : 'smooth' });
  }, [expanded]);

  return (
    <Modal
      title="What's new"
      labelledBy={titleId}
      onClose={onClose}
      overlayClassName="p-4"
      zIndex={100}
      className="whats-new-sheet flex max-h-[calc(100dvh-2rem)] w-[400px] max-w-full flex-col overflow-hidden rounded-xl bg-surface text-ink shadow-(--shadow-float)"
    >
      <div ref={body} className="flex min-h-0 flex-col" style={expanded ? { height } : undefined} data-whats-new={version}>
        <header className="flex shrink-0 items-center gap-2 px-5 pt-5">
          <NekkoAvatar size={20} stationary />
          <h2 id={titleId} className="text-base font-semibold">What's new</h2>
          <span className="text-xs tabular-nums text-ink-faint">v{version}</span>
          <button type="button" className="-mr-1 ml-auto rounded-sm p-1 text-ink-faint hover:text-ink" onClick={onClose} aria-label="Close">
            <GfCloseIcon className="h-4 w-4" />
          </button>
        </header>

        {top.length > 0 && (
          <div className="mt-1.5 min-h-0 flex-1 overflow-y-auto px-2 py-0.5" data-whats-new-list>
            {/* 2px of the 8px gap above sits inside the scroller, so the focus ring on its first or last row is not clipped. */}
            <Group as="div" role="list" label="Highlights">
              {top.map((item, i) => <HighlightRow key={`${item.pr}-${i}`} item={item} />)}

              {expanded && rest.map((item, i) => (
                <HighlightRow key={`${item.pr}-${i}`} item={item} rowRef={i === 0 ? firstMore : undefined} className="whats-new-more" />
              ))}
            </Group>
          </div>
        )}

        <footer className="flex min-h-14 shrink-0 items-center gap-2 px-5 pb-5 pt-2">
          {rest.length > 0 && !expanded && (
            <button type="button" className="btn btn-ghost -ml-3" onClick={showMore} data-whats-new-more>
              Show more
            </button>
          )}
          <button type="button" className="ml-auto text-xs text-accent hover:underline" onClick={() => void window.nekko.openPath(whatsNewUrl(version))} data-whats-new-all>
            See every change ↗
          </button>
        </footer>
      </div>
    </Modal>
  );
}

/**
 * The "What's new" sheet: the few changes in this version worth knowing,
 * from the highlights bundled with the build, and a link to the website's
 * What's new page. A modal over whatever view is showing, opened with `openWhatsNew()`.
 * `data` replaces the bundled highlights (tests).
 */
export function WhatsNewSheet({ data }: { data?: unknown } = {}) {
  const [open, setOpen] = useState(false);
  const version = useUpdater().app?.version;

  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener('nekko:whats-new', show);

    return () => window.removeEventListener('nekko:whats-new', show);
  }, []);

  if (!open || !version) return null;

  return <Sheet version={version} data={data} onClose={() => setOpen(false)} />;
}
