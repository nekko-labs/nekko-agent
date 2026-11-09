import React, { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { SessionSummary } from '@nekko-agent/shared';
import { useStore, viewEnabled, type View } from '../store.js';
import { SHORTCUTS } from '../shortcuts.js';
import { Modal } from './primitives/index.js';
import { openFeedback } from './FeedbackSheet.js';
import { SIMPLE_ITEMS, simpleShown, simpleVisibility } from '@nekko-agent/shared';
import { useExpertMode, useLocalModelLoaded, useSimpleChoices } from '../simpleMode.js';
import { Toggle } from './primitives/Toggle.js';
import { openSettingsGroup, saveSettings, SETTINGS_INDEX, SETTINGS_PAGES, type SettingEntry } from '../settingsIndex.js';
import { finderAge, findTextFor } from '../views/chatFinder.js';
import { chatIndex, refreshChatIndex, staleChats, type IndexProgress } from '../views/chatFinderIndex.js';
import type { ArtifactEntry } from '../artifactsIndex.js';
import {
  PALETTE_FILTERS, highlight, literal, paletteTerms, searchPalette,
  type PaletteDoc, type PaletteFilter, type PaletteHit, type Term,
} from '../paletteSearch.js';

interface Command {
  id: string;
  label: string;
  /** The second row: what it does, in words people search for. */
  description: string;
  /** Shown at the right, usually the keyboard shortcut. */
  hint?: string;
  run: () => void;
}

/** What a row acts on. */
type RowData =
  | { type: 'command'; command: Command }
  | { type: 'page'; group: string }
  | { type: 'setting'; setting: SettingEntry }
  | { type: 'chat'; session: SessionSummary }
  | { type: 'message'; session: SessionSummary; messages: ReadonlyArray<{ id: string; text: string }> }
  | { type: 'artifact'; session?: SessionSummary; artifact: ArtifactEntry };

type Doc = PaletteDoc<RowData>;
type Hit = PaletteHit<RowData>;

/** Latest chats the palette lists before anything is typed. */
const RECENT_CHATS = 5;

/**
 * Ctrl/Cmd+K: search everything. Commands, Settings groups and individual
 * settings (each with its switch or choice, changed in place), chats, the
 * messages inside them and the artifacts they made, ranked by relevance with
 * messages last. Chips filter by type (Tab steps through them). Every row reads
 * as two lines: where the result lives, then the text it was found in, with
 * the matched words marked. Synonyms count ("prefs" finds Settings).
 */
export function CommandPalette() {
  const { paletteOpen, setPaletteOpen, setView, newChat, newTerminal, toggleContextPanel, settings } = useStore(
    useShallow((s) => ({
      paletteOpen: s.paletteOpen,
      setPaletteOpen: s.setPaletteOpen,
      setView: s.setView,
      newChat: s.newChat,
      newTerminal: s.newTerminal,
      toggleContextPanel: s.toggleContextPanel,
      settings: s.settings,
    })),
  );
  const sessions = useStore((s) => s.sessions);
  const providers = useStore((s) => s.providers);
  const hypergate = useStore((s) => s.hypergate);
  const hypergateConnected = useStore((s) => (s.settings?.mcpServers ?? []).some((m) => m.id === 'hypergate'));
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<PaletteFilter>('all');
  const [active, setActive] = useState(0);
  const [progress, setProgress] = useState<IndexProgress | null>(null);
  const [indexTick, setIndexTick] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [expert, setExpert] = useExpertMode();
  const [choices] = useSimpleChoices();
  const localLoaded = useLocalModelLoaded();
  const workspaces = settings?.workspaces ?? EMPTY;
  // Commands and settings answer every keystroke; the chat search can lag a frame behind.
  const deferredQuery = useDeferredValue(query);

  const commands = useMemo<Command[]>(() => {
    const go = (v: View, label: string, description: string): Command => ({ id: `go-${v}`, label, description, hint: 'Go to', run: () => setView(v) });
    return [
      { id: 'new-chat', label: 'New agent', description: 'Start a new chat with an agent', hint: SHORTCUTS.newAgent.label, run: () => newChat() },
      { id: 'new-terminal', label: 'New terminal', description: 'Open a shell in a new pane', hint: SHORTCUTS.newTerminal.label, run: () => newTerminal() },
      go('artifacts', 'Go to Library', 'Files, pictures and other artifacts your chats made'),
      go('skills', 'Go to Skills', 'Installed skills and the skill catalog'),
      go('models', 'Go to Models', 'Local and cloud models, providers and downloads'),
      go('modelserver', 'Go to Model Server', 'Run local models for other apps on this machine'),
      go('connectors', 'Go to Connectors', 'MCP servers and app integrations'),
      // Experimental destinations stay out of the palette while their flag is off.
      ...(viewEnabled('memory', settings) ? [go('memory', 'Go to Memory', 'Global and per-project memory')] : []),
      go('settings', 'Go to Settings', 'Every preference, in one page'),
      { id: 'toggle-context', label: 'Toggle context panel', description: 'Show or hide the panel beside the chat', run: () => toggleContextPanel() },
      { id: 'feedback', label: 'Send feedback', description: 'Report a bug or share an idea with the Nekko team', hint: 'Help', run: openFeedback },
      { id: 'mode', label: expert ? 'Switch to Simple' : 'Switch to Detailed', description: expert ? 'Everyday controls only' : 'Show every control', run: () => setExpert(!expert) },
      { id: 'simple-settings', label: 'Choose what Simple shows', description: 'Pick the controls Simple mode keeps', hint: 'Settings', run: () => openSettingsGroup('simple') },
      // Controls out of sight in this mode stay findable: Detailed-only ones
      // switch to Detailed, the rest open the setting that decides. One that
      // only waits for something to show (a change, a PR) is not out of sight.
      ...SIMPLE_ITEMS.filter((i) => i.platforms.includes('desktop') && !simpleShown(i.id, expert, choices, { localModel: localLoaded, changes: true, pr: true })).map((i): Command => {
        const v = simpleVisibility(i.id, choices);
        return v === 'expert'
          ? { id: `simple-${i.id}`, label: i.label, description: 'Shown in Detailed', run: () => setExpert(true) }
          : { id: `simple-${i.id}`, label: i.label, description: v === 'hide' ? 'Hidden in Settings' : 'Shows when relevant', run: () => openSettingsGroup('simple') };
      }),
      // Only when there is a daemon to reach: an entry that can only fail is
      // worse than no entry. Connected, it is the way back to the tab.
      ...(hypergate
        ? [{
            id: 'hypergate',
            label: hypergateConnected ? 'Open Hypergate' : 'Connect Hypergate',
            description: `The Hypergate daemon on port ${hypergate.port}`,
            run: () => {
              const s = useStore.getState();
              if (hypergateConnected) s.openHypergatePane();
              else void s.connectHypergate(hypergate.port);
            },
          }]
        : []),
    ];
  }, [setView, newChat, newTerminal, toggleContextPanel, hypergate, hypergateConnected, settings, expert, choices, localLoaded]);

  // Commands, Settings groups and settings: a fixed list, cheap to rebuild.
  const appDocs = useMemo<Doc[]>(() => {
    const pageLabel = (group: string) => SETTINGS_PAGES.find((p) => p.group === group)?.label ?? group;
    return [
      ...commands.map((command): Doc => ({ id: `command:${command.id}`, kind: 'command', title: command.label, crumbs: ['Commands'], context: command.description, data: { type: 'command', command } })),
      ...SETTINGS_PAGES.map((p): Doc => ({ id: `page:${p.group}`, kind: 'page', title: p.label, crumbs: ['Settings'], context: `Covers ${p.keywords}`, data: { type: 'page', group: p.group } })),
      ...(settings ? SETTINGS_INDEX : []).map((e): Doc => ({
        id: `setting:${e.id}`, kind: 'setting', title: e.label, crumbs: ['Settings', pageLabel(e.group)],
        context: e.keywords ? `Also matches ${e.keywords}` : e.control.kind === 'toggle' ? 'A switch: Enter flips it' : 'A choice: Enter steps through it',
        data: { type: 'setting', setting: e },
      })),
    ];
  }, [commands, settings]);

  // Chats, their messages and their artifacts: rebuilt as chats change or the transcript index fills.
  const chatDocs = useMemo(() => {
    const project = new Map(workspaces.map((w) => [w.id, w.name]));
    const provider = new Map(providers.map((p) => [p.id, p.label || p.id]));
    const index = chatIndex();
    const live = sessions.filter((s) => !s.incognito).sort((a, b) => b.updatedAt - a.updatedAt);
    const chats: Doc[] = [];
    const messages: Doc[] = [];
    const artifacts = new Map<string, Doc>();
    for (const s of live) {
      const title = s.title || 'Untitled chat';
      const folder = s.workspaceId ? project.get(s.workspaceId) : undefined;
      const description = [s.firstUserText, s.lastReplyText].filter((t): t is string => !!t?.trim());
      chats.push({
        id: `chat:${s.id}`, kind: 'chat', title, crumbs: folder ? ['Chats', folder] : ['Chats'],
        context: description[0] ?? '', body: description.map((text) => ({ text })),
        keywords: `${(s.providerId && provider.get(s.providerId)) || ''}${s.archivedAt ? ' completed' : ''}`,
        at: s.updatedAt, data: { type: 'chat', session: s },
      });
      const indexed = index.get(s.id);
      if (!indexed) continue;
      if (indexed.messages.length) {
        messages.push({ id: `message:${s.id}`, kind: 'message', title, crumbs: ['Messages'], body: indexed.messages, bodyOnly: true, at: s.updatedAt, data: { type: 'message', session: s, messages: indexed.messages } });
      }
      // One row per file: the newest chat that touched it owns it (chats are newest first).
      for (const a of indexed.artifacts) {
        const key = a.path.toLowerCase();
        const prev = artifacts.get(key);
        if (prev && (prev.at ?? 0) >= a.at) continue;
        artifacts.set(key, { id: `artifact:${key}`, kind: 'artifact', title: a.title, crumbs: ['Artifacts', title], context: `${a.filename} · ${a.path}`, at: a.at, data: { type: 'artifact', session: s, artifact: a } });
      }
    }
    return { chats, messages, artifacts: [...artifacts.values()].sort((a, b) => (b.at ?? 0) - (a.at ?? 0)) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, providers, workspaces, indexTick]);

  const typed = deferredQuery.trim().length > 0;
  const results = useMemo(() => {
    const docs = typed
      ? [...appDocs, ...chatDocs.chats, ...chatDocs.artifacts, ...chatDocs.messages]
      // Nothing typed: commands and the latest chats, or everything of the picked type.
      : filter === 'all' ? [...appDocs.filter((d) => d.kind === 'command'), ...chatDocs.chats.slice(0, RECENT_CHATS)]
        : [...appDocs, ...chatDocs.chats, ...chatDocs.artifacts];
    return searchPalette(docs, deferredQuery, filter);
  }, [appDocs, chatDocs, deferredQuery, filter, typed]);
  const hits = results.hits;
  const terms = useMemo(() => paletteTerms(deferredQuery), [deferredQuery]);

  // Read transcripts only when a search needs them; what is read stays for next time.
  const wantIndex = paletteOpen && (typed || filter === 'artifact');
  const sessionsKey = useMemo(() => sessions.map((s) => `${s.id}:${s.updatedAt}`).join('|'), [sessions]);
  useEffect(() => {
    if (!wantIndex) return;
    if (staleChats(sessions).length === 0) { setProgress(null); return; }
    const ctl = new AbortController();
    void refreshChatIndex(sessions, workspaces, (p) => {
      setProgress(p.done >= p.total ? null : p);
      setIndexTick((n) => n + 1);
    }, ctl.signal).catch(() => setProgress(null));
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantIndex, sessionsKey, workspaces]);

  useEffect(() => {
    if (paletteOpen) {
      setQuery('');
      setFilter('all');
      setActive(0);
    }
  }, [paletteOpen]);

  useEffect(() => { setActive(0); }, [deferredQuery, filter]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-palette-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!paletteOpen) return null;

  const openChat = (id: string, findText?: string) => {
    const s = useStore.getState();
    if (findText) useStore.setState({ findSeed: { sessionId: id, query: findText } });
    if (s.view !== 'command') setView('command');
    s.openChatPane(id);
  };

  /** Commands and chats run and close; a setting changes in place and the palette stays. */
  const choose = (hit?: Hit, back = false) => {
    const row = hit?.doc.data;
    if (!row) return;
    if (row.type === 'setting') {
      const { control } = row.setting;
      if (!settings) return;
      if (control.kind === 'toggle') { void saveSettings(control.set(!control.get(settings), settings)); return; }
      const at = control.options.findIndex((o) => o.value === control.get(settings));
      const next = control.options[(at + (back ? -1 : 1) + control.options.length) % control.options.length];
      void saveSettings(control.set(next.value, settings));
      return;
    }
    if (row.type === 'command') row.command.run();
    else if (row.type === 'page') openSettingsGroup(row.group);
    else if (row.type === 'chat') openChat(row.session.id);
    else if (row.type === 'artifact') openChat(row.artifact.sessionId);
    else {
      const message = hit!.bodyIndex !== undefined ? row.messages[hit!.bodyIndex] : undefined;
      openChat(row.session.id, message ? findTextFor(message.text, terms.map((t) => t.raw)) : undefined);
    }
    setPaletteOpen(false);
  };

  const stepFilter = (by: number) => {
    const at = PALETTE_FILTERS.findIndex((f) => f.id === filter);
    setFilter(PALETTE_FILTERS[(at + by + PALETTE_FILTERS.length) % PALETTE_FILTERS.length].id);
  };

  const now = Date.now();
  const emptyText = typed
    ? progress ? 'Still reading chats…' : 'Nothing matches. Try another word, or a different type.'
    : filter === 'message' ? 'Type to search inside every message.' : 'Nothing here yet.';

  return (
    <Modal
      title="Command palette"
      description="Search commands, settings, chats, messages and artifacts. Tab changes the type filter. Enter runs the highlighted result, or flips or steps the highlighted setting."
      onClose={() => setPaletteOpen(false)}
      align="top"
      initialFocus={inputRef}
      className="card w-[640px] max-w-[calc(100vw-16px)] overflow-hidden p-0 shadow-(--shadow-float)"
    >
      <input
        ref={inputRef}
        className="w-full border-b border-line bg-transparent px-4 py-3 text-sm outline-hidden"
        placeholder="Search commands, settings, chats, messages…"
        role="combobox"
        aria-expanded
        aria-controls={listId}
        aria-activedescendant={hits[active] ? `${listId}-${active}` : undefined}
        aria-label="Search everything"
        spellCheck={false}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, hits.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          else if (e.key === 'Tab') { e.preventDefault(); stepFilter(e.shiftKey ? -1 : 1); }
          else if (e.key === 'Enter') { e.preventDefault(); choose(hits[active], e.shiftKey); }
        }}
      />
      <div className="flex items-center gap-1 overflow-x-auto px-3 pb-1 pt-2" role="tablist" aria-label="Filter by type" data-palette-filters>
        {PALETTE_FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={filter === f.id}
            tabIndex={-1}
            data-palette-filter={f.id}
            className={`chat-finder-chip flex shrink-0 items-center gap-1 ${filter === f.id ? 'is-on' : ''}`}
            onClick={() => { setFilter(f.id); inputRef.current?.focus(); }}
          >
            {f.label}
            {typed && <span className="tabular-nums opacity-70" data-palette-count={f.id}>{results.counts[f.id]}</span>}
          </button>
        ))}
      </div>
      {progress && (
        <p className="flex items-center gap-2 px-4 pb-1 text-2xs text-ink-faint" data-palette-indexing aria-live="polite">
          <span className="chat-finder-spinner" aria-hidden />
          Reading chats {progress.done} of {progress.total}; results so far
        </p>
      )}
      <div ref={listRef} id={listId} role="listbox" aria-label="Results" className="max-h-[min(460px,60vh)] overflow-y-auto px-1 pb-1">
        {hits.length === 0 && <div className="px-3 py-3 text-sm text-ink-faint">{emptyText}</div>}
        {hits.map((hit, i) => (
          <ResultRow key={hit.doc.id} hit={hit} index={i} active={i === active} listId={listId} terms={terms} now={now}
            settings={settings} onHover={() => setActive(i)} onChoose={() => choose(hit)} />
        ))}
        {results.moreMessages > 0 && (
          <button type="button" tabIndex={-1} className="w-full px-3 py-2 text-left text-2xs text-accent hover:underline" data-palette-more-messages onClick={() => { setFilter('message'); inputRef.current?.focus(); }}>
            {results.moreMessages} more chat{results.moreMessages === 1 ? '' : 's'} with matching messages. Show all messages
          </button>
        )}
      </div>
    </Modal>
  );
}

