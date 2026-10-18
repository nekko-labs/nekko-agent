import React from 'react';
import { Modal } from './primitives/index.js';
import { CloseIcon } from '../icons.js';
import { imageHost, useRemoteImage, type ChatImageItem } from '../remoteImages.js';

/**
 * The full photo viewer: one image as large as the window allows, with
 * previous / next through every photo of the gallery it was opened from
 * (arrow keys too), its caption and source, and the same actions as the
 * right-click menu. Remote photos not loaded yet load here, through the host.
 */
export function PhotoViewer({ items, index: start, trusted, onClose, onMenu, onCopy, onSave }: {
  items: ChatImageItem[];
  index: number;
  trusted: (url: string) => boolean;
  onClose: () => void;
  onMenu: (e: React.MouseEvent, item: ChatImageItem) => void;
  onCopy: (item: ChatImageItem) => void;
  onSave: (item: ChatImageItem) => void;
}) {
  const [index, setIndex] = React.useState(() => Math.min(Math.max(0, start), items.length - 1));
  const [allowed, setAllowed] = React.useState<Set<string>>(() => new Set());
  const item = items[index];
  const many = items.length > 1;
  const needsFetch = !item.src && !!item.url;
  const mayLoad = needsFetch && (trusted(item.url!) || allowed.has(item.url!));
  const [state, retry] = useRemoteImage(needsFetch ? item.url! : null, mayLoad);
  const src = item.src ?? (state.status === 'ready' ? state.image.dataUrl : undefined);
  const shown: ChatImageItem = { ...item, src };
  const go = React.useCallback((delta: number) => setIndex((i) => (i + delta + items.length) % items.length), [items.length]);

  React.useEffect(() => {
    if (!many) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [many, go]);

  const caption = item.alt || (item.url ? imageHost(item.url) : 'Image');
  const pill = 'flex min-h-9 items-center gap-1.5 rounded-full bg-surface px-3.5 py-1.5 text-[13px] font-medium text-ink shadow-lg hover:bg-surface-2 disabled:opacity-50';

  return (
    <Modal title={many ? `Photo ${index + 1} of ${items.length}: ${caption}` : caption} onClose={onClose} scrim="rgba(0,0,0,0.78)" overlayClassName="p-4" zIndex={55}>
      <div className="flex h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] flex-col items-center gap-3" data-photo-viewer onClick={onClose}>
        <div className="flex w-full items-center gap-2" onClick={(e) => e.stopPropagation()}>
          <span className="min-w-0 flex-1 truncate text-[13px] text-white/90" title={item.url ?? caption}>
            {many && <span className="mr-2 tabular-nums text-white/60">{index + 1} / {items.length}</span>}
            {caption}
            {item.url && item.alt && <span className="ml-2 text-white/55">{imageHost(item.url)}</span>}
          </span>
          <button className={pill} disabled={!src} onClick={() => onCopy(shown)}>Copy</button>
          <button className={pill} disabled={!src} onClick={() => onSave(shown)}>Save…</button>
          {item.url && <button className={pill} onClick={(e) => onMenu(e, shown)} aria-label="More image actions">More…</button>}
          <button className={pill} aria-label="Close image" onClick={onClose}><CloseIcon className="h-4 w-4" /> Close</button>
        </div>
        <div className="relative flex min-h-0 w-full flex-1 items-center justify-center">
          {many && <button className="absolute left-0 z-10 flex h-11 w-11 items-center justify-center rounded-full bg-surface/90 text-xl text-ink shadow-lg hover:bg-surface-2" aria-label="Previous photo" onClick={(e) => { e.stopPropagation(); go(-1); }}>‹</button>}
          {src ? (
            <img
              key={src}
              src={src}
              alt={caption}
              referrerPolicy="no-referrer"
              className="block max-h-full max-w-[calc(100%-7rem)] object-contain"
              onClick={(e) => e.stopPropagation()}
              onContextMenu={(e) => onMenu(e, shown)}
              title="Right-click to copy or save"
            />
          ) : (
            <div className="flex flex-col items-center gap-3 rounded-xl bg-surface p-6 text-center text-sm text-ink-soft shadow-lg" onClick={(e) => e.stopPropagation()} role="status">
              {state.status === 'error' ? <>
                <span>Couldn't load the image from {imageHost(item.url ?? '')}.</span>
                <span className="text-xs text-ink-faint">{state.message}</span>
                <button className="btn btn-ghost h-8 px-3 text-xs" onClick={retry}>Retry</button>
              </> : !mayLoad && item.url ? <>
                <span>Loading this image contacts {imageHost(item.url)}.</span>
                <button className="btn btn-primary h-8 px-3 text-xs" onClick={() => setAllowed((s) => new Set(s).add(item.url!))}>Load image</button>
              </> : <span>Loading image…</span>}
            </div>
          )}
          {many && <button className="absolute right-0 z-10 flex h-11 w-11 items-center justify-center rounded-full bg-surface/90 text-xl text-ink shadow-lg hover:bg-surface-2" aria-label="Next photo" onClick={(e) => { e.stopPropagation(); go(1); }}>›</button>}
        </div>
      </div>
    </Modal>
  );
}
