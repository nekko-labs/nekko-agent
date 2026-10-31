import React, { useEffect, useRef, useState } from 'react';
import { ExternalIcon } from '../icons.js';

/**
 * An integrated Chromium browser pane (Electron <webview>) with a URL bar and
 * back / forward / reload / open-external controls, for previewing a local dev
 * server or docs without leaving the app. Runs out-of-process; remote content
 * has no Node access.
 */

/**
 * Only http(s) ever reaches the frame. Anything else typed with a scheme
 * (`javascript:`, `file:`, `data:`) would run in, or read from, the app's
 * own origin through the Local Web UI's iframe, so it shows nothing; so does
 * the app's own origin, which the sandbox cannot contain.
 */
function safeUrl(candidate: string): string {
  try {
    const u = new URL(candidate);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'about:blank';
    if (typeof location !== 'undefined' && u.origin === location.origin) return 'about:blank';
    return u.href;
  } catch {
    return 'about:blank';
  }
}

/** Turn whatever the user typed into a navigable http(s) URL (or a web search). */
export function normalizeUrl(input: string): string {
  const s = input.trim();
  if (!s || s === 'about:blank') return 'about:blank';
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^(localhost|\d{1,3}(\.\d{1,3}){3}):\d/i.test(s)) return safeUrl(s);
  const looksLocal = /^localhost(:\d+)?(\/|$)/i.test(s) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?/.test(s);
  if (looksLocal) return safeUrl(`http://${s}`);
  // A bare domain (has a dot, no spaces) → https; otherwise treat as a search.
  if (/^[^\s]+\.[^\s]+$/.test(s)) return safeUrl(`https://${s}`);
  return safeUrl(`https://duckduckgo.com/?q=${encodeURIComponent(s)}`);
}

/** Electron renders <webview>; a plain browser (the Local Web UI) does not, so it gets an iframe. */
const HAS_WEBVIEW = typeof navigator !== 'undefined' && /Electron\//.test(navigator.userAgent);

export function BrowserPane({ url: initial }: { url: string }) {
  const start = initial && initial !== 'about:blank' ? initial : '';
  const [url, setUrl] = useState(start ? normalizeUrl(start) : 'about:blank');
  const [address, setAddress] = useState(start);
  const ref = useRef<HTMLElement | null>(null);

  // Keep the address bar in sync with in-page navigation. The webview only
  // mounts once there is a URL, so attach when it appears, not on first render.
  const mounted = url !== 'about:blank';
  useEffect(() => {
    const el = ref.current as any;
    if (!el || !HAS_WEBVIEW) return;
    const onNav = () => { try { setAddress(el.getURL?.() ?? ''); } catch { /* not ready */ } };
    el.addEventListener('did-navigate', onNav);
    el.addEventListener('did-navigate-in-page', onNav);
    return () => {
      el.removeEventListener('did-navigate', onNav);
      el.removeEventListener('did-navigate-in-page', onNav);
    };
  }, [mounted]);

  const wv = () => ref.current as any;
  const go = () => setUrl(normalizeUrl(address));
  const back = () => { try { HAS_WEBVIEW ? wv()?.goBack() : (wv() as HTMLIFrameElement | null)?.contentWindow?.history.back(); } catch { /* cross-origin */ } };
  const forward = () => { try { HAS_WEBVIEW ? wv()?.goForward() : (wv() as HTMLIFrameElement | null)?.contentWindow?.history.forward(); } catch { /* cross-origin */ } };
  const reload = () => { try { if (HAS_WEBVIEW) wv()?.reload(); else { const f = wv() as HTMLIFrameElement | null; if (f) f.src = url; } } catch { /* */ } };

  return (
    <div className="flex h-full flex-col overflow-hidden" style={{ background: 'var(--paper)' }}>
      <div className="flex items-center gap-1 border-b border-line px-2 py-1.5">
        <button className="rounded-sm p-1 text-ink-faint hover:text-ink" title="Back" onClick={back}>‹</button>
        <button className="rounded-sm p-1 text-ink-faint hover:text-ink" title="Forward" onClick={forward}>›</button>
        <button className="rounded-sm p-1 text-ink-faint hover:text-ink" title="Reload" onClick={reload}>⟳</button>
        <input
          className="input min-w-0 flex-1 px-2 py-1 text-xs"
          placeholder="Enter a URL or search…"
          value={address}
          spellCheck={false}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') go(); }}
        />
        <button className="rounded-sm p-1 text-ink-faint hover:text-ink" title="Open in external browser"
          onClick={() => url !== 'about:blank' && window.nekko.openPath(url)}><ExternalIcon className="h-3.5 w-3.5" /></button>
      </div>
      <div className="min-h-0 flex-1">
        {url === 'about:blank' ? (
          <div className="grid h-full place-items-center px-6 text-center text-sm text-ink-faint">
            Type a URL above to browse, e.g. <code className="mx-1">localhost:3000</code> to preview a dev server.
          </div>
        ) : HAS_WEBVIEW ? (
          // allowpopups must be on the element before it attaches; setting it later is ignored.
          <webview ref={ref as any} src={url} allowpopups={'true' as any} style={{ width: '100%', height: '100%' }} />
        ) : (
          <iframe ref={ref as any} src={url} title="Browser" className="h-full w-full border-0 bg-white" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" />
        )}
      </div>
    </div>
  );
}
