/**
 * Saved modes: named bundles of a chat's settings (where it runs, worktrees,
 * approvals, internet, incognito, tools, work mode, effort, MCP servers,
 * connectors, memory, project guidance) that the composer's Mode panel applies in one click. One may be
 * the default for new chats. Memory and project guidance ride along too.
 *
 * A saved mode is only a shortcut for settings that already exist per chat.
 * It adds no permission of its own: applying one is the same as flipping each
 * setting by hand. Switching an MCP server or connector off for a chat never
 * turns one on that is off or disconnected app-wide.
 *
 * Folders are not part of a mode. They belong to the task, not the way of
 * working, so switching modes never re-wires a chat's folders.
 */
import type { ChatMode, ExecutionMode, GuidanceLevel, ChatMemory, Session } from './chat.js';
import { getExecutionMode } from './chat.js';
import { chatEffort } from './chat-scope.js';
import type { EffortLevel } from './settings.js';
import type { WorkModeId } from './work-modes.js';

/** Glyphs a saved mode can wear in the rail; drawn by the renderer. */
export type SavedModeIcon = 'bolt' | 'dial' | 'incognito' | 'box' | 'cap' | 'sparkle' | 'shield' | 'globe-off';

export const SAVED_MODE_ICONS: SavedModeIcon[] = ['bolt', 'dial', 'incognito', 'box', 'cap', 'sparkle', 'shield', 'globe-off'];

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
  /** Which memory notes the chat takes. Unset (older modes) matches any and changes nothing. */
  memory?: ChatMemory;
  /** How much project guidance the chat takes. Unset (older modes) matches any and changes nothing. */
  guidance?: GuidanceLevel;
}

export interface SavedMode {
  id: string;
  name: string;
  icon: SavedModeIcon;
  options: SavedModeOptions;
}

/** What a user starts with before saving any modes of their own. */
export const STARTER_MODES: SavedMode[] = [
  { id: 'everyday', name: 'Everyday', icon: 'bolt', options: { executionMode: 'worktree', mode: 'guardrails', offline: false, incognito: false, disabledTools: [], workMode: 'default' } },
  { id: 'deep-work', name: 'Deep work', icon: 'dial', options: { executionMode: 'worktree', mode: 'yolo', offline: false, incognito: false, disabledTools: [], workMode: 'best-output', effort: 'high' } },
  { id: 'private', name: 'Private', icon: 'incognito', options: { executionMode: 'worktree', mode: 'ask', offline: false, incognito: true, disabledTools: [], workMode: 'default' } },
  { id: 'untrusted-repo', name: 'Untrusted repo', icon: 'box', options: { executionMode: 'sandbox', mode: 'ask', offline: false, incognito: false, disabledTools: [], workMode: 'default' } },
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

type ChatSettings = Pick<Session, 'executionMode' | 'gitIsolation' | 'mode' | 'offline' | 'incognito' | 'disabledTools' | 'workMode' | 'effort' | 'disabledMcpServers' | 'disabledConnectors' | 'memory' | 'guidance'>;

/** A chat's current settings in saved-mode form. */
export function sessionModeOptions(session: ChatSettings, settings?: ModeSettings | null): SavedModeOptions {
  const executionMode = getExecutionMode(session);
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
    memory: session.memory ?? 'all',
    guidance: session.guidance ?? 'rules',
  };
}

const sameList = (a: string[], b: string[]) => {
  const as = [...a].sort(), bs = [...b].sort();
  return as.length === bs.length && as.every((t, i) => t === bs[i]);
};

/**
 * Whether two option sets would run a chat the same way. A field either side
 * leaves unset (effort, MCP servers, connectors, from a mode saved before they
 * were per chat) matches any value.
 */
export function sameModeOptions(a: SavedModeOptions, b: SavedModeOptions): boolean {
  const sandboxed = a.executionMode === 'sandbox';
  if (a.executionMode !== b.executionMode || a.offline !== b.offline || a.incognito !== b.incognito || a.workMode !== b.workMode) return false;
  if (!sandboxed && a.mode !== b.mode) return false;
  if (a.effort && b.effort && a.effort !== b.effort) return false;
  if (a.disabledMcpServers && b.disabledMcpServers && !sameList(a.disabledMcpServers, b.disabledMcpServers)) return false;
  if (a.disabledConnectors && b.disabledConnectors && !sameList(a.disabledConnectors, b.disabledConnectors)) return false;
  if (a.memory && b.memory && a.memory !== b.memory) return false;
  if (a.guidance && b.guidance && a.guidance !== b.guidance) return false;
  return sameList(a.disabledTools, b.disabledTools);
}

/** The saved mode a chat is in right now, if its settings match one exactly. */
export function matchSavedMode(modes: SavedMode[], current: SavedModeOptions): SavedMode | undefined {
  return modes.find((m) => sameModeOptions({
    ...m.options,
    effort: m.options.effort ?? current.effort,
    disabledMcpServers: m.options.disabledMcpServers ?? current.disabledMcpServers,
    disabledConnectors: m.options.disabledConnectors ?? current.disabledConnectors,
    memory: m.options.memory ?? current.memory,
    guidance: m.options.guidance ?? current.guidance,
  }, current));
}

/**
 * The per-chat patch that puts a chat in a mode. A cloud model cannot go
 * offline, so `offline` is left as it is for one rather than refused. Fields
 * the mode leaves unset (effort, MCP servers, connectors) stay as they are.
 */
export function sessionPatchForMode(options: SavedModeOptions, opts: { cloudModel?: boolean } = {}): Partial<Session> {
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
    ...(options.memory ? { memory: options.memory } : {}),
    ...(options.guidance ? { guidance: options.guidance } : {}),
  };
}

/** A short line for the rail: where it runs, then anything unusual. */
export function savedModeSummary(options: SavedModeOptions): string {
  const where = options.executionMode === 'sandbox' ? 'sandbox' : options.executionMode === 'worktree' ? 'worktree' : 'local';
  return [where, options.mode === 'guardrails' ? '' : options.mode, options.offline ? 'offline' : '', options.incognito ? 'incognito' : '', options.effort === 'normal' ? '' : options.effort ?? '', options.memory && options.memory !== 'all' ? `memory ${options.memory}` : '', options.guidance && options.guidance !== 'rules' ? `rules ${options.guidance}` : ''].filter(Boolean).join(' · ');
}

/** A fresh id for a mode the user is saving, unique among `modes`. */
export function newSavedModeId(name: string, modes: SavedMode[]): string {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'mode';
  let id = base, n = 2;
  while (modes.some((m) => m.id === id)) id = `${base}-${n++}`;
  return id;
}
