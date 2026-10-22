/**
 * Saved modes: named bundles of a chat's settings (where it runs, worktrees,
 * approvals, internet, incognito, tools, work mode, effort, MCP servers,
 * connectors, where its models run) that the composer's Mode panel applies in one click. One may be
 * the default for new chats.
 *
 * A saved mode is only a shortcut for settings that already exist per chat.
 * It adds no permission of its own: applying one is the same as flipping each
 * setting by hand. Switching an MCP server or connector off for a chat never
 * turns one on that is off or disconnected app-wide.
 *
 * Folders are not part of a mode. They belong to the task, not the way of
 * working, so switching modes never re-wires a chat's folders.
 */
import type { ChatMode, ExecutionMode, Session } from './chat.js';
import { getExecutionMode } from './chat.js';
import { chatEffort } from './chat-scope.js';
import type { EffortLevel } from './settings.js';
import type { WorkModeId } from './work-modes.js';

/** Glyphs a saved mode can wear in the rail; drawn by the renderer. */
export type SavedModeIcon = 'bolt' | 'dial' | 'incognito' | 'box' | 'cap' | 'sparkle' | 'shield' | 'globe-off' | 'cloud' | 'route' | 'laptop';

export const SAVED_MODE_ICONS: SavedModeIcon[] = ['bolt', 'dial', 'incognito', 'box', 'cap', 'sparkle', 'shield', 'globe-off', 'cloud', 'route', 'laptop'];

/**
 * Where a chat's models run. Each is made of per-chat settings that already
 * exist, so a mode never grants more than flipping them by hand:
 * - `cloud`: cloud providers only (`cloudOnly`); a model server on this
 *   machine is refused.
 * - `fusion`: Auto picks the model per turn and may move a turn between local
 *   and cloud providers (`autoModel` + `autoProviderSwitch`), never to a
 *   weaker model.
 * - `local`: models on this machine only, with the internet off (`offline`).
 */
export type ModelScope = 'cloud' | 'fusion' | 'local';

export interface SavedModeOptions {
  executionMode: ExecutionMode;
  mode: ChatMode;
  offline: boolean;
  incognito: boolean;
  /** Tools switched off, sorted so two modes compare by value. */
  disabledTools: string[];
  workMode: WorkModeId;
  /**
   * The chat's effort. Modes saved before effort was per chat may leave it
   * unset, and an unset value matches any effort and leaves it as it is.
   */
  effort?: EffortLevel;
  /** MCP server ids switched off for the chat, sorted. Unset (older modes) matches any and changes nothing. */
  disabledMcpServers?: string[];
  /** Connector kinds switched off for the chat, sorted. Unset (older modes) matches any and changes nothing. */
  disabledConnectors?: string[];
  /** Where the chat's models run. Unset (older modes) matches any and changes nothing. */
  models?: ModelScope;
}

export interface SavedMode {
  id: string;
  name: string;
  icon: SavedModeIcon;
  options: SavedModeOptions;
}

/**
 * What a user starts with before saving any modes of their own: one per place
 * a chat's models can run, plus Risky business for code you do not trust (a
 * sandbox container with no network, every action asked; a local model keeps
 * the whole chat on this machine).
 */
export const STARTER_MODES: SavedMode[] = [
  { id: 'cloud', name: 'Cloud only', icon: 'cloud', options: { executionMode: 'worktree', mode: 'guardrails', offline: false, incognito: false, disabledTools: [], workMode: 'default', models: 'cloud' } },
  { id: 'fusion', name: 'Fusion', icon: 'route', options: { executionMode: 'worktree', mode: 'guardrails', offline: false, incognito: false, disabledTools: [], workMode: 'default', models: 'fusion' } },
  { id: 'local', name: 'Local only', icon: 'laptop', options: { executionMode: 'worktree', mode: 'guardrails', offline: true, incognito: false, disabledTools: [], workMode: 'default', models: 'local' } },
  { id: 'risky-business', name: 'Risky business', icon: 'box', options: { executionMode: 'sandbox', mode: 'ask', offline: true, incognito: false, disabledTools: [], workMode: 'default' } },
];

