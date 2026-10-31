import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AUTO_COMPLETE_CHOICES, AUTO_COMPLETE_DEFAULT_DAYS, autoCompleteDays, DEFAULT_GUARDRAILS, promptCachingEnabled, RUN_POLICY_OPTIONS } from '@nekko-agent/shared';
import type { AppSettings, AutomationRunPolicy, ShellOption, ChatMode, ChatWorktreeInfo, GuardrailRule, GuardrailAction, HookEvent, HookRule, McpServerStatus, SandboxMode, TerminalRenderer, UpdateCheckSettings } from '@nekko-agent/shared';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../store.js';
import { Badge } from '../components/primitives/index.js';
import { UpdateProgress, useUpdater } from '../components/UpdateBanner.js';
import { ThemePresetPicker } from '../components/ThemePresetPicker.js';
import { pixelWaveFor } from '../components/PixelWaveBackground.js';
import { DEFAULT_SPEC_METHODOLOGY, SPEC_METHODOLOGIES, ORCHESTRATION_STRATEGIES, DEFAULT_ORCHESTRATION, MAX_OUTPUT_TOKENS_DEFAULT, MAX_OUTPUT_TOKENS_RANGE, clampMaxOutputTokens, ONBOARDING_VERSION, updateChecks, DEFAULT_TURN_WRAPPER } from '@nekko-agent/shared';
import { GearIcon, GlobeIcon, PhoneIcon, ShieldIcon, SlidersIcon, SunIcon, TrashIcon, RobotIcon, WandIcon, WrenchIcon } from '../icons.js';
import { VoiceSettings } from '../components/VoiceSettings.js';
import { RemoteAccess } from '../components/RemoteAccess.js';
import { SecuritySettings } from '../components/security/SecuritySettings.js';
import { SyncSettings } from '../components/cloud/SyncSettings.js';
import { ConnectionsSettings } from '../components/ConnectionsSettings.js';
import { UsageReportsSection } from '../components/UsageReports.js';
import { EXPERIMENTAL_FLAGS, saveSettings } from '../settingsIndex.js';
import { DelegationRouteSettings } from '../components/DelegationRouteSettings.js';
import { useT, LANGUAGES } from '../i18n.js';
import { loadWallState, saveWallState, toWallSetting } from '../commandWall.js';
import { hasAppChrome } from '../chrome.js';
import { ServiceLoadState } from '../components/ServiceLoadState.js';
import { ErrorBoundary } from '../components/ErrorBoundary.js';
import { SettingsSearch } from '../components/SettingsSearch.js';
import { ProjectManagementToggles, PullRequestToggles } from '../components/WorkTrackingToggles.js';
import { WallLayoutSettings } from './WallLayoutSettings.js';
import { DesktopBehaviorSection, FunSection } from './DesktopBehaviorSections.js';
import { SkillsColorIcon, ConnectorsColorIcon } from '../navIcons.js';
import { HistorySettings } from '../components/HistorySettings.js';
import { StyleSection } from './StyleSection.js';

const SANDBOX_OPTS: Array<{ value: SandboxMode; label: string; desc: string }> = [
  { value: 'workspace-jail', label: 'Workspace jail', desc: 'File access is confined to your added folders.' },
  { value: 'ask-everything', label: 'Ask everything', desc: 'Every write or command asks for approval.' },
  { value: 'docker', label: 'Docker', desc: 'Run shell commands inside a container if Docker is present.' },
  { value: 'off', label: 'Off', desc: 'No restrictions (power users).' },
];

const ACTION_COLORS: Record<GuardrailAction, string> = { allow: 'var(--success)', ask: 'var(--warning)', deny: 'var(--danger)' };

const CHAT_MODES: Array<{ value: ChatMode; label: string; desc: string }> = [
  { value: 'ask', label: 'Ask', desc: 'Confirm every file write and command before it runs.' },
  { value: 'guardrails', label: 'Guardrails', desc: 'Edit files and run read-only commands (ls, cat, rg, git status) freely; ask before any other command.' },
  { value: 'yolo', label: 'YOLO', desc: 'Run everything without confirming (deny rules still block).' },
];

/** The left-hand nav. Phone pairing sits second so the QR is one click from opening Settings. */
export const SETTINGS_GROUPS = [
  { id: 'general', label: 'General', icon: SunIcon },
  { id: 'phone', label: 'Phone pairing', icon: PhoneIcon },
  { id: 'style', label: 'Style', icon: SlidersIcon },
  { id: 'agents', label: 'Agents', icon: RobotIcon },
  { id: 'safety', label: 'Safety', icon: ShieldIcon },
  { id: 'connections', label: 'Connections', icon: GlobeIcon },
  { id: 'tools', label: 'Tools', icon: WrenchIcon },
  { id: 'system', label: 'System', icon: GearIcon },
] as const;
type SettingsGroupId = (typeof SETTINGS_GROUPS)[number]['id'];

function SettingsGroup({ id, children }: { id: SettingsGroupId; children: React.ReactNode }) {
  const label = SETTINGS_GROUPS.find((g) => g.id === id)!.label;
  return (
    <div id={`settings-${id}`} data-settings-group={id} className="settings-group" aria-labelledby={`settings-${id}-title`} role="region">
      <h2 id={`settings-${id}-title`} className="settings-group-title">{label}</h2>
      {children}
    </div>
  );
}

/** The group whose top has passed the top of the scroller (the last one once scrolled to the bottom). */
export function activeGroup(scroller: HTMLElement): SettingsGroupId {
  const groups = [...scroller.querySelectorAll<HTMLElement>('[data-settings-group]')];
  if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) return (groups.at(-1)?.dataset.settingsGroup ?? 'general') as SettingsGroupId;
  const top = scroller.getBoundingClientRect().top + 24;
  let cur: string = 'general';
  for (const g of groups) if (g.getBoundingClientRect().top <= top) cur = g.dataset.settingsGroup!;
  return cur as SettingsGroupId;
}

