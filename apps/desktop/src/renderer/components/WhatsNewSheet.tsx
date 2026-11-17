import React, { useEffect, useId, useRef, useState } from 'react';
import { NekkoAvatar } from './Mascot.js';
import { useUpdater } from './UpdateBanner.js';
import { Group, Modal, Row } from './primitives/index.js';
import { GfCloseIcon, GfIcon, isGfIconName } from '../gentleface-icons.js';
import { highlightsFor, prUrl, releaseUrl, splitHighlights, type Highlight } from '../whatsNew.js';

/** Every row has a glyph: the highlight's own, or this when it names none we bundle. */
const FALLBACK_ICON = 'sparkles';

function HighlightRow({ item, rowRef }: { item: Highlight; rowRef?: React.Ref<HTMLDivElement> }) {
  const icon = item.icon && isGfIconName(item.icon) ? item.icon : FALLBACK_ICON;

  return (
    <div ref={rowRef} role="listitem">
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

function Sheet({ version, onClose }: { version: string; onClose: () => void }) {
  const titleId = useId();
  const [expanded, setExpanded] = useState(false);
  const firstMore = useRef<HTMLDivElement>(null);

  const { top, rest } = splitHighlights(highlightsFor(version));
  const showMore = () => {
    setExpanded(true);
    // The button that had focus is gone: hand it to the first row it revealed.
    requestAnimationFrame(() => firstMore.current?.querySelector('button')?.focus());
  };

  return (
    <Modal
      title="What's new"
      labelledBy={titleId}
      onClose={onClose}
      overlayClassName="p-4"
      zIndex={100}
      className="whats-new-sheet max-h-[calc(100dvh-2rem)] w-[400px] max-w-full overflow-y-auto rounded-xl bg-surface text-ink shadow-(--shadow-float)"
    >
      <div data-whats-new={version}>
        <header className="flex items-center gap-2 px-5 pt-5">
          <NekkoAvatar size={20} stationary />
          <h2 id={titleId} className="text-base font-semibold">What's new</h2>
          <span className="text-xs tabular-nums text-ink-faint">v{version}</span>
          <button type="button" className="-mr-1 ml-auto rounded-sm p-1 text-ink-faint hover:text-ink" onClick={onClose} aria-label="Close">
            <GfCloseIcon className="h-4 w-4" />
          </button>
        </header>

        {top.length > 0 && (
          <Group as="div" role="list" label="Highlights" className="mt-2 px-2">
            {top.map((item, i) => <HighlightRow key={`${item.pr}-${i}`} item={item} />)}

            {rest.length > 0 && (
              <div className={`collapse-wrap ${expanded ? '' : 'collapsed'}`} data-whats-new-rest inert={!expanded}>
                <div className="min-h-0 overflow-hidden">
                  {rest.map((item, i) => <HighlightRow key={`${item.pr}-${i}`} item={item} rowRef={i === 0 ? firstMore : undefined} />)}
                </div>
              </div>
            )}
          </Group>
        )}

        <footer className="flex items-center gap-2 px-5 pb-5 pt-2">
          {rest.length > 0 && !expanded && (
            <button type="button" className="btn btn-ghost -ml-3" onClick={showMore} data-whats-new-more>
              Show {rest.length} more
            </button>
          )}
          <button type="button" className="ml-auto text-xs text-accent hover:underline" onClick={() => void window.nekko.openPath(releaseUrl(version))} data-whats-new-all>
            See every change ↗
          </button>
        </footer>
      </div>
    </Modal>
  );
}

/**
 * The "What's new" sheet: the few changes in this version worth knowing,
 * from the highlights bundled with the build, and a link to the full release
 * notes. A modal over whatever view is showing, opened with `openWhatsNew()`.
 */
export function WhatsNewSheet() {
  const [open, setOpen] = useState(false);
  const version = useUpdater().app?.version;

  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener('nekko:whats-new', show);

    return () => window.removeEventListener('nekko:whats-new', show);
  }, []);

  if (!open || !version) return null;

  return <Sheet version={version} onClose={() => setOpen(false)} />;
}
