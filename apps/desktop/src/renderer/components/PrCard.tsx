import React, { useEffect, useMemo, useState } from 'react';
import type { PrInfo, PrAction, PrDiff, PrChecks } from '@nekko-agent/shared';
import { getExecutionMode, parsePrUrl } from '@nekko-agent/shared';
import { useStore } from '../store.js';
import { useShown } from '../simpleMode.js';
import { subscribePrPolling } from '../prPolling.js';
import { PrProgress } from './WorkProgress.js';
import { BranchIcon, CheckIcon, CloseIcon } from '../icons.js';
import { isPrCreation, type PrRowEvent } from './agent-console/transcript.js';

/**
 * What each PR milestone says and its colour. Requested and queued merges are
 * worded as requests and keep the accent colour: only `merged` may read as a
 * completed merge, with the merged wash.
 */
export const PR_EVENT_LABEL: Record<PrRowEvent, { label: string; color: string }> = {
  created: { label: 'PR created', color: 'var(--success)' },
  open: { label: 'PR created', color: 'var(--success)' },
  'created-draft': { label: 'Draft PR created', color: 'var(--ink-soft)' },
  draft: { label: 'Moved back to draft', color: 'var(--ink-soft)' },
  ready: { label: 'Marked ready for review', color: 'var(--accent)' },
  'merge-requested': { label: 'Merge requested', color: 'var(--accent)' },
  'auto-merge': { label: 'Auto-merge enabled', color: 'var(--accent)' },
  'merge-queued': { label: 'Added to merge queue', color: 'var(--accent)' },
  merged: { label: 'PR merged', color: 'var(--merged-ink)' },
  closed: { label: 'PR closed', color: 'var(--danger)' },
  reopened: { label: 'PR reopened', color: 'var(--success)' },
};

/** Live PR polling: when a session has an open PR, keep its status fresh. */
function usePrPolling(sessionId: string | undefined) {
  useEffect(() => {
    if (!sessionId) return;
    return subscribePrPolling(sessionId, () => useStore.getState().refreshSessionPrs(sessionId));
  }, [sessionId]);
}

/** Summarise a chat's PRs for the sidebar/header badges. */
export function prSummary(prs: PrInfo[]) {
  const open = prs.filter((p) => p.state === 'open');
  const merged = prs.filter((p) => p.state === 'merged').length;
  const closed = prs.filter((p) => p.state === 'closed').length;
  const ready = open.some((p) => p.reviewDecision === 'APPROVED' && p.checks !== 'failing');
  return { open: open.length, merged, closed, ready, total: prs.length };
}

const CHECK_META: Record<PrChecks, { label: string; color: string; dot: string }> = {
  passing: { label: 'checks passing', color: 'var(--success)', dot: '✓' },
  failing: { label: 'checks failing', color: 'var(--danger)', dot: '✕' },
  pending: { label: 'checks running', color: 'var(--warning)', dot: '●' },
  none: { label: '', color: '', dot: '' },
};

const openExternally = (url: string) => window.nekko.openPath(url).catch(() => {});

/** Static autumn confetti stays decorative and never competes with the milestone text. */
function AutumnConfetti() {
  return <span aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
    {['🍂', '🎃', '🍁', '🍂', '🎃', '🍁'].map((symbol, i) => (
      <span key={i} className="absolute" style={{ left: (8 + i * 16) + '%', top: i % 2 ? '58%' : '8%', fontSize: 12, opacity: 0.28, transform: 'rotate(' + (i % 2 ? -18 : 18) + 'deg)' }}>{symbol}</span>
    ))}
  </span>;
}

/**
 * The merged banner's wash and border. Theme tokens rather than fixed colours:
 * a light violet that reads on dark paper vanishes on light paper (styles.css,
 * --merged-*).
 */
export const MERGED_CARD_STYLE: React.CSSProperties = {
  borderColor: 'var(--merged-line)',
  background: 'linear-gradient(270deg, var(--merged-wash), var(--merged-wash-soft) 70%, transparent)',
};

/**
 * One PR as it appears in the transcript. The merged and closed cards stay as
 * historical milestones (anchored to the message that observed them). When the
 * PR is live (event is "created" and the poller reports it still open), the
 * card expands into the live surface the chat offers for working with it: its
 * Draft/Open state, CI progress and the actions (Approve, Decline, Merge,
 * Review) that used to sit as a strip below the composer.
 */
