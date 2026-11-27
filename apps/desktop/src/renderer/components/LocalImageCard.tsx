import React from 'react';
import { localImageData, localImagePath } from '../localImages.js';
import { useStore } from '../store.js';
import { inDesignPlace } from '../artifactsIndex.js';
import { MarkdownSandbox, MarkdownSession } from './Markdown.js';
import { ChatImages } from '../remoteImages.js';

export function LocalImageCard({ src, title, basePath, sessionId: origin }: { src: string; title: string; basePath?: string; sessionId?: string }) {
  const sandbox = React.useContext(MarkdownSandbox);
  const chat = React.useContext(ChatImages);
  const session = React.useContext(MarkdownSession);
  const sessionId = origin ?? session;
  const target = localImagePath(src, basePath);
  const [preview, setPreview] = React.useState<{ target: string; data: string; error: string } | null>(null);
  React.useEffect(() => {
    if (sandbox || !target) return;
    let active = true;
    void window.nekko.readFile(target).then(file => {
      const data = localImageData(target, file);
      if (active) setPreview({ target, data: data ?? '', error: data ? '' : 'Preview unavailable' });
    }).catch(() => { if (active) setPreview({ target, data: '', error: 'Could not read image' }); });
    return () => { active = false; };
  }, [target, sandbox]);
  const current = !sandbox && preview?.target === target ? preview : null;
  const image = current?.data ? <img src={current.data} alt={title} referrerPolicy="no-referrer" draggable={false}
    className="block h-auto max-h-[640px] w-full object-contain" onError={() => setPreview({ target: current.target, data: '', error: 'Preview unavailable' })} /> : null;
  return <span className="artifact-card my-2 inline-flex w-full max-w-[768px] min-w-0 flex-col overflow-hidden rounded-xl border align-middle" aria-label={title}>
    {current?.data && chat ? <button type="button" className="block w-full cursor-zoom-in focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--ring)"
      title="Open the photo viewer" aria-label={`Open ${title} in photo viewer`}
      onClick={() => chat.open([{ src: current.data, alt: title }], 0)}>
      {image}
    </button> : image ?? <span className="p-4 text-xs text-ink-soft">{sandbox ? 'Host image previews are unavailable in Sandbox' : !target ? 'Preview unavailable' : current?.error || 'Loading image…'}</span>}
    <span className="flex min-w-0 items-center gap-3 px-3 py-2">
      <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-ink" style={{ color: 'var(--ink)' }}>{title}</span><span className="block truncate text-2xs text-ink-soft" style={{ color: 'var(--ink-soft)' }}>{src.split(/[\\/]/).pop()}</span></span>
      <button type="button" disabled={sandbox || !target} className="shrink-0 text-xs underline disabled:opacity-50" title={target ? `Open ${target}` : src}
        onClick={() => { if (!sandbox && target) useStore.getState().openFilePane(target, sessionId); }}>Open source ↗</button>
      {target && inDesignPlace(target) && <button type="button" disabled={sandbox} className="shrink-0 text-xs underline disabled:opacity-50" data-open-in-library
        title={`Open ${target} in Library, full screen`} onClick={() => { if (!sandbox) useStore.getState().openInLibrary(target, sessionId); }}>Open in Library</button>}
    </span>
  </span>;
}
