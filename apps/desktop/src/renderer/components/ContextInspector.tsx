import React, { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ContextBundle, SessionMeta, WorkspaceFolder } from '@nekko-agent/shared';
import { getSessionWorkspaceIds, estimateTokens } from '@nekko-agent/shared';
import { FolderIcon, FileIcon, PlusIcon, TrashIcon, ExternalIcon, ChevronIcon, StarIcon } from '../icons.js';
import { toggleDefaultFolder } from '../defaultFolders.js';
import { useStore } from '../store.js';
import { afterPaint } from '../afterPaint.js';
import { SpecPanel } from './SpecPanel.js';
import { ResourceDock } from './ResourceMonitor.js';
import { ProviderLimitsDock } from './ProviderLimitsDock.js';
import { ModelDock } from './engine/ModelDock.js';
import { DirTree } from './FileTree.js';
import { sourceMeta } from '../contextSources.js';
import { applyFolderSelection, withExcluded, withIncluded, withPrimary } from '../sessionFolders.js';

/** Remembered height of the Folders section when a tree is open. */
const EXPLORER_KEY = 'nekko.contextPanel.explorerHeight';
const DEFAULT_EXPLORER_H = 260;
const MIN_EXPLORER_H = 110;
const MIN_CONTEXT_H = 180;

function readExplorerHeight(): number {
  if (typeof window === 'undefined') return DEFAULT_EXPLORER_H;
  const n = Number(window.localStorage.getItem(EXPLORER_KEY));
  return Number.isFinite(n) && n >= MIN_EXPLORER_H ? n : DEFAULT_EXPLORER_H;
}

/** A small "i" badge that reveals an explanation on hover or keyboard focus. */
function InfoHint({ text }: { text: string }) {
  return (
    <span className="group/info relative inline-flex">
      <span
        tabIndex={0}
        role="note"
        aria-label={text}
        className="grid h-3.5 w-3.5 cursor-help place-items-center rounded-full border border-line text-2xs font-bold text-ink-faint outline-hidden focus-visible:ring-2 focus-visible:ring-(--ring)"
      >
        i
      </span>
      <span
        className="pointer-events-none absolute left-0 top-5 z-50 hidden w-56 rounded-xl border border-line p-3 text-2xs font-normal normal-case leading-snug tracking-normal text-ink-soft shadow-(--shadow-float) group-focus-within/info:block group-hover/info:block"
        style={{ background: 'var(--surface)' }}
      >
        {text}
      </span>
    </span>
  );
}

/** Last path segment, handling both POSIX and Windows separators. */
function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/**
 * The Context Inspector, Nekko Agent's signature panel. Two stacked sections split
 * by a draggable divider, the way VS Code stacks its sidebar views:
 *  1. Folders (top), the project folders grounding this chat as accordions. Each
 *     one expands into its file tree, so browsing and opening a file happens in
 *     the same place you choose what the agent can see.
 *  2. Context (bottom), exactly what enters the prompt on the next reply,
 *     grouped by provenance, each item toggleable and pinnable, with live token
 *     counts. It takes the whole panel while every folder is collapsed and gives
 *     ground as soon as a tree opens.
 */
