import React, { useEffect, useMemo, useState } from 'react';
import type { PrInfo, PrAction, PrDiff, PrChecks } from '@nekko-agent/shared';
import { getExecutionMode, parsePrUrl } from '@nekko-agent/shared';
import { useStore } from '../store.js';
import { subscribePrPolling } from '../prPolling.js';
import { PrProgress } from './WorkProgress.js';
import { BranchIcon, CheckIcon, CloseIcon } from '../icons.js';

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

/** A historical milestone, never an action surface or a live status card. */
export function PrCard({ url, info, event = 'created' }: { url: string; info?: PrInfo; event?: 'created' | 'open' | 'closed' | 'merged' }) {
  const parsed = parsePrUrl(url);
  const label = info ? info.owner + '/' + info.repo + '#' + info.number : parsed ? parsed.owner + '/' + parsed.repo + '#' + parsed.number : url;
  const spooky = useStore((s) => s.settings?.themePreset === 'autumn');
  const merged = event === 'merged';
  return (
    <div className="relative my-2 overflow-hidden rounded-xl border px-4 py-3" data-pr-event={event}
      style={merged ? MERGED_CARD_STYLE : { borderColor: 'var(--line)', background: 'var(--surface)' }}>
      {merged && spooky && <AutumnConfetti />}
      <div className="relative flex flex-wrap items-center gap-x-2 gap-y-1">
        <a href={url} className="min-w-0 truncate font-mono text-xs font-medium hover:underline" onClick={(e) => { e.preventDefault(); openExternally(url); }}>{label}</a>
        {info?.title && <span className="min-w-0 flex-1 truncate text-xs text-ink-soft">{info.title}</span>}
        <span className="ml-auto text-xs font-semibold" style={{ color: merged ? 'var(--merged-ink)' : event === 'closed' ? 'var(--danger)' : 'var(--success)' }}>
          {merged ? 'PR merged' : event === 'closed' ? 'PR closed' : 'PR created'}
        </span>
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

/** Live actions stay above the composer and disappear when the PR is resolved. */
export function PrActionCard({ url, info, sessionId, onDismiss, checksInPlan = false }: { url: string; info?: PrInfo; sessionId: string; onDismiss: () => void; checksInPlan?: boolean }) {
  const parsed = parsePrUrl(url);
  const openPrPane = useStore((s) => s.openPrPane);
  const [busy, setBusy] = useState<PrAction | 'continue' | 'stack' | null>(null);
  const session = useStore((s) => s.sessions.find((item) => item.id === sessionId));
  const parent = session?.gitStackParent;
  const canStack = !!session && !session.offline && !session.incognito && !session.archivedAt && getExecutionMode(session) !== 'sandbox' && session.chatType !== 'image';
  const linkable = canStack && !!parent && parent.url !== url && !info?.stack;
  const [confirm, setConfirm] = useState<PrAction | null>(null);
  const label = parsed ? parsed.owner + '/' + parsed.repo + '#' + parsed.number : url;
  const act = async (action: PrAction) => {
    if (action === 'merge' && info?.stack) { openExternally(url); return; }
    if (confirm !== action) { setConfirm(action); return; }
    setConfirm(null);
    setBusy(action);
    try { await runPrAction(sessionId, url, action); } finally { setBusy(null); }
  };
  const check = info ? CHECK_META[info.checks] : CHECK_META.none;
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
  const actionClass = 'rounded-md px-2 py-0.5 text-2xs font-medium hover:bg-surface-2 disabled:opacity-50';
  return (
    <div className="pr-deck-card rounded-lg border border-line px-3 py-1" data-pr-actions={url}>
      <div className="pr-action-layout">
      <div className="pr-action-content min-w-0 flex-1">
        <div className="pr-action-heading flex flex-wrap items-center gap-x-2 gap-y-1">
          <a href={url} className="truncate font-mono text-2xs font-medium hover:underline" onClick={(e) => { e.preventDefault(); openExternally(url); }}>{label}</a>
          <span className="text-2xs text-ink-faint">{info ? info.isDraft ? 'Draft' : 'Open' : 'Status unavailable'}</span>
          {!info?.checkProgress && check.dot && <span className="text-2xs" style={{ color: check.color }}>{check.dot} {check.label}</span>}
        </div>
        {info?.title && <p className="truncate text-xs">{info.title}</p>}
        <PrProgress url={url} info={info} checks={!checksInPlan} />
        {info?.stack && <span className="text-2xs text-ink-soft">GitHub stack · {info.stack.size} PRs</span>}
        {parent && <a className="block truncate text-2xs text-ink-soft hover:underline" href={parent.url} onClick={(e) => { e.preventDefault(); openExternally(parent.url); }}>Builds on {parent.branch}</a>}
      </div>
      <div className="flex max-w-[55%] shrink-0 flex-wrap items-center justify-end gap-0" data-pr-action-controls>
        {(['approve', 'close', 'merge'] as const).map((action) => (
          <button key={action} className={actionClass} disabled={!!busy || !info} onClick={() => void act(action)}
            title={action === 'close' ? 'Close this PR without merging' : action === 'approve' ? 'Approve this PR' : info?.stack ? 'Review all included layers and merge on GitHub' : 'Merge this PR'}>
            {busy === action ? 'Working…' : confirm === action ? 'Confirm?' : action === 'approve' ? 'Approve' : action === 'close' ? 'Decline' : info?.stack ? 'Merge on GitHub' : 'Merge'}
          </button>
        ))}
        <button className={actionClass} onClick={() => openPrPane(url)}>Review</button>
        {canStack && info?.state === 'open' && <button className={actionClass} disabled={!!busy} onClick={() => void stackAction('continue')} title="Start a separate chat worktree from this PR's committed code">{busy === 'continue' ? 'Preparing…' : 'Continue as stacked PR'}</button>}
        {linkable && info?.state === 'open' && <button className={actionClass} disabled={!!busy} onClick={() => void stackAction('stack')} title="Link this dependent PR to its parent on GitHub">{busy === 'stack' ? 'Linking…' : 'Link stack'}</button>}
        <button className={actionClass} onClick={() => openExternally(url)} aria-label="Open on GitHub">↗</button>
        {confirm && <button className={actionClass} onClick={() => setConfirm(null)}>Cancel</button>}
      </div>
      <button className="pr-action-dismiss grid h-6 w-6 shrink-0 place-items-center rounded-md text-ink-faint hover:bg-surface-2 hover:text-ink"
        onClick={onDismiss} aria-label={'Hide PR ' + label} title="Hide this PR panel (does not close the PR)"><CloseIcon className="h-3.5 w-3.5" /></button>
      </div>
    </div>
  );
}

/**
 * Opens upward from the chat's footer divider: the toggle sits on the divider
 * and the cards stack above it. `floating` closes it into a standalone card
 * where there is no divider below (the wall composer).
 */
/** checksInPlan: the plan card above shows this PR's CI, so the card leaves it out. */
export function PrActionDock({ sessionId, prs, urls, floating = false, checksInPlan = false }: { sessionId: string; prs: PrInfo[]; urls: string[]; floating?: boolean; checksInPlan?: boolean }) {
  const storageKey = 'nekko.pr-dismissed.' + sessionId;
  const load = () => {
    try { const value = JSON.parse(localStorage.getItem(storageKey) ?? '[]'); return new Set<string>(Array.isArray(value) ? value.filter((x) => typeof x === 'string') : []); }
    catch { return new Set<string>(); }
  };
  const [dismissed, setDismissed] = useState(load);
  const byUrl = new Map(prs.map((p) => [p.url, p]));
  const tracked = [...new Set(urls)].filter((url) => !dismissed.has(url));
  const active = tracked.filter((url) => !byUrl.has(url) || byUrl.get(url)?.state === 'open');
  const statusKey = tracked.map((url) => url + ':' + (byUrl.get(url)?.state ?? 'unknown')).sort().join('|');
  const [expansion, setExpansion] = useState<{ key: string; value: boolean } | null>(null);
  // The plan card already shows these PRs and their CI, so the actions start tucked away.
  const expanded = expansion?.key === statusKey ? expansion.value : active.length > 0 && !checksInPlan;
  const [closing, setClosing] = useState<Set<string>>(() => new Set());
  useEffect(() => { setDismissed(load()); }, [storageKey]);
  useEffect(() => subscribePrPolling(sessionId, () => useStore.getState().refreshSessionPrs(sessionId)), [sessionId]);
  // Fallback for disabled animations, background tabs, or interrupted CSS motion.
  useEffect(() => {
    if (!closing.size) return;
    const timer = setTimeout(() => {
      setDismissed((previous) => {
        const next = new Set([...previous, ...closing]);
        try { localStorage.setItem(storageKey, JSON.stringify([...next])); } catch { /* memory-only dismissal */ }
        return next;
      });
      setClosing(new Set());
    }, 260);
    return () => clearTimeout(timer);
  }, [closing, storageKey]);
  if (!tracked.length) return null;
  const dismiss = (url: string) => {
    setClosing((previous) => new Set(previous).add(url));
  };
  const finishDismiss = (url: string) => {
    if (!closing.has(url)) return;
    setDismissed((previous) => {
      const next = new Set(previous).add(url);
      try { localStorage.setItem(storageKey, JSON.stringify([...next])); } catch { /* memory-only dismissal */ }
      return next;
    });
    setClosing((previous) => { const next = new Set(previous); next.delete(url); return next; });
  };
  return <section aria-label="Pending pull requests" className="pr-action-deck" data-expanded={expanded} data-floating={floating}>
    <div className="pr-deck-reveal" id={'pr-deck-' + sessionId} inert={!expanded}>
      <div className="pr-deck-clip"><div className="pr-deck-list">
        {active.map((url) => <div key={url} className="pr-deck-slot" data-closing={closing.has(url)} onTransitionEnd={(event) => { if (event.target === event.currentTarget && event.propertyName === 'opacity') finishDismiss(url); }}>
          <PrActionCard url={url} info={byUrl.get(url)} sessionId={sessionId} onDismiss={() => dismiss(url)} checksInPlan={checksInPlan} />
        </div>)}
      </div></div>
    </div>
    <button className="pr-deck-toggle" aria-expanded={expanded} aria-controls={'pr-deck-' + sessionId} onClick={() => setExpansion({ key: statusKey, value: !expanded })}>
      <BranchIcon className="h-3.5 w-3.5 shrink-0" />
      <span>{tracked.length} pull request{tracked.length === 1 ? '' : 's'}</span>
      <span className="ml-auto text-ink-faint">{active.length ? expanded ? 'Tuck away' : 'Show actions' : tracked.every((url) => byUrl.get(url)?.state === 'merged') ? 'Merged' : 'Resolved'}</span>
      <span aria-hidden className="pr-deck-chevron">⌃</span>
    </button>
  </section>;
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
