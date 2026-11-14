import React, { useEffect, useRef, useState } from 'react';
import { isServableHtml, type HtmlPreviewServed } from '@nekko-agent/shared';
import type { ArtifactKind } from '../../artifactsIndex.js';
import { SERVED_PREVIEW_SANDBOX } from '../ArtifactPreview.js';
import { ArtifactPreview } from './ArtifactPreview.js';
import { FRAME } from './designCanvasView.js';
import { thumbnailCache, thumbnailKind } from './thumbnailCache.js';

/** How long a page runs before its motion is held, so a fade-in has landed. */
const SETTLE_MS = 1200;

/** Starts true once the element has come near the screen, and stays true. */
function useSeen(ref: React.RefObject<HTMLElement | null>): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    if (typeof IntersectionObserver === 'undefined') { setSeen(true); return; }
    const observer = new IntersectionObserver((list) => { if (list.some((e) => e.isIntersecting)) setSeen(true); }, { rootMargin: '200px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, seen]);
  return seen;
}

/**
 * What a file in Library actually looks like: an HTML page running, laid out
 * at a desktop width and shrunk to the tile, then held still; cached first-page
 * document text and resized images. Anything else, a file that cannot be read or served, and the moment
 * before a tile comes into view show the kind's drawing.
 *
 * A page runs where every served page does (an opaque-origin sandbox with no
 * network), cannot be clicked or focused, and is served only once its tile is
 * near the screen. It is released when the tile goes.
 */
export function TilePreview({ kind, path, ext, revision, className = '', mover }: {
  kind: ArtifactKind;
  path: string;
  ext: string;
  revision?: string | number;
  className?: string;
  mover?: string;
}) {
  const box = useRef<HTMLSpanElement>(null);
  const seen = useSeen(box);
  const html = isServableHtml(path) && typeof window !== 'undefined' && !!window.nekko?.serveHtmlPreview;
  const pictureKind = thumbnailKind(path);
  const canRead = !!pictureKind && typeof window !== 'undefined' && !!window.nekko?.readFile;
  const [served, setServed] = useState<HtmlPreviewServed | null>(null);
  const [picture, setPicture] = useState<{ path: string; revision?: string | number; url: string } | null>(() => {
    const url = thumbnailCache.peek(path, revision);
    return url ? { path, revision, url } : null;
  });
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);

  useEffect(() => {
    if (!seen || !html) return;
    let live = true;
    let id = '';
    window.nekko.serveHtmlPreview!(path, { internet: false, controls: true }).then((s) => {
      if (!s?.url) throw new Error('not served');
      if (!live) { void window.nekko.releaseHtmlPreview?.(s.id).catch(() => {}); return; }
      id = s.id;
      setServed(s);
    }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; if (id) void window.nekko.releaseHtmlPreview?.(id).catch(() => {}); };
  }, [seen, html, path]);

  useEffect(() => {
    if (!seen || !canRead) return;
    let live = true;
    thumbnailCache.load(path, revision).then((url) => {
      if (live) setPicture(url ? { path, revision, url } : null);
    });
    return () => { live = false; };
  }, [seen, canRead, path, revision]);

  useEffect(() => {
    const el = box.current;
    if (!el || !html) return;
    const measure = () => { setWidth(el.clientWidth); setHeight(el.clientHeight); };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [html]);

  const frame = useRef<HTMLIFrameElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const settle = () => {
    clearTimeout(timer.current);
    // A moving design costs nothing once held; the canvas lets it play.
    timer.current = setTimeout(() => { frame.current?.contentWindow?.postMessage({ nekkoPreview: 'pause' }, '*'); setReady(true); }, SETTLE_MS);
  };

  const pictureUrl = picture?.path === path && picture.revision === revision ? picture.url : '';
  const live = (html && !failed && served) || pictureUrl;
  const scale = width > 0 ? width / FRAME.width : 0;
  return (
    <span ref={box} className={`library-live ${className}`} data-library-mover={mover} data-library-mover-class={mover ? 'library-preview' : undefined} data-live-preview={live ? (html ? 'page' : pictureKind) : undefined}>
      {!pictureUrl && <ArtifactPreview kind={kind} path={path} ext={ext} className="library-live-art" />}
      {pictureUrl && <img src={pictureUrl} alt="" className="library-live-image" decoding="async" draggable={false} />}
      {live && html && served && scale > 0 && (
        <iframe ref={frame} title="" aria-hidden="true" tabIndex={-1} src={served.url} sandbox={SERVED_PREVIEW_SANDBOX} referrerPolicy="no-referrer" onLoad={settle}
          className="library-live-frame" data-ready={ready || undefined}
          style={{ width: FRAME.width, height: Math.ceil(height / scale), transform: `scale(${scale})` }} />
      )}
    </span>
  );
}
