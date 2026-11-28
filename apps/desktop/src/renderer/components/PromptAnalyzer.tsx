import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ContextItem, SpecDocStatus, WorkspaceFolder } from '@nekko-agent/shared';
import { detectFolderMentions, draftSuggestions, type MentionProject } from '../promptAnalysis.js';
import { CATEGORY } from '../tokens.js';
import { FolderIcon, WandIcon } from '../icons.js';

/** A single piece of context a mentioned project drags in. */
type RefKind = 'guideline' | 'spec' | 'file' | 'code';
interface ContextRef {
  kind: RefKind;
  label: string;
  /** Optional secondary text (e.g. a filename). */
  sub?: string;
}
const REF_META: Record<RefKind, { color: string; label: string }> = {
  guideline: { color: CATEGORY.guideline, label: 'Guideline' },
  spec: { color: CATEGORY.spec, label: 'Spec' },
  file: { color: CATEGORY.file, label: 'File' },
  code: { color: CATEGORY.index, label: 'Code index' },
};

function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}
function normPath(p: string): string {
  return p.toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
}
function isUnder(origin: string, wsPath: string): boolean {
  if (!origin || !wsPath) return false;
  const o = normPath(origin);
  const w = normPath(wsPath);
  return o === w || o.startsWith(w + '/');
}
/** Filenames that read as spec-driven artifacts (spec.md, tasks.md, design.md…). */
function isSpecName(name: string): boolean {
  return /^(spec|tasks|requirements|design|plan|roadmap|prd)\b/i.test(name) || /\.spec\.md$/i.test(name);
}

