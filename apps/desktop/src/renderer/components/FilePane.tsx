import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LineComment } from '@nekko-agent/shared';
import { Markdown } from './Markdown.js';
import { ArtifactPreview, MermaidDiagram } from './ArtifactPreview.js';
import { FileTypeIcon } from '../fileIcons.js';
import { ExternalIcon, CloseIcon, UndoIcon, RedoIcon, CopyIcon, PasteIcon } from '../icons.js';
import { useStore } from '../store.js';

/** Fixed editor line height (px) so the comment gutter aligns row-for-row. */
const LINE_H = 20;
/** Idle gap after the last keystroke before an auto-save fires. */
const AUTOSAVE_DELAY = 900;
/** Edits closer together than this fold into one undo step. */
const COALESCE_MS = 600;
/** Cap on the undo history, so a long editing session can't grow unbounded. */
const HISTORY_LIMIT = 200;
const AUTOSAVE_KEY = 'nekko.editor.autoSave';

/** A point in the edit history: the text plus where the caret was. */
interface Snapshot {
  content: string;
  start: number;
  end: number;
}

/** Format a line comment into a block the agent reads as a user turn. */
function commentBlock(name: string, line: number, lineText: string, comment: string): string {
  const code = lineText.trim() ? `\n\n\`\`\`\n${lineText}\n\`\`\`` : '';
  return `Re \`${name}:${line}\`, ${comment}${code}`;
}

/** The folder a file lives in, so its relative links and images can be opened. */
function dirName(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  parts.pop();
  return parts.join(path.includes('\\') ? '\\' : '/');
}

function readAutoSavePref(): boolean {
  if (typeof window === 'undefined') return true;
  return window.localStorage.getItem(AUTOSAVE_KEY) !== 'off';
}

/**
 * Built-in file viewer/editor. Markdown renders as a real document (with a
 * Source/Preview toggle); other text files open in a lightweight mono editor
 * with auto-save, undo/redo, and clipboard actions. A gutter "+" lets you drop
 * an inline comment on any line that the agent picks up, Add to prompt (queue
 * it) or Run now (send it). Deliberately not a full IDE, just enough to read,
 * tweak, and steer changes without leaving Nekko Agent.
 */
