import React, { useEffect, useState } from 'react';
import { formatBytes } from './storageFormat.js';

/** Under this much free, the notice shows; under `CRITICAL` it takes the warning colour and stays. */
const LOW = 20e9;
const CRITICAL = 5e9;
const SNOOZE_MS = 24 * 3_600_000;
const SNOOZE_DROP = 5e9;
const CHECK_MS = 5 * 60_000;
const KEY = 'nekko.lowDisk.dismissed';

type Dismissed = { at: number; free: number };

/** Fixed amounts, not a share: on a 2 TB disk 10% would warn at 200 GB free (spec: storage-settings). */
export function noticeState(free: number, dismissed: Dismissed | null, now: number): 'hidden' | 'low' | 'critical' {
  if (free >= LOW) return 'hidden';
  if (free < CRITICAL) return 'critical';
  const snoozed = dismissed && now - dismissed.at < SNOOZE_MS && free > dismissed.free - SNOOZE_DROP;
  return snoozed ? 'hidden' : 'low';
}

function readDismissed(): Dismissed | null {
  try { return JSON.parse(localStorage.getItem(KEY) ?? 'null') as Dismissed | null; } catch { return null; }
}

function writeDismissed(d: Dismissed | null) {
  try { if (d) localStorage.setItem(KEY, JSON.stringify(d)); else localStorage.removeItem(KEY); } catch { /* storage blocked: the notice just comes back */ }
}

/** A quiet band at the top of the window when the disk Nekko's data lives on runs low; links to Settings → Storage. */
export function LowDiskNotice({ openStorage }: { openStorage: () => void }) {
  const [free, setFree] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState<Dismissed | null>(readDismissed);
  useEffect(() => {
    let live = true;
    const check = () => window.nekko.getDiskSpace().then((d) => { if (live && d) setFree(d.free); }).catch(() => {});
    void check();
    const t = window.setInterval(check, CHECK_MS);
    return () => { live = false; window.clearInterval(t); };
  }, []);
  // Back above the line, a later dip asks again.
  useEffect(() => { if (free !== null && free >= LOW && dismissed) { writeDismissed(null); setDismissed(null); } }, [free, dismissed]);
  if (free === null) return null;
  const state = noticeState(free, dismissed, Date.now());
  if (state === 'hidden') return null;
  const critical = state === 'critical';
  return (
    <div role="status" data-low-disk={state} className={`fade-in flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-2 text-sm ${critical ? 'text-warning-text' : 'border-b border-(--line) text-ink-soft'}`} style={critical ? { background: 'var(--warning-soft)' } : undefined}>
      <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: critical ? 'var(--warning)' : 'var(--neutral)' }} />
      <span>{critical ? `Your disk is nearly out of space: ${formatBytes(free)} free. Builds and downloads may fail.` : `Your disk is almost full: ${formatBytes(free)} free.`}</span>
      <span className="ml-auto flex gap-2">
        <button type="button" className="btn btn-ghost py-1 text-xs text-(--accent)" onClick={openStorage}>See what's using it</button>
        {!critical && <button type="button" className="btn btn-ghost py-1 text-xs" onClick={() => { const d = { at: Date.now(), free }; writeDismissed(d); setDismissed(d); }}>Not now</button>}
      </span>
    </div>
  );
}
