import React, { useEffect, useMemo, useState } from 'react';
import type { FileChange } from '@nekko-agent/shared';
import { FileTypeIcon } from '../fileIcons.js';

/**
 * Diff & approval view (Devin-style). Lists every file the agent changed this
 * session and lets you accept (keep) or revert at three granularities:
 *   • per line, tick lines to revert, then "Revert selected"
 *   • per file, Keep or Revert file
 *   • all files, Keep all / Revert all
 * Diffs are computed client-side (LCS) against the original snapshot the host
 * took before the agent's first edit. Reverting writes the merged content back.
 */

type Op = { type: 'eq' | 'add' | 'del'; text: string };

/** Line-level LCS diff between original and current. */
function diffLines(a: string[], b: string[]): Op[] {
  const n = a.length, m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops: Op[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ type: 'eq', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ type: 'del', text: a[i] }); i++; }
    else { ops.push({ type: 'add', text: b[j] }); j++; }
  }
  while (i < n) ops.push({ type: 'del', text: a[i++] });
  while (j < m) ops.push({ type: 'add', text: b[j++] });
  return ops;
}

export function DiffPane({ sessionId }: { sessionId: string }) {
  const [changes, setChanges] = useState<FileChange[]>([]);
  const [loaded, setLoaded] = useState(false);

  const reload = () => window.nekko.listChanges(sessionId).then((c) => { setChanges(c); setLoaded(true); }).catch(() => setLoaded(true));

  useEffect(() => {
    reload();
    const off = window.nekko.onChangesUpdated((e) => { if (e.sessionId === sessionId) reload(); });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const keepAll = async () => { await window.nekko.acceptAllChanges(sessionId); reload(); };
  const revertAll = async () => {
    await Promise.all(changes.map((c) => window.nekko.writeFile(c.path, c.original)));
    await window.nekko.acceptAllChanges(sessionId);
    reload();
  };

  return (
    <div className="flex h-full flex-col overflow-hidden" style={{ background: 'var(--paper)' }}>
      <div className="flex items-center gap-2 border-b border-line px-3 py-1 text-xs">
        <span className="font-semibold">Changes</span>
        <span className="chip text-2xs">{changes.length} file{changes.length === 1 ? '' : 's'}</span>
        {changes.length > 0 && (
          <span className="ml-auto flex items-center gap-1">
            <button className="btn btn-ghost px-2 py-0.5 text-2xs" onClick={keepAll} title="Keep every change">Keep all</button>
            <button className="btn btn-ghost px-2 py-0.5 text-2xs text-red-400" onClick={revertAll} title="Revert every file to its original">Revert all</button>
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {!loaded ? (
          <p className="p-4 text-xs text-ink-faint">Loading…</p>
        ) : changes.length === 0 ? (
          <div className="grid h-full place-items-center px-6 text-center text-sm text-ink-faint">
            No pending changes. Files the agent edits this chat show up here to review.
          </div>
        ) : (
          changes.map((c) => <FileDiff key={c.path} sessionId={sessionId} change={c} onChanged={reload} />)
        )}
      </div>
    </div>
  );
}

function FileDiff({ sessionId, change, onChanged }: { sessionId: string; change: FileChange; onChanged: () => void }) {
  const [open, setOpen] = useState(true);
  const [revert, setRevert] = useState<Set<number>>(new Set());
  const name = change.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || change.path;

  const ops = useMemo(() => {
    const a = change.original.length ? change.original.split('\n') : [];
    const b = change.current.length ? change.current.split('\n') : [];
    if (a.length + b.length > 6000) return null; // too large to diff inline
    return diffLines(a, b);
  }, [change.original, change.current]);

  const adds = ops ? ops.filter((o) => o.type === 'add').length : 0;
  const dels = ops ? ops.filter((o) => o.type === 'del').length : 0;

  const toggle = (i: number) => setRevert((s) => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n; });

  /** Build content applying the selected per-line reverts. */
  const mergedAfterRevert = (): string => {
    if (!ops) return change.current;
    const out: string[] = [];
    ops.forEach((op, i) => {
      const reverted = revert.has(i);
      if (op.type === 'eq') out.push(op.text);
      else if (op.type === 'add') { if (!reverted) out.push(op.text); } // reverted add → drop
      else { if (reverted) out.push(op.text); } // reverted del → restore
    });
    return out.join('\n');
  };

  const keepFile = async () => { await window.nekko.acceptChange(sessionId, change.path); onChanged(); };
  const revertFile = async () => {
    await window.nekko.writeFile(change.path, change.original);
    await window.nekko.acceptChange(sessionId, change.path);
    onChanged();
  };
  const revertSelected = async () => {
    await window.nekko.writeFile(change.path, mergedAfterRevert());
    setRevert(new Set());
    onChanged();
  };

  return (
    <div className="border-b border-line">
      <div className="sticky top-0 z-10 flex items-center gap-2 px-3 py-1 text-xs" style={{ background: 'var(--surface-2)' }}>
        <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setOpen((o) => !o)}>
          <span className="w-2 text-2xs text-ink-faint">{open ? '▾' : '▸'}</span>
          <FileTypeIcon name={name} size={14} />
          <span className="truncate font-medium">{name}</span>
          {change.original === '' && <span className="chip text-2xs uppercase">new</span>}
          <span className="ml-1 shrink-0 text-2xs">
            <span className="text-green-500">+{adds}</span> <span className="text-red-400">-{dels}</span>
          </span>
        </button>
        <span className="flex shrink-0 items-center gap-1">
          {revert.size > 0 && (
            <button className="btn btn-ghost px-2 py-0.5 text-2xs text-accent" onClick={revertSelected}>
              Revert {revert.size} line{revert.size === 1 ? '' : 's'}
            </button>
          )}
          <button className="btn btn-ghost px-2 py-0.5 text-2xs" onClick={keepFile} title="Keep this file's changes">Keep</button>
          <button className="btn btn-ghost px-2 py-0.5 text-2xs text-red-400" onClick={revertFile} title="Revert this file to its original">Revert file</button>
        </span>
      </div>

      {open && (
        ops === null ? (
          <p className="px-3 py-2 text-2xs text-ink-faint">File too large to diff inline. Use Keep or Revert file.</p>
        ) : (
          <div className="font-mono text-xs leading-relaxed">
            {ops.map((op, i) => {
              if (op.type === 'eq') {
                return (
                  <div key={i} className="flex">
                    <span className="w-5 shrink-0 select-none text-center text-ink-faint"> </span>
                    <span className="whitespace-pre-wrap wrap-break-word text-ink-soft">{op.text || ' '}</span>
                  </div>
                );
              }
              const reverted = revert.has(i);
              const add = op.type === 'add';
              return (
                <div
                  key={i}
                  onClick={() => toggle(i)}
                  className={`flex cursor-pointer ${reverted ? 'opacity-50' : ''}`}
                  style={{ background: add ? 'var(--success-soft)' : 'var(--danger-soft)' }}
                  title={reverted ? 'Will be reverted, click to keep' : 'Click to revert this line'}
                >
                  <span className="w-5 shrink-0 select-none text-center" style={{ color: add ? 'var(--success)' : 'var(--danger)' }}>
                    {add ? '+' : '-'}
                  </span>
                  <span className={`whitespace-pre-wrap wrap-break-word ${reverted ? 'line-through' : ''}`} style={{ color: add ? 'var(--success)' : 'var(--danger)' }}>
                    {op.text || ' '}
                  </span>
                </div>
              );
            })}
          </div>
        )
      )}
    </div>
  );
}