export function FilePane({ path }: { path: string }) {
  // File panes are independent host documents, not owned by the globally focused chat.
  return <HostFilePane path={path} />;
}
function HostFilePane({ path }: { path: string }) {
  const isMd = /\.(md|markdown)$/i.test(path);
  const isHtml = /\.(html?|svg)$/i.test(path);
  const isMermaid = /\.(mmd|mermaid)$/i.test(path);
  const canPreview = isMd || isHtml || isMermaid;
  const [image, setImage] = useState('');
  const name = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
  const dir = useMemo(() => dirName(path), [path]);
  const sendToChat = useStore((s) => s.sendToChat);
  const pushToast = useStore((s) => s.pushToast);

  const [content, setContent] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [binary, setBinary] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [autoSave, setAutoSave] = useState(readAutoSavePref);
  const [preview, setPreview] = useState(canPreview); // markdown defaults to rendered
  const [comments, setComments] = useState<LineComment[]>([]);
  const [activeLine, setActiveLine] = useState<number | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Edit history. Kept here rather than leaning on the browser's own undo stack:
  // a controlled textarea loses native undo the moment anything sets its value
  // programmatically (a save-reload, an undo, a paste action).
  const undoStack = useRef<Snapshot[]>([]);
  const redoStack = useRef<Snapshot[]>([]);
  const lastPushAt = useRef(0);
  const [historyDepth, setHistoryDepth] = useState({ undo: 0, redo: 0 });
  // Mirrors for the unmount flush: the effect that saves on teardown must see
  // the final text, not the text from the render that registered it.
  const latest = useRef({ content: '', dirty: false, truncated: false });
  latest.current = { content, dirty, truncated };

  useEffect(() => {
    let live = true;
    setLoaded(false);
    setImage('');
    setPreview(canPreview);
    setActiveLine(null);
    undoStack.current = [];
    redoStack.current = [];
    setHistoryDepth({ undo: 0, redo: 0 });
    setSavedAt(null);
    window.nekko.readFile(path).then((f) => {
      if (!live) return;
      setContent(f.content);
      setImage(f.imageDataUrl ?? '');
      setBinary(f.binary);
      setTruncated(f.truncated);
      setDirty(false);
      setLoaded(true);
    }).catch(() => { if (live) { setLoaded(true); setBinary(false); } });
    window.nekko.listComments(path).then((c) => { if (live) setComments(c); }).catch(() => {});
    return () => { live = false; };
  }, [path]);

  const lines = useMemo(() => content.split('\n'), [content]);
  const byLine = useMemo(() => {
    const m = new Map<number, LineComment[]>();
    for (const c of comments) m.set(c.line, [...(m.get(c.line) ?? []), c]);
    return m;
  }, [comments]);

  const write = useCallback(async (text: string) => {
    setSaving(true);
    try {
      await window.nekko.writeFile(path, text);
      setDirty(false);
      setSavedAt(Date.now());
    } catch {
      pushToast('error', `Couldn't save ${name}.`);
    } finally {
      setSaving(false);
    }
  }, [path, name, pushToast]);

  const save = useCallback(() => {
    const { content: text, dirty: isDirty, truncated: isTruncated } = latest.current;
    if (!isDirty || isTruncated) return;
    void write(text);
  }, [write]);

  // Auto-save: one debounced write per idle pause, so edits survive a tab switch
  // or a crash without a Ctrl+S habit. Off is remembered across files.
  useEffect(() => {
    if (!autoSave || !dirty || truncated || !loaded) return;
    const t = setTimeout(save, AUTOSAVE_DELAY);
    return () => clearTimeout(t);
  }, [autoSave, dirty, truncated, loaded, content, save]);

  // Flush on the way out: the workbench unmounts a pane when you switch tabs,
  // and quitting takes the window with it.
  useEffect(() => {
    const flush = () => {
      const { dirty: isDirty, truncated: isTruncated, content: text } = latest.current;
      if (readAutoSavePref() && isDirty && !isTruncated) void window.nekko.writeFile(path, text).catch(() => {});
    };
    window.addEventListener('beforeunload', flush);
    return () => { window.removeEventListener('beforeunload', flush); flush(); };
  }, [path]);

  const toggleAutoSave = () => {
    setAutoSave((on) => {
      const next = !on;
      try { window.localStorage.setItem(AUTOSAVE_KEY, next ? 'on' : 'off'); } catch { /* best effort */ }
      if (next) save();
      return next;
    });
  };

  const syncDepth = () =>
    setHistoryDepth({ undo: undoStack.current.length, redo: redoStack.current.length });

  /** Apply an edit, recording the pre-edit state as an undo step. */
  const edit = (next: string, caret?: number) => {
    const el = taRef.current;
    const now = Date.now();
    const snap: Snapshot = {
      content,
      start: el?.selectionStart ?? content.length,
      end: el?.selectionEnd ?? content.length,
    };
    // Rapid typing folds into one step; a pause (or a discrete action like paste)
    // starts a new one.
    if (now - lastPushAt.current > COALESCE_MS || caret != null || undoStack.current.length === 0) {
      undoStack.current.push(snap);
      if (undoStack.current.length > HISTORY_LIMIT) undoStack.current.shift();
    }
    lastPushAt.current = caret != null ? 0 : now;
    redoStack.current = [];
    syncDepth();
    setContent(next);
    setDirty(true);
    if (caret != null) {
      requestAnimationFrame(() => {
        const ta = taRef.current;
        if (ta) { ta.focus(); ta.setSelectionRange(caret, caret); }
      });
    }
  };

  /** Move one step through the history in either direction. */
  const step = (dir: 'undo' | 'redo') => {
    const from = dir === 'undo' ? undoStack.current : redoStack.current;
    const to = dir === 'undo' ? redoStack.current : undoStack.current;
    const snap = from.pop();
    if (!snap) return;
    const el = taRef.current;
    to.push({ content, start: el?.selectionStart ?? 0, end: el?.selectionEnd ?? 0 });
    lastPushAt.current = 0;
    syncDepth();
    setContent(snap.content);
    setDirty(true);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (ta) { ta.focus(); ta.setSelectionRange(snap.start, snap.end); }
    });
  };

  /** Selected text, or the whole file when nothing is selected. */
  const selection = (): { text: string; start: number; end: number; whole: boolean } => {
    const el = taRef.current;
    const start = el?.selectionStart ?? 0;
    const end = el?.selectionEnd ?? 0;
    if (!el || start === end) return { text: content, start: 0, end: content.length, whole: true };
    return { text: content.slice(start, end), start, end, whole: false };
  };

  const copy = async (cut = false) => {
    const sel = selection();
    try {
      await navigator.clipboard.writeText(sel.text);
    } catch {
      pushToast('error', "Couldn't reach the clipboard.");
      return;
    }
    if (cut && !truncated) edit(content.slice(0, sel.start) + content.slice(sel.end), sel.start);
    else pushToast('success', sel.whole ? 'Whole file copied.' : 'Selection copied.');
  };

  const paste = async () => {
    if (truncated) return;
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch {
      pushToast('error', "Couldn't read the clipboard.");
      return;
    }
    if (!text) return;
    const el = taRef.current;
    const start = el?.selectionStart ?? content.length;
    const end = el?.selectionEnd ?? content.length;
    edit(content.slice(0, start) + text + content.slice(end), start + text.length);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === 's') { e.preventDefault(); save(); return; }
    if (mod && key === 'z' && !e.shiftKey) { e.preventDefault(); step('undo'); return; }
    if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) { e.preventDefault(); step('redo'); return; }
    // Tab indents instead of leaving the editor, which is what a code pane owes you.
    if (e.key === 'Tab' && !truncated) {
      e.preventDefault();
      const el = taRef.current;
      if (!el) return;
      const start = el.selectionStart;
      edit(content.slice(0, start) + '  ' + content.slice(el.selectionEnd), start + 2);
    }
  };

  const reloadComments = () => window.nekko.listComments(path).then(setComments).catch(() => {});

  // Persist a new comment on the active line, then optionally route it to a chat.
  const addComment = async (text: string, action: 'save' | 'prompt' | 'run') => {
    if (activeLine == null || !text.trim()) return;
    const lineText = lines[activeLine - 1] ?? '';
    await window.nekko.addComment(path, activeLine, lineText, text.trim());
    await reloadComments();
    if (action !== 'save') await sendToChat(commentBlock(name, activeLine, lineText, text.trim()), action === 'run');
  };

  const resolveComment = async (id: string) => {
    await window.nekko.resolveComment(path, id);
    reloadComments();
  };

  const showGutter = loaded && !binary && !(isMd && preview);
  const editable = loaded && !binary && !truncated;

  return (
    <div className="flex h-full flex-col overflow-hidden" style={{ background: 'var(--paper)' }}>
      <div className="flex items-center gap-2 border-b border-line px-3 py-1 text-xs">
        <FileTypeIcon name={name} size={15} />
        <span className="font-medium">{name}</span>
        {comments.length > 0 && (
          <span className="chip text-2xs" title={`${comments.length} comment${comments.length > 1 ? 's' : ''} on this file`}>💬 {comments.length}</span>
        )}
        {editable && <SaveState dirty={dirty} saving={saving} savedAt={savedAt} autoSave={autoSave} />}

        <span className="ml-auto flex items-center gap-1">
          {editable && (
            <>
              {/* Edit actions. The pane has no native menu bar, so undo/redo and
                  the clipboard need somewhere to live besides the shortcuts. */}
              <IconAction label="Undo (Ctrl+Z)" disabled={historyDepth.undo === 0} onClick={() => step('undo')}>
                <UndoIcon className="h-3.5 w-3.5" />
              </IconAction>
              <IconAction label="Redo (Ctrl+Shift+Z)" disabled={historyDepth.redo === 0} onClick={() => step('redo')}>
                <RedoIcon className="h-3.5 w-3.5" />
              </IconAction>
              <IconAction label="Copy selection (or the whole file)" onClick={() => copy()}>
                <CopyIcon className="h-3.5 w-3.5" />
              </IconAction>
              <IconAction label="Paste at the caret" onClick={paste}>
                <PasteIcon className="h-3.5 w-3.5" />
              </IconAction>
              <span className="mx-0.5 h-4 w-px bg-line" aria-hidden="true" />
              <button
                className="ctl-toggle text-2xs"
                onClick={toggleAutoSave}
                aria-pressed={autoSave}
                title={autoSave ? 'Auto-save is on - edits save as you pause' : 'Auto-save is off - save with Ctrl+S'}
              >
                <span className="ctl-dot" /> Auto-save
              </button>
            </>
          )}
          {isHtml && !truncated && (
            <button className="chip chip-action text-2xs" onClick={async () => {
              const state = useStore.getState();
              const workspaceId = state.activeProjectId ?? state.settings?.workspaces[0]?.id;
              if (!workspaceId) { pushToast('error', 'Choose a project first.'); return; }
              try { await window.nekko.addDesignPage(workspaceId, name, path); state.setView('design'); }
              catch (e) { pushToast('error', (e as Error).message); }
            }}>Add to design board</button>
          )}
          {loaded && !truncated && !binary && (
            <button className="chip chip-action text-2xs" onClick={() => {
              const url = URL.createObjectURL(new Blob([content], { type: isHtml && /\.svg$/i.test(path) ? 'image/svg+xml' : 'text/plain;charset=utf-8' }));
              const link = document.createElement('a');
              link.href = url;
              link.download = name;
              link.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            }} title="Download a copy of this file">Download</button>
          )}
          {canPreview && (
            <button className="chip chip-action text-2xs" onClick={() => setPreview((p) => !p)} title={preview ? 'Edit source' : 'Preview artifact'}>
              {preview ? 'Source' : 'Preview'}
            </button>
          )}
          {editable && !autoSave && (
            <button className="btn btn-ghost px-2 py-0.5 text-2xs" onClick={save} disabled={!dirty || saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          )}
          <button className="rounded-sm p-1 text-ink-faint hover:text-ink" title="Reveal in OS"
            onClick={() => window.nekko.openPath(path)}><ExternalIcon className="h-3.5 w-3.5" /></button>
        </span>
      </div>

      {truncated && (
        <div className="border-b border-line px-3 py-1 text-2xs text-amber-500">
          Large file, showing the first part only; editing is disabled.
        </div>
      )}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {showGutter && (
          <div className="relative w-11 shrink-0 overflow-hidden border-r border-line text-right" style={{ background: 'var(--surface-2)' }}>
            <div style={{ transform: `translateY(${-scrollTop}px)` }} className="pt-3">
              {lines.map((_, i) => {
                const ln = i + 1;
                const has = byLine.has(ln);
                const isActive = activeLine === ln;
                return (
                  <div
                    key={ln}
                    className={`group/g relative cursor-pointer pr-2 font-mono text-2xs ${isActive ? 'text-accent' : 'text-ink-faint hover:text-ink'}`}
                    style={{ height: LINE_H, lineHeight: `${LINE_H}px` }}
                    onClick={() => setActiveLine(ln)}
                    title={has ? 'View comment' : 'Comment on this line'}
                  >
                    <span className="opacity-0 transition-opacity group-hover/g:opacity-0">{has ? '' : ln}</span>
                    <span className={`absolute inset-y-0 left-0 flex items-center pl-1 text-accent ${has ? '' : 'opacity-0 group-hover/g:opacity-100'}`}>
                      {has ? '●' : '+'}
                    </span>
                    {!has && <span className="absolute inset-y-0 right-1.5 flex items-center group-hover/g:opacity-0">{ln}</span>}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto">
          {!loaded ? (
            <p className="p-4 text-xs text-ink-faint">Loading…</p>
          ) : image ? (
            <img src={image} alt={name} className="mx-auto max-h-full max-w-full object-contain p-4" />
          ) : binary ? (
            <p className="p-4 text-xs text-ink-faint">Binary file, can't display as text.</p>
          ) : isHtml && preview ? (
            <ArtifactPreview source={content} title={name} />
          ) : isMermaid && preview ? (
            <MermaidDiagram code={content} />
          ) : isMd && preview ? (
            <div className="mx-auto max-w-3xl px-6 py-5"><Markdown text={content} doc basePath={dir} /></div>
          ) : (
            <textarea
              ref={taRef}
              className="h-full w-full resize-none whitespace-pre bg-transparent px-3 pt-3 font-mono outline-hidden"
              style={{ fontSize: '12.5px', lineHeight: `${LINE_H}px` }}
              spellCheck={false}
              wrap="off"
              value={content}
              readOnly={truncated}
              onScroll={(e) => setScrollTop((e.target as HTMLTextAreaElement).scrollTop)}
              onKeyDown={onKeyDown}
              onBlur={save}
              onChange={(e) => edit(e.target.value)}
            />
          )}
        </div>
      </div>

      {activeLine != null && showGutter && (
        <CommentDock
          line={activeLine}
          lineText={lines[activeLine - 1] ?? ''}
          comments={byLine.get(activeLine) ?? []}
          onClose={() => setActiveLine(null)}
          onAdd={addComment}
          onResolve={resolveComment}
          onResend={(c, run) => sendToChat(commentBlock(name, c.line, c.lineText, c.comment), run)}
        />
      )}
    </div>
  );
}

/** Quiet icon button for the editor's toolbar. */
function IconAction({
  label, disabled, onClick, children,
}: {
  label: string; disabled?: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button
      className="rounded-sm p-1 text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-ink-faint"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** Where this file stands: unsaved, writing, or saved (and when). */
function SaveState({
  dirty, saving, savedAt, autoSave,
}: {
  dirty: boolean; saving: boolean; savedAt: number | null; autoSave: boolean;
}) {
  if (saving) return <span className="text-2xs text-ink-faint">Saving…</span>;
  if (dirty) {
    return (
      <span className="flex items-center gap-2 text-2xs text-ink-faint" title={autoSave ? 'Saves shortly after you stop typing' : 'Unsaved changes (Ctrl+S)'}>
        <span className="h-1.5 w-1.5 rounded-full bg-accent" />
        {autoSave ? 'Saving shortly' : 'Unsaved'}
      </span>
    );
  }
  if (savedAt) {
    return (
      <span className="text-2xs" style={{ color: 'var(--success)' }} title={new Date(savedAt).toLocaleTimeString()}>
        Saved
      </span>
    );
  }
  return null;
}

/** Bottom dock to read/add comments on the active line and route them to a chat. */
function CommentDock({
  line, lineText, comments, onClose, onAdd, onResolve, onResend,
}: {
  line: number;
  lineText: string;
  comments: LineComment[];
  onClose: () => void;
  onAdd: (text: string, action: 'save' | 'prompt' | 'run') => void | Promise<void>;
  onResolve: (id: string) => void;
  onResend: (c: LineComment, run: boolean) => void;
}) {
  const [text, setText] = useState('');
  const act = (action: 'save' | 'prompt' | 'run') => { onAdd(text, action); setText(''); };
  return (
    <div className="max-h-[45%] shrink-0 overflow-y-auto border-t border-line px-3 py-2" style={{ background: 'var(--surface-2)' }}>
      <div className="mb-1 flex items-center gap-2 text-xs">
        <span className="font-semibold text-accent">Line {line}</span>
        <code className="min-w-0 flex-1 truncate font-mono text-2xs text-ink-faint">{lineText.trim() || '(empty line)'}</code>
        <button className="rounded-sm p-0.5 text-ink-faint hover:text-ink" title="Close" onClick={onClose}><CloseIcon className="h-3.5 w-3.5" /></button>
      </div>

      {comments.map((c) => (
        <div key={c.id} className="mb-1 rounded-lg border border-line p-2" style={{ background: 'var(--paper)' }}>
          <p className="whitespace-pre-wrap text-xs">{c.comment}</p>
          <div className="mt-1 flex items-center gap-3 text-2xs text-ink-faint">
            <button className="hover:text-accent" onClick={() => onResend(c, false)} title="Queue into the composer">Add to prompt</button>
            <button className="hover:text-accent" onClick={() => onResend(c, true)} title="Send to the agent now">Run now</button>
            <button className="ml-auto hover:text-ink" onClick={() => onResolve(c.id)} title="Remove this comment">Resolve</button>
          </div>
        </div>
      ))}

      <textarea
        className="input min-h-[44px] resize-none text-xs"
        rows={2}
        placeholder="Comment on this line for the agent…"
        value={text}
        autoFocus
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); act('prompt'); } }}
      />
      <div className="mt-1 flex items-center justify-end gap-2 text-xs">
        <button className="btn btn-ghost py-1" disabled={!text.trim()} onClick={() => act('save')} title="Save as a note (no agent)">Save</button>
        <button className="btn btn-outline py-1" disabled={!text.trim()} onClick={() => act('prompt')}>Add to prompt</button>
        <button className="btn btn-primary py-1" disabled={!text.trim()} onClick={() => act('run')}>Run now</button>
      </div>
    </div>
  );
}