export function SettingsView() {
  const { applyTheme, onboardingOpen, wavePreset, settings, settingsError, refreshSettings } = useStore(useShallow((s) => ({ applyTheme: s.applyTheme, onboardingOpen: s.onboardingOpen, wavePreset: s.resolvedPreset, settings: s.settings, settingsError: s.settingsError, refreshSettings: s.refreshSettings })));
  const tr = useT();
  const prevOnboardingOpen = useRef(onboardingOpen);
  const pageRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<SettingsGroupId>('general');
  const jumping = useRef(0);
  const onScroll = () => { if (scrollRef.current && !jumping.current) setActive(activeGroup(scrollRef.current)); };
  const goTo = (id: SettingsGroupId) => {
    setActive(id);
    const scroller = scrollRef.current;
    const target = document.getElementById(`settings-${id}`);
    if (!scroller || !target) return;
    const from = scroller.scrollTop;
    const to = Math.min(from + target.getBoundingClientRect().top - scroller.getBoundingClientRect().top, scroller.scrollHeight - scroller.clientHeight);
    cancelAnimationFrame(jumping.current);
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { scroller.scrollTop = to; return; }
    // Native smooth scroll takes ~500ms over a long page; this lands in 200ms with an ease-out.
    const start = performance.now();
    const step = (t: number) => {
      const p = Math.min(1, (t - start) / 200);
      scroller.scrollTop = from + (to - from) * (1 - (1 - p) ** 3);
      jumping.current = p < 1 ? requestAnimationFrame(step) : 0;
    };
    jumping.current = requestAnimationFrame(step);
  };
  const reload = useCallback(() => refreshSettings(false), [refreshSettings]);

  useEffect(() => { void reload(); }, [reload]);

  // When the wizard overlay closes, re-read settings so the Settings view
  // behind it reflects any theme/onboarding changes made inside the wizard.
  useEffect(() => {
    if (prevOnboardingOpen.current && !onboardingOpen) {
      void reload();
    }
    prevOnboardingOpen.current = onboardingOpen;
  }, [onboardingOpen, reload]);

  const update = saveSettings;

  /** Reopen the first-run wizard: clear the completion flag, then show it. */
  const replaySetup = async () => {
    await update({ onboarding: { version: ONBOARDING_VERSION } });
    useStore.getState().setOnboardingOpen(true);
  };

  const updateGuardrail = async (rule: GuardrailRule) => {
    if (!settings) return;
    const guardrails = settings.guardrails.map((g) => (g.id === rule.id ? rule : g));
    update({ guardrails });
  };

  if (!settings) return <ServiceLoadState label="settings" error={settingsError} retry={reload} />;

  return (
    <div ref={scrollRef} className="settings-panel h-full overflow-y-auto" onScroll={onScroll}>
      <div ref={pageRef} className="settings-page" data-presenter-exempt>
        {settingsError && <ServiceLoadState label="settings" error={settingsError} retry={reload} />}
        {!hasAppChrome && <h1 className="view-title">{tr('settings.title')}</h1>}
        <div aria-label="Skills and connectors" className="mb-7 flex flex-wrap gap-3">
          {([{ view: 'skills', label: tr('nav.skills'), Icon: SkillsColorIcon }, { view: 'connectors', label: tr('nav.connectors'), Icon: ConnectorsColorIcon }] as const).map(({ view, label, Icon }) => (
            <button key={view} type="button" onClick={() => useStore.getState().setView(view)} className="flex min-h-16 flex-1 items-center gap-3 rounded-2xl border border-line bg-surface px-5 py-4 text-left text-base font-semibold hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
              <Icon className="h-7 w-7 shrink-0" />{label}<span aria-hidden="true" className="ml-auto">↗</span>
            </button>
          ))}
        </div>
        <div className="flex flex-col gap-6 md:flex-row md:gap-8">
          <nav aria-label="Settings sections" className="settings-nav" data-settings-search>
            {SETTINGS_GROUPS.map((g) => (
              <button
                key={g.id}
                type="button"
                className="settings-nav-item"
                aria-current={active === g.id ? 'true' : undefined}
                onClick={() => goTo(g.id)}
              >
                <g.icon className="h-4 w-4 shrink-0" />{g.label}
              </button>
            ))}
          </nav>
          <div className="min-w-0 flex-1">
            <SettingsGroup id="general">
              <ErrorBoundary label="Usage reports"><UsageReportsSection settings={settings} update={update} /></ErrorBoundary>
              <section className="card mt-5 p-5">
                <h2 className="font-semibold">View settings</h2>
                <p className="mt-1 text-xs text-ink-faint">Optional sidebar shortcuts. Skills and Connectors are always available at the top of Settings.</p>
                {(['skills', 'connectors'] as const).map((view) => (
                  <div key={view} className="mt-3 flex min-h-[40px] items-center justify-between gap-3">
                    <span className="text-sm">Show {tr(`nav.${view}`)} in sidebar</span>
                    <Toggle aria-label={`Show ${view === 'skills' ? 'Skills' : 'Connectors'} in sidebar`} on={settings.sidebarViews?.[view] === true} onChange={(v) => update({ sidebarViews: { ...settings.sidebarViews, [view]: v } })} />
                  </div>
                ))}
              </section>
              {/* Appearance */}
              <section className="card mt-6 p-5">
                <div className="flex items-center gap-2"><SunIcon className="h-4 w-4" /><h2 className="font-semibold">{tr('settings.appearance')}</h2><SettingsSearch root={pageRef} /></div>
                <ErrorBoundary label="Appearance"><ThemePresetPicker settings={settings} update={update} /></ErrorBoundary>

                <div className="mt-3 flex min-h-[40px] items-center justify-between gap-3">
                  <div className="min-w-0">
                    <span className="text-sm">Background animation</span>
                    <p id="background-animation-hint" className="text-2xs text-ink-faint">
                      {pixelWaveFor(wavePreset)
                        ? 'Moving pixel dots only in empty new-agent windows. Turn off for lower power use.'
                        : 'Pixel dots in empty new-agent windows with Lilac, Lavender and Experimental themes. This theme has none.'}
                    </p>
                  </div>
                  <Toggle
                    aria-label="Background animation"
                    aria-describedby="background-animation-hint"
                    on={settings.backgroundAnimation !== false}
                    onChange={(v) => update({ backgroundAnimation: v })}
                  />
                </div>

                <div className="mt-2 flex min-h-[40px] items-center justify-between gap-3">
                  <div className="min-w-0">
                    <span className="text-sm">{tr('settings.language')}</span>
                    <p className="text-2xs text-ink-faint">{tr('settings.languageHint')}</p>
                  </div>
                  <select
                    className="input max-w-[180px] py-1"
                    value={settings.language ?? ''}
                    onChange={(e) => update({ language: e.target.value || undefined })}
                  >
                    <option value="">{tr('settings.systemDefault')}</option>
                    {LANGUAGES.map((l) => (
                      <option key={l.code} value={l.code}>{l.label}</option>
                    ))}
                  </select>
                </div>
                <div className="mt-2 flex min-h-[40px] items-center justify-between gap-3">
                  <div className="min-w-0">
                    <label htmlFor="chat-pane-action" className="text-sm">Chat pane top-right action</label>
                    <p className="text-2xs text-ink-faint">The X completes a chat and keeps it under Completed until you delete it. Delete asks for confirmation unless you explicitly skip it. Close remains in the title-bar menu.</p>
                  </div>
                  <select
                    id="chat-pane-action"
                    className="input max-w-[180px] py-1"
                    value={settings.chatPaneAction ?? 'complete'}
                    onChange={(e) => update({ chatPaneAction: e.target.value === 'delete' ? 'delete' : 'complete' })}
                  >
                    <option value="complete">Complete (default)</option>
                    <option value="delete">Delete</option>
                  </select>
                </div>
                <div className="mt-2 flex min-h-[40px] items-center justify-between gap-3">
                  <div className="min-w-0">
                    <label htmlFor="auto-complete-after" className="text-sm">Complete idle agents after</label>
                    <p className="text-2xs text-ink-faint">Agents with no activity for this long are completed, like pressing their X. Pinned, running, waiting and sub-agent chats are skipped. Restore any from Show completed.</p>
                  </div>
                  <select
                    id="auto-complete-after"
                    className="input max-w-[180px] py-1"
                    value={autoCompleteDays(settings.autoCompleteAfterDays)}
                    onChange={(e) => update({ autoCompleteAfterDays: Number(e.target.value) })}
                  >
                    {AUTO_COMPLETE_CHOICES.map((c) => (
                      <option key={c.days} value={c.days}>{c.label}{c.days === AUTO_COMPLETE_DEFAULT_DAYS ? ' (default)' : ''}</option>
                    ))}
                  </select>
                </div>
                <div className="mt-2 flex min-h-[40px] items-center justify-between">
                  <span className="text-sm">Show tips</span>
                  <Toggle aria-label="Show tips" on={settings.showTips !== false} onChange={(v) => update({ showTips: v })} />
                </div>
                <div className="mt-2 flex min-h-[40px] items-center justify-between gap-3">
                  <span className="text-sm">Confirm deletions</span>
                  <Toggle aria-label="Confirm deletions" on={settings.skipDeleteConfirmation !== true} onChange={(v) => update({ skipDeleteConfirmation: !v })} />
                </div>
                <div className="mt-2 flex min-h-[40px] items-center justify-between gap-3 border-t border-line pt-3">
                  <div className="min-w-0">
                    <span className="text-sm">Setup wizard</span>
                    <p className="text-2xs text-ink-faint">Reopen the first-run walkthrough (theme, providers, integrations).</p>
                  </div>
                  <button className="btn btn-outline shrink-0 py-1 text-xs" onClick={() => void replaySetup()}>
                    Replay setup
                  </button>
                </div>
              </section>
              <DesktopBehaviorSection settings={settings} update={update} />
              <FunSection settings={settings} update={update} />
              <section className="card mt-5 p-5">
                <h2 className="font-semibold">Agents wall</h2>
                <WallLayoutSettings settings={settings} update={update} />
                <label className="mt-3 flex items-center justify-between gap-3 text-sm">Auto-add new agents
                  <input type="checkbox" checked={loadWallState(localStorage, settings.commandWall).autoAdd} onChange={async (e) => {
                    const wall = { ...loadWallState(localStorage, settings.commandWall), autoAdd: e.target.checked };
                    await update({ commandWall: toWallSetting(wall) });
                    saveWallState(localStorage, wall);
                  }} />
                </label>
                <p className="mt-1 text-xs text-ink-faint">Add newly created top-level agents to the wall automatically.</p>
              </section>
              <ErrorBoundary label="Customization"><CustomizationSection settings={settings} update={update} /></ErrorBoundary>
              <ErrorBoundary label="Voice settings"><VoiceSettings /></ErrorBoundary>
              <ErrorBoundary label="Notifications"><NotificationsSection settings={settings} update={update} /></ErrorBoundary>
              <ErrorBoundary label="Chat history"><HistorySettings openSync={() => goTo('phone')} refreshSessions={() => useStore.getState().refreshSessions()} /></ErrorBoundary>
            </SettingsGroup>
            <SettingsGroup id="phone">
              {/* Remote access (relay) */}
              <ErrorBoundary label="Remote access"><RemoteAccess /></ErrorBoundary>
              {/* Nekko Cloud sign-in and end-to-end encrypted sync */}
              <ErrorBoundary label="Sync"><SyncSettings /></ErrorBoundary>
            </SettingsGroup>
            <SettingsGroup id="style">
              <ErrorBoundary label="Style"><StyleSection settings={settings} update={update} /></ErrorBoundary>
            </SettingsGroup>
            <SettingsGroup id="agents">
              {/* Chat modes */}
              <section className="card mt-5 p-5">
                <div className="flex items-center gap-2"><ShieldIcon className="h-4 w-4" /><h2 className="font-semibold">{tr('settings.chatModes')}</h2></div>
                <p className="mt-1 text-xs text-ink-faint">
                  How chats run tools. Pick the default for new chats, each chat can override it from the composer.
                </p>
                <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-3">
                  {CHAT_MODES.map((m) => {
                    const active = (settings.defaultChatMode ?? 'guardrails') === m.value;
                    return (
                      <button key={m.value} onClick={() => update({ defaultChatMode: m.value })} className={`card p-3 text-left ${active ? 'border-accent' : ''}`}>
                        <div className="text-sm font-medium">{m.label}</div>
                        <div className="mt-0.5 text-2xs text-ink-faint">{m.desc}</div>
                      </button>
                    );
                  })}
                </div>
              </section>
              {/* Agent loop */}
              <ErrorBoundary label="Agent loop"><AgentLoopSection settings={settings} update={update} /></ErrorBoundary>
              <ErrorBoundary label="Hooks"><HooksSection settings={settings} update={update} /></ErrorBoundary>
              {/* Spec-driven development */}
              <section className="card mt-5 p-5">
                <div className="flex items-center gap-2"><h2 className="font-semibold">Spec-driven development</h2></div>
                <p className="mt-1 text-xs text-ink-faint">
                  Default workflow for building a spec and tasks from a conversation. Each chat can override it in the Context panel.
                </p>
                <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-3">
                  {SPEC_METHODOLOGIES.map((m) => {
                    const active = (settings.specMethodology ?? DEFAULT_SPEC_METHODOLOGY) === m.id;
                    return (
                      <button key={m.id} onClick={() => update({ specMethodology: m.id })} className={`card p-3 text-left ${active ? 'border-accent' : ''}`}>
                        <div className="text-sm font-medium">{m.label}</div>
                        <div className="mt-0.5 text-2xs text-ink-faint">{m.description}</div>
                      </button>
                    );
                  })}
                </div>
              </section>

              {/* Agent orchestration */}
              <section className="card mt-5 p-5">
                <div className="flex items-center gap-2"><RobotIcon className="h-4 w-4" /><h2 className="font-semibold">Agent orchestration</h2></div>
                <p className="mt-1 text-xs text-ink-faint">
                  How agents delegate to sub-agents. Shapes the system prompt and whether the <code className="text-2xs">spawn_agent</code> tool is offered.
                </p>
                <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-3">
                  {ORCHESTRATION_STRATEGIES.map((st) => {
                    const cur = settings.orchestration ?? DEFAULT_ORCHESTRATION;
                    const active = cur.strategy === st.id;
                    return (
                      <button
                        key={st.id}
                        onClick={() => update({ orchestration: { ...cur, strategy: st.id } })}
                        className={`card p-3 text-left ${active ? 'border-accent' : ''}`}
                      >
                        <div className="text-sm font-medium">{st.label}</div>
                        <div className="mt-0.5 text-2xs text-ink-faint">{st.description}</div>
                      </button>
                    );
                  })}
                </div>
                {(settings.orchestration ?? DEFAULT_ORCHESTRATION).strategy !== 'solo' && (
                  <div className="mt-3 flex flex-wrap gap-4">
                    {([
                      { key: 'maxDepth', label: 'Max nesting depth', min: 1, max: 4 },
                      { key: 'maxParallel', label: 'Parallel sub-agents (advisory)', min: 1, max: 12 },
                    ] as const).map((f) => {
                      const cur = settings.orchestration ?? DEFAULT_ORCHESTRATION;
                      return (
                        <label key={f.key} className="flex items-center gap-2 text-xs">
                          <span className="text-ink-faint">{f.label}</span>
                          <input
                            type="number"
                            min={f.min}
                            max={f.max}
                            value={cur[f.key]}
                            onChange={(e) => {
                              const n = Math.max(f.min, Math.min(f.max, Number(e.target.value) || f.min));
                              update({ orchestration: { ...cur, [f.key]: n } });
                            }}
                            className="input w-16 text-xs"
                          />
                        </label>
                      );
                    })}
                  </div>
                )}
              </section>

              <section className="card mt-6 p-5"><ErrorBoundary label="Delegation routes"><DelegationRouteSettings settings={settings} update={update} /></ErrorBoundary></section>
              <ErrorBoundary label="Automations"><AutomationsSection settings={settings} update={update} /></ErrorBoundary>
              <ErrorBoundary label="Claude plan features"><ClaudePlanFeaturesSection settings={settings} update={update} /></ErrorBoundary>
            </SettingsGroup>
            <SettingsGroup id="safety">
              {/* Security: hardware keys and step-up (SK-4) */}
              <ErrorBoundary label="Security"><SecuritySettings /></ErrorBoundary>
              {/* Sandbox */}
              <section className="card mt-5 p-5">
                <div className="flex items-center gap-2"><ShieldIcon className="h-4 w-4" /><h2 className="font-semibold">{tr('settings.sandbox')}</h2></div>
                <p className="mt-1 text-xs text-ink-faint">How Nekko Agent is allowed to touch your machine.</p>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  {SANDBOX_OPTS.map((o) => (
                    <button key={o.value} onClick={() => update({ sandboxMode: o.value })} className={`card p-3 text-left ${settings.sandboxMode === o.value ? 'border-accent' : ''}`}>
                      <div className="text-sm font-medium">{o.label}</div>
                      <div className="mt-0.5 text-2xs text-ink-faint">{o.desc}</div>
                    </button>
                  ))}
                </div>
              </section>
              {/* Guardrails */}
              <ErrorBoundary label="Guardrails"><GuardrailsSection settings={settings} update={update} updateGuardrail={updateGuardrail} /></ErrorBoundary>
            </SettingsGroup>
            <SettingsGroup id="connections">
              <ErrorBoundary label="Connections"><ConnectionsSettings settings={settings} update={update} /></ErrorBoundary>
            </SettingsGroup>
            <SettingsGroup id="tools">
              <ErrorBoundary label="Git management"><GitManagementSection settings={settings} update={update} /></ErrorBoundary>
              <ErrorBoundary label="Project management"><ProjectManagementSection settings={settings} update={update} /></ErrorBoundary>
              <ErrorBoundary label="Pull requests"><PullRequestsSection settings={settings} update={update} /></ErrorBoundary>
              {/* Terminal */}
              <ErrorBoundary label="Terminal"><TerminalSection settings={settings} update={update} /></ErrorBoundary>
              {/* MCP servers */}
              <ErrorBoundary label="MCP servers"><McpSection settings={settings} update={update} reload={reload} /></ErrorBoundary>
            </SettingsGroup>
            <SettingsGroup id="system">
              {/* Updates */}
              <ErrorBoundary label="Updates"><UpdatesSection settings={settings} update={update} /></ErrorBoundary>
              <section className="card mt-5 p-5">
                <h2 className="font-semibold">Developer</h2>
                <div className="mt-3 flex min-h-[40px] items-center justify-between gap-3">
                  <div><span className="text-sm">Show server controls</span>
                    <p className="text-2xs text-ink-faint">Desktop only. Show agent and model server toggles and Restart server in the top-right title bar. Off by default.</p></div>
                  <Toggle aria-label="Show server controls" on={settings.developer?.serverControls === true} onChange={(v) => update({ developer: { ...settings.developer, serverControls: v } })} />
                </div>
              </section>

              {/* Experimental */}
              <section className="card mt-5 p-5">
                <div className="flex items-center gap-2"><WandIcon className="h-4 w-4" /><h2 className="font-semibold">Experimental</h2></div>
                <p className="mt-1 text-xs text-ink-faint">
                  In-progress surfaces, kept out of the sidebar until you switch them on here. Off by default; turning one off hides the tab again.
                </p>
                <div className="mt-3">
                  {EXPERIMENTAL_FLAGS.map((f) => (
                    <div key={f.key} className="flex min-h-[40px] items-center justify-between gap-3">
                      <div className="min-w-0">
                        <span className="text-sm">{f.label}</span>
                        <p className="text-2xs text-ink-faint">{f.desc}</p>
                      </div>
                      <Toggle
                        aria-label={f.label}
                        on={settings.experimental?.[f.key] === true}
                        onChange={(v) => update({ experimental: { ...settings.experimental, [f.key]: v } })}
                      />
                    </div>
                  ))}
                </div>
              </section>

              {/* Backup & restore */}
              <ErrorBoundary label="Backup"><BackupSection settings={settings} onSettings={(s) => { useStore.setState({ settings: s }); applyTheme(); }} /></ErrorBoundary>


              {/* Data & privacy */}
              <ErrorBoundary label="Data and privacy"><DataSection onSettings={(s) => { useStore.setState({ settings: s }); applyTheme(); }} /></ErrorBoundary>
            </SettingsGroup>
            <p className="mt-6 text-center text-2xs text-ink-faint">Nekko Agent · open source · MIT</p>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Replies have no tool-step limit; the output cap saves on blur/Enter.
 */
function AgentLoopSection({ settings, update }: { settings: AppSettings; update: (patch: Partial<AppSettings>) => void }) {
  const savedOut = clampMaxOutputTokens(settings.maxOutputTokens);
  const [out, setOut] = useState(String(savedOut));
  useEffect(() => { setOut(String(clampMaxOutputTokens(settings.maxOutputTokens))); }, [settings.maxOutputTokens]);

  const commitOut = () => {
    const next = clampMaxOutputTokens(Number(out));
    setOut(String(next));
    if (next !== savedOut) update({ maxOutputTokens: next });
  };

  const savedWait = Math.max(0, Math.round(settings.unattendedQuestionMinutes ?? 0));
  const [wait, setWait] = useState(String(savedWait));
  useEffect(() => { setWait(String(Math.max(0, Math.round(settings.unattendedQuestionMinutes ?? 0)))); }, [settings.unattendedQuestionMinutes]);
  const commitWait = () => {
    const n = Number(wait);
    const next = Number.isFinite(n) ? Math.min(1440, Math.max(0, Math.round(n))) : savedWait;
    setWait(String(next));
    if (next !== savedWait) update({ unattendedQuestionMinutes: next });
  };

  return (
    <section className="card mt-5 p-5">
      <div className="flex items-center gap-2"><RobotIcon className="h-4 w-4" /><h2 className="font-semibold">Agent loop</h2></div>
      <p className="mt-1 text-xs text-ink-faint">
        Nekko Agent keeps working until the task is finished or you press Stop. Loop detection catches repeated tool
        calls and error streaks; output safeguards remain active.
      </p>
      <InternetRecoverySetting settings={settings} update={update} />
      <div className="mt-3 flex min-h-[40px] items-center justify-between gap-3">
        <div className="min-w-0">
          <span className="text-sm">Prompt caching</span>
          <p id="prompt-caching-hint" className="text-2xs text-ink-faint">
            On by default. Always sends the full context. Uses native caching on supported cloud providers and
            local KV cache reuse where supported; unsupported remote providers are not treated as cached.
            Off disables Nekko's cache requests and managed reuse, but providers may still cache automatically.
            For managed local models, the launch policy takes effect when you reload the model.
          </p>
        </div>
        <Toggle on={promptCachingEnabled(settings)} onChange={(v) => update({ promptCaching: v })} aria-label="Prompt caching" aria-describedby="prompt-caching-hint" />
      </div>
      <div className="mt-3 flex min-h-[40px] items-center justify-between gap-3">
        <div className="min-w-0">
          <span className="text-sm">Output cap per response, local models</span>
          <p className="text-2xs text-ink-faint">
            Tokens one response from a local server (Ollama, LM Studio, vLLM, llama.cpp) may generate. Stops a model
            that gets stuck repeating itself from streaming until its context fills. Cloud providers run to their own
            limits and are not capped. {MAX_OUTPUT_TOKENS_RANGE.min}–{MAX_OUTPUT_TOKENS_RANGE.max.toLocaleString()}.
            Default {MAX_OUTPUT_TOKENS_DEFAULT.toLocaleString()}.
          </p>
        </div>
        <input
          type="number"
          className="input max-w-[110px] py-1 tabular-nums"
          min={MAX_OUTPUT_TOKENS_RANGE.min}
          max={MAX_OUTPUT_TOKENS_RANGE.max}
          step={256}
          value={out}
          aria-label="Output cap per response"
          onChange={(e) => setOut(e.target.value)}
          onBlur={commitOut}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        />
      </div>
      <div className="mt-3 flex min-h-[40px] items-center justify-between gap-3">
        <div className="min-w-0">
          <span className="text-sm">Unattended questions: decide after</span>
          <p className="text-2xs text-ink-faint">
            Minutes a question from the agent waits for you before it is told nobody answered and to choose the most
            reasonable option itself, stating the assumption. For chats you leave running. 0 waits for ever. Approvals
            of risky commands never time out.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="number"
            className="input max-w-[90px] py-1 tabular-nums"
            min={0}
            max={1440}
            step={5}
            value={wait}
            aria-label="Unattended questions: decide after minutes"
            onChange={(e) => setWait(e.target.value)}
            onBlur={commitWait}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          />
          <span className="text-xs text-ink-faint">min</span>
        </div>
      </div>

    </section>
  );
}

const HOOK_EVENTS: Array<{ value: HookEvent; label: string; hint: string }> = [
  { value: 'PreToolUse', label: 'Before a tool', hint: 'Exit code 2, or {"decision":"block","reason":"…"} on stdout, blocks the call; the reason goes to the model.' },
  { value: 'PostToolUse', label: 'After a tool', hint: 'Whatever it prints is appended to the tool result for the model.' },
  { value: 'TurnEnd', label: 'When a reply ends', hint: 'Runs when a reply finishes, fails or is stopped. Nothing waits on it.' },
];

/**
 * Lifecycle hooks: a shell command per event, the event as JSON on stdin.
 */
function HooksSection({ settings, update }: { settings: AppSettings; update: (patch: Partial<AppSettings>) => void }) {
  const hooks = settings.hooks ?? [];
  const save = (next: HookRule[]) => update({ hooks: next });
  const edit = (id: string, patch: Partial<HookRule>) => save(hooks.map((h) => (h.id === id ? { ...h, ...patch } : h)));
  const add = () => save([...hooks, { id: `hook_${Date.now().toString(36)}`, event: 'PreToolUse', matcher: '', command: '', enabled: true }]);
  return (
    <section className="card mt-5 p-5">
      <div className="flex items-center gap-2"><WandIcon className="h-4 w-4" /><h2 className="font-semibold">Hooks</h2></div>
      <p className="mt-1 text-xs text-ink-faint">
        Your own commands around the agent's actions. Each gets the event as JSON on stdin (event, tool name and input,
        the result for post-hooks) and runs in the chat's workspace with <code>NEKKO_HOOK_EVENT</code> set; the tool name
        matcher is a regular expression, empty for every tool. While a tool hook is on, every tool runs in the host so the
        hook sees it.
      </p>
      <div className="mt-3 space-y-2">
        {hooks.map((h) => {
          const ev = HOOK_EVENTS.find((e) => e.value === h.event) ?? HOOK_EVENTS[0];
          return (
            <div key={h.id} className="rounded-lg border border-line p-3">
              <div className="flex flex-wrap items-center gap-2">
                <select className="input max-w-[170px] py-1" value={h.event} aria-label="Hook event" onChange={(e) => edit(h.id, { event: e.target.value as HookEvent })}>
                  {HOOK_EVENTS.map((e) => <option key={e.value} value={e.value}>{e.label}</option>)}
                </select>
                <input className="input max-w-[150px] py-1 text-xs" placeholder="Name" aria-label="Hook name" defaultValue={h.name ?? ''} onBlur={(e) => edit(h.id, { name: e.target.value.trim() || undefined })} />
                {h.event !== 'TurnEnd' && (
                  <input className="input max-w-[170px] py-1 font-mono text-xs" placeholder="Tools (regex), empty = all" aria-label="Hook tool matcher" defaultValue={h.matcher ?? ''} onBlur={(e) => edit(h.id, { matcher: e.target.value.trim() })} />
                )}
                <div className="ml-auto flex items-center gap-2">
                  <Toggle aria-label={`Hook ${h.name || 'enabled'}`} on={h.enabled !== false} onChange={(v) => edit(h.id, { enabled: v })} />
                  <button className="btn btn-ghost px-2 py-1 text-ink-faint hover:text-(--danger)" title="Remove hook" aria-label="Remove hook" onClick={() => save(hooks.filter((x) => x.id !== h.id))}><TrashIcon className="h-3.5 w-3.5" /></button>
                </div>
              </div>
              <input className="input mt-2 w-full py-1 font-mono text-xs" placeholder="Command, e.g. node scripts/check-tool.js" aria-label="Hook command" defaultValue={h.command} onBlur={(e) => edit(h.id, { command: e.target.value })} />
              <p className="mt-1 text-2xs text-ink-faint">{ev.hint}</p>
            </div>
          );
        })}
      </div>
      <button className="btn btn-outline mt-3 px-3 py-1 text-xs" onClick={add}>Add hook</button>
    </section>
  );
}

/**
 * Which renderer terminals use. xterm.js on WebGL is the default because it
 * holds the one-frame budget under heavy output; Ghostty's core is offered as
 * an experiment until its canvas renderer does too.
 */
function TerminalSection({ settings, update }: { settings: AppSettings; update: (patch: Partial<AppSettings>) => void }) {
  const [shells, setShells] = useState<ShellOption[]>([]);
  useEffect(() => { window.nekko.listShells().then(setShells).catch(() => {}); }, []);
  return (
    <section className="card mt-5 p-5">
      <div className="flex items-center gap-2"><h2 className="font-semibold">Terminal</h2></div>
      <label className="mt-3 flex min-h-[40px] items-center justify-between gap-3">
        <span className="text-sm">Default shell</span>
        <select className="input max-w-[180px] py-1" aria-label="Default shell" value={settings.defaultShellPath ?? ''} onChange={(e) => update({ defaultShellPath: e.target.value || undefined })}>
          <option value="">Auto-detect</option>
          {settings.defaultShellPath && !shells.some((shell) => shell.path === settings.defaultShellPath) && <option value={settings.defaultShellPath}>{settings.defaultShellPath} (unavailable)</option>}
          {shells.map((shell) => <option key={shell.id} value={shell.path}>{shell.label}</option>)}
        </select>
      </label>
      <div className="mt-3 flex min-h-[40px] items-center justify-between gap-3">
        <div className="min-w-0">
          <span className="text-sm">Renderer</span>
          <p className="text-2xs text-ink-faint">
            xterm.js draws on the GPU and stays smooth under heavy output. Ghostty uses the same terminal core as
            the Ghostty app, but can lag while a command prints a lot. Open terminals redraw when you switch.
          </p>
        </div>
        <select
          className="input max-w-[180px] py-1"
          aria-label="Terminal renderer"
          value={settings.terminal?.renderer ?? 'xterm'}
          onChange={(e) => update({ terminal: { ...settings.terminal, renderer: e.target.value as TerminalRenderer } })}
        >
          <option value="xterm">xterm.js</option>
          <option value="ghostty">Ghostty (experimental)</option>
        </select>
      </div>
    </section>
  );
}

function BackupSection({ settings, onSettings }: { settings: AppSettings; onSettings: (s: AppSettings) => void }) {
  const { pushToast, refreshProviders } = useStore(useShallow((s) => ({ pushToast: s.pushToast, refreshProviders: s.refreshProviders })));

  const exportSettings = () => {
    const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'nekko-agent-settings.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const importSettings = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Not a settings object');
        if (!window.confirm('Import these settings? This overwrites your current configuration.')) return;
        const next = await window.nekko.updateSettings(parsed);
        onSettings(next);
        await refreshProviders();
        pushToast('success', 'Settings imported.');
      } catch (e) {
        pushToast('error', `Import failed: ${(e as Error).message}`);
      }
    };
    input.click();
  };

  return (
    <section className="card mt-5 p-5">
      <div className="flex items-center gap-2"><SunIcon className="h-4 w-4" /><h2 className="font-semibold">Backup &amp; restore</h2></div>
      <p className="mt-1 text-xs text-ink-faint">Export your configuration (providers, guardrails, prompts, MCP servers…) to a JSON file, or restore it on another machine.</p>
      <div className="mt-3 flex gap-2">
        <button className="btn btn-outline py-1 text-xs" onClick={exportSettings}>Export settings</button>
        <button className="btn btn-outline py-1 text-xs" onClick={importSettings}>Import settings…</button>
      </div>
    </section>
  );
}

