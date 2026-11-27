import React, { useCallback, useEffect, useState } from 'react';
import type { CloudStatus, IdlePreview, KeptReason, RunnerImage, StorageCategory, StorageCategoryId, StorageUsage } from '@nekko-agent/shared';
import { StorageAuditButton } from './StorageAudit.js';
import { SettingsSection } from './SettingsSection.js';
import { HistorySettings } from './HistorySettings.js';
import { thisComputerName } from './ComputerChip.js';
import { useStore } from '../store.js';
import { formatBytes } from './storageFormat.js';

export { formatBytes } from './storageFormat.js';

/** Each category's colour in the bar: series tokens, then lighter mixes of them. */
const COLOUR: Record<StorageCategoryId, string> = {
  worktrees: 'var(--accent)',
  runners: 'var(--accent-2)',
  models: 'var(--info)',
  caches: 'color-mix(in srgb, var(--info) 55%, var(--paper))',
  history: 'color-mix(in srgb, var(--accent-2) 50%, var(--paper))',
  other: 'color-mix(in srgb, var(--accent) 35%, var(--paper))',
};
const OTHER_APPS = 'color-mix(in srgb, var(--neutral) 45%, var(--paper))';
const HATCH = 'repeating-linear-gradient(135deg, var(--surface-2) 0 6px, color-mix(in srgb, var(--neutral) 30%, var(--paper)) 6px 9px)';

const KEPT_TEXT: Record<KeptReason, string> = {
  recent: 'used in the last 3 days',
  dirty: 'with uncommitted changes',
  unpushed: 'with commits on no remote',
  running: 'open in a running chat',
  locked: 'locked',
  open: 'open in another program',
  ignored: "with ignored files that aren't build output",
};

const folderName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const toast = (kind: 'success' | 'error', message: string) => useStore.getState().pushToast(kind, message);
const errorText = (e: unknown) => String((e as Error)?.message ?? e);