const EMPTY: never[] = [];

function Marked({ text, terms }: { text: string; terms: readonly Term[] }) {
  return <>{highlight(text, terms).map((s, i) => (s.hit ? <mark key={i} className="palette-mark">{s.text}</mark> : <React.Fragment key={i}>{s.text}</React.Fragment>))}</>;
}

/** One result: the breadcrumb on top, the text it was found in below, the action or control at the right. */
function ResultRow({ hit, index, active, listId, terms, now, settings, onHover, onChoose }: {
  hit: Hit; index: number; active: boolean; listId: string; terms: readonly Term[]; now: number;
  settings: ReturnType<typeof useStore.getState>['settings'];
  onHover: () => void; onChoose: () => void;
}) {
  const { doc } = hit;
  const row = doc.data!;
  // Text cut from a message or description matches only what was typed, so only that is marked there.
  const contextTerms = hit.bodyIndex !== undefined ? literal(terms) : terms;
  const isSetting = row.type === 'setting';
  const right = (() => {
    if (row.type === 'setting') {
      const control = row.setting.control;
      if (!settings) return null;
      return control.kind === 'toggle'
        ? <Toggle label={row.setting.label} value={control.get(settings)} onChange={(v) => void saveSettings(control.set(v, settings))} />
        : <select className="input max-w-[180px] shrink-0 py-1 text-xs" aria-label={row.setting.label} value={control.get(settings)} tabIndex={-1}
            onChange={(ev) => void saveSettings(control.set(ev.target.value, settings))} onClick={(ev) => ev.stopPropagation()}>
            {control.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>;
    }
    if (row.type === 'command') return row.command.hint ? <span className="shrink-0 text-2xs text-ink-faint">{row.command.hint}</span> : null;
    if (row.type === 'page') return <span className="shrink-0 text-2xs text-ink-faint">Open</span>;
    return (
      <span className="flex shrink-0 items-center gap-2">
        {row.type === 'message' && hit.bodyCount ? <span className="chat-finder-badge tabular-nums" data-palette-message-count>{hit.bodyCount} message{hit.bodyCount === 1 ? '' : 's'}</span> : null}
        {row.type !== 'artifact' && row.session.archivedAt ? <span className="text-2xs text-ink-faint">Completed</span> : null}
        {doc.at ? <span className="text-2xs tabular-nums text-ink-faint">{finderAge(doc.at, now)}</span> : null}
      </span>
    );
  })();
  return (
    <div
      id={`${listId}-${index}`}
      role="option"
      aria-selected={active}
      data-palette-index={index}
      data-palette-kind={doc.kind}
      data-palette-id={doc.id}
      {...(isSetting ? { 'data-palette-setting': (row as { setting: SettingEntry }).setting.id } : {})}
      className={`palette-row flex w-full cursor-default items-center gap-3 rounded-lg px-3 py-1.5 text-left ${active ? 'is-active' : ''}`}
      onMouseMove={() => { if (!active) onHover(); }}
      onClick={(e) => {
        // A setting's own switch or menu handles its click; the row does not also flip it.
        if (isSetting && (e.target as HTMLElement).closest('button, select, input')) return;
        onChoose();
      }}
    >
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-1 truncate" data-palette-crumbs>
          {doc.crumbs.map((c, i) => (
            <React.Fragment key={i}>
              <span className="max-w-[45%] shrink-0 truncate text-xs text-ink-faint" dir="auto"><Marked text={c} terms={terms} /></span>
              <span className="shrink-0 text-xs text-ink-faint" aria-hidden>›</span>
            </React.Fragment>
          ))}
          <span className="min-w-0 truncate text-sm text-ink" dir="auto" data-palette-title><Marked text={doc.title} terms={terms} /></span>
        </span>
        {hit.context && (
          <span className="block truncate text-2xs text-ink-faint" dir="auto" data-palette-context>
            <Marked text={hit.context} terms={contextTerms} />
          </span>
        )}
      </span>
      {right}
    </div>
  );
}
