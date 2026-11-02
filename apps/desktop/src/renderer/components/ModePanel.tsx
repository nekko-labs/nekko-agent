import React, { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { ChatMode, EffortLevel, ExecutionMode, ModelScope, GuidanceLevel, ChatMemory, SavedMode, SavedModeIcon, Session, ToolApproach, WorkModeId } from '@nekko-agent/shared';
import {
  CONNECTOR_CATALOG, WORK_MODES, chatEffort, modelDefaultEffort, chatModelScope, defaultSavedMode, getExecutionMode, getSessionWorkspaceIds, getWorkMode, matchSavedMode, newSavedModeId,
  modePatchSkips, savedModeSummary, savedModes, sessionModeOptions, sessionPatchForMode,
} from '@nekko-agent/shared';
import { useStore } from '../store.js';
import { addFolderToChat, applyFolderSelection, withExcluded } from '../sessionFolders.js';
import { EFFORT_LABEL, effortRungs } from './ChatMetrics.js';
import { ToolsList, toolCounts, useChatTools } from './ChatControls.js';
import {
  BoltIcon, BrainIcon, CapIcon, CheckIcon, CodeIcon, ChevronIcon, CloseIcon, CloudIcon, CompassIcon, CubeIcon, DialIcon, DocTextIcon, EffortBarsIcon,
  ExternalIcon, FileIcon, FolderIcon, GaugeIcon, ListIcon, GlobeIcon, GlobeOffIcon, HandIcon, IncognitoIcon, LaptopIcon, LockIcon, PlugIcon, PlusIcon,
  RouteIcon, ServerIcon, ShieldCheckIcon, ShieldIcon, SparkleIcon, StarIcon, WorktreeIcon, WrenchIcon, BoltIcon as YoloIcon,
} from '../icons.js';

const WORKTREE_DOCS = 'https://git-scm.com/docs/git-worktree';
export const CODE_MODE_DOCS = 'https://nekkoagent.com/docs/code-mode';

/** The two ways a chat's tools reach the model, as the Tools flyout offers them. */
const TOOL_APPROACHES: Array<{ id: ToolApproach; label: string; description: string; isNew?: boolean }> = [
  { id: 'list', label: 'Tool list', description: 'Every tool is offered by name with its full definition, on every model call, and every result comes back through the model.' },
  { id: 'code', label: 'Code mode', isNew: true, description: 'The model writes JavaScript that calls your tools in a sandbox. It looks up a tool\'s definition only when it needs it, and only what the code returns reaches the model, so long tool lists and big results cost far fewer tokens. Each call is still approved and guarded.' },
];

export const SAVED_MODE_GLYPH: Record<SavedModeIcon, (p: { className?: string }) => React.ReactElement> = {
  bolt: BoltIcon, dial: DialIcon, incognito: IncognitoIcon, box: CubeIcon, cap: CapIcon, sparkle: SparkleIcon, shield: ShieldIcon, 'globe-off': GlobeOffIcon,
  cloud: CloudIcon, route: RouteIcon, laptop: LaptopIcon,
};

const MODEL_SCOPE_DESC: Record<ModelScope | 'any', string> = {
  cloud: 'Cloud providers only. A model on this machine is refused.',
  fusion: 'Auto picks per turn and may move a turn between local and cloud models: never a weaker one, local counts as free.',
  local: 'Models on this machine only, with the internet off. Nothing leaves your computer.',
  any: 'Any provider you pick. Choose one to pin where this chat\'s models run.',
};

/** Why a mode or scope could not be applied as is to a chat on this model. */
const SKIP_NOTE = {
  offline: 'This chat is on a cloud model, so the internet stays on. Pick a local model to keep it on this machine.',
  cloudOnly: 'This chat is on a local model, so Cloud only is not set. Pick a cloud model first.',
};

/** Tell the open chat pane its model changed (Auto on), as the model picker does. */
const announceBrain = (s: Session | null) => {
  if (s) window.dispatchEvent(new CustomEvent('nekko-session-brain', { detail: { id: s.id, session: s } }));
};

const MEMORY_DESC: Record<ChatMemory, string> = {
  all: 'Your global notes and the notes for this chat\'s folders.',
  project: 'Only the notes for this chat\'s folders.',
  off: 'No memory notes in this chat.',
};

const GUIDANCE_DESC: Record<GuidanceLevel, string> = {
  rules: 'AGENTS.md and its kin, plus the rule folders of Cursor, Claude, Kiro, Windsurf and Copilot. Scoped rules load when they apply.',
  root: 'Only AGENTS.md, CLAUDE.md and the other guideline files at each folder\'s root.',
  off: 'No project guidance. For a repository whose instructions you do not trust.',
};

const APPROVAL_DESC: Record<ChatMode, string> = {
  ask: 'Asks before every file write and command.',
  guardrails: 'Edits files and runs read-only commands freely; asks before any other command.',
  yolo: 'Never asks (deny rules still block). Pair it with a sandbox or worktree.',
};

/** The saved mode each chat was last put in, so an edited chat can offer Update and Revert. */
const lastApplied = new Map<string, string>();

type Deps = {
  session: Session;
  isCloudModel: boolean;
  onChange: (s: Session | null) => void;
  /** Sandbox needs its setup dialog (image, consent) before a chat can move in. */
  onSandboxSetup: () => void;
};

const toastError = (e: unknown) => useStore.getState().pushToast('error', String(e));

/**
 * Everything the panel writes, kept out of the component so each write can be
 * tested on its own. Per-chat settings (effort, MCP servers and connectors
 * included) go through setSessionOptions; saved modes are app settings.
 */
export function modePanelActions({ session, isCloudModel, onChange, onSandboxSetup }: Deps) {
  const settings = () => useStore.getState().settings;
  const saveSettings = async (patch: Parameters<typeof window.nekko.updateSettings>[0]) => {
    await window.nekko.updateSettings(patch);
    await useStore.getState().refreshSettings();
  };
  const patchChat = async (patch: Partial<Session>) => {
    const next = await window.nekko.setSessionOptions(session.id, patch as never);
    onChange(next);
    return next;
  };
  return {
    /** Local machine (with or without a worktree) or Sandbox. Also the default for new chats, as before. */
    async setExecution(executionMode: ExecutionMode) {
      if (executionMode === 'sandbox') { onSandboxSetup(); return; }
      try {
        await patchChat({ executionMode, gitIsolation: executionMode === 'worktree' });
        await saveSettings({ defaultExecutionMode: executionMode, gitManagement: { ...settings()?.gitManagement, mode: executionMode === 'worktree' ? 'worktree' : 'shared' } });
      } catch (e) { toastError(e); }
    },
    /** Approvals for this chat; saved as the default only once the chat took it. */
    async setApprovals(mode: ChatMode) {
      try {
        const next = await patchChat({ mode });
        if (next) await saveSettings({ defaultChatMode: mode });
      } catch (e) { toastError(e); }
    },
    async toggle(key: 'incognito' | 'offline') {
      if (key === 'offline' && isCloudModel && !session.offline) return;
      try { await patchChat({ [key]: !session[key] }); } catch (e) { toastError(e); }
    },
    async setWorkMode(workMode: WorkModeId) {
      try { await patchChat({ workMode }); } catch (e) { toastError(e); }
    },
    /** This chat's effort; `null` goes back to the app-wide one. */
    async setEffort(effort: EffortLevel | null) {
      try {
        const next = await patchChat({ effort: effort as EffortLevel });
        if (next && effort) await saveSettings({ effort });
      } catch (e) { toastError(e); }
    },
    /** Which memory notes this chat takes. */
    async setMemory(memory: ChatMemory) {
      try { await patchChat({ memory }); } catch (e) { toastError(e); }
    },
    /** How much project guidance this chat takes. */
    async setGuidance(guidance: GuidanceLevel) {
      try { await patchChat({ guidance }); } catch (e) { toastError(e); }
    },
    /** A tool list, or code mode, for this chat's turns. */
    async setToolApproach(toolApproach: ToolApproach) {
      try { await patchChat({ toolApproach }); } catch (e) { toastError(e); }
    },
    /** Offer or withhold one MCP server's tools in this chat. It keeps running for other chats. */
    async setMcpServer(id: string, on: boolean) {
      const off = new Set(session.disabledMcpServers ?? []);
      if (on) off.delete(id); else off.add(id);
      try { await patchChat({ disabledMcpServers: [...off].sort() }); } catch (e) { toastError(e); }
    },
    /** Read or skip one connector's context in this chat. */
    async setConnector(kind: string, on: boolean) {
      const off = new Set(session.disabledConnectors ?? []);
      if (on) off.delete(kind); else off.add(kind);
      try { await patchChat({ disabledConnectors: [...off].sort() }); } catch (e) { toastError(e); }
    },
    /**
     * Pin where this chat's models run, or (`null`) stop pinning. Local needs a
     * local model and Cloud only a cloud one; the chat is not switched for them.
     */
    async setModelScope(scope: ModelScope | null) {
      const info = (m: string) => useStore.getState().pushToast('info', m);
      if (scope === 'local' && isCloudModel) { info(SKIP_NOTE.offline); return; }
      if (scope === 'cloud' && !isCloudModel) { info(SKIP_NOTE.cloudOnly); return; }
      const now = chatModelScope(session);
      const patch: Partial<Session> = scope === 'cloud' ? { cloudOnly: true, offline: false }
        : scope === 'local' ? { offline: true, cloudOnly: false }
        : scope === 'fusion' ? { offline: false, cloudOnly: false, autoModel: true, autoProviderSwitch: true }
        : now === 'local' ? { offline: false } : now === 'cloud' ? { cloudOnly: false } : now === 'fusion' ? { autoProviderSwitch: false } : {};
      try {
        const next = await patchChat(patch);
        if (patch.autoModel) announceBrain(next);
      } catch (e) { toastError(e); }
    },
    /** Put this chat in a saved mode: one per-chat write, then the sandbox dialog if it needs one. */
    async applyMode(mode: SavedMode) {
      const patch = sessionPatchForMode(mode.options, { cloudModel: isCloudModel });
      const skipped = modePatchSkips(mode.options, { cloudModel: isCloudModel });
      const intoSandbox = mode.options.executionMode === 'sandbox' && getExecutionMode(session) !== 'sandbox';
      if (intoSandbox) { delete patch.executionMode; delete patch.gitIsolation; delete patch.mode; }
      try {
        const next = await patchChat(patch);
        lastApplied.set(session.id, mode.id);
        if (patch.autoModel) announceBrain(next);
        if (skipped) useStore.getState().pushToast('info', SKIP_NOTE[skipped]);
        if (intoSandbox) onSandboxSetup();
      } catch (e) { toastError(e); }
    },
    async saveMode(name: string, makeDefault: boolean) {
      const modes = savedModes(settings());
      const mode: SavedMode = { id: newSavedModeId(name, modes), name: name.trim() || 'New mode', icon: 'sparkle', options: sessionModeOptions(session, settings()) };
      lastApplied.set(session.id, mode.id);
      try { await saveSettings({ savedModes: [...modes, mode], ...(makeDefault ? { defaultSavedModeId: mode.id } : {}) }); } catch (e) { toastError(e); }
      return mode;
    },
    async updateMode(id: string) {
      const modes = savedModes(settings()).map((m) => (m.id === id ? { ...m, options: sessionModeOptions(session, settings()) } : m));
      try { await saveSettings({ savedModes: modes }); } catch (e) { toastError(e); }
    },
    async deleteMode(id: string) {
      const s = settings();
      try { await saveSettings({ savedModes: savedModes(s).filter((m) => m.id !== id), ...(s?.defaultSavedModeId === id ? { defaultSavedModeId: undefined } : {}) }); } catch (e) { toastError(e); }
    },
    /** Star a mode as the start for new chats; starring the default again clears it. */
    async toggleDefault(id: string) {
      const s = settings();
      try { await saveSettings({ savedModes: savedModes(s), defaultSavedModeId: s?.defaultSavedModeId === id ? undefined : id }); } catch (e) { toastError(e); }
    },
  };
}

/** The saved mode a chat is in, or the one it was last put in (for Update/Revert). */
export function chatModeState(session: Session, settings: Parameters<typeof savedModes>[0] & Parameters<typeof sessionModeOptions>[1]) {
  const modes = savedModes(settings);
  const current = sessionModeOptions(session, settings);
  const active = matchSavedMode(modes, current);
  const last = modes.find((m) => m.id === lastApplied.get(session.id));
  return { modes, current, active, edited: active ? undefined : last };
}

type Fly = 'tools' | 'mcp' | 'connectors' | 'skills';

/**
 * The composer's Mode panel: saved modes down a rail on the left, then every
 * per-chat setting in three columns (Environment and Model, Privacy,
 * Approach). Tools, MCP servers, Connectors and Skills open a list out the side.
 */
export function ModePanel({
  session, isCloudModel, modelId, onChange, onSandboxSetup, style, panelRef,
}: Deps & { modelId?: string; style?: React.CSSProperties; panelRef?: React.Ref<HTMLDivElement> }) {
  const settings = useStore((s) => s.settings);
  const tools = useChatTools();
  const [fly, setFly] = useState<Fly | null>(null);
  const [saving, setSaving] = useState<{ name: string; makeDefault: boolean } | null>(null);
  const [flyStyle, setFlyStyle] = useState<React.CSSProperties>({});
  const anchors = useRef<Partial<Record<Fly, HTMLButtonElement | null>>>({});
  const panel = useRef<HTMLDivElement | null>(null);
  const actions = modePanelActions({ session, isCloudModel, onChange, onSandboxSetup });
  const { modes, current, active, edited } = chatModeState(session, settings);
  const defaultId = defaultSavedMode(settings)?.id;
  const execution = getExecutionMode(session);
  const sandbox = execution === 'sandbox';
  const workMode = getWorkMode(session.workMode);
  const narrow = typeof window !== 'undefined' && window.innerWidth < 720;

  // A flyout sits out the panel's side when there is room, else beside its row.
  useLayoutEffect(() => {
    if (!fly || narrow) return;
    const place = () => {
      const a = anchors.current[fly]?.getBoundingClientRect(), p = panel.current?.getBoundingClientRect();
      if (!a || !p) return;
      const w = 320, vw = window.innerWidth, vh = window.innerHeight;
      const left = p.right + 8 + w <= vw - 8 ? p.right + 8 : a.right + 6 + w <= vw - 8 ? a.right + 6 : Math.max(8, a.left - w - 6);
      const maxHeight = Math.min(480, vh - 16);
      setFlyStyle({ left, width: w, maxHeight, top: Math.max(8, Math.min(a.top - 10, vh - maxHeight - 8)) });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [fly, narrow]);

  const toggleFly = (f: Fly) => setFly((o) => (o === f ? null : f));
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    if (fly) { e.stopPropagation(); setFly(null); anchors.current[fly]?.focus({ preventScroll: true }); }
    else if (saving) { e.stopPropagation(); setSaving(null); }
  };

  const { enabled: toolsOn, usable: toolsUsable } = toolCounts(session, tools);
  const mcpServers = settings?.mcpServers ?? [];
  const workspaces = settings?.workspaces ?? [];
  const folders = getSessionWorkspaceIds(session).map((id) => ({ id, folder: workspaces.find((w) => w.id === id) }));
  const rungs = effortRungs(chatEffort(session, settings?.effort) ?? 'normal', modelId);
  const mcpOff = new Set(session.disabledMcpServers ?? []);
  const mcpOn = mcpServers.filter((s) => s.enabled && !mcpOff.has(s.id)).length;
  const connected = (settings?.connectors ?? []).filter((c) => c.connected);
  const connectorsOff = new Set(session.disabledConnectors ?? []);
  const connectorsOn = connected.filter((c) => !connectorsOff.has(c.kind)).length;
  const goTo = (view: 'settings' | 'connectors') => { setFly(null); useStore.getState().setView(view); };
  /** One per-chat switch row in a flyout. */
  const flyItem = (key: string, title: string, sub: string, on: boolean, set: (on: boolean) => void, disabled = false, data: Record<string, string> = {}) => (
    <div key={key} className={`mode-row ${disabled ? 'is-disabled' : ''}`} {...data}>
      <span className="min-w-0 flex-1"><span className="mode-t">{title}</span><span className="mode-s">{sub}</span></span>
      {sw(on && !disabled, () => set(!on), `${title} in this chat`, disabled)}
    </div>
  );

  const approach: ToolApproach = sandbox ? 'list' : session.toolApproach ?? 'list';
  const flyBody = (f: Fly) => f === 'tools'
    ? <>
        <ToolApproachPicker approach={approach} sandbox={sandbox} onPick={(a) => void actions.setToolApproach(a)} />
        <p className="mode-group">{approach === 'code' ? 'Tools code can call' : 'Tools'}</p>
        <ToolsList session={session} onChange={onChange} tools={tools} />
      </>
    : f === 'mcp'
      ? <>
          {sandbox ? <p className="mode-note">MCP is unavailable in Sandbox.</p>
            : session.offline ? <p className="mode-note">Internet is blocked for this chat, so MCP servers are off.</p>
            : <p className="mode-note">Which servers' tools this chat sees. A server switched off here keeps running for other chats.</p>}
          {mcpServers.length === 0 && <p className="mode-note">No MCP servers yet.</p>}
          {mcpServers.map((m) => flyItem(m.id, m.name, !m.enabled ? 'Off in Settings for every chat' : m.url != null ? 'http' : 'stdio', !mcpOff.has(m.id),
            (on) => void actions.setMcpServer(m.id, on), sandbox || !!session.offline || !m.enabled, { 'data-chat-mcp': m.id }))}
          <button className="mode-link" onClick={() => goTo('settings')}>Add or turn off servers for every chat in Settings</button>
        </>
      : f === 'connectors'
        ? <>
          {sandbox ? <p className="mode-note">Connectors are off in Sandbox.</p>
            : session.offline ? <p className="mode-note">Internet is blocked for this chat, so connectors are off.</p>
            : <p className="mode-note">Connected services add a few recent items to this chat's context. Switch off the ones this chat should not read.</p>}
          {connected.length === 0 && <p className="mode-note">No connectors connected yet.</p>}
          {connected.map((c) => flyItem(c.kind, CONNECTOR_CATALOG.find((m) => m.kind === c.kind)?.label ?? c.kind, 'Connected', !connectorsOff.has(c.kind),
            (on) => void actions.setConnector(c.kind, on), sandbox || !!session.offline, { 'data-chat-connector': c.kind }))}
          <button className="mode-link" onClick={() => goTo('connectors')}>Connect or disconnect services</button>
        </>
      : <div role="radiogroup" aria-label="Work mode">
          <p className="mode-group">Work mode</p>
          {WORK_MODES.map((m) => (
            <button key={m.id} role="radio" aria-checked={workMode.id === m.id} data-work-mode={m.id} className="mode-opt" onClick={() => void actions.setWorkMode(m.id)}>
              <span className="mode-opt-ic">{m.id === 'default' ? <SparkleIcon /> : m.id === 'better-review' ? <ShieldCheckIcon /> : m.id === 'design' ? <CompassIcon /> : <DialIcon />}</span>
              <span className="min-w-0 flex-1">
                <span className="mode-t">{m.label}{workMode.id === m.id && <CheckIcon className="h-3.5 w-3.5 text-accent" />}</span>
                <span className="mode-s">{m.description}{m.cost ? ` ${m.cost}.` : ''}</span>
                {m.skills.length > 0 && <span className="mode-path">{m.skills.map((n) => `/${n}`).join('  ')}</span>}
              </span>
            </button>
          ))}
          <p className="mode-note">Picking skills one by one, per chat, is coming.</p>
        </div>;

  const FLY_TITLE: Record<Fly, [string, ReactNode]> = { tools: ['Tools', <WrenchIcon />], mcp: ['MCP servers', <ServerIcon />], connectors: ['Connectors', <PlugIcon />], skills: ['Skills', <SparkleIcon />] };
  const flyRow = (f: Fly, icon: ReactNode, title: string, meta: string) => (<>
    <button ref={(el) => { anchors.current[f] = el; }} className={`mode-row mode-row-btn ${fly === f ? 'is-open' : ''}`} aria-expanded={fly === f} aria-haspopup="dialog" data-mode-fly={f} onClick={() => toggleFly(f)}>
      <span className="mode-ic">{icon}</span>
      <span className="mode-t min-w-0 flex-1">{title}</span>
      <span className="mode-meta">{meta}</span>
      <ChevronIcon className={`mode-chev ${narrow && fly === f ? 'rotate-90' : ''}`} />
    </button>
    {narrow && fly === f && <div className="mode-inline-fly">{flyBody(f)}</div>}
  </>);
  const soon = (icon: ReactNode, title: string, sub: string) => (
    <div className="mode-row is-disabled" aria-disabled="true">
      <span className="mode-ic">{icon}</span>
      <span className="min-w-0 flex-1"><span className="mode-t">{title} <span className="mode-badge">Coming soon</span></span><span className="mode-s">{sub}</span></span>
    </div>
  );
  const sw = (on: boolean, onClick: () => void, label: string, disabled = false) => (
    <button role="switch" aria-checked={on} aria-label={label} className="mode-switch" disabled={disabled} onClick={onClick} />
  );
  const tiles = <T extends string>(label: string, value: T, options: Array<[T, string, ReactNode, Record<string, string>?]>, pick: (v: T) => void) => (
    <div className="mode-tiles" role="radiogroup" aria-label={label}>
      {options.map(([v, l, icon, data]) => (
        <button key={v} role="radio" aria-checked={value === v} onClick={() => pick(v)} {...data}>{icon}<span>{l}</span></button>
      ))}
    </div>
  );
  const approvals: ChatMode = current.mode;
  const scope = chatModelScope(session);

  return (<>
    <div ref={(el) => { panel.current = el; if (typeof panelRef === 'function') panelRef(el); else if (panelRef) (panelRef as React.MutableRefObject<HTMLDivElement | null>).current = el; }}
      style={style} className="mode-panel card fixed z-[100] shadow-(--shadow-float)" role="dialog" aria-label="Mode" data-mode-panel onKeyDown={onKeyDown}>
      <div className="mode-rail" role="radiogroup" aria-label="Saved modes">
        <p className="mode-sec">Saved modes</p>
        {modes.map((m) => {
          const Glyph = SAVED_MODE_GLYPH[m.icon] ?? SparkleIcon;
          const isDefault = m.id === defaultId;
          return (
            <div key={m.id} className="mode-rail-item" aria-checked={active?.id === m.id} role="radio" tabIndex={0} data-saved-mode={m.id}
              title={`${m.name}: ${savedModeSummary(m.options) || 'local'}`}
              onClick={() => void actions.applyMode(m)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void actions.applyMode(m); } }}>
              <span className="mode-glyph"><Glyph /></span>
              <span className="min-w-0 flex-1"><span className="mode-rail-n">{m.name}</span><span className="mode-rail-d">{savedModeSummary(m.options) || 'local'}</span></span>
              <button className={`mode-star ${isDefault ? 'is-on' : ''}`} aria-label={isDefault ? `${m.name} is the default for new chats` : `Use ${m.name} for new chats`} title={isDefault ? 'Default for new chats (click to clear)' : 'Use for new chats'}
                onClick={(e) => { e.stopPropagation(); void actions.toggleDefault(m.id); }}><StarIcon filled={isDefault} /></button>
            </div>
          );
        })}
        <span className="flex-1" />
        <button className="mode-rail-item" onClick={() => setSaving({ name: '', makeDefault: false })}><span className="mode-glyph"><PlusIcon /></span><span className="mode-rail-n">New mode</span></button>
      </div>

      <div className="mode-main">
        <div className="mode-head">
          <h2>{active?.name ?? 'Custom'}{active && active.id === defaultId && <span className="mode-badge is-accent">Default</span>}</h2>
          {saving ? (
            <form className="mode-save" onSubmit={(e) => { e.preventDefault(); void actions.saveMode(saving.name, saving.makeDefault); setSaving(null); }}>
              <input className="input" autoFocus placeholder="Name this mode" maxLength={32} value={saving.name} aria-label="Mode name" onChange={(e) => setSaving({ ...saving, name: e.target.value })} />
              <label><input type="checkbox" checked={saving.makeDefault} onChange={(e) => setSaving({ ...saving, makeDefault: e.target.checked })} /> Use for new chats</label>
              <button type="submit" className="mode-btn is-primary">Save</button>
              <button type="button" className="mode-btn" onClick={() => setSaving(null)}>Cancel</button>
            </form>
          ) : (
            <div className="mode-save">
              {!active && <span className="mode-dirty">{edited ? `Changed from ${edited.name}` : 'Not a saved mode'}</span>}
              {!active && edited && <button className="mode-btn" onClick={() => void actions.applyMode(edited)}>Revert</button>}
              {!active && edited && <button className="mode-btn" onClick={() => void actions.updateMode(edited.id)}>Update “{edited.name}”</button>}
              {active && <button className="mode-btn" onClick={() => void actions.deleteMode(active.id)} aria-label={`Delete ${active.name}`}><CloseIcon className="h-3 w-3" /> Delete</button>}
              <button className={`mode-btn ${active ? '' : 'is-primary'}`} onClick={() => setSaving({ name: '', makeDefault: false })}><PlusIcon className="h-3 w-3" /> {active ? 'Save as new' : 'Save mode'}</button>
            </div>
          )}
        </div>

        <div className="mode-scroll"><div className="mode-grid">
          <section className="mode-col" aria-label="Environment and model">
            <p className="mode-sec"><CubeIcon /> Environment</p>
            <div className="mode-row is-stacked">
              <span className="mode-ic">{sandbox ? <CubeIcon /> : <LaptopIcon />}</span>
              <span className="min-w-0 flex-1"><span className="mode-t">Run on</span><span className="mode-s">{sandbox ? 'A local container. Only scoped files and bash; host previews, hooks and MCP are off.' : 'Your machine, with your shell, apps and credentials.'}</span></span>
              {tiles<'local' | 'sandbox'>('Run on', sandbox ? 'sandbox' : 'local', [['local', 'Local machine', <LaptopIcon />, { 'data-execution': 'local' }], ['sandbox', 'Sandbox', <CubeIcon />, { 'data-execution': 'sandbox' }]],
                (v) => void (v === 'sandbox' ? (sandbox ? onSandboxSetup() : actions.setExecution('sandbox')) : sandbox && actions.setExecution(session.gitIsolation === false ? 'unified' : 'worktree')))}
            </div>
            <div className={`mode-row ${sandbox ? 'is-disabled' : ''}`}>
              <span className="mode-ic"><WorktreeIcon /></span>
              <span className="min-w-0 flex-1"><span className="mode-t">Use worktrees</span>
                <span className="mode-s">{sandbox ? 'Not needed in Sandbox, which already works on a copy.' : <>Edits land in a separate Git checkout, so your branch stays clean. <a href={WORKTREE_DOCS} onClick={(e) => { e.preventDefault(); void window.nekko.openPath(WORKTREE_DOCS); }}>What's a worktree? <ExternalIcon className="inline h-2.5 w-2.5" /></a></>}</span>
              </span>
              {sw(execution === 'worktree', () => void actions.setExecution(execution === 'worktree' ? 'unified' : 'worktree'), 'Use worktrees', sandbox)}
            </div>
            {sandbox && <button className="mode-link" onClick={onSandboxSetup}>Sandbox setup</button>}

            <p className="mode-sec is-sub"><DialIcon /> Model</p>
            <div className="mode-row is-stacked">
              <span className="mode-ic">{scope === 'cloud' ? <CloudIcon /> : scope === 'local' ? <LaptopIcon /> : <RouteIcon />}</span>
              <span className="min-w-0 flex-1"><span className="mode-t">Models run</span><span className="mode-s">{MODEL_SCOPE_DESC[scope ?? 'any']}</span></span>
              {tiles<ModelScope | 'any'>('Models run', scope ?? 'any', [['cloud', 'Cloud only', <CloudIcon />, { 'data-model-scope': 'cloud' }], ['fusion', 'Fusion', <RouteIcon />, { 'data-model-scope': 'fusion' }], ['local', 'Local only', <LaptopIcon />, { 'data-model-scope': 'local' }]],
                (v) => void actions.setModelScope(v === scope ? null : v as ModelScope))}
            </div>
            {soon(<RouteIcon />, 'Model router', 'Picks the model for each turn from what the task needs.')}
            <div className="mode-row is-stacked">
              <span className="mode-ic"><GaugeIcon /></span>
              <span className="min-w-0 flex-1"><span className="mode-t">Effort</span><span className="mode-s">How long the model thinks before acting. Your choice is remembered for new chats on this computer. Recommended: {EFFORT_LABEL[modelDefaultEffort(modelId)]}.</span></span>
              {tiles<EffortLevel>('Effort', rungs.options[rungs.index], rungs.options.map((o, i) => [o, o === 'xhigh' ? 'X-high' : EFFORT_LABEL[o], <EffortBarsIcon level={Math.max(1, Math.round(((i + 1) / rungs.options.length) * 4))} />, { 'data-effort': o }]),
                (v) => void actions.setEffort(v))}
            </div>
          </section>

          <section className="mode-col" aria-label="Privacy">
            <p className="mode-sec"><LockIcon /> Privacy</p>
            <div className="mode-row">
              <span className="mode-ic"><IncognitoIcon /></span>
              <span className="min-w-0 flex-1"><span className="mode-t">Incognito</span><span className="mode-s">This chat is not saved to your history.</span></span>
              {sw(!!session.incognito, () => void actions.toggle('incognito'), 'Incognito')}
            </div>
            <div className="mode-row">
              <span className="mode-ic">{session.offline ? <GlobeOffIcon /> : <GlobeIcon />}</span>
              <span className="min-w-0 flex-1"><span className="mode-t">Internet access</span>
                <span className="mode-s">{session.offline ? 'Blocked: online tools, connectors and MCP are off. Shell commands are not network-sandboxed.' : isCloudModel ? 'On. A cloud model needs the internet; pick a local model to block it.' : 'Web tools, connectors and MCP can reach the internet.'}</span>
              </span>
              {sw(!session.offline, () => void actions.toggle('offline'), 'Internet access', isCloudModel && !session.offline)}
            </div>
            <div className="mode-row">
              <span className="mode-ic"><FolderIcon /></span>
              <span className="min-w-0 flex-1"><span className="mode-t">Folders</span><span className="mode-s">What the agent can read and write. The first is where it works.</span>
                <span className="mode-folders">
                  {folders.map(({ id, folder }) => (
                    <span key={id} className="mode-chip" title={folder?.path}><span>{folder?.name ?? id}</span>
                      <button aria-label={`Remove ${folder?.name ?? id}`} onClick={() => void applyFolderSelection(session.id, withExcluded(session, id)).then(onChange).catch(toastError)}><CloseIcon className="h-2.5 w-2.5" /></button>
                    </span>
                  ))}
                  <button className="mode-chip is-add" onClick={() => void addFolderToChat(session.id, session, 'include').then((s) => s && onChange(s)).catch(toastError)}><PlusIcon className="h-3 w-3" /> Add folder</button>
                </span>
              </span>
            </div>
            <div className="mode-row is-stacked">
              <span className="mode-ic"><ShieldIcon /></span>
              <span className="min-w-0 flex-1"><span className="mode-t">Approvals</span><span className="mode-s">{sandbox ? 'Sandbox always asks first.' : `${APPROVAL_DESC[approvals]} Guardrails is recommended for general use.`}</span></span>
              {tiles<ChatMode>('Approvals', approvals, [['ask', 'Ask', <HandIcon />, { 'data-chat-mode': 'ask' }], ['guardrails', 'Guardrails', <ShieldCheckIcon />, { 'data-chat-mode': 'guardrails' }], ['yolo', 'YOLO', <YoloIcon />, { 'data-chat-mode': 'yolo' }]],
                (v) => void (!sandbox && actions.setApprovals(v)))}
            </div>
            {flyRow('tools', <WrenchIcon />, 'Tools', `${toolsOn} of ${toolsUsable} on${approach === 'code' ? ' · code mode' : ''}`)}
            {flyRow('mcp', <ServerIcon />, 'MCP servers', sandbox ? 'Off in Sandbox' : session.offline ? 'Off while offline' : `${mcpOn} of ${mcpServers.length} on`)}
            {flyRow('connectors', <PlugIcon />, 'Connectors', sandbox ? 'Off in Sandbox' : session.offline ? 'Off while offline' : `${connectorsOn} of ${connected.length} on`)}
          </section>

          <section className="mode-col" aria-label="Approach">
            <p className="mode-sec"><CompassIcon /> Approach</p>
            {flyRow('skills', <SparkleIcon />, 'Skills', workMode.label)}
            <p className="mode-s mode-under">{workMode.id === 'default' ? 'No extra skills. Pick a work mode to bring its skills along.' : `${workMode.description} Applies ${WORK_MODES.find((m) => m.id === workMode.id)!.skills.map((n) => `/${n}`).join(', ')}.`}</p>
            {soon(<DocTextIcon />, 'System prompt', 'Pick a saved prompt per chat and open it to edit.')}
            <div className={`mode-row is-stacked ${sandbox ? 'is-disabled' : ''}`}>
              <span className="mode-ic"><ListIcon /></span>
              <span className="min-w-0 flex-1"><span className="mode-t">Project rules</span><span className="mode-s">{sandbox ? 'Off in Sandbox, which reads nothing from your folders.' : GUIDANCE_DESC[current.guidance ?? 'rules']}</span></span>
              {tiles<GuidanceLevel>('Project rules', current.guidance ?? 'rules', [['rules', 'Rules', <ListIcon />, { 'data-guidance': 'rules' }], ['root', 'Root files', <FileIcon />, { 'data-guidance': 'root' }], ['off', 'Off', <CloseIcon />, { 'data-guidance': 'off' }]],
                (v) => void (!sandbox && actions.setGuidance(v)))}
            </div>
            <div className={`mode-row is-stacked ${sandbox || session.incognito ? 'is-disabled' : ''}`}>
              <span className="mode-ic"><BrainIcon /></span>
              <span className="min-w-0 flex-1"><span className="mode-t">Memory</span><span className="mode-s">{sandbox ? 'Off in Sandbox.' : session.incognito ? 'Off while incognito: an incognito chat reads no memory notes.' : MEMORY_DESC[current.memory ?? 'all']}</span></span>
              {tiles<ChatMemory>('Memory', current.memory ?? 'all', [['all', 'Everything', <BrainIcon />, { 'data-memory': 'all' }], ['project', 'Project', <FolderIcon />, { 'data-memory': 'project' }], ['off', 'Off', <CloseIcon />, { 'data-memory': 'off' }]],
                (v) => void (!sandbox && actions.setMemory(v)))}
            </div>
          </section>
        </div></div>
      </div>
    </div>

    {fly && !narrow && createPortal(
      <div className="mode-fly card fixed z-[101] shadow-(--shadow-float)" style={flyStyle} role="dialog" aria-label={FLY_TITLE[fly][0]} data-mode-panel onKeyDown={onKeyDown}>
        <p className="mode-fly-h">{FLY_TITLE[fly][1]} {FLY_TITLE[fly][0]}</p>
        <div className="mode-fly-body">{flyBody(fly)}</div>
      </div>,
      document.body,
    )}
  </>);
}

/**
 * The Tools flyout's choice of how tools reach the model: a tool list, or
 * code mode (new). A sandbox chat keeps the list.
 */
export function ToolApproachPicker({ approach, sandbox, onPick }: { approach: ToolApproach; sandbox: boolean; onPick: (a: ToolApproach) => void }) {
  return (
    <div role="radiogroup" aria-label="How tools reach the model" data-tool-approaches>
      <p className="mode-group">How tools reach the model</p>
      {TOOL_APPROACHES.map((a) => (
        <button key={a.id} role="radio" aria-checked={approach === a.id} disabled={sandbox} data-tool-approach={a.id} className="mode-opt disabled:cursor-not-allowed disabled:opacity-50" onClick={() => onPick(a.id)}>
          <span className="mode-opt-ic">{a.id === 'code' ? <CodeIcon /> : <ListIcon />}</span>
          <span className="min-w-0 flex-1">
            <span className="mode-t">{a.label}{a.isNew && <span className="mode-badge is-accent">New</span>}{approach === a.id && <CheckIcon className="h-3.5 w-3.5 text-accent" />}</span>
            <span className="mode-s">{a.description}</span>
          </span>
        </button>
      ))}
      <a className="mode-link block" href={CODE_MODE_DOCS} data-code-mode-docs onClick={(e) => { e.preventDefault(); void window.nekko.openPath(CODE_MODE_DOCS); }}>What's code mode, and what does it save? <ExternalIcon className="inline h-2.5 w-2.5" /></a>
      {sandbox && <p className="mode-note">Sandbox chats use the tool list: their few tools run in the container.</p>}
    </div>
  );
}

/** The Mode button's label: the saved mode this chat is in, or Custom. */
export function modeButtonLabel(session: Session, settings: Parameters<typeof chatModeState>[1]) {
  const { active, current } = chatModeState(session, settings);
  return { name: active?.name ?? 'Custom', icon: active ? SAVED_MODE_GLYPH[active.icon] : SparkleIcon, summary: savedModeSummary(current) };
}
