import React, { useEffect, useState } from 'react';
import { SettingsSection } from './SettingsSection.js';

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
    <SettingsSection title="Chat history" help="Completed chats are kept until you delete them. Nothing is automatically deleted." data-history-settings>
      <p className="mt-(--q-inline) text-xs text-ink-soft">{usage ? `${historyStorageLabel(usage.bytes)} of local chat history · ${usage.count} completed chats` : 'Measuring local chat history…'}</p>
      {usage && <HistoryStorageNotice bytes={usage.bytes} openSync={openSync} />}
      <label htmlFor="history-range" className="mt-(--q-group) block text-sm font-medium">Clear completed chat history</label>
      <p id="history-range-hint" className="mt-(--q-tight) text-xs text-ink-faint">Active and running chats are kept. This removes local conversations and their command logs, not project files or settings.</p>
      <details className="mt-(--q-tight) text-xs text-ink-faint">
        <summary className="w-fit cursor-pointer transition-colors duration-(--dur-fast) hover:text-ink">How ranges count</summary>
        <p className="mt-(--q-tight)">Based on last activity. Today starts at local midnight; month ranges use calendar months.</p>
      </details>
      <div className="mt-(--q-inline) flex flex-wrap items-center gap-2">
        <select id="history-range" className="quiet-field min-w-0 max-w-full py-1.5" aria-describedby="history-range-hint" value={range} disabled={busy || confirming} onChange={e => { setRange(e.target.value as HistoryRange); setResult(''); }}>
          {HISTORY_RANGES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
        </select>
        <button type="button" className="btn btn-ghost py-1 text-xs text-danger-text" disabled={busy || confirming || !usage || usage.count === 0} onClick={() => { setResult(''); setConfirming(true); }} data-history-clear>Clear history…</button>
        <button type="button" className="btn btn-ghost py-1 text-xs" disabled={busy || confirming} onClick={() => void load()}>Refresh storage</button>
      </div>
      {confirming && (
        <div role="alertdialog" aria-labelledby="history-confirm-title" aria-describedby="history-confirm-hint" className="mt-(--q-inline) rounded-xl p-4" style={{ background: 'var(--danger-soft)' }}>
          <h3 id="history-confirm-title" className="text-sm font-semibold">Delete completed chats: {HISTORY_RANGES.find(r => r.value === range)?.label}?</h3>
          <p id="history-confirm-hint" className="mt-(--q-tight) text-xs text-ink-soft">These local conversations and command logs will be permanently deleted. This cannot be undone.</p>
          <div className="mt-(--q-inline) flex flex-wrap gap-2">
            <button type="button" className="btn btn-ghost py-1 text-xs" disabled={busy} onClick={() => setConfirming(false)} autoFocus data-history-cancel>Cancel</button>
            <button type="button" className="btn btn-ghost py-1 text-xs text-danger-text" disabled={busy} onClick={() => void clear()} data-history-confirm>{busy ? 'Deleting…' : 'Delete permanently'}</button>
          </div>
        </div>
      )}
      {result && <p role="status" className="mt-(--q-inline) text-xs text-ink-soft">{result}</p>}
      {error && <p role="alert" className="mt-(--q-inline) text-xs text-danger-text">{error}</p>}
    </SettingsSection>
  );
}

export function HistoryStorageNotice({ bytes, openSync }: { bytes: number; openSync: () => void }) {
  return bytes >= HISTORY_WARNING_BYTES ? (
        <div role="status" className="mt-(--q-inline) text-xs" data-history-warning>
          <p className="font-medium text-warning-text">Your chat history uses 1 GB or more.</p>
          <p className="mt-(--q-tight) text-ink-soft">Clear old completed chats below, or explore Nekko Cloud sync to keep a synced copy. Sync does not automatically free local space.</p>
          <button type="button" className="btn btn-ghost mt-(--q-inline) py-1 text-xs" onClick={openSync} data-history-sync>Open Nekko Cloud sync</button>
        </div>
  ) : null;
}
