import React, { useEffect, useState } from 'react';
import type { RunnerImage, StorageUsage } from '@nekko-agent/shared';
import { useStore } from '../store.js';
import { initialChatBrain } from './ChatPane.settings.js';
import { formatBytes } from './storageFormat.js';

const WEEK = 7 * 24 * 3600_000;
const KEY = 'nekko.storageAudit.snoozedUntil';

/** Only measured aggregates leave the machine: no workspace roots, branches, or image names. */
export function auditPrompt(usage: StorageUsage, images: RunnerImage[] | null, reminder: boolean) {
  const size = (n: number | null) => n == null ? 'not measured' : formatBytes(n);
  const rows = usage.categories.map(c => `${c.id}: ${size(c.bytes)}`).join('; ');
  const unused = images?.filter(i => !i.inUse);
  return [
    'Audit my Nekko storage using only the measurements below. Explain what uses the most space and what I can safely review in Settings → Storage. Do not delete anything or give shell deletion commands.',
    usage.disk ? `Disk: ${size(usage.disk.free)} free of ${size(usage.disk.total)}.` : 'Disk capacity unavailable.',
    `Nekko categories${usage.measuring ? ' (measurement in progress; missing figures are unknown)' : ''}: ${rows}.`,
    unused && images ? `Nekko runner images: ${images.length - unused.length} protected; ${unused.length} unused (${size(unused.reduce((sum, i) => sum + i.bytes, 0))} reported).` : 'Runner image inventory unavailable.',
    reminder ? 'The last check found at least 15 merged worktrees unused for more than a week.' : '',
    'The Remove idle worktrees preview is broader than merged branches: pushed does not mean merged. Review selections before confirming. Keep protected images. Do not infer duplicates, external VM usage or exact reclaimable space from sizes alone.',
  ].filter(Boolean).join('\n');
}

let starting = false;
export function StorageAuditButton({ reminder = false, onStarted }: { reminder?: boolean; onStarted?: () => void }) {
  const [busy, setBusy] = useState(false);
  async function start() {
    if (starting) return;
    starting = true; setBusy(true);
    try {
      await useStore.getState().refreshProviders();
      const state = useStore.getState();
      const brain = initialChatBrain(null, state);
      const modelId = brain.modelId ?? state.models.find(m => m.providerId === brain.providerId)?.id;
      if (!brain.providerId || !modelId) { state.setView('models'); throw Error('Choose a chat model, then run the storage audit again.'); }
      if (state.providers.find(p => p.id === brain.providerId)?.kind === 'claude-code') { state.setView('models'); throw Error('Claude Code requires a workspace folder. Choose a different chat provider for a folderless storage audit.'); }
      const [usage, images] = await Promise.all([window.nekko.getStorageUsage(), window.nekko.listRunnerImages().catch(() => null)]);
      const text = auditPrompt(usage, images, reminder);
      const session = await window.nekko.createSession(); // Deliberately no current or supporting folder.
      if (!await window.nekko.setSessionOptions(session.id, { title: 'Storage audit', mode: 'ask', memory: 'off', guidance: 'off', orchestrate: false, autoProviderSwitch: false, toolApproach: 'list' }, { chatOnly: true })) throw Error('Could not configure the audit chat.');
      await state.refreshSessions();
      state.showNewChat(session.id);
      await window.nekko.sendChat({ sessionId: session.id, providerId: brain.providerId, modelId, text, noTools: true });
      onStarted?.();
    } catch (e) { useStore.getState().pushToast('error', e instanceof Error ? e.message : 'Could not start the storage audit.'); }
    finally { starting = false; setBusy(false); }
  }
  return <button type="button" className="btn py-1 text-xs" disabled={busy} onClick={() => void start()}>{busy ? 'Starting audit…' : 'Run storage audit'}</button>;
}

export function MergedWorktreeNotice() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    let live = true;
    const check = async () => {
      try { if (Number(localStorage.getItem(KEY)) > Date.now()) { if (live) setShow(false); return; } } catch { /* storage unavailable */ }
      try { const eligible = await window.nekko.hasOldMergedWorktrees(); if (live) setShow(eligible === true); } catch { /* a disconnected host cannot confirm eligibility */ }
    };
    void check();
    const t = window.setInterval(() => void check(), 24 * 3600_000);
    return () => { live = false; window.clearInterval(t); };
  }, []);
  const snooze = () => { setShow(false); try { localStorage.setItem(KEY, String(Date.now() + WEEK)); } catch { /* dismissed for this window */ } };
  if (!show) return null;
  return <div role="status" data-merged-reminder className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-(--line) px-5 py-2 text-sm text-ink-soft">
    <span>At least 15 merged worktrees haven’t been used in over a week. Review what you can clean up.</span>
    <span className="ml-auto flex gap-2"><StorageAuditButton reminder onStarted={snooze} /><button type="button" className="btn btn-ghost py-1 text-xs" onClick={snooze}>Not now</button></span>
  </div>;
}
