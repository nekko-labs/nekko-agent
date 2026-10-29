import React from 'react';
import type { ConnectivityNotice } from '@nekko-agent/shared';

/** Persisted and live (including incognito) notices share ids; never duplicate them. */
export function mergeConnectivityNotices(...groups: (readonly ConnectivityNotice[] | undefined)[]): ConnectivityNotice[] {
  const notices = new Map<string, ConnectivityNotice>();
  for (const group of groups) {
    for (const notice of group ?? []) {
      if (notice?.id && Number.isFinite(notice.createdAt) && Math.abs(notice.createdAt) <= 8.64e15 && typeof notice.content === 'string') notices.set(notice.id, notice);
    }
  }
  return [...notices.values()].sort((a, b) => a.createdAt - b.createdAt).slice(-100);
}

export function ConnectivityNotices({ notices }: { notices: readonly ConnectivityNotice[] }) {
  if (!notices.length) return null;
  return <details className="rounded-lg border border-line px-3 py-2 text-[12px] text-ink-soft" open>
    <summary className="cursor-pointer font-medium">Internet connectivity</summary>
    <ol aria-label="Internet connectivity notices" className="mt-2 space-y-2" aria-live="polite" aria-relevant="additions">
      {notices.map((notice) => <li key={notice.id} className="flex flex-wrap gap-x-2 gap-y-0.5">
        <time className="shrink-0 text-[11px] tabular-nums text-ink-faint" dateTime={new Date(notice.createdAt).toISOString()} title={new Date(notice.createdAt).toLocaleString()}>
          {new Date(notice.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </time>
        <span className="min-w-0 flex-1 basis-48 break-words">{notice.content}</span>
      </li>)}
    </ol>
  </details>;
}

// Ephemeral only, including incognito. Keep notices when a pane is unmounted;
// bounded independently of the transcript cache and never written by the UI.
const liveNotices = new Map<string, ConnectivityNotice[]>();
export function rememberConnectivityNotice(sessionId: string, notice: ConnectivityNotice): void {
  liveNotices.set(sessionId, mergeConnectivityNotices(liveNotices.get(sessionId), [notice]));
  if (liveNotices.size > 50) liveNotices.delete(liveNotices.keys().next().value!);
}
export function rememberedConnectivityNotices(sessionId: string): ConnectivityNotice[] {
  return liveNotices.get(sessionId) ?? [];
}