export function PromptAnalyzer({
  text,
  sessionId,
  workspaces = [],
  contextItems = [],
  activeWorkspaceIds = [],
  onFill,
}: {
  text: string;
  sessionId?: string;
  workspaces?: WorkspaceFolder[];
  /** Items currently assembled into this chat's context (from the bundle). */
  contextItems?: ContextItem[];
  /** Workspace ids grounding this chat (primary + supporting). */
  activeWorkspaceIds?: string[];
  /** Append an editable suggestion; never send the draft. */
  onFill?: (snippet: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [specDocs, setSpecDocs] = useState<Record<string, SpecDocStatus[]>>({});
  const { suggestions, warnings } = useMemo(() => draftSuggestions(text), [text]);

  const projects = useMemo<MentionProject[]>(
    () => workspaces.map((w) => ({ id: w.id, name: w.name, base: baseName(w.path) })),
    [workspaces],
  );
  const mentions = useMemo(() => detectFolderMentions(text, projects), [text, projects]);

  // Mentioned known projects, in first-seen order.
  const mentionedIds = useMemo(() => {
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const m of mentions) if (m.workspaceId && !seen.has(m.workspaceId)) { seen.add(m.workspaceId); ids.push(m.workspaceId); }
    return ids;
  }, [mentions]);
  const mentionKey = mentionedIds.join(',');

  // Mentioned folders that aren't a known project (highlighted, but no context map).
  const looseFolders = useMemo(() => {
    const seen = new Set<string>();
    const arr: string[] = [];
    for (const m of mentions) if (!m.workspaceId) { const k = m.text.toLowerCase(); if (!seen.has(k)) { seen.add(k); arr.push(m.text); } }
    return arr;
  }, [mentions]);

  // Pull the spec-driven artifacts for each mentioned project from disk, so the
  // "specs that will be referenced" list is accurate even when they aren't in
  // the always-on context. Refetches only when the mentioned set changes.
  useEffect(() => {
    if (!sessionId || mentionedIds.length === 0) { setSpecDocs({}); return; }
    let live = true;
    Promise.all(
      mentionedIds.map((id) =>
        window.nekko.readSpecDocs(sessionId, id)
          .then((r) => [id, r.docs.filter((d) => d.exists)] as const)
          .catch(() => [id, [] as SpecDocStatus[]] as const),
      ),
    ).then((entries) => { if (live) setSpecDocs(Object.fromEntries(entries)); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, mentionKey]);

  // For each mentioned project: is it grounding the chat, and what context does it drag in?
  const refsByProject = useMemo(() => {
    const map: Record<string, { folder: WorkspaceFolder; active: boolean; refs: ContextRef[] }> = {};
    for (const id of mentionedIds) {
      const w = workspaces.find((x) => x.id === id);
      if (!w) continue;
      const active = activeWorkspaceIds.includes(id);
      const under = contextItems.filter((it) => isUnder(it.origin, w.path));
      const refs: ContextRef[] = [];
      for (const it of under.filter((x) => x.source === 'guideline')) refs.push({ kind: 'guideline', label: it.label });
      for (const d of specDocs[id] ?? []) refs.push({ kind: 'spec', label: d.label, sub: d.filename });
      for (const it of under.filter((x) => x.source === 'attached-file' && isSpecName(baseName(x.origin)))) {
        if (!refs.some((r) => r.kind === 'spec' && r.label === it.label)) refs.push({ kind: 'spec', label: it.label });
      }
      for (const it of under.filter((x) => x.source === 'attached-file' && !isSpecName(baseName(x.origin)))) refs.push({ kind: 'file', label: it.label });
      const codeCount = under.filter((x) => x.source === 'index-snippet').length;
      if (codeCount > 0) refs.push({ kind: 'code', label: `${codeCount} code snippet${codeCount === 1 ? '' : 's'}` });
      map[id] = { folder: w, active, refs };
    }
    return map;
  }, [mentionedIds, workspaces, activeWorkspaceIds, contextItems, specDocs]);

  const active = text.trim().length >= 12;
  const refCount = mentionedIds.length + looseFolders.length;

  const details = (
    <div className="space-y-2 p-3 text-xs">
      {/* What this prompt will reference — mentioned projects + their context. */}
      {refCount > 0 && (
        <div className="space-y-1">
          <p className="flex items-center gap-2 text-xs font-medium text-ink-soft">
            <FolderIcon className="h-3 w-3" /> Will reference
          </p>
          {mentionedIds.map((id) => {
            const entry = refsByProject[id];
            if (!entry) return null;
            return (
              <div key={id} className="rounded-lg border border-line p-2" style={{ background: 'var(--surface-2)' }}>
                <div className="flex items-center gap-2">
                  <span
                    className="inline-flex items-center gap-1 rounded-sm px-2 py-0.5 text-2xs font-medium"
                    style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
                  >
                    <FolderIcon className="h-3 w-3" />{baseName(entry.folder.path) || entry.folder.name}
                  </span>
                  {!entry.active && <span className="chip text-2xs" title="Mentioned, but not added to this chat yet">not in chat</span>}
                </div>
                {entry.active ? (
                  entry.refs.length > 0 ? (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {entry.refs.map((r, i) => (
                        <span
                          key={i}
                          className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-2xs text-ink-soft"
                          title={REF_META[r.kind].label}
                        >
                          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: REF_META[r.kind].color }} />
                          {r.label}{r.sub ? <span className="text-ink-faint"> · {r.sub}</span> : null}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-1 text-2xs text-ink-faint">Grounding this chat. No guideline or spec files detected yet.</p>
                  )
                ) : (
                  <p className="mt-1 text-2xs text-ink-faint">Add this folder to the chat to ground it in its code, guidelines, and specs.</p>
                )}
              </div>
            );
          })}
          {looseFolders.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 text-2xs text-ink-faint">
              <span>Folders:</span>
              {looseFolders.map((f, i) => (
                <span key={i} className="rounded-sm px-1 py-0.5 font-mono text-2xs" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>{f}</span>
              ))}
            </div>
          )}
        </div>
      )}
  
      {warnings.length > 0 && (
        <ul className="space-y-1" aria-label="Privacy reminders">
          {warnings.map((message) => <li key={message} className="text-ink">{message}</li>)}
        </ul>
      )}
      {suggestions.length > 0 ? (
        <ul className="space-y-1">
          {suggestions.map(({ label, description, snippet }) => (
            <li key={label}>
              <button type="button" className="w-full rounded-lg border border-line px-3 py-2 text-left hover:bg-surface-2" onClick={() => {
                setOpen(false);
                onFill?.(snippet);
              }}>
                <span className="block font-medium text-ink">{label}</span>
                <span className="block text-ink-soft">{description}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : <p className="text-ink-soft">No suggested additions for this draft.</p>}
    </div>
  );

  // The composer clips its overflow; portaling keeps the popover outside it.
  const chipRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null);
  useLayoutEffect(() => {
    if (!open || !active) { setAnchor(null); return; }
    const place = () => {
      const r = chipRef.current?.getBoundingClientRect();
      if (r) setAnchor({ left: Math.max(8, Math.min(r.right - 360, window.innerWidth - 368)), bottom: window.innerHeight - r.top + 6 });
    };
    place();
    const down = (e: MouseEvent) => { if (!chipRef.current?.contains(e.target as Node) && !popRef.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); chipRef.current?.focus(); } };
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    window.addEventListener('mousedown', down);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('mousedown', down);
      window.removeEventListener('keydown', key);
    };
  }, [open, active]);
  useEffect(() => { if (!active) setOpen(false); }, [active]);
  const panelVisible = open && anchor !== null;
  useLayoutEffect(() => { if (panelVisible) popRef.current?.focus(); }, [panelVisible]);

  if (!active) return null;
  return (
    <>
      <button
        ref={chipRef}
        type="button"
        data-prompt-suggestions
        className={`composer-suggestions-chip ${open ? 'is-open' : ''}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Suggestions"
        onClick={() => setOpen((o) => !o)}
      >
        <WandIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="composer-suggestions-label">Suggestions</span>
      </button>
      {open && anchor && createPortal(
        <div ref={popRef} tabIndex={-1} role="dialog" aria-label="Prompt suggestions" className="card fixed z-[100] w-[360px] max-w-[calc(100vw-16px)] overflow-y-auto outline-hidden shadow-(--shadow-float)" style={{ left: anchor.left, bottom: anchor.bottom, maxHeight: `min(60vh, max(0px, calc(100vh - ${anchor.bottom + 8}px)))`, background: 'var(--paper)' }}>
          <div className="border-b border-line px-3 py-2 text-xs">
            <p className="font-medium text-ink">Improve your draft</p>
            <p className="text-ink-soft">Pick an optional addition, then edit it before sending.</p>
          </div>
          {details}
        </div>,
        document.body,
      )}
    </>
  );
}