type ModeSettings = { savedModes?: SavedMode[]; defaultSavedModeId?: string; defaultChatMode?: ChatMode; effort?: EffortLevel };

/** The user's saved modes, or the starter set until they save their own. */
export function savedModes(settings: ModeSettings | null | undefined): SavedMode[] {
  return settings?.savedModes ?? STARTER_MODES;
}

/** The mode new chats start in, when the user picked one. */
export function defaultSavedMode(settings: ModeSettings | null | undefined): SavedMode | undefined {
  const id = settings?.defaultSavedModeId;
  return id ? savedModes(settings).find((m) => m.id === id) : undefined;
}

type ChatSettings = Pick<Session, 'executionMode' | 'gitIsolation' | 'mode' | 'offline' | 'cloudOnly' | 'incognito' | 'disabledTools' | 'workMode' | 'effort' | 'disabledMcpServers' | 'disabledConnectors' | 'autoModel' | 'autoProviderSwitch'>;

/** Where a chat's models run, when its settings pin it; unset when they do not. */
export function chatModelScope(session: Pick<ChatSettings, 'offline' | 'cloudOnly' | 'autoModel' | 'autoProviderSwitch'>): ModelScope | undefined {
  if (session.offline) return 'local';
  if (session.cloudOnly) return 'cloud';
  if (session.autoModel && session.autoProviderSwitch) return 'fusion';
  return undefined;
}

/** A chat's current settings in saved-mode form. */
export function sessionModeOptions(session: ChatSettings, settings?: ModeSettings | null): SavedModeOptions {
  const executionMode = getExecutionMode(session);
  const models = chatModelScope(session);
  return {
    executionMode,
    // The host forces Ask in a sandbox; read it the way the engine runs it.
    mode: executionMode === 'sandbox' ? 'ask' : session.mode ?? settings?.defaultChatMode ?? 'guardrails',
    offline: !!session.offline,
    incognito: !!session.incognito,
    disabledTools: [...(session.disabledTools ?? [])].sort(),
    workMode: session.workMode ?? 'default',
    ...(chatEffort(session, settings?.effort) ? { effort: chatEffort(session, settings?.effort) } : {}),
    disabledMcpServers: [...(session.disabledMcpServers ?? [])].sort(),
    disabledConnectors: [...(session.disabledConnectors ?? [])].sort(),
    ...(models ? { models } : {}),
  };
}

const sameList = (a: string[], b: string[]) => {
  const as = [...a].sort(), bs = [...b].sort();
  return as.length === bs.length && as.every((t, i) => t === bs[i]);
};

/**
 * Whether two option sets would run a chat the same way. A field either side
 * leaves unset (effort, MCP servers, connectors, from a mode saved before
 * they were per chat) matches any value; `matchSavedMode` fills in a mode's
 * unset models from the chat the same way. In a sandbox the approvals
 * are always Ask and the container has no network, so neither tells two
 * sandbox modes apart.
 */
export function sameModeOptions(a: SavedModeOptions, b: SavedModeOptions): boolean {
  const sandboxed = a.executionMode === 'sandbox';
  if (a.executionMode !== b.executionMode || a.incognito !== b.incognito || a.workMode !== b.workMode) return false;
  if (!sandboxed && (a.mode !== b.mode || a.offline !== b.offline)) return false;
  // Unset models on a chat means nothing pins them, which is a value of its own.
  if (a.models !== b.models) return false;
  if (a.effort && b.effort && a.effort !== b.effort) return false;
  if (a.disabledMcpServers && b.disabledMcpServers && !sameList(a.disabledMcpServers, b.disabledMcpServers)) return false;
  if (a.disabledConnectors && b.disabledConnectors && !sameList(a.disabledConnectors, b.disabledConnectors)) return false;
  return sameList(a.disabledTools, b.disabledTools);
}

