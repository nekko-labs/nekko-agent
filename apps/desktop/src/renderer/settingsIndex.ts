import { AUTO_COMPLETE_CHOICES, autoCompleteDays, promptCachingEnabled, telemetryChoice, type AppSettings } from '@nekko-agent/shared';
import { LANGUAGES } from './i18n.js';
import { textScaleOf, useStore } from './store.js';

/** Save a settings patch the way the Settings page does: store, theme, a toast on failure. */
export async function saveSettings(patch: Partial<AppSettings>) {
  try {
    const next = await window.nekko.updateSettings(patch);
    useStore.setState({ settings: next, settingsError: null });
    useStore.getState().applyTheme();
  } catch (e) { useStore.getState().pushToast('error', (e as Error).message); }
}

/** The in-progress surfaces under Settings > System > Experimental. */
export const EXPERIMENTAL_FLAGS = [
  { key: 'resourceQueue', label: 'Developer resource queue', desc: 'Experimental outbound coordinator: register this machine and manually claim prompt jobs in Model Server. No automatic pickup.' },
  { key: 'training', label: 'Model training', desc: 'Show the Training tab: launch and watch data-scientist agent runs.' },
  { key: 'design', label: 'Design board', desc: 'Show the Design tab: sketch or describe a UI and generate live prototypes.' },
  { key: 'memory', label: 'Memory', desc: 'Show the Memory tab: browse and edit global and per-project memory.' },
  { key: 'workflowLoopbackListener', label: 'Workflow loopback listener', desc: 'Listen on 127.0.0.1:1441 for inbound workflow webhooks (desktop only).' },
] as const;

export type SettingControl =
  | { kind: 'toggle'; get: (s: AppSettings) => boolean; set: (v: boolean, s: AppSettings) => Partial<AppSettings> }
  | { kind: 'select'; options: Array<{ value: string; label: string }>; get: (s: AppSettings) => string; set: (v: string, s: AppSettings) => Partial<AppSettings> };

export interface SettingEntry {
  id: string;
  label: string;
  /** The Settings group (`settings-<group>` on the page) it lives in. */
  group: 'general' | 'style' | 'agents' | 'tools' | 'system';
  /** Extra words people search for that the label does not say. */
  keywords?: string;
  control: SettingControl;
}

const toggle = (get: (s: AppSettings) => boolean, set: (v: boolean, s: AppSettings) => Partial<AppSettings>): SettingControl => ({ kind: 'toggle', get, set });

/**
 * The app-wide switches and choices the command palette can change in place.
 * Per-item controls (each hook, MCP server, guardrail) stay on their page.
 */