function ago(ms: number): string {
  const m = Math.round((Date.now() - ms) / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${plural(m, 'minute')} ago` : `${plural(Math.round(m / 60), 'hour')} ago`;
}

type Segment = { key: string; bytes: number | null; colour: string; label?: string };

function Bar({ total, segments, label }: { total: number; segments: Segment[]; label: string }) {
  return (
    <div data-storage-bar role="img" aria-label={label} className="my-(--q-inline) flex h-5 overflow-hidden rounded-md" style={{ background: 'var(--surface-2)' }}>
      {segments.map((s) => (
        <span key={s.key} className="h-full transition-[width] duration-(--dur-slow) ease-(--ease-out)" style={{ width: `${total > 0 ? ((s.bytes ?? 0) / total) * 100 : 0}%`, minWidth: s.bytes ? 2 : 0, background: s.bytes === null ? HATCH : s.colour, boxShadow: 'inset 2px 0 0 var(--paper)' }} />
      ))}
    </div>
  );
}

function Legend({ items }: { items: { colour: string; text: string }[] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-soft">
      {items.map((i) => <span key={i.text}><i aria-hidden className="mr-1.5 inline-block size-2 rounded-[2px] align-[1px]" style={{ background: i.colour, boxShadow: 'inset 0 0 0 1px var(--line)' }} />{i.text}</span>)}
    </div>
  );
}

function Confirm({ title, hint, children, actions }: { title: string; hint: string; children?: React.ReactNode; actions: React.ReactNode }) {
  return (
    <div role="alertdialog" aria-label={title} className="mt-(--q-inline) rounded-xl p-4" style={{ background: 'var(--danger-soft)' }}>
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-(--q-tight) text-xs text-ink-faint">{hint}</p>
      {children}
      <div className="mt-3 flex flex-wrap gap-2">{actions}</div>
    </div>
  );
}

function StorageRow({ id, title, detail, bytes, children }: { id: StorageCategoryId; title: string; detail: React.ReactNode; bytes: number | null; children?: React.ReactNode }) {
  return (
    <div data-storage-row={id} className="quiet-row flex min-h-(--q-row) flex-wrap items-center gap-x-4 gap-y-2 py-(--q-inline)">
      <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: bytes === null ? HATCH : COLOUR[id] }} />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{title}</div>
        <div className="mt-(--q-tight) text-xs text-ink-faint">{bytes === null ? 'Measuring…' : detail}</div>
      </div>
      <span className="shrink-0 font-mono text-xs text-ink-soft">{bytes === null ? '–' : formatBytes(bytes)}</span>
      <span className="flex shrink-0 flex-wrap justify-end gap-2">{children}</span>
    </div>
  );
}

function IdleWorktrees({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [preview, setPreview] = useState<IdlePreview | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    window.nekko.previewIdleWorktrees()
      .then((p) => { setPreview(p); setPicked(new Set(p.idle.map((w) => w.root))); })
      .catch((e) => setError(errorText(e)));
  }, []);
  if (error) return <p role="alert" className="mt-(--q-inline) text-xs text-danger-text">{error}</p>;
  if (!preview) return <p className="mt-(--q-inline) text-xs text-ink-faint">Checking which worktrees are idle…</p>;
  const size = (roots: Iterable<string>) => [...roots].reduce((n, r) => n + (preview.idle.find((w) => w.root === r)?.bytes ?? 0), 0);
  const kept = Object.entries(preview.kept).filter(([, n]) => n) as [KeptReason, number][];
  const keptTotal = kept.reduce((n, [, k]) => n + k, 0);
  const keptLine = kept.map(([k, n]) => `${n} ${KEPT_TEXT[k]}`).join(' · ');
  const remove = async () => {
    setBusy(true);
    try {
      const r = await window.nekko.removeWorktrees(preview.idle.filter((w) => picked.has(w.root)).map((w) => w.root));
      const failed = r.failed.length ? ` ${plural(r.failed.length, "worktree")} couldn't be removed: ${r.failed.map((f) => `${folderName(f.root)} (${f.error})`).join('; ')}` : '';
      toast(r.failed.length ? 'error' : 'success', `Removed ${plural(r.removed.length, 'worktree')}, freed ${formatBytes(r.freed)}.${failed}`);
      onDone();
    } catch (e) { setError(errorText(e)); setBusy(false); }
  };
  if (preview.idle.length === 0) {
    return <p className="mt-(--q-inline) text-xs text-ink-faint">No idle worktrees right now.{keptLine && ` Kept: ${keptLine}.`} <button type="button" className="btn btn-ghost py-1 text-xs" onClick={onCancel}>Close</button></p>;
  }
  return (
    <Confirm
      title={`Remove ${plural(preview.idle.length, 'idle worktree')}? Frees about ${formatBytes(size(preview.idle.map((w) => w.root)))}.`}
      hint="Each is clean, unused for 3 days and fully pushed. Branches are kept, so you can check any of them out again."
      actions={<>
        <button type="button" className="btn btn-ghost py-1 text-xs" autoFocus disabled={busy} onClick={onCancel}>Cancel</button>
        <button type="button" className="btn btn-ghost py-1 text-xs text-danger-text" disabled={busy || picked.size === 0} onClick={() => void remove()}>{busy ? 'Removing…' : `Remove ${plural(picked.size, 'worktree')}`}</button>
      </>}
    >
      <div className="mt-(--q-inline) flex flex-wrap items-center gap-2">
        <span className="text-xs text-ink-faint">{picked.size} of {preview.idle.length} selected · {formatBytes(size(picked))}</span>
        <span className="ml-auto flex gap-1">
          <button type="button" className="btn btn-ghost py-1 text-xs" onClick={() => setPicked(new Set(preview.idle.map((w) => w.root)))}>Select all</button>
          <button type="button" className="btn btn-ghost py-1 text-xs" onClick={() => setPicked(new Set())}>Deselect all</button>
        </span>
      </div>
      <div className="mt-(--q-inline) max-h-[220px] overflow-auto">
        {preview.idle.map((w) => (
          <label key={w.root} className="grid grid-cols-[16px_1fr_auto] items-start gap-x-2 py-(--q-inline) text-sm" title={w.root}>
            <input type="checkbox" className="mt-[3px] accent-(--accent)" data-worktree={w.root} checked={picked.has(w.root)} onChange={() => setPicked((p) => { const n = new Set(p); if (n.has(w.root)) n.delete(w.root); else n.add(w.root); return n; })} />
            <span className="min-w-0">
              <span className="block truncate">{folderName(w.root)}</span>
              <span className="block truncate text-xs text-ink-faint">{[w.projectName, w.branch ?? `detached at ${w.head.slice(0, 7)}`, w.reason === 'merged' ? 'PR merged' : 'pushed'].filter(Boolean).join(' · ')}</span>
            </span>
            <span className="font-mono text-xs text-ink-soft">{w.bytes === null ? '–' : formatBytes(w.bytes)}</span>
          </label>
        ))}
      </div>
      {keptTotal > 0 && (
        <details className="mt-(--q-inline) text-xs text-ink-faint">
          <summary className="w-fit cursor-pointer">{keptTotal} kept</summary>
          <p className="mt-(--q-tight)">{keptLine}</p>
        </details>
      )}
    </Confirm>
  );
}

