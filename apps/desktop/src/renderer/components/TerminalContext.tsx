import React, { useEffect, useRef, useState } from 'react';
import type { PrInfo, TerminalInfo } from '@nekko-agent/shared';
import { TerminalIcon } from '../icons.js';
import { TerminalViewersBadge } from './TerminalViewersBadge.js';
import { terminalPresentation, terminalPrUrl } from './terminalActivity.js';

/** A read-only companion to the terminal. No automatic network fetches or approvals. */
export function TerminalContext({ terminal }: { terminal: TerminalInfo }) {
  const p = terminalPresentation(terminal);
  const url = terminalPrUrl(terminal);
  const [pr, setPr] = useState<PrInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const request = useRef(0);
  useEffect(() => { request.current++; setPr(null); setLoading(false); setError(false); return () => { request.current++; }; }, [url]);
  const refresh = async () => {
    if (!url || loading) return;
    const token = ++request.current;
    setLoading(true); setError(false);
    try {
      const result = await window.nekko.getPrInfo(url);
      if (request.current === token) { setPr(result); setError(!result); }
    } catch { if (request.current === token) { setPr(null); setError(true); } }
    finally { if (request.current === token) setLoading(false); }
  };
  return <div data-terminal-context className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-2 text-2xs">
    <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 font-medium" title="Title reported by the terminal"><TerminalIcon className="h-3 w-3 shrink-0" /><span className="truncate">{p.title}</span></span>
    <span style={{ color: p.tone }}>{p.status}</span>
    {p.detail && <span className="max-w-[36ch] truncate text-ink-soft" title={p.detail}>{p.detail}</span>}
    <span className="min-w-0 max-w-[36ch] truncate font-mono text-ink-faint" title={p.cwd}>{p.cwd}</span>
    <TerminalViewersBadge terminalId={terminal.id} initial={terminal.viewers} />
    {url && <span className="ml-auto inline-flex items-center gap-2">
      <button type="button" className="text-accent hover:underline" title={pr?.title ?? 'Link observed in terminal output; status not verified'} onClick={() => void window.nekko.openPath(url).catch(() => {})}>PR #{url.split('/').pop()}</button>
      <span className="text-ink-faint" title={pr ? 'Last fetched status; refresh to check again' : undefined}>{loading ? 'Checking…' : error ? 'Status unavailable' : pr ? `${pr.isDraft ? 'Draft · ' : ''}${pr.state} · checks ${pr.checks}` : 'Observed link'}</span>
      <button type="button" className="btn btn-ghost px-1 py-0 text-2xs" disabled={loading} aria-label="Refresh pull request status" onClick={() => void refresh()}>Refresh</button>
    </span>}
  </div>;
}
