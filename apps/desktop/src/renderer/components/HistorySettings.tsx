import React, { useEffect, useState } from 'react';

export const HISTORY_WARNING_BYTES = 1_000_000_000;
export const HISTORY_RANGES = [
  { value: 'today', label: 'Today' },
  { value: 'last-week', label: 'Last week (past 7 days)' },
  { value: 'older-2-weeks', label: 'Older than 2 weeks' },
  { value: 'older-1-month', label: 'Older than 1 month' },
  { value: 'older-6-months', label: 'Older than 6 months' },
] as const;
type HistoryRange = typeof HISTORY_RANGES[number]['value'];

export function historyStorageLabel(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${Math.ceil(bytes / 1000)} KB`;
}

export function HistorySettings({ openSync, refreshSessions }: { openSync: () => void; refreshSessions: () => Promise<void> }) {
  const [usage, setUsage] = useState<{ bytes: number; count: number } | null>(null);
  const [range, setRange] = useState<HistoryRange>('older-1-month');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const load = async () => {
    try { setUsage(await window.nekko.getHistoryUsage()); setError(''); }
    catch (e) { setError(`Could not measure chat history: ${(e as Error).message}`); }
  };
  useEffect(() => { void load(); }, []);
  const clear = async () => {
    setBusy(true); setError(''); setResult('');
    try {
      const count = await window.nekko.clearHistory(range);
      setConfirming(false);
      setResult(`${count} completed chat${count === 1 ? '' : 's'} deleted.`);
      await Promise.all([load(), refreshSessions()]);
    } catch (e) { await Promise.allSettled([load(), refreshSessions()]); setError(`Could not clear chat history: ${(e as Error).message}. Some chats may already have been removed. Refresh before trying again.`); }
    finally { setBusy(false); }
  };
  return (
    <section className="card mt-5 p-5" data-history-settings>
      <h2 className="font-semibold">Chat history</h2>
      <p className="mt-1 text-xs text-ink-soft">Completed chats are kept until you delete them. Nothing is automatically deleted.</p>
      <p className="mt-2 text-xs text-ink-faint">{usage ? `${historyStorageLabel(usage.bytes)} of local chat history · ${usage.count} completed chats` : 'Measuring local chat history…'}</p>
      {usage && <HistoryStorageNotice bytes={usage.bytes} openSync={openSync} />}
      <label htmlFor="history-range" className="mt-4 block text-sm">Clear completed chat history</label>
      <p id="history-range-hint" className="mt-1 text-2xs text-ink-faint">Based on last activity. Today starts at local midnight; month ranges use calendar months. Active and running chats are kept. This removes local conversations and their command logs, not project files or settings.</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select id="history-range" className="input min-w-0 max-w-full py-1" aria-describedby="history-range-hint" value={range} disabled={busy || confirming} onChange={e => { setRange(e.target.value as HistoryRange); setResult(''); }}>
          {HISTORY_RANGES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
        </select>
        <button type="button" className="btn btn-outline text-xs text-(--danger)" disabled={busy || confirming || !usage || usage.count === 0} onClick={() => { setResult(''); setConfirming(true); }} data-history-clear>Clear history…</button>
        <button type="button" className="btn btn-outline text-xs" disabled={busy || confirming} onClick={() => void load()}>Refresh storage</button>
      </div>
      {confirming && (
        <div role="alertdialog" aria-labelledby="history-confirm-title" aria-describedby="history-confirm-hint" className="mt-3 rounded-lg border border-line p-3">
          <h3 id="history-confirm-title" className="text-sm font-semibold">Delete completed chats: {HISTORY_RANGES.find(r => r.value === range)?.label}?</h3>
          <p id="history-confirm-hint" className="mt-1 text-xs text-ink-soft">These local conversations and command logs will be permanently deleted. This cannot be undone.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className="btn btn-outline text-xs" disabled={busy} onClick={() => setConfirming(false)} autoFocus data-history-cancel>Cancel</button>
            <button type="button" className="btn btn-outline text-xs text-(--danger)" disabled={busy} onClick={() => void clear()} data-history-confirm>{busy ? 'Deleting…' : 'Delete permanently'}</button>
          </div>
        </div>
      )}
      {result && <p role="status" className="mt-2 text-xs text-ink-soft">{result}</p>}
      {error && <p role="alert" className="mt-2 text-xs text-(--danger)">{error}</p>}
    </section>
  );
}

export function HistoryStorageNotice({ bytes, openSync }: { bytes: number; openSync: () => void }) {
  return bytes >= HISTORY_WARNING_BYTES ? (
        <div role="status" className="mt-3 rounded-lg border p-3 text-xs" style={{ borderColor: 'var(--warning)', background: 'var(--surface-2)' }} data-history-warning>
          <p className="font-medium">Your chat history uses 1 GB or more.</p>
          <p className="mt-1 text-ink-soft">Clear old completed chats below, or explore Nekko Cloud sync to keep a synced copy. Sync does not automatically free local space.</p>
          <button type="button" className="btn btn-outline mt-2 text-xs" onClick={openSync} data-history-sync>Open Nekko Cloud sync</button>
        </div>
  ) : null;
}