function DataSection({ onSettings }: { onSettings: (s: AppSettings) => void }) {
  const { refreshSessions, refreshProviders, pushToast } = useStore(
    useShallow((s) => ({
      refreshSessions: s.refreshSessions,
      refreshProviders: s.refreshProviders,
      pushToast: s.pushToast,
    })),
  );
  const [busy, setBusy] = useState(false);

  const clear = async (scope: 'today' | 'month' | 'all', label: string) => {
    if (!window.confirm(`Delete ${label}? This can't be undone.`)) return;
    setBusy(true);
    const n = await window.nekko.clearSessions(scope);
    await refreshSessions();
    useStore.setState({ activeSessionId: null });
    setBusy(false);
    pushToast('success', `Deleted ${n} chat${n === 1 ? '' : 's'}.`);
  };

  const reset = async () => {
    if (!window.confirm('Reset all settings to defaults? Your providers and preferences will be cleared (chats are kept).')) return;
    setBusy(true);
    const s = await window.nekko.resetSettings();
    onSettings(s);
    await refreshProviders();
    setBusy(false);
    pushToast('success', 'Settings reset to defaults.');
  };

  const wipe = async () => {
    if (!window.confirm('Delete EVERYTHING, all chats, settings, memory, and usage? This cannot be undone.')) return;
    if (!window.confirm('Are you absolutely sure? This wipes all Nekko Agent data.')) return;
    setBusy(true);
    const s = await window.nekko.wipeAllData();
    onSettings(s);
    await refreshSessions();
    await refreshProviders();
    useStore.setState({ activeSessionId: null });
    setBusy(false);
    pushToast('success', 'All data deleted.');
  };

  return (
    <section className="card mt-5 p-5" style={{ borderColor: 'color-mix(in srgb, var(--danger) 35%, var(--line))' }}>
      <div className="flex items-center gap-2"><ShieldIcon className="h-4 w-4" /><h2 className="font-semibold">Data &amp; privacy</h2></div>
      <p className="mt-1 text-xs text-ink-faint">Everything stays on your machine. Clean it up here whenever you want.</p>

      <div className="mt-3 flex min-h-[36px] flex-wrap items-center justify-between gap-2">
        <span className="text-sm">Delete chats</span>
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-outline py-1 text-xs" disabled={busy} onClick={() => clear('today', "today's chats")}>Today</button>
          <button className="btn btn-outline py-1 text-xs" disabled={busy} onClick={() => clear('month', "this month's chats")}>This month</button>
          <button className="btn btn-outline py-1 text-xs" disabled={busy} onClick={() => clear('all', 'all chats')}>All chats</button>
        </div>
      </div>

      <div className="mt-2 flex min-h-[36px] items-center justify-between gap-2">
        <span className="text-sm">Reset settings to defaults</span>
        <button className="btn btn-outline py-1 text-xs" disabled={busy} onClick={reset}>Reset configs</button>
      </div>

      <div className="mt-2 flex min-h-[36px] items-center justify-between gap-2">
        <div>
          <span className="text-sm">Delete everything</span>
          <p className="text-2xs text-ink-faint">Chats, settings, memory, and usage analytics.</p>
        </div>
        <button
          className="btn py-1 text-xs text-white!"
          style={{ background: 'var(--danger)' }}
          disabled={busy}
          onClick={wipe}
        >
          Delete everything
        </button>
      </div>
    </section>
  );
}