export function PrCard({ url, info, event = 'created', sessionId }: { url: string; info?: PrInfo; event?: PrRowEvent; sessionId?: string }) {
  const spooky = useStore((s) => s.settings?.themePreset === 'autumn');
  // Hidden in Settings > Simple mode, an open PR stays a plain milestone in the chat.
  const showStatus = useShown('pr-status', { pr: true });
  const parsed = parsePrUrl(url);
  const label = info ? info.owner + '/' + info.repo + '#' + info.number : parsed ? parsed.owner + '/' + parsed.repo + '#' + parsed.number : url;
  // The created card goes live only when the poller still reports it open:
  // merged/closed events keep their own historical rows a few lines down, so
  // "created" must stay as a static milestone once resolved.
  if (showStatus && isPrCreation(event) && info?.state === 'open' && sessionId) {
    return <OpenPrCard url={url} info={info} sessionId={sessionId} label={label} />;
  }
  const merged = event === 'merged';
  const milestone = PR_EVENT_LABEL[event];
  // Creation and the final states are cards; the steps between are one quiet line.
  const step = !isPrCreation(event) && event !== 'merged' && event !== 'closed';
  return (
    <div className={'relative overflow-hidden rounded-xl border ' + (step ? 'my-1 px-3 py-1.5' : 'my-2 px-4 py-3')} data-pr-event={event}
      style={merged ? MERGED_CARD_STYLE : { borderColor: 'var(--line)', background: step ? 'transparent' : 'var(--surface)' }}>
      {merged && spooky && <AutumnConfetti />}
      <div className="relative flex flex-wrap items-center gap-x-2 gap-y-1">
        <a href={url} className="min-w-0 truncate font-mono text-xs font-medium hover:underline" onClick={(e) => { e.preventDefault(); openExternally(url); }}>{label}</a>
        {info?.title && <span className="min-w-0 flex-1 truncate text-xs text-ink-soft">{info.title}</span>}
        <span className="ml-auto shrink-0 whitespace-nowrap text-xs font-semibold" style={{ color: milestone.color }}>{milestone.label}</span>
      </div>
    </div>
  );
}

/** The live card for an open PR: status, progress and the actions chats used to carry below the composer. */
function OpenPrCard({ url, info, sessionId, label }: { url: string; info: PrInfo; sessionId: string; label: string }) {
  usePrPolling(sessionId);
  const openPrPane = useStore((s) => s.openPrPane);
  const session = useStore((s) => s.sessions.find((item) => item.id === sessionId));
  const parent = session?.gitStackParent;
  const canStack = !!session && !session.offline && !session.incognito && !session.archivedAt && getExecutionMode(session) !== 'sandbox' && session.chatType !== 'image';
  const linkable = canStack && !!parent && parent.url !== url && !info?.stack;
  const [busy, setBusy] = useState<PrAction | 'continue' | 'stack' | null>(null);
  const [confirm, setConfirm] = useState<PrAction | null>(null);
  const act = async (action: PrAction) => {
    if (action === 'merge' && info?.stack) { openExternally(url); return; }
    if (confirm !== action) { setConfirm(action); return; }
    setConfirm(null);
    setBusy(action);
    try { await runPrAction(sessionId, url, action); } finally { setBusy(null); }
  };
  const stackAction = async (action: 'continue' | 'stack') => {
    setBusy(action); setConfirm(null);
    try {
      if (action === 'continue') await useStore.getState().continuePrStack(sessionId, url);
      else {
        const result = await window.nekko.linkPrStack(sessionId, url);
        useStore.getState().pushToast(result.ok ? 'success' : 'error', result.message);
        await useStore.getState().refreshSessionPrs(sessionId, result.ok);
      }
    } catch (error) { useStore.getState().pushToast('error', (error as Error).message); }
    finally { setBusy(null); }
  };
  const check = CHECK_META[info.checks];
  const actionClass = 'rounded-md px-2 py-0.5 text-2xs font-medium hover:bg-surface-2 disabled:opacity-50';
  return (
    <div className="relative my-2 rounded-xl border border-line px-3 py-2" data-pr-event="open" data-pr-actions={url} style={{ background: 'var(--surface)' }}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <a href={url} className="min-w-0 truncate font-mono text-xs font-medium hover:underline" onClick={(e) => { e.preventDefault(); openExternally(url); }}>{label}</a>
        {info.title && <span className="min-w-0 flex-1 truncate text-xs text-ink-soft">{info.title}</span>}
        <span className="ml-auto text-2xs font-semibold" style={{ color: info.isDraft ? 'var(--ink-faint)' : 'var(--accent)' }}>
          {info.isDraft ? 'Draft' : 'Open'}
        </span>
        {!info.checkProgress && check.dot && <span className="text-2xs" style={{ color: check.color }}>{check.dot} {check.label}</span>}
      </div>
      <PrProgress url={url} info={info} checks />
      {info.stack && <p className="mt-1 text-2xs text-ink-soft">GitHub stack · {info.stack.size} PRs</p>}
      {parent && <a className="mt-1 block truncate text-2xs text-ink-soft hover:underline" href={parent.url} onClick={(e) => { e.preventDefault(); openExternally(parent.url); }}>Builds on {parent.branch}</a>}
      <div className="mt-1.5 flex flex-wrap items-center justify-end gap-0" data-pr-action-controls>
        {(['approve', 'close', 'merge'] as const).map((action) => (
          <button key={action} className={actionClass} disabled={!!busy} onClick={() => void act(action)}
            title={action === 'close' ? 'Close this PR without merging' : action === 'approve' ? 'Approve this PR' : info.stack ? 'Review all included layers and merge on GitHub' : 'Merge this PR'}>
            {busy === action ? 'Working…' : confirm === action ? 'Confirm?' : action === 'approve' ? 'Approve' : action === 'close' ? 'Decline' : info.stack ? 'Merge on GitHub' : 'Merge'}
          </button>
        ))}
        <button className={actionClass} onClick={() => openPrPane(url)}>Review</button>
        {canStack && <button className={actionClass} disabled={!!busy} onClick={() => void stackAction('continue')} title="Start a separate chat worktree from this PR's committed code">{busy === 'continue' ? 'Preparing…' : 'Continue as stacked PR'}</button>}
        {linkable && <button className={actionClass} disabled={!!busy} onClick={() => void stackAction('stack')} title="Link this dependent PR to its parent on GitHub">{busy === 'stack' ? 'Linking…' : 'Link stack'}</button>}
        <button className={actionClass} onClick={() => openExternally(url)} aria-label="Open on GitHub">↗</button>
        {confirm && <button className={actionClass} onClick={() => setConfirm(null)}>Cancel</button>}
      </div>
    </div>
  );
}

