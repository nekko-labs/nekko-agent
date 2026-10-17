/**
 * Saved modes: named bundles of a chat's settings (where it runs, worktrees,
 * approvals, internet, incognito, tools, work mode, effort) that the composer's
 * Mode panel applies in one click. One may be the default for new chats.
 *
 * A saved mode is only a shortcut for settings that already exist per chat
 * (and effort, which is still app-wide). It adds no permission of its own:
 * applying one is the same as flipping each setting by hand.
 *
 * Folders are not part of a mode. They belong to the task, not the way of
 * working, so switching modes never re-wires a chat's folders.
 */
import type { ChatMode, ExecutionMode, Session } from './chat.js';
import { getExecutionMode } from './chat.js';
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
  /** App-wide today; applying a mode sets it for every chat. */
  effort?: EffortLevel;
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

type ChatSettings = Pick<Session, 'executionMode' | 'gitIsolation' | 'mode' | 'offline' | 'incognito' | 'disabledTools' | 'workMode'>;

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
    ...(settings?.effort ? { effort: settings.effort } : {}),
  };
}

/**
 * Whether two option sets would run a chat the same way. A mode that leaves
 * effort unset matches any effort.
 */
export function sameModeOptions(a: SavedModeOptions, b: SavedModeOptions): boolean {
  const sandboxed = a.executionMode === 'sandbox';
  if (a.executionMode !== b.executionMode || a.offline !== b.offline || a.incognito !== b.incognito || a.workMode !== b.workMode) return false;
  if (!sandboxed && a.mode !== b.mode) return false;
  if (a.effort && b.effort && a.effort !== b.effort) return false;
  const at = [...a.disabledTools].sort(), bt = [...b.disabledTools].sort();
  return at.length === bt.length && at.every((t, i) => t === bt[i]);
}

/** The saved mode a chat is in right now, if its settings match one exactly. */
export function matchSavedMode(modes: SavedMode[], current: SavedModeOptions): SavedMode | undefined {
  return modes.find((m) => sameModeOptions({ ...m.options, effort: m.options.effort ?? current.effort }, current));
}

/**
 * The per-chat patch that puts a chat in a mode. A cloud model cannot go
 * offline, so `offline` is left as it is for one rather than refused.
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
  };
}

/** A short line for the rail: where it runs, then anything unusual. */
export function savedModeSummary(options: SavedModeOptions): string {
  const where = options.executionMode === 'sandbox' ? 'sandbox' : options.executionMode === 'worktree' ? 'worktree' : 'local';
  return [where, options.mode === 'guardrails' ? '' : options.mode, options.offline ? 'offline' : '', options.incognito ? 'incognito' : '', options.effort === 'normal' ? '' : options.effort ?? ''].filter(Boolean).join(' · ');
}

/** A fresh id for a mode the user is saving, unique among `modes`. */
export function newSavedModeId(name: string, modes: SavedMode[]): string {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'mode';
  let id = base, n = 2;
  while (modes.some((m) => m.id === id)) id = `${base}-${n++}`;
  return id;
}