const IMAGE_TITLE: Record<RunnerImage['kind'], string> = {
  macos: 'macOS image', linux: 'Linux image', cache: 'Download cache', unfinished: 'Unfinished image build', previous: 'Previous Linux image', other: '',
};

function RunnerImages({ images, onRemoved }: { images: RunnerImage[]; onRemoved: () => void }) {
  const [asking, setAsking] = useState<RunnerImage | null>(null);
  const [busy, setBusy] = useState(false);
  const remove = async (i: RunnerImage) => {
    setBusy(true);
    try {
      const { freed } = await window.nekko.removeRunnerImage(i.name);
      toast('success', `Removed ${i.name}, freed ${formatBytes(freed)}.`);
      setAsking(null);
      onRemoved();
    } catch (e) { toast('error', errorText(e)); } finally { setBusy(false); }
  };
  return (
    <div className="pl-6">
      {images.map((i) => (
        <div key={i.name} data-runner-image={i.name}>
          <div className="quiet-row flex min-h-(--q-row) items-center gap-4 py-(--q-inline)">
            <div className="min-w-0 flex-1">
              <div className={`truncate text-sm font-medium ${i.kind === 'other' ? 'font-mono' : ''}`}>{IMAGE_TITLE[i.kind] || i.name}</div>
              <div className="mt-(--q-tight) text-xs text-ink-faint">{i.inUse ? 'In use' : `Not used by any runner · ${new Date(i.modifiedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`}</div>
            </div>
            <span className="font-mono text-xs text-ink-soft">{formatBytes(i.bytes)}</span>
            {!i.inUse && <button type="button" className="btn btn-ghost py-1 text-xs text-danger-text" disabled={busy} onClick={() => setAsking(i)}>Remove…</button>}
          </div>
          {asking?.name === i.name && (
            <Confirm title={`Remove ${i.name}? Frees ${formatBytes(i.bytes)}.`} hint="No runner uses it. This can't be undone." actions={<>
              <button type="button" className="btn btn-ghost py-1 text-xs" autoFocus disabled={busy} onClick={() => setAsking(null)}>Cancel</button>
              <button type="button" className="btn btn-ghost py-1 text-xs text-danger-text" disabled={busy} onClick={() => void remove(i)}>Remove permanently</button>
            </>} />
          )}
        </div>
      ))}
    </div>
  );
}