/** Runs a PR action for a chat, toasts the result and refreshes the chat's PRs. Shared with "Nekko, ship it". */
export async function runPrAction(sessionId: string, url: string, action: PrAction): Promise<void> {
  try {
    const res = await window.nekko.prAction(url, action);
    useStore.getState().pushToast(res.ok ? 'success' : 'error', res.message);
    if (res.pr) {
      useStore.setState((s) => ({ prsBySession: { ...s.prsBySession, [sessionId]: [...(s.prsBySession[sessionId] ?? []).filter((p) => p.url !== url), res.pr!] } }));
    }
    await useStore.getState().refreshSessionPrs(sessionId);
  } catch (e) {
    useStore.getState().pushToast('error', (e as Error).message);
  }
}

/** One line of a unified-diff hunk. */
function patchLines(patch: string) {
  return patch.split('\n').map((line, i) => {
    let color: string | undefined;
    let bg: string | undefined;
    if (line.startsWith('@@')) color = 'var(--accent)';
    else if (line.startsWith('+')) { color = 'var(--success)'; bg = 'color-mix(in srgb, var(--success) 10%, transparent)'; }
    else if (line.startsWith('-')) { color = 'var(--danger)'; bg = 'color-mix(in srgb, var(--danger) 10%, transparent)'; }
    return (
      <div key={i} className="flex" style={{ background: bg }}>
        <span className="whitespace-pre-wrap wrap-break-word px-3" style={{ color: color ?? 'var(--ink-soft)' }}>{line || ' '}</span>
      </div>
    );
  });
}