export const ContextInspector = memo(function ContextInspector({ sessionId }: { sessionId: string | null }) {
  const sandbox = useStore((s) => s.sessions.find((item) => item.id === sessionId)?.executionMode === 'sandbox');
  return sandbox ? <p className="p-4 text-sm text-ink-soft">Host context, file previews, spec actions and hooks are unavailable in Sandbox. Only scoped files and bash are supported.</p> : <HostContextInspector sessionId={sessionId} />;
});
const HostContextInspector = memo(function HostContextInspector({ sessionId: shown }: { sessionId: string | null }) {
  // Follows the chat on screen one frame behind: switching chats paints the
  // chat first, and this panel's re-read of the new one comes after that frame
  // rather than inside the switch. (A deferred value is not enough: React can
  // render it before the browser gets to paint.)
  const [sessionId, setSessionId] = useState(shown);
  useEffect(() => (shown === sessionId ? undefined : afterPaint(() => setSessionId(shown))), [shown, sessionId]);
  const settings = useStore((s) => s.settings);
  const sessions = useStore((s) => s.sessions);
  const refreshSettings = useStore((s) => s.refreshSettings);
  const refreshSessions = useStore((s) => s.refreshSessions);

  const [bundle, setBundle] = useState<ContextBundle | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [pinned, setPinned] = useState<Set<string>>(new Set());
  // Which folder trees are open. Empty = the Context section owns the panel.
  const [openTrees, setOpenTrees] = useState<Set<string>>(new Set());
  // The height you asked for (persisted), and the room there is for it.
  const [explorerH, setExplorerH] = useState(readExplorerHeight);
  const explorerHRef = useRef(explorerH);
  const [splitH, setSplitH] = useState(0);
  // The area the divider splits (Folders + Context), excluding the pinned dock.
  const splitRef = useRef<HTMLDivElement>(null);

  const session = sessions.find((s) => s.id === sessionId) ?? null;
  const defaultFolderIds = settings?.defaultWorkspaceIds ?? [];
  const workspaces = (settings?.workspaces ?? []).map((w) => ({ ...w, path: session?.gitIsolation === false ? w.path : session?.gitWorktrees?.[w.id]?.path ?? w.path }));
  const attached = session?.attachedPaths ?? [];
  // The skill armed in this chat's composer (renderer-only until sent), so we can
  // show it in the window and count its tokens live.
  const activeSkill = useStore((s) => (sessionId ? s.activeSkillBySession[sessionId] ?? null : null));
  // What's typed but unsent, so the panel's total tracks the composer as you
  // type instead of only moving once a reply lands.
  const draft = useStore((s) => (sessionId ? s.draftBySession[sessionId] ?? '' : ''));

  const refreshBundle = () => {
    if (!sessionId) return;
    window.nekko.previewContext(sessionId, []).then((b) => {
      setBundle(b);
      setExcluded(new Set(b.items.filter((i) => !i.included).map((i) => i.id)));
      setPinned(new Set(b.items.filter((i) => i.pinned).map((i) => i.id)));
    });
  };

  useEffect(() => {
    if (!sessionId) {
      setBundle(null);
      return;
    }
    refreshBundle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, attached.length, session?.workspaceId, session?.supportingWorkspaceIds?.length, session?.messageCount]);

  // Follow a running turn. `session.messages` only moves when the store reloads
  // sessions (end of turn), but the agent checkpoints every finished step, so
  // each tool result is a real change to what the next request will carry.
  // Throttled, since a tool-heavy turn emits these in bursts.
  useEffect(() => {
    if (!sessionId) return;
    let last = 0;
    const off = window.nekko.onAgentEvent((e) => {
      if (e.sessionId !== sessionId) return;
      if (e.type !== 'tool_result' && e.type !== 'done') return;
      if (e.type === 'tool_result' && Date.now() - last < 1_500) return;
      last = Date.now();
      refreshBundle();
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // A folder that goes away shouldn't leave its tree "open" and hold height.
  useEffect(() => {
    setOpenTrees((prev) => {
      const next = new Set([...prev].filter((id) => workspaces.some((w) => w.id === id)));
      return next.size === prev.size ? prev : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaces.length]);

  // Track how much room the divider actually has. The space to divide is the
  // split area, not the whole panel, since the resource dock at the foot is
  // pinned and can be tall. The height you dragged to is kept as-is and only
  // clamped for display, so collapsing the dock hands the room back instead of
  // stranding the split where a cramped panel left it. The dock's own rectangle
  // (it publishes one when open, none when collapsed) is a dependency as well as
  // an observer target: collapsing it changes the room available without resizing
  // anything this component renders.
  const dockRect = useStore((s) => s.monitorDockRect);
  useLayoutEffect(() => {
    const el = splitRef.current;
    if (!el) return;
    const measure = () => setSplitH(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [openTrees.size, dockRect?.h]);

  if (!sessionId) return <Empty />;

  const persist = (nextExcluded: Set<string>, nextPinned: Set<string>) => {
    window.nekko.setContextPrefs(sessionId, { excluded: [...nextExcluded], pinned: [...nextPinned] });
  };

  const toggle = (id: string) => {
    const nextExcluded = new Set(excluded);
    const nextPinned = new Set(pinned);
    if (nextExcluded.has(id)) {
      nextExcluded.delete(id);
    } else {
      nextExcluded.add(id);
      nextPinned.delete(id);
    }
    setExcluded(nextExcluded);
    setPinned(nextPinned);
    persist(nextExcluded, nextPinned);
  };

  // --- Sources actions ---
  const addFolder = async () => {
    await window.nekko.addWorkspace();
    await refreshSettings();
  };
  const removeFolder = async (id: string) => {
    await window.nekko.removeWorkspace(id);
    if (session) await applyFolderSelection(sessionId, withExcluded(session, id));
    await refreshSettings();
  };
  const includeFolder = async (id: string) => { await applyFolderSelection(sessionId, withIncluded(session, id)); };
  const excludeFolder = async (id: string) => { await applyFolderSelection(sessionId, withExcluded(session, id)); };
  const makePrimary = async (id: string) => {
    if (!session || session.workspaceId === id) return;
    await applyFolderSelection(sessionId, withPrimary(session, id));
  };
  const addFiles = async () => {
    const picked = await window.nekko.openFilesDialog();
    if (!picked.length) return;
    const next = Array.from(new Set([...attached, ...picked]));
    await window.nekko.setSessionAttachments(sessionId, next);
    await refreshSessions();
  };
  const removeFile = async (path: string) => {
    await window.nekko.setSessionAttachments(sessionId, attached.filter((p) => p !== path));
    await refreshSessions();
  };
  const open = (target: string) => window.nekko.openPath(target);
  const openInPane = (path: string) => useStore.getState().openFilePane(path);

  const toggleTree = (id: string) =>
    setOpenTrees((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  // --- The draggable divider between Folders and Context ---
  // The pointerup handler closes over the height at drag start, so the live value
  // is read from a ref when persisting.
  explorerHRef.current = explorerH;
  // What the Folders section gets on screen: the asked-for height, capped so the
  // Context section below it always keeps a usable minimum.
  const maxExplorerH = Math.max(MIN_EXPLORER_H, (splitH || DEFAULT_EXPLORER_H + MIN_CONTEXT_H) - MIN_CONTEXT_H);
  const shownExplorerH = Math.min(Math.max(explorerH, MIN_EXPLORER_H), maxExplorerH);

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = shownExplorerH;
    const onMove = (ev: PointerEvent) => {
      setExplorerH(Math.min(maxExplorerH, Math.max(MIN_EXPLORER_H, startH + (ev.clientY - startY))));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      try {
        window.localStorage.setItem(EXPLORER_KEY, String(Math.round(explorerHRef.current)));
      } catch { /* best effort */ }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const visible = (bundle?.items ?? []).map((i) => ({
    ...i,
    included: !excluded.has(i.id),
    pinned: pinned.has(i.id),
  }));
  const skillTokens = activeSkill ? estimateTokens(activeSkill.template) : 0;
  const draftTokens = draft.trim() ? estimateTokens(draft) : 0;
  const total = visible.filter((i) => i.included).reduce((s, i) => s + i.tokens, 0) + skillTokens + draftTokens;
  const windowTokens = bundle?.contextWindow ?? 128000;
  const pct = Math.min(100, (total / windowTokens) * 100);
  const guidelineItems = visible.filter((i) => i.source === 'guideline');
  const memoryItems = visible.filter((i) => i.source === 'memory');

  // Compact "where the tokens go" summary: sum included items per source, then
  // fold in the armed skill so its weight is visible before it's even sent.
  const bySource = visible
    .filter((i) => i.included)
    .reduce<Record<string, number>>((acc, i) => {
      acc[i.source] = (acc[i.source] ?? 0) + i.tokens;
      return acc;
    }, {});
  if (skillTokens) bySource.skill = (bySource.skill ?? 0) + skillTokens;
  if (draftTokens) bySource.draft = (bySource.draft ?? 0) + draftTokens;
  const breakdown = Object.entries(bySource)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);

  const treesOpen = openTrees.size > 0;

  return (
    <div className="flex h-full w-80 flex-col border-l border-line">
      <div ref={splitRef} className="flex min-h-0 flex-1 flex-col">
        {/* ---- Folders + file explorer ---- */}
        <section
          className="flex min-h-0 shrink-0 flex-col"
          style={treesOpen ? { height: shownExplorerH } : undefined}
        >
          <SectionHeader
            title="Folders"
            info="Project folders grounding this chat. The active folder's files can be read and searched by the agent, and set the working directory for terminals and tools. Expand one to browse and open its files."
            onAdd={addFolder}
            addLabel="Add folder"
          />
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pb-2">
            {workspaces.length === 0 && <Hint>No folder yet. Add one to ground the chat in your code.</Hint>}
            {workspaces.map((w) => (
              <FolderAccordion
                key={w.id}
                workspace={w}
                session={session}
                expanded={openTrees.has(w.id)}
                onToggleExpanded={() => toggleTree(w.id)}
                onMakePrimary={() => makePrimary(w.id)}
                onInclude={() => includeFolder(w.id)}
                onExclude={() => excludeFolder(w.id)}
                onRemove={() => removeFolder(w.id)}
                onOpenFile={openInPane}
                isDefault={defaultFolderIds.includes(w.id)}
                onToggleDefault={() => toggleDefaultFolder(w.id)}
              />
            ))}
          </div>
        </section>

        {/* The split handle. Only draggable while a tree is open, since a collapsed
            Folders section is content-height by design. */}
        {treesOpen ? (
          <div
            className="group relative h-1 shrink-0 cursor-row-resize border-y border-line"
            style={{ background: 'var(--surface-2)' }}
            onPointerDown={startResize}
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize the Folders section"
            title="Drag to resize"
          >
            <span className="absolute inset-x-0 -top-1 -bottom-1 group-hover:bg-accent/25" />
          </div>
        ) : (
          <div className="h-px shrink-0 bg-line" aria-hidden="true" />
        )}

        {/* ---- Context ---- */}
        <section className="flex min-h-0 flex-1 flex-col">
          <div className="border-b border-line px-4 py-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Context</h3>
              <span className="chip">{total.toLocaleString()} tok</span>
            </div>
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full" style={{ background: 'var(--surface-2)' }}>
              <div className="h-full rounded-full" style={{ width: `${pct}%`, background: pct > 85 ? 'var(--danger)' : 'var(--accent)' }} />
            </div>
            <p className="mt-1 text-2xs text-ink-faint">
              {Math.round(pct)}% of the {windowTokens.toLocaleString()}-token window · {draftTokens > 0 ? 'includes what you’re typing.' : 'updates as you type.'}
            </p>
          </div>

          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
            <Section title="System prompt" info="Standing instructions, user profile, and the server-side per-turn wrapper.">
              <button className="btn btn-outline w-full py-1 text-xs" onClick={() => {
                useStore.getState().setView('settings');
                const locate = () => {
                  const section = document.getElementById('customization');
                  if (section) { section.scrollIntoView({ block: 'start' }); section.querySelector<HTMLTextAreaElement>('textarea[aria-label="System prompt"]')?.focus(); }
                };
                setTimeout(locate, 200);
              }}>Edit system prompt &amp; customization</button>
            </Section>
            {session?.gitWorktrees && Object.entries(session.gitWorktrees).map(([id, checkout]) => (
              <div key={id} className="rounded-lg border border-line p-2 text-2xs text-ink-soft">
                <p className="font-medium">{checkout.branch}</p>
                <p className="mt-1 break-all">{checkout.path}</p>
                <p className="mt-1">{checkout.notice}</p>
              </div>
            ))}
            {/* Armed skill: highlighted, with its token weight (Claude-Code style). */}
            {activeSkill && (
              <div className="rounded-xl border border-accent/40 p-3" style={{ background: 'var(--accent-soft)' }}>
                <div className="flex items-center justify-between gap-2">
                  <span className="skill-pill text-xs">
                    <span className="skill-pill-slash">/</span>{activeSkill.name}
                  </span>
                  <span className="shrink-0 text-2xs font-medium text-accent">{skillTokens.toLocaleString()} tok</span>
                </div>
                <p className="mt-1 text-2xs leading-snug text-ink-soft">{activeSkill.description}</p>
                <p className="mt-1 text-2xs text-ink-faint">Added to your message when you send. Not typed into the box.</p>
              </div>
            )}

            {/* Where the tokens go, a compact, always-accurate breakdown. */}
            {breakdown.length > 0 && (
              <Section title="In the window" info="Everything that enters the model's prompt on the next reply, by source. The conversation grows with every reply, which is what makes a long chat fill the window.">
                <div className="space-y-1">
                  {breakdown.map(([src, n]) => (
                    <div key={src} className="flex items-center gap-2 text-xs">
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: sourceMeta(src).color }} />
                      <span className="min-w-0 flex-1 truncate text-ink-soft">{sourceMeta(src).label}</span>
                      <span className="shrink-0 text-ink-faint">{n.toLocaleString()} tok</span>
                    </div>
                  ))}
                  <div className="mt-1 flex items-center gap-2 border-t border-line pt-1 text-xs font-medium">
                    <span className="min-w-0 flex-1 text-ink">Total</span>
                    <span className="shrink-0 text-ink">{total.toLocaleString()} tok</span>
                  </div>
                </div>
              </Section>
            )}

            {/* Sources: attached files */}
            <Section title="Files" info="Files you attach are pinned into every reply of this chat verbatim, use them for specs, snippets, or docs the model should always see." onAdd={addFiles} addLabel="Attach files">
              {attached.length === 0 && <Hint>Attach files to pin them into every reply of this chat.</Hint>}
              {attached.map((p) => (
                <Row
                  key={p}
                  icon={<FileIcon className="h-3.5 w-3.5" />}
                  title={baseName(p)}
                  subtitle={p}
                  onClick={() => openInPane(p)}
                  onRemove={() => removeFile(p)}
                />
              ))}
            </Section>

            {/* Sources: guidelines & memory */}
            {(guidelineItems.length > 0 || memoryItems.length > 0) && (
              <Section title="Guidelines" info="Always-on project guidelines and memory relevant to this chat.">
                {guidelineItems.map((g) => (
                  <Row
                    key={g.id}
                    icon={<FileIcon className="h-3.5 w-3.5" />}
                    title={g.label}
                    subtitle={g.origin}
                    onClick={() => open(g.origin)}
                    included={g.included}
                    onToggle={() => toggle(g.id)}
                  />
                ))}
                {memoryItems.map((m) => (
                  <Row
                    key={m.id}
                    icon={<FileIcon className="h-3.5 w-3.5" />}
                    title={m.label}
                    subtitle={m.preview}
                    included={m.included}
                    onToggle={() => toggle(m.id)}
                  />
                ))}
              </Section>
            )}

            {/* Spec-driven development */}
            <SpecPanel sessionId={sessionId} session={session} />
          </div>
        </section>
      </div>

      {/* Capacity across every provider, directly above the machine's own
          meters: the two answer the same question (what is about to run out)
          about the two different resources a run actually spends. */}
      <ProviderLimitsDock />

      {/* What is loaded and where it runs, directly above the machine's own
          meters: GPU placement explains the tokens-per-second the meter below
          is about to report. */}
      <ModelDock />

      {/* Resource monitors: pinned at the foot of the panel so they stay visible
          while the sources/breakdown above scroll. The floating chip warps into
          this section while it's on screen. */}
      <ResourceDock />
    </div>
  );
});

/**
 * One project folder as an accordion: the row carries what the agent may see
 * (primary / supporting / excluded), and expanding it reveals the folder's file
 * tree so you can open a file without leaving the panel.
 */
function FolderAccordion({
  workspace, session, expanded, onToggleExpanded, onMakePrimary, onInclude, onExclude, onRemove, onOpenFile, isDefault, onToggleDefault,
}: {
  isDefault: boolean;
  onToggleDefault: () => void;
  workspace: WorkspaceFolder;
  session: SessionMeta | null;
  expanded: boolean;
  onToggleExpanded: () => void;
  onMakePrimary: () => void;
  onInclude: () => void;
  onExclude: () => void;
  onRemove: () => void;
  onOpenFile: (path: string) => void;
}) {
  const included = getSessionWorkspaceIds(session ?? { workspaceId: undefined }).includes(workspace.id);
  const primary = session?.workspaceId === workspace.id;
  const name = baseName(workspace.path) || workspace.path;

  return (
    <div
      className={`group overflow-hidden rounded-lg border ${primary ? 'border-accent/40' : 'border-line'} ${included ? '' : 'opacity-50'}`}
      style={primary ? { background: 'color-mix(in srgb, var(--accent) 5%, transparent)' } : undefined}
    >
      <div className="flex items-center gap-1 px-2 py-1">
        <button
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={onToggleExpanded}
          aria-expanded={expanded}
          title={expanded ? 'Collapse files' : 'Browse files'}
        >
          <ChevronIcon className={`h-3 w-3 shrink-0 text-ink-faint transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`} />
          <FolderIcon className={`h-3.5 w-3.5 shrink-0 ${primary ? 'text-accent' : 'text-ink-faint'}`} />
          <span className="truncate text-sm font-medium" title={workspace.path}>{name}</span>
        </button>
        {included && (
          primary
            ? <span className="chip shrink-0 text-2xs uppercase">primary</span>
            : (
              <button
                className="chip chip-action shrink-0 text-2xs uppercase"
                onClick={onMakePrimary}
                title="Make this the primary folder"
              >
                supporting
              </button>
            )
        )}
        <button
          type="button"
          className={`shrink-0 rounded-sm p-0.5 transition-opacity focus-visible:opacity-100 ${isDefault ? 'text-accent' : 'text-ink-faint opacity-0 hover:text-ink group-hover:opacity-100'}`}
          aria-pressed={isDefault}
          aria-label={isDefault ? `Stop starting new chats in ${name}` : `Start new chats in ${name}`}
          title={isDefault ? 'Default for new chats (click to unset)' : 'Set as default for new chats'}
          onClick={onToggleDefault}
        >
          <StarIcon className="h-3.5 w-3.5" filled={isDefault} />
        </button>
        <button
          className="shrink-0 rounded-sm p-0.5 text-ink-faint opacity-0 transition-opacity hover:text-(--danger) focus-visible:opacity-100 group-hover:opacity-100"
          title="Remove this folder"
          onClick={onRemove}
        >
          <TrashIcon className="h-3.5 w-3.5" />
        </button>
        <input
          type="checkbox"
          className="shrink-0 accent-(--accent)"
          checked={included}
          aria-label={included ? `Stop using ${name} in this chat` : `Use ${name} in this chat`}
          onChange={() => (included ? onExclude() : onInclude())}
          title={included ? 'In this chat’s context' : 'Not in this chat’s context'}
        />
      </div>
      {expanded && (
        <div className="border-t border-line py-1" style={{ background: 'var(--surface-2)' }}>
          <DirTree root={workspace.path} onOpen={onOpenFile} />
        </div>
      )}
    </div>
  );
}

/** A section header that sits flush against the panel edge (no inner card). */
function SectionHeader({
  title, info, onAdd, addLabel,
}: {
  title: string; info?: string; onAdd?: () => void; addLabel?: string;
}) {
  return (
    <div className="flex items-center justify-between px-4 pb-1 pt-3">
      <span className="flex items-center gap-2 text-2xs font-semibold uppercase tracking-wide text-ink-faint">
        {title}
        {info && <InfoHint text={info} />}
      </span>
      {onAdd && (
        <button className="text-ink-faint hover:text-ink" title={addLabel} onClick={onAdd}>
          <PlusIcon className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

function Section({
  title,
  info,
  onAdd,
  addLabel,
  children,
}: {
  title: string;
  info?: string;
  onAdd?: () => void;
  addLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="flex items-center gap-2 text-2xs font-semibold uppercase tracking-wide text-ink-faint">
          {title}
          {info && <InfoHint text={info} />}
        </span>
        {onAdd && (
          <button className="text-ink-faint hover:text-ink" title={addLabel} onClick={onAdd}>
            <PlusIcon className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function Row({
  icon,
  title,
  subtitle,
  active,
  badge,
  badgeAction,
  onClick,
  onRemove,
  included,
  onToggle,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  active?: boolean;
  badge?: string;
  badgeAction?: () => void;
  onClick?: () => void;
  onRemove?: () => void;
  included?: boolean;
  onToggle?: () => void;
}) {
  return (
    <div
      className={`group flex items-center gap-2 rounded-lg border px-2 py-1 ${
        active ? 'border-accent/40 bg-accent/5' : 'border-line'
      } ${onClick ? 'cursor-pointer hover:bg-surface-2' : ''} ${included === false ? 'opacity-40' : ''}`}
      onClick={onClick}
    >
      <span className={active ? 'text-accent' : 'text-ink-faint'}>{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{title}</span>
          {badge && (badgeAction ? (
            <button
              className="chip shrink-0 cursor-pointer text-2xs uppercase hover:text-accent"
              onClick={(e) => {
                e.stopPropagation();
                badgeAction();
              }}
              title="Make primary"
            >
              {badge}
            </button>
          ) : <span className="chip shrink-0 text-2xs uppercase">{badge}</span>)}
          {onClick && <ExternalIcon className="h-3 w-3 shrink-0 text-ink-faint opacity-0 group-hover:opacity-100" />}
        </div>
        {subtitle && <p className="truncate text-2xs text-ink-faint">{subtitle}</p>}
      </div>
      {onRemove && (
        <button
          className="shrink-0 text-ink-faint opacity-0 hover:text-(--danger) group-hover:opacity-100"
          title="Remove"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          <TrashIcon className="h-3.5 w-3.5" />
        </button>
      )}
      {onToggle && (
        <input
          type="checkbox"
          className="shrink-0 accent-(--accent)"
          checked={included !== false}
          aria-label={included === false ? `Include ${title}` : `Exclude ${title}`}
          onClick={(e) => e.stopPropagation()}
          onChange={onToggle}
        />
      )}
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="px-1 text-2xs leading-snug text-ink-faint">{children}</p>;
}

function Empty() {
  return (
    <div className="flex h-full w-80 flex-col items-center justify-center border-l border-line p-6 text-center">
      <h3 className="text-sm font-semibold">Context</h3>
      <p className="mt-2 text-xs text-ink-faint">Start or open a chat to see and manage its context here.</p>
    </div>
  );
}