export const SETTINGS_INDEX: SettingEntry[] = [
  { id: 'telemetry', label: 'Help improve Nekko Agent', group: 'general', keywords: 'usage crash reports telemetry analytics privacy', control: toggle((s) => s.telemetry?.enabled === true, (v) => ({ telemetry: telemetryChoice(v) })) },
  ...(['skills', 'connectors'] as const).map((view): SettingEntry => ({
    id: `sidebar-${view}`, label: `Show ${view === 'skills' ? 'Skills' : 'Connectors'} in sidebar`, group: 'general', keywords: 'view nav',
    control: toggle((s) => s.sidebarViews?.[view] === true, (v, s) => ({ sidebarViews: { ...s.sidebarViews, [view]: v } })),
  })),
  { id: 'background-animation', label: 'Background animation', group: 'general', keywords: 'appearance pixel wave power', control: toggle((s) => s.backgroundAnimation !== false, (v) => ({ backgroundAnimation: v })) },
  { id: 'language', label: 'Language', group: 'general', keywords: 'locale translation', control: { kind: 'select', options: [{ value: '', label: 'System default' }, ...LANGUAGES.map((l) => ({ value: l.code, label: l.label }))], get: (s) => s.language ?? '', set: (v) => ({ language: v || undefined }) } },
  { id: 'chat-pane-action', label: 'Chat pane top-right action', group: 'general', keywords: 'complete delete close x', control: { kind: 'select', options: [{ value: 'complete', label: 'Complete' }, { value: 'delete', label: 'Delete' }], get: (s) => s.chatPaneAction ?? 'complete', set: (v) => ({ chatPaneAction: v === 'delete' ? 'delete' : 'complete' }) } },
  { id: 'auto-complete', label: 'Complete idle agents after', group: 'general', keywords: 'archive inactive', control: { kind: 'select', options: AUTO_COMPLETE_CHOICES.map((c) => ({ value: String(c.days), label: c.label })), get: (s) => String(autoCompleteDays(s.autoCompleteAfterDays)), set: (v) => ({ autoCompleteAfterDays: Number(v) }) } },
  { id: 'tips', label: 'Show tips', group: 'general', control: toggle((s) => s.showTips !== false, (v) => ({ showTips: v })) },
  { id: 'confirm-deletions', label: 'Confirm deletions', group: 'general', keywords: 'delete prompt', control: toggle((s) => s.skipDeleteConfirmation !== true, (v) => ({ skipDeleteConfirmation: !v })) },
  { id: 'close-behavior', label: 'When I close the window', group: 'general', keywords: 'tray quit shut down desktop behavior', control: { kind: 'select', options: [{ value: 'tray', label: 'Keep running in tray' }, { value: 'shutdown', label: 'Shut down Nekko' }], get: (s) => s.desktopCloseBehavior ?? 'tray', set: (v) => ({ desktopCloseBehavior: v === 'shutdown' ? 'shutdown' : 'tray' }) } },
  { id: 'low-memory', label: 'When memory runs low', group: 'general', keywords: 'ram memory tray close app free unload', control: { kind: 'select', options: [{ value: 'ask', label: 'Ask me' }, { value: 'release', label: "Free Nekko's memory" }, { value: 'ignore', label: 'Do nothing' }], get: (s) => s.lowMemoryAction ?? 'ask', set: (v) => ({ lowMemoryAction: v === 'release' || v === 'ignore' ? v : undefined }) } },
  { id: 'mascot', label: 'Show Nekko mascot', group: 'general', keywords: 'fun cat', control: toggle((s) => s.mascotEnabled === true, (v) => ({ mascotEnabled: v })) },
  { id: 'tray-farewell', label: 'Tray farewell', group: 'general', keywords: 'fun goodbye', control: toggle((s) => s.trayFarewellEnabled !== false, (v) => ({ trayFarewellEnabled: v })) },
  { id: 'desktop-notifications', label: 'Desktop notifications', group: 'general', keywords: 'alerts system', control: toggle((s) => s.desktopNotifications !== false, (v) => ({ desktopNotifications: v })) },
  { id: 'text-size', label: 'Text size', group: 'style', keywords: 'font scale zoom', control: { kind: 'select', options: [80, 90, 100, 110, 125, 150].map((n) => ({ value: String(n), label: `${n}%` })), get: (s) => String(textScaleOf(s.textScale)), set: (v) => ({ textScale: Number(v) }) } },
  { id: 'internet-recovery', label: 'Automatically resume after internet restoration', group: 'agents', keywords: 'offline reconnect retry', control: toggle((s) => s.autoResumeOnInternetRestore === true, (v) => ({ autoResumeOnInternetRestore: v })) },
  { id: 'prompt-caching', label: 'Prompt caching', group: 'agents', keywords: 'cache kv', control: toggle((s) => promptCachingEnabled(s), (v) => ({ promptCaching: v })) },
  { id: 'git-mode', label: 'New chat checkout', group: 'tools', keywords: 'git worktree branch', control: { kind: 'select', options: [{ value: 'worktree', label: 'Isolated worktree' }, { value: 'shared', label: 'Shared project checkout' }], get: (s) => s.gitManagement?.mode ?? 'worktree', set: (v, s) => ({ gitManagement: { ...s.gitManagement, mode: v === 'shared' ? 'shared' : 'worktree' } }) } },
  { id: 'git-baseline', label: 'Worktree baseline', group: 'tools', keywords: 'git head local changes', control: { kind: 'select', options: [{ value: 'head', label: 'Committed HEAD' }, { value: 'local-changes', label: 'HEAD plus local edits' }], get: (s) => s.gitManagement?.baseline ?? 'head', set: (v, s) => ({ gitManagement: { ...s.gitManagement, baseline: v === 'local-changes' ? 'local-changes' : 'head' } }) } },
  { id: 'server-controls', label: 'Show server controls', group: 'system', keywords: 'developer restart', control: toggle((s) => s.developer?.serverControls === true, (v, s) => ({ developer: { ...s.developer, serverControls: v } })) },
  ...EXPERIMENTAL_FLAGS.map((f): SettingEntry => ({
    id: `experimental-${f.key}`, label: f.label, group: 'system', keywords: 'experimental',
    control: toggle((s) => s.experimental?.[f.key] === true, (v, s) => ({ experimental: { ...s.experimental, [f.key]: v } })),
  })),
];

/** Each Settings group with the sections it holds, so searching "hooks" or "guardrails" can jump there. */
export const SETTINGS_PAGES: Array<{ group: string; label: string; keywords: string }> = [
  { group: 'general', label: 'General', keywords: 'usage reports view appearance theme agents wall customization voice notifications chat history desktop behavior fun' },
  { group: 'phone', label: 'Phone pairing', keywords: 'qr mobile iphone remote access sync' },
  { group: 'style', label: 'Style', keywords: 'fonts text size' },
  { group: 'agents', label: 'Agents', keywords: 'chat modes agent loop hooks spec-driven development orchestration delegation routes automations' },
  { group: 'safety', label: 'Safety', keywords: 'security sandbox guardrails permissions' },
  { group: 'connections', label: 'Connections', keywords: 'network activity log' },
  { group: 'tools', label: 'Tools', keywords: 'git management project management pull requests terminal shell mcp servers' },
  { group: 'system', label: 'System', keywords: 'updates developer experimental backup data privacy' },
];

/** Open Settings scrolled to one group (the page mounts on the next frame). */
export function openSettingsGroup(group: string) {
  useStore.getState().setView('settings');
  requestAnimationFrame(() => requestAnimationFrame(() => document.getElementById(`settings-${group}`)?.scrollIntoView({ block: 'start' })));
}

const hits = (hay: string, query: string) => {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every((w) => hay.toLowerCase().includes(w));
};

/** Settings groups whose name or sections contain every word of `query`. */
export const matchSettingsPages = (query: string) => SETTINGS_PAGES.filter((p) => hits(`${p.label} settings ${p.keywords}`, query));

/** Entries whose label, keywords or group contain every word of `query`. */
export const matchSettings = (query: string) => SETTINGS_INDEX.filter((e) => hits(`${e.label} ${e.keywords ?? ''} ${e.group}`, query));