/** The PR diff, shown as a workbench side pane (read-only, Devin-style). */
export function PrPane({ url }: { url: string }) {
  const [diff, setDiff] = useState<PrDiff | null>(null);
  const [loaded, setLoaded] = useState(false);
  const parsed = parsePrUrl(url);
  const label = parsed ? `${parsed.owner}/${parsed.repo}#${parsed.number}` : url;

  useEffect(() => {
    setLoaded(false);
    window.nekko.getPrDiff(url).then((d) => { setDiff(d); setLoaded(true); }).catch(() => setLoaded(true));
  }, [url]);

  const totals = useMemo(() => {
    const files = diff?.files ?? [];
    return {
      files: files.length,
      adds: files.reduce((n, f) => n + f.additions, 0),
      dels: files.reduce((n, f) => n + f.deletions, 0),
    };
  }, [diff]);

  return (
    <div className="flex h-full flex-col overflow-hidden" style={{ background: 'var(--paper)' }}>
      <div className="flex items-center gap-2 border-b border-line px-3 py-1 text-xs">
        <span className="shrink-0 text-green-400">⑂</span>
        <span className="truncate font-semibold">{label}</span>
        {loaded && (
          <span className="shrink-0 text-2xs">
            <span className="text-green-500">+{totals.adds}</span> <span className="text-red-400">-{totals.dels}</span> · {totals.files} file{totals.files === 1 ? '' : 's'}
          </span>
        )}
        <button className="ml-auto shrink-0 text-2xs text-ink-faint hover:text-ink" onClick={() => openExternally(url)}>Open on GitHub ↗</button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {!loaded ? (
          <p className="p-4 text-xs text-ink-faint">Loading diff…</p>
        ) : !diff || diff.files.length === 0 ? (
          <div className="grid h-full place-items-center px-6 text-center text-sm text-ink-faint">
            Couldn't load the diff. The PR may be private, or gh/GitHub isn't reachable — open it on GitHub instead.
          </div>
        ) : (
          <>
            {diff.files.map((f) => <PrFileDiff key={f.path} file={f} />)}
            {diff.truncated && <p className="p-3 text-2xs text-ink-faint">Diff truncated (large PR). Open on GitHub for the full change.</p>}
          </>
        )}
      </div>
    </div>
  );
}

function PrFileDiff({ file }: { file: PrDiff['files'][number] }) {
  const [open, setOpen] = useState(true);
  const name = file.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || file.path;
  return (
    <div className="border-b border-line">
      <button className="sticky top-0 z-10 flex w-full items-center gap-2 px-3 py-1 text-left text-xs" style={{ background: 'var(--surface-2)' }} onClick={() => setOpen((o) => !o)}>
        <span className="w-2 text-2xs text-ink-faint">{open ? '▾' : '▸'}</span>
        <span className="truncate font-medium" title={file.path}>{name}</span>
        {file.status !== 'modified' && <span className="chip text-2xs uppercase">{file.status}</span>}
        <span className="ml-auto shrink-0 text-2xs"><span className="text-green-500">+{file.additions}</span> <span className="text-red-400">-{file.deletions}</span></span>
      </button>
      {open && (
        file.patch ? (
          <div className="font-mono text-xs leading-relaxed">{patchLines(file.patch)}</div>
        ) : (
          <p className="px-3 py-2 text-2xs text-ink-faint">No inline patch (binary or too large).</p>
        )
      )}
    </div>
  );
}

/** Compact PR status badge for chat rows and the chat header. */
export function PrBadge({ prs, compact = false }: { prs: PrInfo[]; compact?: boolean }) {
  if (!prs.length) return null;
  const { open, merged, closed, ready } = prSummary(prs);
  if (compact) {
    const label = `${merged} merged, ${open} open, ${closed} closed PRs`;
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-2xs tabular-nums text-ink-faint" aria-label={label} title={label}>
        <BranchIcon className="h-3 w-3" />
        {merged > 0 && <span className="inline-flex items-center gap-0.5" style={{ color: 'var(--success)' }}>{merged}<CheckIcon className="h-3 w-3" /></span>}
        {open > 0 && <span className="inline-flex items-center gap-0.5" style={{ color: 'var(--warning)' }}>{open}<svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg></span>}
        {closed > 0 && <span className="inline-flex items-center gap-0.5">{closed}<CloseIcon className="h-3 w-3" /></span>}
      </span>
    );
  }
  const chips: React.ReactNode[] = [];
  if (open > 0) {
    chips.push(
      <span
        key="open"
        className="shrink-0 rounded-sm px-1 py-px text-2xs font-medium leading-normal"
        style={ready ? { background: 'rgba(46,160,67,0.18)', color: '#3fb950' } : { background: 'var(--accent-soft)', color: 'var(--accent)' }}
        title={ready ? 'PR ready to merge' : `${open} open PR${open === 1 ? '' : 's'}`}
      >
        {ready ? 'PR ready' : `⑂ ${open}`}
      </span>,
    );
  }
  if (merged > 0 && (!compact || open === 0)) {
    chips.push(
      <span key="merged" className="shrink-0 rounded-sm px-1 py-px text-2xs font-medium leading-normal" style={{ background: 'var(--merged-chip)', color: 'var(--merged-ink)' }} title={`${merged} merged PR${merged === 1 ? '' : 's'}`}>
        ✓ {merged}
      </span>,
    );
  }
  if (!chips.length) return null;
  return <span className="flex shrink-0 items-center gap-1">{compact ? chips.slice(0, 1) : chips}</span>;
}
