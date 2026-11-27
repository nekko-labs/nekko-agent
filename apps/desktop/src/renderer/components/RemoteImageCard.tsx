import React from 'react';
import { ChatImages, imageHost, PreviewImageAutoload, useNearViewport, useRemoteImage, type ChatImageItem } from '../remoteImages.js';
import { PixelSkeleton } from './PixelSkeleton.js';

/**
 * A photo loaded through the host (`image:fetch`). A document preview uses its
 * auto-load preference; chat still requires URL provenance or an explicit click.
 */
export function RemoteImageCard({ url, alt, items, index = 0, tile = false }: {
  url: string;
  alt: string;
  /** Every photo in the gallery this one belongs to, for the viewer's prev/next. */
  items?: ChatImageItem[];
  index?: number;
  /** Rendered as a gallery tile (square-ish crop) rather than a full-width card. */
  tile?: boolean;
}) {
  const chat = React.useContext(ChatImages);
  const previewAutoload = React.useContext(PreviewImageAutoload);
  const [clicked, setClicked] = React.useState(false);
  const autoLoad = previewAutoload ?? !!chat?.trusted(url);
  const [ref, near] = useNearViewport<HTMLSpanElement>();
  const [state, retry, decodeFailed] = useRemoteImage(url, clicked || (near && autoLoad));
  const fallback = state.status === 'error' || (!autoLoad && !clicked);
  const host = imageHost(url);
  const label = alt || `Image from ${host}`;
  const item: ChatImageItem = { url, alt, src: state.status === 'ready' ? state.image.dataUrl : undefined };
  const list = items ?? [item];

  const frame = tile
    ? 'aspect-[4/3] w-full'
    : 'min-h-[140px] w-full';

  let body: React.ReactNode;
  if (state.status === 'ready') {
    const image = (
      <img
        src={state.image.dataUrl}
        alt={label}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        draggable={false}
        onError={decodeFailed}
        className={tile ? 'block h-full w-full object-cover' : 'block h-auto max-h-[480px] w-full object-contain'}
        style={tile ? { aspectRatio: '4 / 3' } : undefined}
      />
    );
    body = chat ? (
      <button
        type="button"
        className="block w-full cursor-zoom-in"
        title="Open the photo viewer (right-click for more)"
        aria-label={`Open ${label}`}
        onClick={() => chat.open(list.map((it) => (it.url === url ? { ...it, src: state.image.dataUrl } : it)), index)}
        onContextMenu={(e) => chat.menu(e, item)}
      >
        {image}
      </button>
    ) : image;
  } else if (fallback) {
    body = (
      <span className={`flex w-full items-center justify-center px-3 py-2 ${tile ? frame : ''}`}>
        <button type="button" className="btn btn-outline h-7 px-3 text-xs" onClick={() => {
          setClicked(true);
          if (state.status === 'error') retry();
        }}>Load image</button>
      </span>
    );
  } else {
    body = <PixelSkeleton className={frame} label={`Loading ${label}`} />;
  }

  return (
    <span
      ref={ref}
      data-remote-image={url}
      data-state={state.status === 'idle' && fallback ? 'blocked' : state.status}
      className={`artifact-card inline-flex min-w-0 flex-col overflow-hidden rounded-xl border align-top ${tile ? 'w-full' : 'my-2 w-full max-w-[640px]'}`}
      aria-label={label}
    >
      {body}
      <span className="flex min-w-0 items-center gap-2 px-3 py-1">
        {!fallback && alt && <span className="min-w-0 flex-1 truncate text-xs text-ink" title={alt}>{alt}</span>}
        <span className="min-w-0 truncate text-2xs text-ink-faint" title={url}>From {host}</span>
      </span>
    </span>
  );
}

/** Several photos in a row of a reply, laid out as a grid of tiles that share one viewer. */
export function RemoteImageGallery({ images }: { images: Array<{ url: string; alt: string }> }) {
  const items = React.useMemo<ChatImageItem[]>(() => images.map(({ url, alt }) => ({ url, alt })), [images]);
  const cols = images.length === 2 || images.length === 4 ? 'sm:grid-cols-2' : 'sm:grid-cols-3';
  return (
    <span className={`my-2 grid w-full max-w-[768px] grid-cols-2 gap-2 ${cols}`} role="group" data-photo-gallery aria-label={`${images.length} photos`}>
      {images.map((img, i) => <RemoteImageCard key={`${i}-${img.url}`} url={img.url} alt={img.alt} items={items} index={i} tile />)}
    </span>
  );
}
