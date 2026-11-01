import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { AgentEvent, DesignBoard, DesignPage } from '@nekko-agent/shared';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../store.js';
import { PlusIcon, CloseIcon, ExternalIcon, TrashIcon } from '../icons.js';
import { Modal } from '../components/primitives/index.js';
import { ArtifactPreview, isolatedDocument } from '../components/ArtifactPreview.js';
import { hasAppChrome } from '../chrome.js';

/**
 * Design board: create designs two ways, both first-class.
 * 1) DRAW: sketch a rough layout on a pen/touch-friendly canvas (built for
 *    iPad/iPhone use in the Local Web UI) and it gets turned into a working,
 *    self-contained HTML code prototype.
 * 2) DESCRIBE: write a prompt and watch a design pop up, then refine it
 *    iteratively with follow-up prompts (a Claude Design-style loop).
 * Generated concepts are mirrored into the workspace's nekko-designs/ folder
 * as real HTML files, so agents (and you) keep iterating on them as code.
 * The board still holds live snapshots of the app's real pages: each is a
 * scaled read-only preview that reloads as agents edit the UI, with notes and
 * comments that feed the prompt (Add to prompt / Run now).
 */
export function DesignBoardView() {
  const { settings, sessions, activeProjectId, setActiveProject, sendToChat, openChatPane } = useStore(
    useShallow((s) => ({
      settings: s.settings,
      sessions: s.sessions,
      activeProjectId: s.activeProjectId,
      setActiveProject: s.setActiveProject,
      sendToChat: s.sendToChat,
      openChatPane: s.openChatPane,
    })),
  );
  const workspaces = settings?.workspaces ?? [];
  const wsId = activeProjectId && workspaces.some((w) => w.id === activeProjectId)
    ? activeProjectId
    : workspaces[0]?.id ?? null;

  const [board, setBoard] = useState<DesignBoard | null>(null);
  const [zoom, setZoom] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<'sketch' | 'prompt' | 'live' | null>(null);
  const [busy, setBusy] = useState<{ label: string; pageId?: string } | null>(null);
  const [genError, setGenError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  // Sessions in this workspace whose agent is actively working (→ "updating").
  const [working, setWorking] = useState<Set<string>>(new Set());

  const load = () => { if (wsId) window.nekko.getDesignBoard(wsId).then(setBoard).catch(() => setBoard(null)); };
  useEffect(() => { setSelected(null); load(); /* eslint-disable-next-line */ }, [wsId]);

  // An agent editing files in this workspace marks pages "updating" and reloads
  // their previews so changes show up as they land.
  const wsSessionIds = useMemo(
    () => new Set(sessions.filter((s) => (s.workspaceId ?? null) === wsId).map((s) => s.id)),
    [sessions, wsId],
  );
  useEffect(() => {
    const off = window.nekko.onAgentEvent((e: AgentEvent) => {
      if (!wsSessionIds.has(e.sessionId)) return;
      setWorking((prev) => {
        const n = new Set(prev);
        if (e.type === 'done' || e.type === 'error') n.delete(e.sessionId);
        else n.add(e.sessionId);
        return n;
      });
      if (e.type === 'done') { setReloadNonce((x) => x + 1); load(); }
    });
    return off;
    // eslint-disable-next-line
  }, [wsSessionIds]);
  useEffect(() => {
    const off = window.nekko.onChangesUpdated((e) => { if (wsSessionIds.has(e.sessionId)) setReloadNonce((x) => x + 1); });
    return off;
  }, [wsSessionIds]);

  const updating = working.size > 0;
  const runningSessionId = [...working][0] ?? null;
  const goToAgent = () => { if (runningSessionId) { openChatPane(runningSessionId); useStore.getState().setView('command'); } };

  const pages = board?.pages ?? [];
  const selectedPage = pages.find((p) => p.id === selected) ?? null;

  /** Generate a new concept (from a prompt or a sketch) or refine an existing one. */
  const generate = async (input: { prompt: string; sketchDataUrl?: string; pageId?: string; label?: string }) => {
    if (!wsId) return;
    setGenError(null);
    setBusy({
      label: input.pageId
        ? pages.find((p) => p.id === input.pageId)?.label ?? 'Refining…'
        : input.label || input.prompt.slice(0, 42) || 'Sketch concept',
      pageId: input.pageId,
    });
    setMode(null);
    try {
      const next = await window.nekko.generateDesign(wsId, input);
      setBoard(next);
      // Surface the fresh card's sheet so refine/notes are one tap away.
      if (!input.pageId) {
        const before = new Set(pages.map((p) => p.id));
        const fresh = next.pages.find((p) => !before.has(p.id));
        if (fresh) setSelected(fresh.id);
      }
    } catch (e) {
      setGenError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const addPage = async (label: string, url: string) => {
    if (!wsId || !url.trim()) return;
    setBoard(await window.nekko.addDesignPage(wsId, label, url));
    setMode(null);
  };
  const removePage = async (pageId: string) => {
    if (!wsId) return;
    setBoard(await window.nekko.removeDesignPage(wsId, pageId));
    if (selected === pageId) setSelected(null);
  };

  if (!wsId) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="grid h-14 w-14 place-items-center rounded-2xl text-2xl" style={{ background: 'var(--accent-soft)' }}>🎨</div>
        <h2 className="text-xl font-semibold">Design</h2>
        <p className="max-w-sm text-sm text-ink-faint">Add a project folder first (from a chat's <b>+</b> menu). Then sketch or describe a design here and watch it become a working prototype.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
        {!hasAppChrome && <h1 className="view-title">Design</h1>}
        {workspaces.length > 1 && (
          <select className="input py-1 text-xs" value={wsId} onChange={(e) => setActiveProject(e.target.value)}>
            {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        )}
        {updating && (
          <button className="chip flex items-center gap-2 text-2xs text-accent" onClick={goToAgent} title="An agent is updating your app, open its chat">
            <span className="h-2 w-2 animate-pulse rounded-full bg-accent" /> Updating… open agent
          </button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <label className="hidden items-center gap-2 text-2xs text-ink-faint sm:flex">
            Zoom
            <input type="range" min={0.5} max={1.5} step={0.1} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} />
          </label>
          <button className="btn btn-ghost px-2 py-1 text-xs" title="Reload all previews" onClick={() => setReloadNonce((x) => x + 1)}>↻</button>
          <button className="btn btn-outline px-3 py-1 text-xs" onClick={() => setMode('live')}><PlusIcon className="h-3.5 w-3.5" /> Live page</button>
          <button className="btn btn-outline px-3 py-1 text-xs" onClick={() => setMode('sketch')}>✏️ Sketch</button>
          <button className="btn btn-primary px-3 py-1 text-xs" onClick={() => setMode('prompt')}>✨ Generate</button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 flex-1 overflow-auto p-5" style={{ background: 'var(--surface-2)' }}>
          {genError && (
            <div className="mb-4 flex items-start justify-between gap-3 rounded-xl border border-red-400/40 bg-red-400/10 px-3 py-2 text-xs text-red-300">
              <span>{genError}</span>
              <button className="shrink-0 text-red-300 hover:text-red-200" onClick={() => setGenError(null)}>✕</button>
            </div>
          )}
          {mode === 'live' && <AddPageForm onAdd={addPage} onCancel={() => setMode(null)} />}
          {pages.length === 0 && !busy && mode !== 'live' ? (
            <EmptyBoard onSketch={() => setMode('sketch')} onPrompt={() => setMode('prompt')} onLive={() => setMode('live')} />
          ) : (
            <div className="flex flex-wrap gap-5">
              {pages.map((p) => (
                <PageCard
                  key={p.id}
                  page={p}
                  zoom={zoom}
                  reloadNonce={reloadNonce}
                  updating={updating}
                  active={selected === p.id}
                  busy={busy?.pageId === p.id}
                  onOpen={() => setSelected(p.id)}
                  onUpdatingClick={goToAgent}
                />
              ))}
              {busy && !busy.pageId && <BusyCard label={busy.label} zoom={zoom} />}
            </div>
          )}
        </div>

        {selectedPage && (
          <PageSheet
            key={selectedPage.id}
            page={selectedPage}
            refining={busy?.pageId === selectedPage.id}
            onClose={() => setSelected(null)}
            onRemove={() => removePage(selectedPage.id)}
            onOpenBrowser={() => { useStore.getState().openBrowserPane(selectedPage.url); useStore.getState().setView('command'); }}
            onOpenFile={selectedPage.file ? () => { useStore.getState().openFilePane(selectedPage.file!); useStore.getState().setView('command'); } : undefined}
            onRefine={(text) => generate({ prompt: text, pageId: selectedPage.id })}
            onRestore={async (html) => { setBoard(await window.nekko.updateDesignPage(wsId, selectedPage.id, { html })); }}
            onAddNote={async (text) => { if (wsId) setBoard(await window.nekko.addDesignNote(wsId, selectedPage.id, text)); }}
            onResolveNote={async (id) => { if (wsId) setBoard(await window.nekko.resolveDesignNote(wsId, selectedPage.id, id)); }}
            onComment={(text, run) => sendToChat(
              selectedPage.kind === 'concept'
                ? `Re the design concept "${selectedPage.label}"${selectedPage.file ? ` (prototype file: ${selectedPage.file})` : ''}, ${text}`
                : `Re design page "${selectedPage.label}" (${selectedPage.url}), ${text}`,
              run,
            )}
          />
        )}
      </div>

      {mode === 'sketch' && (
        <SketchStudio
          onCancel={() => setMode(null)}
          onGenerate={(dataUrl, note) => generate({ prompt: note, sketchDataUrl: dataUrl, label: note.slice(0, 42) || 'Sketch concept' })}
        />
      )}
      {mode === 'prompt' && (
        <PromptStudio onCancel={() => setMode(null)} onGenerate={(prompt, label) => generate({ prompt, label })} />
      )}
    </div>
  );
}

/** First-run hero: the two ways to create, front and center. */
function EmptyBoard({ onSketch, onPrompt, onLive }: { onSketch: () => void; onPrompt: () => void; onLive: () => void }) {
  return (
    <div className="mx-auto mt-10 max-w-3xl">
      <h2 className="text-center text-xl font-bold tracking-tight">Design something</h2>
      <p className="mx-auto mt-1 max-w-md text-center text-sm text-ink-faint">
        Two ways in. Both end as a working HTML prototype in your workspace that you (or an agent) can keep iterating on.
      </p>
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <button className="card group p-5 text-left transition hover:border-(--accent)" onClick={onSketch}>
          <div className="grid h-11 w-11 place-items-center rounded-xl text-2xl" style={{ background: 'var(--accent-soft)' }}>✏️</div>
          <div className="mt-3 text-sm font-semibold">Draw it</div>
          <p className="mt-1 text-xs leading-snug text-ink-faint">
            Sketch boxes, arrows, and labels with a finger, mouse, or Apple Pencil. Your rough drawing becomes a real code prototype.
          </p>
        </button>
        <button className="card group p-5 text-left transition hover:border-(--accent)" onClick={onPrompt}>
          <div className="grid h-11 w-11 place-items-center rounded-xl text-2xl" style={{ background: 'var(--accent-soft)' }}>✨</div>
          <div className="mt-3 text-sm font-semibold">Describe it</div>
          <p className="mt-1 text-xs leading-snug text-ink-faint">
            Write what you want and watch a design pop up. Refine it with follow-up prompts until it's right.
          </p>
        </button>
      </div>
      <p className="mt-5 text-center text-xs text-ink-faint">
        or <button className="text-accent hover:underline" onClick={onLive}>add a live page</button> from your running app to review it here
      </p>
    </div>
  );
}

/** Placeholder card shown while a concept is generating. */
function BusyCard({ label, zoom }: { label: string; zoom: number }) {
  const W = Math.round(340 * zoom);
  const H = Math.round(W * 0.64);
  return (
    <div className="card overflow-hidden p-0" style={{ width: W }}>
      <div className="relative animate-pulse" style={{ height: H, background: 'var(--surface-2)' }}>
        <div className="absolute inset-0 grid place-items-center">
          <div className="flex items-center gap-2 text-xs text-ink-faint">
            <span className="h-2 w-2 animate-pulse rounded-full bg-accent" /> Designing…
          </div>
        </div>
      </div>
      <div className="border-t border-line px-3 py-1">
        <div className="truncate text-xs font-medium">{label}</div>
        <div className="truncate text-2xs text-ink-faint">generating</div>
      </div>
    </div>
  );
}

/** A scaled preview of one page: live URL iframe, or the generated concept HTML. */
function PageCard({
  page, zoom, reloadNonce, updating, active, busy, onOpen, onUpdatingClick,
}: {
  page: DesignPage; zoom: number; reloadNonce: number; updating: boolean; active: boolean; busy?: boolean;
  onOpen: () => void; onUpdatingClick: () => void;
}) {
  const W = Math.round(340 * zoom);
  const H = Math.round(W * 0.64);
  const LOGICAL = 1280; // render the page at desktop width, then scale to fit
  const scale = W / LOGICAL;
  const concept = page.kind === 'concept';
  return (
    <div
      className={`card overflow-hidden p-0 transition-shadow ${active ? 'ring-2 ring-accent' : ''}`}
      style={{ width: W }}
    >
      <div className="relative cursor-pointer" style={{ height: H, background: '#fff' }} onClick={onOpen} title="Open notes & comments">
        <iframe
          key={`${page.id}:${reloadNonce}`}
          {...(concept ? { srcDoc: isolatedDocument(page.html ?? '') } : { src: page.url })}
          title={page.label}
          sandbox={concept ? '' : 'allow-scripts allow-same-origin'}
          style={{
            width: LOGICAL, height: Math.round(H / scale), border: 0,
            transform: `scale(${scale})`, transformOrigin: 'top left', pointerEvents: 'none',
          }}
        />
        {/* Click-catcher so the read-only preview opens the sheet instead of interacting. */}
        <div className="absolute inset-0" />
        {busy && (
          <div className="absolute inset-0 grid place-items-center bg-black/30">
            <span className="flex items-center gap-2 rounded-full bg-black/60 px-3 py-1 text-2xs font-medium text-white">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" /> refining…
            </span>
          </div>
        )}
        {updating && !concept && (
          <button
            className="absolute right-1.5 top-1.5 flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-medium text-white shadow-(--shadow-sm)"
            style={{ background: 'var(--accent)' }}
            onClick={(e) => { e.stopPropagation(); onUpdatingClick(); }}
            title="An agent is updating your app, open its chat"
          >
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" /> updating
          </button>
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-line px-3 py-1">
        <button className="min-w-0 flex-1 text-left" onClick={onOpen}>
          <div className="truncate text-xs font-medium">{page.label}</div>
          <div className="truncate text-2xs text-ink-faint">
            {concept ? `${page.origin === 'sketch' ? '✏️ from a sketch' : '✨ from a prompt'}` : page.url}
          </div>
        </button>
        {page.notes.length > 0 && <span className="chip text-2xs" title={`${page.notes.length} note(s)`}>📌 {page.notes.length}</span>}
      </div>
    </div>
  );
}

/** Add-a-live-page inline form. */
function AddPageForm({ onAdd, onCancel }: { onAdd: (label: string, url: string) => void; onCancel: () => void }) {
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('http://localhost:3000');
  return (
    <div className="card mb-5 max-w-lg p-3">
      <div className="mb-2 text-xs font-semibold">Add a live page</div>
      <div className="flex flex-col gap-2">
        <input className="input text-xs" placeholder="Label (e.g. Home)" value={label} onChange={(e) => setLabel(e.target.value)} autoFocus />
        <input className="input font-mono text-xs" placeholder="http://localhost:3000/path" value={url} onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') onAdd(label, url); }} />
      </div>
      <div className="mt-2 flex justify-end gap-2">
        <button className="btn btn-ghost py-1 text-xs" onClick={onCancel}>Cancel</button>
        <button className="btn btn-primary py-1 text-xs" disabled={!url.trim()} onClick={() => onAdd(label, url)}>Add</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sketch studio: a pen/touch-first canvas (iPad/iPhone friendly) whose drawing
// is handed to a vision model and returned as a working HTML prototype.
// ---------------------------------------------------------------------------

type Stroke = { color: string; size: number; erase: boolean; points: Array<[number, number]> };

const SKETCH_COLORS = ['#111827', '#6d5efc', '#ef4444', '#2563eb', '#059669'];
const SKETCH_SIZES = [2, 4, 8];

function SketchStudio({ onCancel, onGenerate }: { onCancel: () => void; onGenerate: (dataUrl: string, note: string) => void }) {
  const titleId = useId();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const liveRef = useRef<Stroke | null>(null);
  const [color, setColor] = useState(SKETCH_COLORS[0]);
  const [size, setSize] = useState(4);
  const [erasing, setErasing] = useState(false);
  const [note, setNote] = useState('');
  const [strokeCount, setStrokeCount] = useState(0);

  // Size the canvas to its container once, honoring devicePixelRatio.
  useEffect(() => {
    const canvas = canvasRef.current, wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = wrap.getBoundingClientRect();
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.scale(dpr, dpr);
  }, []);

  const redraw = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
    for (const s of [...strokesRef.current, ...(liveRef.current ? [liveRef.current] : [])]) drawStroke(ctx, s);
  };

  const drawStroke = (ctx: CanvasRenderingContext2D, s: Stroke) => {
    ctx.globalCompositeOperation = s.erase ? 'destination-out' : 'source-over';
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.erase ? s.size * 4 : s.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    s.points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    if (s.points.length === 1) ctx.lineTo(s.points[0][0] + 0.1, s.points[0][1] + 0.1);
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
  };

  const pos = (e: React.PointerEvent): [number, number] => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  };

  const down = (e: React.PointerEvent) => {
    e.preventDefault();
    canvasRef.current?.setPointerCapture(e.pointerId);
    liveRef.current = { color, size, erase: erasing, points: [pos(e)] };
    redraw();
  };
  const move = (e: React.PointerEvent) => {
    if (!liveRef.current) return;
    e.preventDefault();
    liveRef.current.points.push(pos(e));
    const ctx = canvasRef.current?.getContext('2d');
    if (ctx) drawStroke(ctx, { ...liveRef.current, points: liveRef.current.points.slice(-2) });
  };
  const up = () => {
    if (!liveRef.current) return;
    strokesRef.current.push(liveRef.current);
    liveRef.current = null;
    setStrokeCount(strokesRef.current.length);
    redraw();
  };

  const undo = () => { strokesRef.current.pop(); setStrokeCount(strokesRef.current.length); redraw(); };
  const clear = () => { strokesRef.current = []; setStrokeCount(0); redraw(); };

  const generate = () => {
    const canvas = canvasRef.current;
    if (!canvas || strokesRef.current.length === 0) return;
    // Export on a white background so the model sees paper, not transparency.
    const out = document.createElement('canvas');
    out.width = canvas.width;
    out.height = canvas.height;
    const ctx = out.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(canvas, 0, 0);
    onGenerate(out.toDataURL('image/png'), note.trim());
  };

  return (
    <Modal
      title="Sketch a design"
      labelledBy={titleId}
      onClose={onCancel}
      align="stretch"
      scrim="var(--paper)"
      closeOnScrimClick={false}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <span id={titleId} className="text-sm font-semibold">✏️ Sketch a design</span>
        <span className="hidden text-2xs text-ink-faint md:inline">boxes + labels are enough, the model fills in the design</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {SKETCH_COLORS.map((c) => (
            <button
              key={c}
              className="h-6 w-6 rounded-full border-2 transition"
              style={{ background: c, borderColor: !erasing && color === c ? 'var(--accent)' : 'transparent' }}
              onClick={() => { setColor(c); setErasing(false); }}
              title={`Pen ${c}`}
            />
          ))}
          <span className="mx-1 h-5 w-px bg-(--line)" />
          {SKETCH_SIZES.map((s) => (
            <button
              key={s}
              className={`grid h-6 w-6 place-items-center rounded-full border ${size === s ? 'border-(--accent)' : 'border-transparent'}`}
              onClick={() => setSize(s)}
              title={`Stroke ${s}px`}
            >
              <span className="rounded-full bg-current" style={{ width: s + 2, height: s + 2 }} />
            </button>
          ))}
          <span className="mx-1 h-5 w-px bg-(--line)" />
          <button className={`btn px-2 py-1 text-xs ${erasing ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setErasing((v) => !v)}>Eraser</button>
          <button className="btn btn-ghost px-2 py-1 text-xs" disabled={!strokeCount} onClick={undo}>Undo</button>
          <button className="btn btn-ghost px-2 py-1 text-xs" disabled={!strokeCount} onClick={clear}>Clear</button>
        </div>
      </div>

      <div ref={wrapRef} className="min-h-0 flex-1 p-3" style={{ background: 'var(--surface-2)' }}>
        <canvas
          ref={canvasRef}
          className="h-full w-full rounded-xl"
          style={{ background: '#ffffff', touchAction: 'none', cursor: 'crosshair' }}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-line px-3 py-2">
        <input
          className="input min-w-0 flex-1 text-xs"
          placeholder='Optional notes for the model: "mobile app, dark theme", "the big box is a video player"…'
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <button className="btn btn-ghost py-1 text-xs" onClick={onCancel}>Cancel</button>
        <button className="btn btn-primary py-1 text-xs" disabled={!strokeCount} onClick={generate}>
          Generate prototype →
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Prompt studio: describe it, watch it appear.
// ---------------------------------------------------------------------------

const PROMPT_IDEAS = [
  'A landing page for a sushi delivery startup, warm and appetizing',
  'A mobile budgeting app home screen with a spending ring and recent transactions',
  'A dark analytics dashboard with a big line chart and four stat tiles',
];

function PromptStudio({ onCancel, onGenerate }: { onCancel: () => void; onGenerate: (prompt: string, label?: string) => void }) {
  const [prompt, setPrompt] = useState('');
  const [label, setLabel] = useState('');
  const titleId = useId();
  return (
    <Modal
      title="Describe a design"
      labelledBy={titleId}
      onClose={onCancel}
      overlayClassName="p-4"
      className="card w-full max-w-xl p-5"
    >
      <h2 id={titleId} className="text-xl font-bold tracking-tight">✨ Describe it. Watch it appear.</h2>
      <p className="mt-1 text-xs text-ink-faint">
        One prompt in, a working design out. Refine it afterwards with follow-ups, you're the designer, the model just drafts fast.
      </p>
      <textarea
        className="input mt-3 min-h-[88px] w-full resize-y text-sm"
        placeholder="What should it be? Audience, vibe, key sections…"
        value={prompt}
        autoFocus
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && prompt.trim()) onGenerate(prompt.trim(), label.trim() || undefined); }}
      />
      <div className="mt-2 flex flex-wrap gap-2">
        {PROMPT_IDEAS.map((idea) => (
          <button key={idea} className="chip max-w-full truncate text-2xs hover:text-ink" onClick={() => setPrompt(idea)}>
            {idea}
          </button>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <input className="input flex-1 text-xs" placeholder="Card label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} />
        <button className="btn btn-ghost py-1 text-xs" onClick={onCancel}>Cancel</button>
        <button className="btn btn-primary py-1 text-xs" disabled={!prompt.trim()} onClick={() => onGenerate(prompt.trim(), label.trim() || undefined)}>
          Generate →
        </button>
      </div>
    </Modal>
  );
}

/** Right drawer for a page: refine (concepts), persistent notes, and comments. */
function PageSheet({
  page, refining, onClose, onRemove, onOpenBrowser, onOpenFile, onRefine, onRestore, onAddNote, onResolveNote, onComment,
}: {
  page: DesignPage;
  refining?: boolean;
  onClose: () => void;
  onRemove: () => void;
  onOpenBrowser: () => void;
  onOpenFile?: () => void;
  onRestore: (html: string) => Promise<void>;
  onRefine: (text: string) => void | Promise<void>;
  onAddNote: (text: string) => void | Promise<void>;
  onResolveNote: (id: string) => void | Promise<void>;
  onComment: (text: string, run: boolean) => void | Promise<void>;
}) {
  const [note, setNote] = useState('');
  const [comment, setComment] = useState('');
  const [refineText, setRefineText] = useState('');
  const noteRef = useRef<HTMLInputElement>(null);
  const concept = page.kind === 'concept';
  const refine = () => {
    if (!refineText.trim() || refining) return;
    void onRefine(refineText.trim());
    setRefineText('');
  };
  return (
    <aside className="flex w-80 shrink-0 flex-col overflow-y-auto border-l border-line" style={{ background: 'var(--paper)' }}>
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{page.label}</div>
          <div className="truncate text-2xs text-ink-faint">{concept ? (page.origin === 'sketch' ? 'concept · from a sketch' : 'concept · from a prompt') : page.url}</div>
        </div>
        {concept && onOpenFile && (
          <button className="rounded-sm p-1 text-ink-faint hover:text-ink" title="Open the prototype file" onClick={onOpenFile}><ExternalIcon className="h-3.5 w-3.5" /></button>
        )}
        {!concept && (
          <button className="rounded-sm p-1 text-ink-faint hover:text-ink" title="Open in browser pane" onClick={onOpenBrowser}><ExternalIcon className="h-3.5 w-3.5" /></button>
        )}
        <button className="rounded-sm p-1 text-ink-faint hover:text-red-400" title="Remove page" onClick={onRemove}><TrashIcon className="h-3.5 w-3.5" /></button>
        <button className="rounded-sm p-1 text-ink-faint hover:text-ink" title="Close" onClick={onClose}><CloseIcon className="h-3.5 w-3.5" /></button>
      </div>

      {concept && <ArtifactPreview source={page.html ?? ''} title={page.label} />}
      {concept && (page.revisions?.length ?? 0) > 0 && <details className="p-3 text-xs">
        <summary>Previous versions ({page.revisions?.length})</summary>
        {page.revisions?.map((revision) => <button key={revision.id} className="chip chip-action my-1 block" onClick={() => { if (window.confirm('Restore this version? The current design will be kept in history.')) void onRestore(revision.html); }}>
          Restore · {new Date(revision.createdAt).toLocaleString()}
        </button>)}
      </details>}
      <div className="px-3 py-3">
        {concept && (
          <>
            <div className="mb-1 text-xs font-medium text-ink-soft">Refine</div>
            {page.prompt && <p className="mb-1 line-clamp-2 text-2xs italic text-ink-faint">"{page.prompt}"</p>}
            <textarea
              className="input min-h-[52px] w-full resize-none text-xs"
              rows={2}
              placeholder='"Make the hero darker", "add a pricing section", "more whitespace"…'
              value={refineText}
              onChange={(e) => setRefineText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) refine(); }}
            />
            <div className="mt-1 flex justify-end">
              <button className="btn btn-primary py-1 text-xs" disabled={!refineText.trim() || refining} onClick={refine}>
                {refining ? 'Refining…' : 'Refine design'}
              </button>
            </div>
            <div className="my-3 h-px bg-(--line)" />
          </>
        )}

        {/* Notes, persistent */}
        <div className="mb-1 text-xs font-medium text-ink-soft">Notes</div>
        {page.notes.length === 0 && <p className="mb-2 text-xs text-ink-faint">No notes yet, pin design intent that sticks with this page.</p>}
        {page.notes.map((n) => (
          <div key={n.id} className="mb-1 flex items-start gap-2 rounded-lg border border-line p-2">
            <p className="min-w-0 flex-1 whitespace-pre-wrap text-xs">{n.text}</p>
            <button className="shrink-0 text-2xs text-ink-faint hover:text-ink" onClick={() => onResolveNote(n.id)} title="Remove note">✕</button>
          </div>
        ))}
        <div className="mt-1 flex gap-2">
          <input ref={noteRef} className="input flex-1 text-xs" placeholder="Pin a note…" value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && note.trim()) { onAddNote(note); setNote(''); } }} />
          <button className="btn btn-outline px-2 py-1 text-xs" disabled={!note.trim()} onClick={() => { onAddNote(note); setNote(''); noteRef.current?.focus(); }}>Pin</button>
        </div>

        {/* Comment, routes to the agent */}
        <div className="mb-1 mt-4 text-xs font-medium text-ink-soft">Comment for the agent</div>
        <textarea className="input min-h-[60px] resize-none text-xs" rows={3} placeholder="Describe a change to this page…"
          value={comment} onChange={(e) => setComment(e.target.value)} />
        <div className="mt-1 flex justify-end gap-2">
          <button className="btn btn-outline py-1 text-xs" disabled={!comment.trim()} onClick={() => { onComment(comment, false); setComment(''); }}>Add to prompt</button>
          <button className="btn btn-primary py-1 text-xs" disabled={!comment.trim()} onClick={() => { onComment(comment, true); setComment(''); }}>Run now</button>
        </div>
      </div>
    </aside>
  );
}