const PLAN_LABEL: Record<string, string> = { pro: 'Pro', team: 'Enterprise' };
const fmt = (n: number) => formatBytes(n, true);

function CloudStorage({ status, goTo, openView }: { status: CloudStatus | null; goTo: (g: string) => void; openView: (v: 'artifacts') => void }) {
  const usage = status?.signedIn ? status.sync.usage : null;
  const links = <>
    <button type="button" className="btn btn-ghost py-1 text-xs text-(--accent)" onClick={() => openView('artifacts')}>Library</button>
    <button type="button" className="btn btn-ghost py-1 text-xs text-(--accent)" onClick={() => goTo('cloud')}>Sync settings</button>
  </>;
  if (!usage || usage.limit <= 0) {
    return (
      <section data-storage-cloud className="mt-(--q-group)">
        <h3 className="text-base font-semibold">Nekko Cloud</h3>
        <p className="mt-(--q-tight) text-xs text-ink-faint">Nekko Cloud keeps a synced, encrypted copy of your chats and Library on Pro and Enterprise. <button type="button" className="btn btn-ghost py-1 text-xs text-(--accent)" onClick={() => goTo('cloud')}>Nekko Cloud settings</button></p>
      </section>
    );
  }
  const p = usage.parts;
  const used = usage.bytes + (p?.shares ?? 0);
  const full = used / usage.limit >= 0.9;
  const segs: Segment[] = p
    ? [{ key: 'chats', bytes: p.chats, colour: COLOUR.worktrees, label: 'Synced chats' }, { key: 'library', bytes: p.library, colour: COLOUR.models, label: 'Library files' }, { key: 'revisions', bytes: p.revisions, colour: COLOUR.runners, label: 'Kept revisions' }, { key: 'shares', bytes: p.shares, colour: COLOUR.caches, label: 'Shares' }]
    : [{ key: 'used', bytes: used, colour: COLOUR.worktrees, label: 'Used' }];
  const shown = full ? segs.map((s, i) => ({ ...s, colour: `color-mix(in srgb, var(--warning) ${100 - i * 25}%, var(--paper))` })) : segs;
  return (
    <section data-storage-cloud className="mt-(--q-group)">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-base font-semibold">Nekko Cloud</h3>
        <span className={`font-mono text-xs ${full ? 'text-warning-text' : 'text-ink-soft'}`}>{fmt(used)} of {fmt(usage.limit)} · {PLAN_LABEL[status?.account?.plan ?? ''] ?? status?.account?.plan}</span>
      </div>
      <Bar total={usage.limit} segments={shown} label={`Nekko Cloud: ${fmt(used)} used of ${fmt(usage.limit)}`} />
      <Legend items={[...shown.map((s) => ({ colour: s.colour, text: `${s.label} ${fmt(s.bytes ?? 0)}` })), { colour: 'var(--surface-2)', text: `Free ${fmt(Math.max(0, usage.limit - used))}` }]} />
      {full && <p className="mt-(--q-inline) text-xs text-warning-text">Almost full. New and changed files stop syncing at {fmt(usage.limit)}.</p>}
      <p className="mt-(--q-inline) text-xs text-ink-faint">Synced copies are extra; your files stay on {thisComputerName().replace(/^This/, 'this')}. {links}</p>
    </section>
  );
}

type Open = 'worktrees' | 'runners' | 'caches' | 'history' | null;