/** The saved mode a chat is in right now, if its settings match one exactly. */
export function matchSavedMode(modes: SavedMode[], current: SavedModeOptions): SavedMode | undefined {
  return modes.find((m) => sameModeOptions({
    ...m.options,
    effort: m.options.effort ?? current.effort,
    disabledMcpServers: m.options.disabledMcpServers ?? current.disabledMcpServers,
    disabledConnectors: m.options.disabledConnectors ?? current.disabledConnectors,
    models: m.options.models ?? current.models,
  }, current));
}

/** The per-chat fields a model scope sets; `localModel` keeps a chat on a local model out of Cloud only. */
function modelScopePatch(models: ModelScope | undefined, localModel: boolean): Partial<Session> {
  if (models === 'cloud') return localModel ? {} : { cloudOnly: true };
  if (models === 'fusion') return { cloudOnly: false, autoModel: true, autoProviderSwitch: true };
  if (models === 'local') return { cloudOnly: false };
  return {};
}

/**
 * The per-chat patch that puts a chat in a mode. A cloud model cannot go
 * offline and a local one cannot go cloud-only, so those are left as they are
 * for such a chat rather than refused (`modePatchSkips` names what was left).
 * Fields the mode leaves unset (effort, MCP servers, connectors, models) stay
 * as they are.
 */
export function sessionPatchForMode(options: SavedModeOptions, opts: { cloudModel?: boolean } = {}): Partial<Session> {
  // Without a model to go by (a new chat) nothing is held back.
  const localModel = opts.cloudModel === false;
  return {
    executionMode: options.executionMode,
    gitIsolation: options.executionMode === 'worktree',
    mode: options.mode,
    ...(opts.cloudModel && options.offline ? {} : { offline: options.offline }),
    incognito: options.incognito,
    disabledTools: [...options.disabledTools],
    workMode: options.workMode,
    ...(options.effort ? { effort: options.effort } : {}),
    ...(options.disabledMcpServers ? { disabledMcpServers: [...options.disabledMcpServers] } : {}),
    ...(options.disabledConnectors ? { disabledConnectors: [...options.disabledConnectors] } : {}),
    ...modelScopePatch(options.models, localModel),
  };
}

/** What `sessionPatchForMode` had to leave as it was for this chat's model, if anything. */
export function modePatchSkips(options: SavedModeOptions, opts: { cloudModel: boolean }): 'offline' | 'cloudOnly' | undefined {
  if (opts.cloudModel && options.offline && options.executionMode !== 'sandbox') return 'offline';
  if (!opts.cloudModel && options.models === 'cloud') return 'cloudOnly';
  return undefined;
}

const MODEL_SCOPE_LABEL: Record<ModelScope, string> = { cloud: 'cloud models', fusion: 'local + cloud', local: 'local models' };

/** A short line for the rail: where it runs, then anything unusual. */
export function savedModeSummary(options: SavedModeOptions): string {
  const where = options.executionMode === 'sandbox' ? 'sandbox' : options.executionMode === 'worktree' ? 'worktree' : 'local';
  const models = options.models ? MODEL_SCOPE_LABEL[options.models] : '';
  // Local models are offline by definition, and a sandbox has no network.
  const offline = options.offline && options.models !== 'local' ? (options.executionMode === 'sandbox' ? 'no network' : 'offline') : '';
  return [where, models, options.mode === 'guardrails' ? '' : options.mode, offline, options.incognito ? 'incognito' : '', options.effort === 'normal' ? '' : options.effort ?? ''].filter(Boolean).join(' · ');
}

/** A fresh id for a mode the user is saving, unique among `modes`. */
export function newSavedModeId(name: string, modes: SavedMode[]): string {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'mode';
  let id = base, n = 2;
  while (modes.some((m) => m.id === id)) id = `${base}-${n++}`;
  return id;
}
