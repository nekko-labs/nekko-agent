import React from 'react';
import { ChatImages, imageHost, useNearViewport, useRemoteImage, type ChatImageItem } from '../remoteImages.js';

/**
 * A photo from the web in a chat reply. It loads through the host
 * (`image:fetch`), only once it is near the viewport, and only by itself when
 * the chat has actually seen the URL in a tool result or a user message;
 * otherwise it waits for a click. Click opens the photo viewer; right-click
 * offers copy, save, copy link and open.
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
  const [clicked, setClicked] = React.useState(false);
  const trusted = !!chat?.trusted(url);
  const [ref, near] = useNearViewport<HTMLSpanElement>();
  const [state, retry] = useRemoteImage(url, near && (trusted || clicked));
  const host = imageHost(url);
  const label = alt || `Image from ${host}`;
  const item: ChatImageItem = { url, alt, src: state.status === 'ready' ? state.image.dataUrl : undefined };
  const list = items ?? [item];

  const frame = tile
    ? 'aspect-[4/3] w-full'
    : 'min-h-[140px] w-full';

  let body: React.ReactNode;
  if (state.status === 'ready') {
    body = (
      <button
        type="button"
        className="block w-full cursor-zoom-in"
        title="Open the photo viewer (right-click for more)"
        aria-label={`Open ${label}`}
        onClick={() => chat?.open(list.map((it) => (it.url === url ? { ...it, src: state.image.dataUrl } : it)), index)}
        onContextMenu={(e) => chat?.menu(e, item)}
      >
        <img
          src={state.image.dataUrl}
          alt={label}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          draggable={false}
          className={tile ? 'block h-full w-full object-cover' : 'block h-auto max-h-[480px] w-full object-contain'}
          style={tile ? { aspectRatio: '4 / 3' } : undefined}
        />
      </button>
    );
  } else if (state.status === 'error') {
    body = (
      <span className={`flex ${frame} flex-col items-center justify-center gap-2 p-4 text-center text-xs text-ink-soft`} role="status">
        <span>Couldn't load the image from {host}.</span>
        <span className="text-2xs text-ink-faint">{state.message}</span>
        <button type="button" className="btn btn-ghost h-7 px-2.5 text-xs" onClick={retry}>Retry</button>
      </span>
    );
  } else if (!trusted && !clicked) {
    body = (
      <span className={`flex ${frame} flex-col items-center justify-center gap-2 p-4 text-center text-xs text-ink-soft`}>
        <span>Image from <strong className="font-medium text-ink">{host}</strong></span>
        <span className="max-w-[320px] text-2xs text-ink-faint">Not from a search or page in this chat, so it waits for you. Loading it contacts {host}.</span>
        <button type="button" className="btn btn-ghost h-7 px-2.5 text-xs" onClick={() => setClicked(true)}>Load image</button>
      </span>
    );
  } else {
    body = <span className={`remote-image-skeleton block ${frame}`} role="status" aria-label={`Loading ${label}`} />;
  }

  return (
    <span
      ref={ref}
      data-remote-image={url}
      data-state={state.status === 'idle' && !trusted && !clicked ? 'blocked' : state.status}
      className={`artifact-card inline-flex min-w-0 flex-col overflow-hidden rounded-xl border align-top ${tile ? 'w-full' : 'my-2 w-full max-w-[640px]'}`}
      aria-label={label}
    >
      {body}
      <span className="flex min-w-0 items-center gap-2 px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate text-xs text-ink" title={alt || undefined}>{alt || host}</span>
        <span className="shrink-0 truncate text-2xs text-ink-faint" title={url}>{host}</span>
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