function McpSection({
  settings, update, reload,
}: {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
  reload: () => Promise<void>;
}) {
  const { pushToast } = useStore(useShallow((s) => ({ pushToast: s.pushToast })));
  const servers = settings.mcpServers ?? [];
  const [status, setStatus] = useState<McpServerStatus[]>([]);
  const [busy, setBusy] = useState(false);
  const [linking, setLinking] = useState(false);
  // The local Hypergate daemon, if one is running: undefined while probing,
  // null when nothing answered. Lives in the store because the pairing is
  // app-wide (the tab, the palette, and the deep link all read it).
  const hypergate = useStore((s) => s.hypergate);
  const refreshHypergate = useStore((s) => s.refreshHypergate);
  const connectHypergate = useStore((s) => s.connectHypergate);
  const openHypergatePane = useStore((s) => s.openHypergatePane);
  useEffect(() => { void refreshHypergate(); }, [refreshHypergate]);
  // The gateway keeps a fixed id, so "is it connected" is a lookup rather than
  // something to track.
  const connected = servers.some((s) => s.id === 'hypergate');
  /** One click: claim a token, save the entry, connect it, open the tab. */
  const link = async () => {
    setLinking(true);
    if (await connectHypergate(hypergate?.port)) await reload();
    setLinking(false);
  };
  const setServers = (next: typeof servers) => update({ mcpServers: next });
  const add = () =>
    setServers([
      ...servers,
      { id: `m_${Date.now().toString(36)}`, name: 'filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'], enabled: false },
    ]);
  const addUrl = () =>
    setServers([
      ...servers,
      { id: `m_${Date.now().toString(36)}`, name: 'http server', command: '', args: [], url: 'http://localhost:7777/mcp', token: '', enabled: false },
    ]);
  const edit = (id: string, patch: Partial<(typeof servers)[number]>) =>
    setServers(servers.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const remove = (id: string) => setServers(servers.filter((s) => s.id !== id));
  const connect = async () => {
    setBusy(true);
    try {
      const st = await window.nekko.getMcpStatus();
      setStatus(st);
      const tools = st.reduce((n, s) => n + s.tools.length, 0);
      pushToast('success', `Connected ${st.filter((s) => s.connected).length}/${st.length} server(s), ${tools} tool(s).`);
    } catch (e) {
      pushToast('error', (e as Error).message);
    }
    setBusy(false);
  };
  const stOf = (id: string) => status.find((s) => s.id === id);

  return (
    <section className="card mt-5 p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2"><ShieldIcon className="h-4 w-4" /><h2 className="font-semibold">MCP servers</h2></div>
        <div className="flex gap-2">
          <button className="btn btn-outline py-1 text-xs" onClick={connect} disabled={busy || servers.length === 0}>
            {busy ? 'Connecting…' : 'Connect & refresh'}
          </button>
          <button className="btn btn-outline py-1 text-xs" onClick={add}>+ Add</button>
          <button className="btn btn-outline py-1 text-xs" onClick={addUrl} title="A streamable-HTTP MCP endpoint (URL + optional bearer token)">+ Add URL</button>
        </div>
      </div>
      <p className="mt-1 text-xs text-ink-faint">
        Model Context Protocol servers extend the agent with extra tools. Enabled servers' tools are offered in every chat.
      </p>
      {hypergate && (
        <div className="card mt-3 p-3" style={{ borderColor: 'color-mix(in srgb, var(--accent) 35%, transparent)' }}>
          <div className="flex items-center gap-2">
            <ShieldIcon className="h-5 w-5 shrink-0 text-accent" />
            {/* min-w-0 so the prose is what gives way when the card narrows;
                without it the buttons are squeezed and their labels wrap. */}
            <div className="min-w-0">
              <p className="text-xs font-semibold">
                Hypergate detected{' '}
                <span className="font-normal text-ink-faint">
                  · v{hypergate.version} · {hypergate.servers} managed server{hypergate.servers === 1 ? '' : 's'} · port {hypergate.port}
                </span>
              </p>
              <p className="text-xs text-ink-faint">
                {connected
                  ? `Connected${hypergate.agent ? ` as ${hypergate.agent}` : ''}. Every server it manages is one entry here, and its tools are in every chat.`
                  : 'One click registers Nekko Agent with it, adds the gateway below, and opens Hypergate as a tab in this window.'}
              </p>
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-2 whitespace-nowrap">
              {connected && (
                <button className="btn btn-outline py-1 text-xs" onClick={openHypergatePane}>Open tab</button>
              )}
              <button className="btn btn-primary py-1 text-xs" disabled={linking} onClick={() => void link()}>
                {linking ? 'Connecting…' : connected ? 'Reconnect' : 'Connect Hypergate'}
              </button>
            </div>
          </div>
        </div>
      )}
      {hypergate === null && (
        <div className="mt-3 flex items-center gap-2 rounded-xl border border-line px-3 py-2">
          <ShieldIcon className="h-5 w-5 shrink-0 text-ink-faint" />
          <p className="text-xs text-ink-faint">
            Optional: <span className="font-medium text-ink-soft">Hypergate</span> runs and supervises local MCP servers behind one
            endpoint. Start its daemon and a one-click Connect appears here{connected ? ' (the saved gateway reconnects on its own)' : ''}.
          </p>
          <button
            className="btn btn-ghost ml-auto shrink-0 px-2! py-0.5! text-2xs text-accent"
            onClick={() => window.nekko.openPath('https://hypergate.app')}
          >
            Get Hypergate ↗
          </button>
        </div>
      )}
      <div className="mt-3 space-y-2">
        {servers.length === 0 && <p className="text-xs text-ink-faint">No MCP servers. Add one (e.g. <code>npx -y @modelcontextprotocol/server-filesystem .</code>).</p>}
        {servers.map((s) => {
          const st = stOf(s.id);
          return (
            <div key={s.id} className={`card p-3 ${s.enabled ? '' : 'opacity-60'}`}>
              <div className="flex items-center gap-2">
                <input className="input py-1 text-xs" style={{ maxWidth: 160 }} value={s.name} onChange={(e) => edit(s.id, { name: e.target.value })} />
                <span className="chip">{s.url != null ? 'http' : 'stdio'}</span>
                {st && (
                  <Badge tone={st.connected ? 'success' : 'danger'} variant="solid" title={st.error}>
                    {st.connected ? `${st.tools.length} tools` : 'offline'}
                  </Badge>
                )}
                <div className="ml-auto flex items-center gap-2">
                  <Toggle aria-label={`MCP server ${s.name}`} on={s.enabled} onChange={(v) => edit(s.id, { enabled: v })} />
                  <button className="btn btn-ghost px-2 py-1" title="Remove" onClick={() => remove(s.id)}><TrashIcon className="h-4 w-4" /></button>
                </div>
              </div>
              {s.url != null ? (
                <div className="mt-2 flex gap-2">
                  <input className="input py-1 font-mono text-xs" value={s.url} onChange={(e) => edit(s.id, { url: e.target.value })} placeholder="http://localhost:7777/mcp" />
                  <input className="input py-1 font-mono text-xs" style={{ maxWidth: 200 }} type="password" value={s.token ?? ''} onChange={(e) => edit(s.id, { token: e.target.value })} placeholder="bearer token (optional)" />
                </div>
              ) : (
                <div className="mt-2 flex gap-2">
                  <input className="input py-1 font-mono text-xs" style={{ maxWidth: 110 }} value={s.command} onChange={(e) => edit(s.id, { command: e.target.value })} placeholder="npx" />
                  <input className="input py-1 font-mono text-xs" value={s.args.join(' ')} onChange={(e) => edit(s.id, { args: e.target.value.split(/\s+/).filter(Boolean) })} placeholder="-y @modelcontextprotocol/server-filesystem ." />
                </div>
              )}
              {st?.error && <p className="mt-1 text-2xs" style={{ color: 'var(--danger)' }}>{st.error}</p>}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function ProjectManagementSection({ settings, update }: { settings: AppSettings; update: (patch: Partial<AppSettings>) => void }) {
  return (
    <section className="card mt-5 p-5">
      <h2 className="font-semibold">Project management</h2>
      <p className="mt-1 text-xs text-ink-faint">How agent chats track their work. A change bound for a PR gets an issue first, and the PR links to it.</p>
      <ProjectManagementToggles value={settings.projectManagement} onChange={(projectManagement) => update({ projectManagement })} />
    </section>
  );
}

export function PullRequestsSection({ settings, update }: { settings: AppSettings; update: (patch: Partial<AppSettings>) => void }) {
  return (
    <section className="card mt-5 p-5">
      <h2 className="font-semibold">Pull requests</h2>
      <p className="mt-1 text-xs text-ink-faint">What goes into the PRs agent chats open. Secrets and unrelated images are never included.</p>
      <PullRequestToggles value={settings.pullRequests} onChange={(pullRequests) => update({ pullRequests })} />
    </section>
  );
}

function GitManagementSection({ settings, update }: { settings: AppSettings; update: (patch: Partial<AppSettings>) => void }) {
  const [worktrees, setWorktrees] = useState<ChatWorktreeInfo[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const refresh = useCallback(() => {
    window.nekko.listChatWorktrees().then(setWorktrees).catch((e) => { setWorktrees([]); setMessage(String((e as Error).message ?? e)); });
  }, []);
  useEffect(() => {
    refresh();
    // The host removes merged worktrees in the background; re-read while this is open.
    const t = window.setInterval(refresh, 60_000);
    return () => window.clearInterval(t);
  }, [refresh]);
  const remove = async (w: ChatWorktreeInfo) => {
    setBusy(w.root);
    setMessage(null);
    try {
      const { branchDeleted } = await window.nekko.removeChatWorktree(w.root);
      setMessage(branchDeleted
        ? `Removed the worktree and its merged branch ${w.branch}.`
        : `Removed the worktree. Branch ${w.branch} was kept because it has commits not on the main checkout; the chat picks it back up if continued.`);
    } catch (e) {
      setMessage(String((e as Error).message ?? e));
    } finally {
      setBusy(null);
      refresh();
    }
  };
  const setSetup = (id: string, value: string) => {
    const current = settings.workspaces.find((w) => w.id === id)?.worktreeSetup ?? '';
    if (value.trim() === current) return;
    update({ workspaces: settings.workspaces.map((w) => (w.id === id ? { ...w, worktreeSetup: value.trim() || undefined } : w)) });
  };
  return (
    <section className="card mt-5 p-5">
      <h2 className="font-semibold">Git management</h2>
      <p className="mt-1 text-xs text-ink-faint">New chats get their own branch and worktree, so several agents can work on one repository at once without touching each other's files or your checkout. Existing chats and delegated sub-agents keep their current checkout.</p>
      <label className="mt-3 flex items-center justify-between gap-3 text-sm">
        New chat checkout
        <select className="input max-w-[230px]" value={settings.gitManagement?.mode ?? 'worktree'} onChange={(e) => update({ gitManagement: { ...settings.gitManagement, mode: e.target.value as 'worktree' | 'shared' } })}>
          <option value="worktree">Isolated worktree (recommended)</option>
          <option value="shared">Shared project checkout</option>
        </select>
      </label>
      <label className="mt-3 flex items-center justify-between gap-3 text-sm">
        Worktree baseline
        <select className="input max-w-[230px]" value={settings.gitManagement?.baseline ?? 'head'} onChange={(e) => update({ gitManagement: { ...settings.gitManagement, baseline: e.target.value as 'head' | 'local-changes' } })}>
          <option value="head">Committed HEAD (recommended)</option>
          <option value="local-changes">HEAD plus tracked local edits</option>
        </select>
      </label>
      <p className="mt-2 text-2xs text-ink-faint">Committed HEAD excludes local edits and shows a notice at startup. Copying local edits includes tracked changes only, not untracked files, secrets, or build artifacts.</p>
      <label className="mt-3 flex items-center justify-between gap-3 text-sm">
        <span>
          Remove worktrees after their PR merges
          <span className="mt-0.5 block text-2xs text-ink-faint">Checked hourly. A worktree with uncommitted or untracked files, or whose chat is running, is kept. Continuing the chat later restores its checkout.</span>
        </span>
        <input type="checkbox" className="h-4 w-4 shrink-0" checked={settings.gitManagement?.removeMerged !== false} onChange={(e) => update({ gitManagement: { ...settings.gitManagement, removeMerged: e.target.checked } })} />
      </label>

      {settings.workspaces.length > 0 && (
        <div className="mt-4 border-t border-line pt-3">
          <span className="text-sm font-medium">Worktree setup</span>
          <p className="mt-0.5 text-2xs text-ink-faint">A new worktree has only tracked files. Each project can run a command there before the chat's first turn (for example <code>npm install</code>); its output appears in the chat's Agent commands terminal. To copy ignored local files such as <code>.env</code>, list them in a <code>.worktreeinclude</code> file at the repository root (gitignore syntax).</p>
          <div className="mt-2 space-y-2">
            {settings.workspaces.map((w) => (
              <label key={w.id} className="flex items-center justify-between gap-3 text-xs">
                <span className="min-w-0 truncate" title={w.path}>{w.name}</span>
                <input key={w.worktreeSetup ?? ''} className="input max-w-[260px] font-mono text-xs" placeholder="No setup command" aria-label={`Worktree setup command for ${w.name}`} defaultValue={w.worktreeSetup ?? ''} onBlur={(e) => setSetup(w.id, e.target.value)} />
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="mt-4 border-t border-line pt-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium">Chat worktrees</span>
          <button className="btn btn-outline py-1 text-xs" onClick={refresh}>Refresh</button>
        </div>
        <p className="mt-0.5 text-2xs text-ink-faint">Worktrees are kept when a chat is completed or deleted. Removing one frees the folder: Git refuses if it has uncommitted changes, and its branch is deleted only once merged.</p>
        <div className="mt-2 space-y-1">
          {worktrees === null && <p className="text-xs text-ink-faint">Loading...</p>}
          {worktrees?.length === 0 && <p className="text-xs text-ink-faint">No chat worktrees.</p>}
          {worktrees?.map((w) => {
            const blocked = w.running ? 'Stop the chat first.' : w.dirtyCount ? 'Has uncommitted changes.' : '';
            return (
              <div key={w.root} className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-xs">{w.sessionTitle ?? <span className="text-ink-faint">Deleted chat</span>}{w.running && <span className="ml-2 text-2xs text-ink-faint">running</span>}</div>
                  <div className="truncate font-mono text-2xs text-ink-faint" title={w.root}>{w.branch ?? 'detached'} · {w.dirtyCount ? `${w.dirtyCount} uncommitted` : 'clean'} · {w.unmergedCount ? `${w.unmergedCount} unmerged commit${w.unmergedCount === 1 ? '' : 's'}` : 'no new commits'}</div>
                </div>
                <button className="btn btn-outline shrink-0 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40" disabled={!!blocked || busy === w.root} title={blocked || 'Remove this worktree folder'} onClick={() => void remove(w)}>
                  {busy === w.root ? 'Removing...' : 'Remove'}
                </button>
              </div>
            );
          })}
        </div>
        {message && <p role="status" className="mt-2 text-2xs text-ink-soft">{message}</p>}
      </div>
    </section>
  );
}

function CustomizationSection({ settings, update }: { settings: AppSettings; update: (patch: Partial<AppSettings>) => void }) {
  return (
    <section id="customization" className="card mt-5 p-5">
      <h2 className="font-semibold">Customization</h2>
      <p className="mt-1 text-xs text-ink-faint">These preferences are sent to the selected provider on every chat turn. Avoid including secrets. Built-in safety and tool policies still apply.</p>
      {([
        { key: 'aboutUser', label: 'About you', hint: 'Your name, role, experience, goals, language, and communication preferences.', fallback: '' },
        { key: 'systemInstructions', label: 'System prompt', hint: 'Additional standing instructions for how Nekko should work with you.', fallback: '' },
        { key: 'turnWrapper', label: 'Server prompt wrapper', hint: 'Applied server-side to each user turn without altering the saved user message. Titles and plans use app tools when available.', fallback: DEFAULT_TURN_WRAPPER },
      ] as const).map((field) => (
        <label key={field.key} className="mt-4 block text-sm">
          <span className="font-medium">{field.label}</span>
          <p className="mt-0.5 text-2xs text-ink-faint">{field.hint}</p>
          <textarea key={settings[field.key] ?? field.fallback} aria-label={field.label} className="input mt-2 min-h-[100px] resize-y text-xs leading-relaxed" defaultValue={settings[field.key] ?? field.fallback} onBlur={(e) => { if (e.target.value !== (settings[field.key] ?? field.fallback)) update({ [field.key]: e.target.value }); }} />
        </label>
      ))}
      <p className="mt-2 text-2xs text-ink-faint">Edits save when you leave a field. An empty wrapper disables the extra per-turn instructions.</p>
      <button className="btn btn-outline mt-3 py-1 text-xs" onClick={() => update({ turnWrapper: DEFAULT_TURN_WRAPPER })}>Reset wrapper to recommended points</button>
    </section>
  );
}

function PromptsSection({ settings, update }: { settings: AppSettings; update: (patch: Partial<AppSettings>) => void }) {
  const prompts = settings.prompts ?? [];
  const setPrompts = (next: typeof prompts) => update({ prompts: next });
  const add = () =>
    setPrompts([...prompts, { id: `p_${Date.now().toString(36)}`, name: 'new', body: '' }]);
  const edit = (id: string, patch: Partial<{ name: string; body: string }>) =>
    setPrompts(prompts.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  const remove = (id: string) => setPrompts(prompts.filter((p) => p.id !== id));

  return (
    <section className="card mt-5 p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2"><SunIcon className="h-4 w-4" /><h2 className="font-semibold">Slash commands</h2></div>
        <button className="btn btn-outline py-1 text-xs" onClick={add}>+ Add</button>
      </div>
      <p className="mt-1 text-xs text-ink-faint">Reusable prompts. Type <code>/name</code> in the composer to insert one.</p>
      <div className="mt-3 space-y-2">
        {prompts.length === 0 && <p className="text-xs text-ink-faint">No prompts yet.</p>}
        {prompts.map((p) => (
          <div key={p.id} className="card p-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-ink-faint">/</span>
              <input
                className="input py-1 text-xs"
                style={{ maxWidth: 180 }}
                value={p.name}
                onChange={(e) => edit(p.id, { name: e.target.value.replace(/\s+/g, '-') })}
              />
              <button className="btn btn-ghost px-2 py-1" title="Delete" onClick={() => remove(p.id)}>
                <TrashIcon className="h-4 w-4" />
              </button>
            </div>
            <textarea
              className="input mt-2 min-h-[56px] resize-none text-xs"
              value={p.body}
              placeholder="Prompt text inserted when you pick this command…"
              onChange={(e) => edit(p.id, { body: e.target.value })}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

function GuardrailsSection({
  settings,
  update,
  updateGuardrail,
}: {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
  updateGuardrail: (rule: GuardrailRule) => void;
}) {
  const [jsonMode, setJsonMode] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');

  const openJson = () => {
    setDraft(JSON.stringify(settings.guardrails, null, 2));
    setError('');
    setJsonMode(true);
  };

  const defaultById = new Map(DEFAULT_GUARDRAILS.map((r) => [r.id, r]));
  const isChanged = (g: GuardrailRule) => {
    const d = defaultById.get(g.id);
    return !d || d.action !== g.action || d.enabled !== g.enabled || d.pattern !== g.pattern;
  };
  const changedCount =
    settings.guardrails.filter(isChanged).length + DEFAULT_GUARDRAILS.filter((d) => !settings.guardrails.some((g) => g.id === d.id)).length;

  const resetToDefaults = () => {
    update({ guardrails: DEFAULT_GUARDRAILS.map((r) => ({ ...r })) });
    setJsonMode(false);
    setError('');
  };

  const apply = () => {
    try {
      const parsed = JSON.parse(draft) as GuardrailRule[];
      if (!Array.isArray(parsed)) throw new Error('Expected a JSON array of rules.');
      for (const r of parsed) {
        if (!r.id || !r.pattern || !r.action) throw new Error('Each rule needs id, pattern, and action.');
      }
      update({ guardrails: parsed });
      setJsonMode(false);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section className="card mt-5 p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2"><ShieldIcon className="h-4 w-4" /><h2 className="font-semibold">Guardrails</h2></div>
        <button className="btn btn-outline py-1 text-xs" onClick={() => (jsonMode ? setJsonMode(false) : openJson())}>
          {jsonMode ? 'Visual editor' : 'Edit as JSON'}
        </button>
      </div>
      <p className="mt-1 text-xs text-ink-faint">
        In Guardrails mode only read-only commands (ls, cat, rg, git status and the like) run without asking. These rules add to that: an allow rule lets matching commands run too (your test or build command, say), ask always asks, and deny blocks in every mode. Edit them here or as JSON. The dot marks each rule's default.
      </p>

      {jsonMode ? (
        <div className="mt-3">
          <textarea
            className="input min-h-[260px] font-mono text-xs leading-relaxed"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
          />
          {error && <p className="mt-1 text-xs" style={{ color: 'var(--danger)' }}>{error}</p>}
          <div className="mt-2 flex justify-end gap-2">
            <button className="btn btn-ghost" onClick={() => setJsonMode(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={apply}>Apply</button>
          </div>
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          {settings.guardrails.map((g) => (
            <div key={g.id} className={`card p-3 ${g.enabled ? '' : 'opacity-50'}`}>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{g.label}</span>
                    <span className="h-2 w-2 rounded-full" style={{ background: g.severity === 'high' ? 'var(--danger)' : g.severity === 'medium' ? 'var(--warning)' : 'var(--neutral)' }} />
                  </div>
                  <p className="truncate text-2xs text-ink-faint">{g.description}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <div className="flex rounded-lg p-0.5" style={{ background: 'var(--surface-2)' }}>
                    {(['allow', 'ask', 'deny'] as GuardrailAction[]).map((a) => {
                      const isDefault = defaultById.get(g.id)?.action === a;
                      return (
                        <button
                          key={a}
                          onClick={() => updateGuardrail({ ...g, action: a })}
                          title={isDefault ? 'Default' : undefined}
                          className="relative rounded-md px-2 py-1 text-2xs font-medium"
                          style={g.action === a ? { background: ACTION_COLORS[a], color: '#fff' } : { color: 'var(--ink-faint)' }}
                        >
                          {a}
                          {isDefault && (
                            <span
                              aria-label="default"
                              className="absolute right-[3px] top-[3px] h-1.5 w-1.5 rounded-full"
                              style={{ background: 'currentColor', opacity: 0.9 }}
                            />
                          )}
                        </button>
                      );
                    })}
                  </div>
                  <Toggle aria-label={g.label} on={g.enabled} onChange={(v) => updateGuardrail({ ...g, enabled: v })} />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="text-xs text-ink-faint">
          {changedCount === 0 ? 'Using the default rules.' : `${changedCount} ${changedCount === 1 ? 'rule differs' : 'rules differ'} from the defaults.`}
        </p>
        <button className="btn btn-outline py-1 text-xs" onClick={resetToDefaults} disabled={changedCount === 0 && settings.guardrails.length === DEFAULT_GUARDRAILS.length}>
          Reset to defaults
        </button>
      </div>
    </section>
  );
}

function UpdatesSection({ settings, update }: { settings: AppSettings; update: (patch: Partial<AppSettings>) => void }) {
  const updater = useUpdater();
  const { app: info, info: status, stage } = updater;
  const isWeb = info?.edition === 'web';
  const checks = updateChecks(settings);
  const [catalogState, setCatalogState] = useState<'idle' | 'checking' | 'done' | 'failed'>('idle');
  // The app toggle also writes the legacy `autoUpdate` field: the main-process
  // startup check and the first-run prompt still read it.
  const setCheck = (key: keyof UpdateCheckSettings, v: boolean) =>
    update({ updates: { ...settings.updates, [key]: v }, ...(key === 'app' ? { autoUpdate: v } : {}) });
  const runCatalogChecks = async () => {
    setCatalogState('checking');
    try {
      await window.nekko.runUpdateChecks();
      setCatalogState('done');
    } catch {
      setCatalogState('failed');
    }
  };
  const statusText = stage === 'available'
    ? isWeb ? 'A newer build is ready.' : `Update available: v${status?.version ?? ''}`
    : stage === 'downloaded'
      ? `Ready to install v${status?.version ?? ''}.`
      : stage === 'downloading'
        ? `Downloading v${status?.version ?? ''}`
        : stage === 'installing'
          ? `Installing v${status?.version ?? ''} and restarting.`
          : stage === 'installed'
            ? `Updated to v${info?.version ?? ''}.`
            : stage === 'failed'
              ? updater.error ?? 'Update failed.'
              : status?.state === 'none' && !status.message
                ? "You're up to date."
                : status?.message ?? '';

  return (
    <section className="card mt-5 p-5">
      <div className="flex items-center gap-2"><SunIcon className="h-4 w-4" /><h2 className="font-semibold">Updates</h2></div>
      <p className="mt-1 text-xs text-ink-faint">
        {info ? `Nekko Agent ${info.version} · ${info.edition} edition` : ' '}
      </p>
      <div className="mt-3 flex min-h-[40px] items-center justify-between">
        <div>
          <span className="text-sm">App updates</span>
          <p className="text-2xs text-ink-faint">Connects to the internet to look for new versions.</p>
        </div>
        <Toggle aria-label="App updates" on={checks.app} onChange={(v) => void setCheck('app', v)} />
      </div>
      <div className="mt-3 flex min-h-[40px] items-center justify-between border-t border-line pt-3">
        <div>
          <span className="text-sm">Provider model lists</span>
          <p className="text-2xs text-ink-faint">Re-read each configured provider's catalog in the background, so new models appear without an app release.</p>
        </div>
        <Toggle aria-label="Provider model lists" on={checks.modelLists} onChange={(v) => void setCheck('modelLists', v)} />
      </div>
      <div className="mt-3 flex min-h-[40px] items-center justify-between border-t border-line pt-3">
        <div>
          <span className="text-sm">Skills catalog</span>
          <p className="text-2xs text-ink-faint">Refresh the skills marketplace shelf in the background.</p>
        </div>
        <Toggle aria-label="Skills catalog" on={checks.skills} onChange={(v) => void setCheck('skills', v)} />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button className="btn btn-outline py-1 text-xs" onClick={() => void runCatalogChecks()} disabled={catalogState === 'checking'}>
          {catalogState === 'checking' ? 'Refreshing…' : 'Refresh catalogs now'}
        </button>
        {catalogState === 'done' && <span className="text-xs text-ink-faint" role="status">Model lists and skills checked.</span>}
        {catalogState === 'failed' && <span className="text-xs text-danger" role="status">Refresh failed; try again.</span>}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button className="btn btn-outline py-1 text-xs" onClick={() => void updater.check(true)} disabled={stage === 'checking' || stage === 'downloading' || stage === 'installing'}>
          {stage === 'checking' ? 'Checking…' : 'Check now'}
        </button>
        {stage === 'available' && (isWeb ? (
          <button className="btn btn-primary py-1 text-xs" onClick={() => void updater.install()}>Refresh now</button>
        ) : (
          <>
            <button className="btn btn-primary py-1 text-xs" onClick={() => void updater.downloadAndInstall()}>Download &amp; install</button>
            <button className="btn btn-outline py-1 text-xs" onClick={() => void updater.downloadOnly()}>Download only</button>
            <button className="btn btn-ghost py-1 text-xs" onClick={updater.skip}>Skip</button>
          </>
        ))}
        {stage === 'downloaded' && (
          <>
            <button className="btn btn-primary py-1 text-xs" onClick={() => void updater.install()}>Install &amp; restart</button>
            <button className="btn btn-ghost py-1 text-xs" onClick={updater.skip}>Skip</button>
          </>
        )}
        {stage === 'failed' && <button className="btn btn-outline py-1 text-xs" onClick={() => void updater.retry()}>Retry</button>}
        {statusText && <span className={`text-xs ${stage === 'failed' ? 'text-danger' : 'text-ink-faint'}`} role="status" aria-live="polite">{statusText}</span>}
      </div>
      {(stage === 'downloading' || stage === 'installing') && (
        <div className="mt-3 flex max-w-md items-center gap-3">
          <UpdateProgress percent={status?.percent} installing={stage === 'installing'} />
          <span className="min-w-10 text-right text-2xs tabular-nums text-ink-faint">
            {stage === 'downloading' ? `${status?.percent ?? 0}%` : 'restarting'}
          </span>
        </div>
      )}
    </section>
  );
}

export function Toggle({ on, onChange, ...aria }: { on: boolean; onChange: (v: boolean) => void } & Pick<React.AriaAttributes, 'aria-label' | 'aria-describedby'>) {
  return (
    <button
      role="switch"
      {...aria}
      aria-checked={on}
      onClick={() => onChange(!on)}
      className="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors"
      style={{ background: on ? 'var(--accent)' : 'var(--line)' }}
    >
      <span
        className="inline-block h-5 w-5 rounded-full bg-white shadow-(--shadow-sm) transition-transform"
        style={{ transform: on ? 'translateX(22px)' : 'translateX(2px)' }}
      />
    </button>
  );
}

/**
 * When scheduled tasks and workflows may run while you use the computer: the
 * default run policy (each automation can set its own) and how long without
 * input counts as away (`run_policy.rs`).
 */
export function AutomationsSection({ settings, update }: { settings: AppSettings; update: (patch: Partial<AppSettings>) => void }) {
  const minutes = settings.automationIdleMinutes ?? 5;
  // Written on blur or Enter; a value out of range snaps back to the saved one.
  const commit = (input: HTMLInputElement) => {
    const n = Math.round(Number(input.value));
    if (Number.isFinite(n) && n >= 1 && n <= 240) {
      if (n !== minutes) update({ automationIdleMinutes: n });
    } else {
      input.value = String(minutes);
    }
  };
  const policy = settings.automationRunPolicy;
  return (
    <section id="automations" className="card mt-5 p-5" aria-labelledby="automations-heading" data-settings-automations>
      <h2 id="automations-heading" className="font-semibold">Automations</h2>
      <p className="mt-1 text-xs text-ink-faint">
        Scheduled tasks and workflows on a model that runs on this computer compete with you for its GPU, memory and fans.
        Choose when they may start. Each automation can override this in its editor.
      </p>
      <div className="mt-3 flex min-h-[40px] items-center justify-between gap-3">
        <div className="min-w-0">
          <span className="text-sm">When automations run</span>
          <p className="text-2xs text-ink-faint" data-settings-run-policy-hint>
            {policy
              ? RUN_POLICY_OPTIONS.find((o) => o.id === policy)?.hint
              : 'On a local model, only when you are away (after 2 hours they run anyway). On a cloud model, on time.'}
          </p>
        </div>
        <select
          className="input w-56 shrink-0"
          aria-label="When automations run"
          data-settings-run-policy
          value={policy ?? ''}
          onChange={(e) => update({ automationRunPolicy: (e.target.value || null) as AutomationRunPolicy | null })}
        >
          <option value="">By where the model runs</option>
          {RUN_POLICY_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      </div>
      <div className="mt-2 flex min-h-[40px] items-center justify-between gap-3">
        <div className="min-w-0">
          <span className="text-sm">Away after</span>
          <p className="text-2xs text-ink-faint">
            Minutes without keyboard, mouse or touch input, with no chat of yours replying, before you count as away.
          </p>
        </div>
        <span className="flex shrink-0 items-center gap-2 text-xs text-ink-faint">
          <input
            type="number"
            min={1}
            max={240}
            className="input w-20"
            aria-label="Away after, in minutes"
            data-settings-idle-minutes
            key={minutes}
            defaultValue={minutes}
            onBlur={(e) => commit(e.currentTarget)}
            onKeyDown={(e) => { if (e.key === 'Enter') commit(e.currentTarget); }}
          />
          minutes
        </span>
      </div>
    </section>
  );
}

export function NotificationsSection({ settings, update }: { settings: AppSettings; update: (patch: Partial<AppSettings>) => void }) {
  return (
    <section id="notifications" className="card mt-5 p-5" aria-labelledby="notifications-heading">
      <h2 id="notifications-heading" className="font-semibold">Notifications</h2>
      <div className="mt-3 flex min-h-[40px] items-center justify-between gap-3">
        <div className="min-w-0">
          <span className="text-sm">Desktop notifications</span>
          <p className="text-2xs text-ink-faint">
            A system notification when a chat you are not looking at finishes, fails, or stops to ask you something.
            Clicking it opens that chat.
          </p>
        </div>
        <Toggle aria-label="Desktop notifications" on={settings.desktopNotifications !== false} onChange={(v) => update({ desktopNotifications: v })} />
      </div>
    </section>
  );
}

/**
 * For a user who has Anthropic's own permission: turns on the features that
 * are off on a Claude plan until Anthropic approves them (claude-policy.ts).
 * nekkod enforces it (crates/nekkod/src/claude_policy.rs); this only saves it.
 */
export function ClaudePlanFeaturesSection({ settings, update }: { settings: AppSettings; update: (patch: Partial<AppSettings>) => void }) {
  const on = settings.claudePlanFeaturesApproved === true;
  return (
    <section id="claude-plan-features" className="card mt-5 p-5" aria-labelledby="claude-plan-features-heading" data-settings-claude-plan>
      <h2 id="claude-plan-features-heading" className="font-semibold">Claude plan features</h2>
      <p className="mt-1 text-xs text-ink-faint">
        On a Claude plan (Pro, Max or Team) through Claude Code, Nekko keeps these off: scheduled tasks, workflows and auto-continue,
        Nekko's own tools inside a Claude chat, the project note Nekko adds to a chat, and your plan's usage limits.
        With an Anthropic API key or a cloud account they are always on.
      </p>
      <div role="note" id="claude-plan-features-warning" className="mt-3 rounded-lg border border-warning bg-warning-soft p-3 text-xs" data-settings-claude-plan-warning>
        <p className="font-semibold">Only turn this on if Anthropic has approved it for you in writing.</p>
        <p className="mt-1">
          Anthropic's terms don't allow third-party apps to use these features on a Claude plan without their approval,
          and Anthropic can limit or suspend an account that breaks them, without notice.
          Nekko can't check whether you have approval: turning this on is your decision and your responsibility.
          If you aren't sure, leave it off and use an API key for these features.
        </p>
      </div>
      <div className="mt-3 flex min-h-[40px] items-center justify-between gap-3">
        <div className="min-w-0">
          <span className="text-sm">Anthropic has approved my use</span>
          <p className="text-2xs text-ink-faint" data-settings-claude-plan-state>
            {on ? 'On: these features now run on your Claude plan.' : 'Off: these features need an API key or cloud account.'}
          </p>
        </div>
        <Toggle on={on} onChange={(v) => update({ claudePlanFeaturesApproved: v })}
          aria-label="Anthropic has approved my use of Claude plan features" aria-describedby="claude-plan-features-warning" />
      </div>
    </section>
  );
}

/** Explicit opt-in: unlike ordinary provider retries this can restart a call after an outage. */
export function InternetRecoverySetting({ settings, update }: { settings: AppSettings; update: (patch: Partial<AppSettings>) => void }) {
  return <div id="internet-recovery" className="mt-3 flex min-h-[40px] items-center justify-between gap-3">
    <div className="min-w-0">
      <span className="text-sm">Automatically resume after internet restoration</span>
      <p id="internet-recovery-hint" className="text-2xs text-ink-faint">
        Off by default. Continue the same interrupted online model request when this computer reconnects (up to 30 minutes).
        Additional provider usage may incur charges. Completed tools are not replayed. Ordinary provider retries are unchanged.
      </p>
    </div>
    <Toggle on={settings.autoResumeOnInternetRestore === true} onChange={(v) => update({ autoResumeOnInternetRestore: v })}
      aria-label="Automatically resume after internet restoration" aria-describedby="internet-recovery-hint" />
  </div>;
}