/** Settings → Storage: where Nekko's disk goes here and in Nekko Cloud, and the cleanup that is safe for each. */
export function StorageSettings({ goTo, openView, refreshSessions }: { goTo: (group: string) => void; openView: (view: 'models' | 'artifacts') => void; refreshSessions: () => Promise<void> }) {
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [images, setImages] = useState<RunnerImage[]>([]);
  const [cloud, setCloud] = useState<CloudStatus | null>(null);
  const [open, setOpen] = useState<Open>(null);
  const [error, setError] = useState('');
  const load = useCallback(async (refresh = false) => {
    try { setUsage(await window.nekko.getStorageUsage(refresh)); setError(''); } catch (e) { setError(`Could not measure storage: ${errorText(e)}`); }
    window.nekko.listRunnerImages().then(setImages).catch(() => setImages([]));
  }, []);
  useEffect(() => {
    void load();
    window.nekko.cloudStatus().then(setCloud).catch(() => setCloud(null));
  }, [load]);
  // While measuring, read the last result every 2 s until it settles.
  useEffect(() => {
    if (!usage?.measuring) return;
    const t = window.setTimeout(() => void load(), 2000);
    return () => window.clearTimeout(t);
  }, [usage, load]);
  const done = () => { setOpen(null); void load(true); };
  const toggle = (o: Open) => setOpen((cur) => (cur === o ? null : o));
  const clearCaches = async () => {
    try { await window.nekko.clearAppCaches!(); toast('success', 'Caches cleared.'); done(); } catch (e) { toast('error', errorText(e)); }
  };

  const cat = (id: StorageCategoryId): StorageCategory => usage?.categories.find((c) => c.id === id) ?? { id, bytes: null };
  const leftovers = images.filter((i) => !i.inUse);
  const leftoverBytes = leftovers.reduce((n, i) => n + i.bytes, 0);
  const canClear = typeof window.nekko.clearAppCaches === 'function';
  const rows = (['worktrees', 'runners', 'models', 'history', 'caches', 'other'] as const)
    .map(cat)
    .filter((c) => !(c.id === 'runners' && !c.bytes && images.length === 0) && !(c.id === 'caches' && !canClear))
    .sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1));
  // A models folder on another disk isn't this disk's space.
  const here = (c: StorageCategory) => Math.max(0, (c.bytes ?? 0) - (c.detail?.elsewhereBytes ?? 0));
  const nekko = rows.reduce((n, c) => n + here(c), 0);
  const disk = usage?.disk;
  const otherApps = disk ? Math.max(0, disk.total - disk.free - nekko) : 0;

  const render = (c: StorageCategory) => {
    const b = c.bytes;
    switch (c.id) {
      case 'worktrees': return (
        <React.Fragment key="worktrees">
          <StorageRow id="worktrees" title="Agent worktrees" bytes={b} detail={`${c.detail?.count ?? 0} checkouts · ${formatBytes(c.detail?.buildOutputBytes ?? 0)} of it is build output (node_modules, target)`}>
            <button type="button" className="btn py-1 text-xs" disabled={b === null || open === 'worktrees'} onClick={() => toggle('worktrees')}>Remove idle worktrees…</button>
            <button type="button" className="btn btn-ghost py-1 text-xs" onClick={() => goTo('tools')}>See all</button>
          </StorageRow>
          {open === 'worktrees' && <IdleWorktrees onDone={done} onCancel={() => setOpen(null)} />}
        </React.Fragment>
      );
      case 'runners': return (
        <React.Fragment key="runners">
          <StorageRow id="runners" title="CI runner images" bytes={b} detail={leftovers.length ? `${leftovers.length} unused old image runner${leftovers.length === 1 ? '' : 's'} · ${formatBytes(leftoverBytes)}` : 'Images your CI runners use'}>
            {images.length > 0 && <button type="button" className="btn py-1 text-xs" onClick={() => toggle('runners')}>{open === 'runners' ? 'Hide images' : 'Review images…'}</button>}
          </StorageRow>
          {open === 'runners' && <RunnerImages images={images} onRemoved={done} />}
        </React.Fragment>
      );
      case 'models': return (
        <StorageRow key="models" id="models" title="Models" bytes={b} detail={`Models and their runtimes · removed one at a time${c.detail?.elsewhereBytes ? ` · ${formatBytes(c.detail.elsewhereBytes)} on another disk` : ''}`}>
          <button type="button" className="btn btn-ghost py-1 text-xs" onClick={() => openView('models')}>Open Models</button>
        </StorageRow>
      );
      case 'caches': return (
        <React.Fragment key="caches">
          <StorageRow id="caches" title="App caches" bytes={b} detail="Browser caches the app rebuilds as it goes">
            <button type="button" className="btn py-1 text-xs" disabled={!b || open === 'caches'} onClick={() => toggle('caches')}>Clear caches…</button>
          </StorageRow>
          {open === 'caches' && b !== null && (
            <Confirm title={`Clear ${formatBytes(b)} of caches?`} hint="You stay signed in; chats and settings are kept. The app may be slower to open screens for a moment, and the caches grow back as you use it." actions={<>
              <button type="button" className="btn btn-ghost py-1 text-xs" autoFocus onClick={() => setOpen(null)}>Cancel</button>
              <button type="button" className="btn btn-ghost py-1 text-xs text-danger-text" onClick={() => void clearCaches()}>Clear caches</button>
            </>} />
          )}
        </React.Fragment>
      );
      case 'history': return (
        <React.Fragment key="history">
          <StorageRow id="history" title="Chat history" bytes={b} detail={`${formatBytes(c.detail?.picturesBytes ?? 0)} of pictures`}>
            <button type="button" className="btn py-1 text-xs" onClick={() => toggle('history')}>{open === 'history' ? 'Hide' : 'Clear history…'}</button>
          </StorageRow>
          {open === 'history' && <HistorySettings openSync={() => goTo('cloud')} refreshSessions={async () => { await refreshSessions(); void load(true); }} />}
        </React.Fragment>
      );
      default: return <StorageRow key="other" id="other" title="Other Nekko data" bytes={b} detail="Settings, logs, backups, usage" />;
    }
  };

  return (
    <SettingsSection id="storage" title={thisComputerName()} help="Where Nekko's disk space goes, and cleanup that never touches models, Library files, prompts or commits." data-storage
      meta={disk ? <span className="font-mono text-xs text-ink-soft">{formatBytes(disk.free)} free of {formatBytes(disk.total)}</span> : undefined}>
      <div className="mt-(--q-tight) flex flex-wrap items-center gap-2 text-xs text-ink-soft"><StorageAuditButton /> Start a read-only chat about these measurements.</div>
      <p className="mt-(--q-tight) text-xs text-ink-faint">
        {usage?.measuring ? 'Measuring…' : usage?.measuredAt ? `Measured ${ago(usage.measuredAt)}` : 'Not measured yet'}
        {' · '}<button type="button" className="btn btn-ghost py-1 text-xs text-(--accent)" disabled={usage?.measuring} onClick={() => void load(true)}>Measure again</button>
      </p>
      {disk && (
        <>
          <Bar total={disk.total} label={`Disk: Nekko ${formatBytes(nekko)}, other apps and files ${formatBytes(otherApps)}, ${formatBytes(disk.free)} free`}
            segments={[...rows.map((c) => ({ key: c.id, bytes: c.bytes === null ? null : here(c), colour: COLOUR[c.id] })), { key: 'apps', bytes: otherApps, colour: OTHER_APPS }]} />
          <Legend items={[{ colour: COLOUR.worktrees, text: `Nekko ${formatBytes(nekko)}` }, { colour: OTHER_APPS, text: `Other apps and files ${formatBytes(otherApps)}` }, { colour: 'var(--surface-2)', text: `Free ${formatBytes(disk.free)}` }]} />
        </>
      )}
      <div className="-mx-3 mt-(--q-group)">{rows.map(render)}</div>
      {error && <p role="alert" className="mt-(--q-inline) text-xs text-danger-text">{error}</p>}
      <div className="mt-(--q-section) border-t border-(--line) pt-(--q-group)">
        <CloudStorage status={cloud} goTo={goTo} openView={openView} />
      </div>
    </SettingsSection>
  );
}
