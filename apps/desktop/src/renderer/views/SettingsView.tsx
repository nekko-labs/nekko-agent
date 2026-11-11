import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AboutYouSection } from './AboutYouSettings.js';
import { allowModeChange } from '../components/YoloWarning.js';
import { CHAT_MODE_ICON } from '../gentleface-icons.js';
import { CHAT_MODE_LABEL, AUTO_COMPLETE_CHOICES, AUTO_COMPLETE_DEFAULT_DAYS, autoCompleteDays, DEFAULT_GUARDRAILS, keepSecrets, promptCachingEnabled, RUN_POLICY_OPTIONS, withoutSecrets } from '@nekko-agent/shared';
import type { AppSettings, AutomationRunPolicy, ShellOption, ChatMode, ChatWorktreeInfo, GuardrailRule, GuardrailAction, HookEvent, HookRule, McpServerStatus, SandboxMode, TerminalRenderer, UpdateCheckSettings } from '@nekko-agent/shared';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../store.js';
import { QuietTabs, StatusDot } from '../components/primitives/index.js';
import { UpdateProgress, useUpdater } from '../components/UpdateBanner.js';
import { hasNotices, OpenSourceLicenses } from '../components/OpenSourceLicenses.js';
import { ThemePresetPicker } from '../components/ThemePresetPicker.js';
import { pixelWaveFor } from '../components/PixelWaveBackground.js';
import { DEFAULT_SPEC_METHODOLOGY, SPEC_METHODOLOGIES, ORCHESTRATION_STRATEGIES, DEFAULT_ORCHESTRATION, MAX_OUTPUT_TOKENS_DEFAULT, MAX_OUTPUT_TOKENS_RANGE, clampMaxOutputTokens, ONBOARDING_VERSION, updateChecks, DEFAULT_TURN_WRAPPER } from '@nekko-agent/shared';
import { ComputerIcon, GearIcon, GlobeIcon, PhoneIcon, ShieldIcon, SlidersIcon, SunIcon, RobotIcon, WandIcon, WrenchIcon } from '../icons.js';
import { VoiceSettings } from '../components/VoiceSettings.js';
import { RemoteAccess } from '../components/RemoteAccess.js';
import { ComputersSection } from '../components/ComputersSection.js';
import { SecuritySettings } from '../components/security/SecuritySettings.js';
import { SyncSettings } from '../components/cloud/SyncSettings.js';
import { ConnectionsSettings } from '../components/ConnectionsSettings.js';
import { UsageReportsSection } from '../components/UsageReports.js';
import { GitHubStarSupport } from '../components/GitHubStarSupport.js';
import { EXPERIMENTAL_FLAGS, saveSettings } from '../settingsIndex.js';
import { zoomOf } from '../textScale.js';
import { DelegationRouteSettings } from '../components/DelegationRouteSettings.js';
import { useT, LANGUAGES } from '../i18n.js';
import { loadWallState, saveWallState, toWallSetting } from '../commandWall.js';
import { hasAppChrome } from '../chrome.js';
import { ServiceLoadState } from '../components/ServiceLoadState.js';
import { ServiceManagement } from '../components/ServiceManagement.js';
import { ErrorBoundary } from '../components/ErrorBoundary.js';
import { SettingsSearch } from '../components/SettingsSearch.js';
import { ProjectManagementToggles, PullRequestToggles } from '../components/WorkTrackingToggles.js';
import { WallLayoutSettings } from './WallLayoutSettings.js';
import { AnimationsSection, DesktopBehaviorSection, FunSection } from './DesktopBehaviorSections.js';
import { SkillsColorIcon, ConnectorsColorIcon } from '../navIcons.js';
import { HistorySettings } from '../components/HistorySettings.js';
import { DeleteEverythingDialog, wipeEverything } from '../components/DeleteEverythingDialog.js';
import { StyleSection } from './StyleSection.js';
import { openCustomize } from '../components/CustomizeExperience.js';
import { SimpleModeSettings } from '../components/SimpleModeSettings.js';
import { useExpertMode, useShown } from '../simpleMode.js';
import { ChoiceList, SettingRow, SettingsLabel, SettingsSection } from '../components/SettingsSection.js';

const SANDBOX_OPTS: Array<{ value: SandboxMode; label: string; desc: string }> = [
  { value: 'workspace-jail', label: 'Workspace jail', desc: 'File access is confined to your added folders.' },
  { value: 'ask-everything', label: 'Ask everything', desc: 'Every write or command asks for approval.' },
  { value: 'docker', label: 'Docker', desc: 'Run shell commands inside a container if Docker is present.' },
  { value: 'off', label: 'Off', desc: 'Nothing is confined (power users).' },
];

const ACTION_TEXT: Record<GuardrailAction, string> = { allow: 'text-success-text', ask: 'text-warning-text', deny: 'text-danger-text' };

const CHAT_MODES: Array<{ value: ChatMode; label: string; desc: string }> = [
  { value: 'ask', label: CHAT_MODE_LABEL.ask, desc: 'Confirm every file write and command before it runs.' },
  { value: 'guardrails', label: CHAT_MODE_LABEL.guardrails, desc: 'Edit files and run read-only commands (ls, cat, rg, git status) freely; ask before any other command.' },
  { value: 'yolo', label: CHAT_MODE_LABEL.yolo, desc: 'Run everything without confirming (deny rules still block).' },
];

/** Help out the team sits first; General and Phone pairing remain adjacent. */
export const SETTINGS_GROUPS = [
  { id: 'support', label: 'Help out the Nekko Team', icon: WandIcon },
  { id: 'general', label: 'General', icon: SunIcon },
  { id: 'phone', label: 'Phone pairing', icon: PhoneIcon },
  { id: 'computers', label: 'Computers', icon: ComputerIcon },
  { id: 'customize', label: 'Customize', icon: SlidersIcon },
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

/**
 * Developer settings in Simple mode: folded behind one row rather than gone,
 * so they stay one click away (Settings > Customize > Simple mode, Advanced settings).
 */
function AdvancedFold({ children }: { children: React.ReactNode }) {
  const shown = useShown('set-tools');
  const [open, setOpen] = useState(false);
  if (shown || open) return <>{children}</>;
  return (
    <section className="settings-section flex flex-wrap items-center gap-4" data-advanced-fold>
      <p className="min-w-0 flex-1 text-xs text-ink-soft">Git management, project management, pull requests, the terminal and MCP servers are kept for Detailed.</p>
      <button type="button" className="btn btn-ghost py-1 text-xs" onClick={() => setOpen(true)}>Show advanced settings</button>
    </section>
  );
}

/** The group whose top has passed the top of the scroller (the last one once scrolled to the bottom). */
export function activeGroup(scroller: HTMLElement): SettingsGroupId {
  const groups = [...scroller.querySelectorAll<HTMLElement>('[data-settings-group]')];
  if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) return (groups.at(-1)?.dataset.settingsGroup ?? 'support') as SettingsGroupId;
  const top = scroller.getBoundingClientRect().top + 24;
  let cur: string = 'support';
  for (const g of groups) if (g.getBoundingClientRect().top <= top) cur = g.dataset.settingsGroup!;
  return cur as SettingsGroupId;
}

/** The `scrollTop` that brings `target` to the top of `scroller`, or as near as the page's end allows. */
export function scrollTopFor(scroller: HTMLElement, target: HTMLElement): number {
  const distance = (target.getBoundingClientRect().top - scroller.getBoundingClientRect().top) / zoomOf(scroller);
  return Math.min(scroller.scrollTop + distance, scroller.scrollHeight - scroller.clientHeight);
}

export function SettingsView() {
  const { applyTheme, onboardingOpen, wavePreset, settings, settingsError, refreshSettings } = useStore(useShallow((s) => ({ applyTheme: s.applyTheme, onboardingOpen: s.onboardingOpen, wavePreset: s.resolvedPreset, settings: s.settings, settingsError: s.settingsError, refreshSettings: s.refreshSettings })));
  const tr = useT();
  const prevOnboardingOpen = useRef(onboardingOpen);
  const pageRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<SettingsGroupId>('support');
  // Simple says nothing about computers until one is connected; Detailed is where the first one is paired.
  const [expert] = useExpertMode();
  const hasComputers = useStore((s) => s.computers.length > 0);
  const computersPage = expert || hasComputers;
  const jumping = useRef(0);
  // Section spy: it measures the page, so at most once a frame, not per scroll event.
  const spyFrame = useRef(0);
  const onScroll = () => {
    if (spyFrame.current) return;
    spyFrame.current = requestAnimationFrame(() => {
      spyFrame.current = 0;
      if (scrollRef.current && !jumping.current) setActive(activeGroup(scrollRef.current));
    });
  };
  const goTo = (id: SettingsGroupId) => {
    setActive(id);
    const scroller = scrollRef.current;
    const target = document.getElementById(`settings-${id}`);
    if (!scroller || !target) return;
    const from = scroller.scrollTop;
    const to = scrollTopFor(scroller, target);
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
    <div className="settings-panel">
      <aside className="settings-rail">
        {!hasAppChrome && <h1 className="view-title">{tr('settings.title')}</h1>}
        <div aria-label="Skills and connectors" className="settings-shortcuts">
          <button className="settings-nav-item" onClick={openCustomize}>Customize</button>
          {([{ view: 'skills', label: tr('nav.skills'), Icon: SkillsColorIcon }, { view: 'connectors', label: tr('nav.connectors'), Icon: ConnectorsColorIcon }] as const).map(({ view, label, Icon }) => (
            <button key={view} type="button" onClick={() => useStore.getState().setView(view)} className="settings-nav-item">
              <Icon className="h-4 w-4 shrink-0" />{label}<span aria-hidden="true" className="ml-auto text-ink-faint">↗</span>
            </button>
          ))}
        </div>
        <SettingsSearch root={pageRef} />
        <nav aria-label="Settings sections" className="settings-nav">
          {SETTINGS_GROUPS.filter((g) => g.id !== 'computers' || computersPage).map((g) => (
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
      </aside>
      <div ref={scrollRef} className="settings-content" onScroll={onScroll}>
        <div ref={pageRef} className="settings-page" data-presenter-exempt>
          {settingsError && <ServiceLoadState label="settings" error={settingsError} retry={reload} />}
          <div className="min-w-0">
            <SettingsGroup id="support">
              <ErrorBoundary label="Usage reports"><UsageReportsSection settings={settings} update={update} /></ErrorBoundary>
              <ErrorBoundary label="GitHub support"><GitHubStarSupport /></ErrorBoundary>
            </SettingsGroup>
            <SettingsGroup id="general">
              <ErrorBoundary label="Notifications"><NotificationsSection settings={settings} update={update} /></ErrorBoundary>
              <SettingsSection id="chats" title="Chats">
                <SettingRow
                  htmlFor="chat-pane-action"
                  title="Chat pane top-right action"
                  detail="Complete keeps the chat under Completed until you delete it."
                  control={
                    <select id="chat-pane-action" className="quiet-field w-[180px] py-1" value={settings.chatPaneAction ?? 'complete'} onChange={(e) => update({ chatPaneAction: e.target.value === 'delete' ? 'delete' : 'complete' })}>
                      <option value="complete">Complete (default)</option>
                      <option value="delete">Delete</option>
                    </select>
                  }
                />
                <SettingRow
                  htmlFor="auto-complete-after"
                  title="Complete idle agents after"
                  detail="Pinned, running, waiting and sub-agent chats are skipped. Restore any from Show completed."
                  control={
                    <select id="auto-complete-after" className="quiet-field w-[180px] py-1" value={autoCompleteDays(settings.autoCompleteAfterDays)} onChange={(e) => update({ autoCompleteAfterDays: Number(e.target.value) })}>
                      {AUTO_COMPLETE_CHOICES.map((c) => (
                        <option key={c.days} value={c.days}>{c.label}{c.days === AUTO_COMPLETE_DEFAULT_DAYS ? ' (default)' : ''}</option>
                      ))}
                    </select>
                  }
                />
                <SettingRow title="Confirm deletions" control={<Toggle aria-label="Confirm deletions" on={settings.skipDeleteConfirmation !== true} onChange={(v) => update({ skipDeleteConfirmation: !v })} />} />
              </SettingsSection>
              <ErrorBoundary label="Desktop behavior"><DesktopBehaviorSection settings={settings} update={update} /></ErrorBoundary>
              <SettingsSection id="language-and-help" title="Language and help">
                <SettingRow
                  htmlFor="settings-language"
                  title={tr('settings.language')}
                  detail={tr('settings.languageHint')}
                  control={
                    <select id="settings-language" className="quiet-field w-[180px] py-1" value={settings.language ?? ''} onChange={(e) => update({ language: e.target.value || undefined })}>
                      <option value="">{tr('settings.systemDefault')}</option>
                      {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
                    </select>
                  }
                />
                <SettingRow title="Show tips" control={<Toggle aria-label="Show tips" on={settings.showTips !== false} onChange={(v) => update({ showTips: v })} />} />
                <SettingRow
                  title="Setup wizard"
                  detail="Reopen the first-run walkthrough."
                  control={<button className="btn btn-ghost py-1 text-xs" onClick={() => void replaySetup()}>Replay setup</button>}
                />
              </SettingsSection>
              <ErrorBoundary label="Voice settings"><VoiceSettings /></ErrorBoundary>
              <ErrorBoundary label="Chat history"><HistorySettings openSync={() => goTo('phone')} refreshSessions={() => useStore.getState().refreshSessions()} /></ErrorBoundary>
            </SettingsGroup>
            <SettingsGroup id="phone">
              {/* Remote access (relay) */}
              <ErrorBoundary label="Remote access"><RemoteAccess /></ErrorBoundary>
              {/* Nekko Cloud sign-in and end-to-end encrypted sync */}
              <ErrorBoundary label="Sync"><SyncSettings /></ErrorBoundary>
            </SettingsGroup>
            {computersPage && <SettingsGroup id="computers">
              <ErrorBoundary label="Computers"><ComputersSection /></ErrorBoundary>
            </SettingsGroup>}
            <SettingsGroup id="customize">
              {/* Personal: how Nekko addresses you belongs with the rest of personalization (#2102). */}
              <AboutYouSection settings={settings} update={update} />
              <SettingsSection id="appearance" title={tr('settings.appearance')}>
                <ErrorBoundary label="Appearance"><ThemePresetPicker settings={settings} update={update} /></ErrorBoundary>
                <SettingRow
                  title="Background animation"
                  detailId="background-animation-hint"
                  detail={pixelWaveFor(wavePreset)
                    ? 'Moving pixel dots only in empty new-agent windows. Turn off for lower power use.'
                    : 'Pixel dots in empty new-agent windows with Lilac, Lavender and Experimental themes. This theme has none.'}
                  control={<Toggle aria-label="Background animation" aria-describedby="background-animation-hint" on={settings.backgroundAnimation !== false} onChange={(v) => update({ backgroundAnimation: v })} />}
                />
              </SettingsSection>
              {/* Keep existing subsection anchors while the rail groups them under Customize. */}
              <div id="settings-style">
                <ErrorBoundary label="Style"><StyleSection settings={settings} update={update} /></ErrorBoundary>
              </div>
              <div id="settings-animations">
                <AnimationsSection settings={settings} update={update} />
              </div>
              <SettingsSection id="agents-wall" title="Agents wall">
                <WallLayoutSettings settings={settings} update={update} />
                <SettingRow
                  title="Auto-add new agents"
                  detail="Add newly created top-level agents to the wall automatically."
                  control={<Toggle aria-label="Auto-add new agents" on={loadWallState(localStorage, settings.commandWall).autoAdd} onChange={async (v) => {
                    const wall = { ...loadWallState(localStorage, settings.commandWall), autoAdd: v };
                    await update({ commandWall: toWallSetting(wall) });
                    saveWallState(localStorage, wall);
                  }} />}
                />
              </SettingsSection>
              <SettingsSection id="view-settings" title="View settings" help="Optional sidebar shortcuts. Skills and Connectors are always at the top of Settings.">
                {(['skills', 'connectors'] as const).map((view) => (
                  <SettingRow key={view} title={`Show ${tr(`nav.${view}`)} in sidebar`} control={<Toggle aria-label={`Show ${view === 'skills' ? 'Skills' : 'Connectors'} in sidebar`} on={settings.sidebarViews?.[view] === true} onChange={(v) => update({ sidebarViews: { ...settings.sidebarViews, [view]: v } })} />} />
                ))}
              </SettingsSection>
              <div id="settings-simple">
                <ErrorBoundary label="Simple mode"><SimpleModeSettings /></ErrorBoundary>
              </div>
              <ErrorBoundary label="Customization"><CustomizationSection settings={settings} update={update} /></ErrorBoundary>
              <FunSection settings={settings} update={update} />
            </SettingsGroup>
            <SettingsGroup id="agents">
              <ErrorBoundary label="Agent loop"><AgentLoopSection settings={settings} update={update} /></ErrorBoundary>
              <SettingsSection id="spec-driven" title="Spec-driven development" help="The default workflow for building a spec and tasks from a conversation. Each chat can override it in the Context panel.">
                <ChoiceList
                  label="Spec-driven development"
                  value={settings.specMethodology ?? DEFAULT_SPEC_METHODOLOGY}
                  onChange={(id) => update({ specMethodology: id })}
                  items={SPEC_METHODOLOGIES.map((m) => ({ value: m.id, label: m.label, detail: m.description }))}
                />
              </SettingsSection>
              <SettingsSection id="orchestration" title="Agent orchestration" help={<>How agents delegate to sub-agents: the system prompt and whether <code className="text-2xs">spawn_agent</code> is offered.</>}>
                <ChoiceList
                  label="Agent orchestration"
                  value={(settings.orchestration ?? DEFAULT_ORCHESTRATION).strategy}
                  onChange={(strategy) => update({ orchestration: { ...(settings.orchestration ?? DEFAULT_ORCHESTRATION), strategy } })}
                  items={ORCHESTRATION_STRATEGIES.map((st) => ({ value: st.id, label: st.label, detail: st.description }))}
                />
                {(settings.orchestration ?? DEFAULT_ORCHESTRATION).strategy !== 'solo' && ([
                  { key: 'maxDepth', label: 'Max nesting depth', min: 1, max: 4 },
                  { key: 'maxParallel', label: 'Parallel sub-agents (advisory)', min: 1, max: 12 },
                ] as const).map((f) => {
                  const cur = settings.orchestration ?? DEFAULT_ORCHESTRATION;
                  return (
                    <SettingRow
                      key={f.key}
                      htmlFor={`orchestration-${f.key}`}
                      title={f.label}
                      control={
                        <input
                          id={`orchestration-${f.key}`}
                          type="number"
                          min={f.min}
                          max={f.max}
                          value={cur[f.key]}
                          onChange={(e) => {
                            const n = Math.max(f.min, Math.min(f.max, Number(e.target.value) || f.min));
                            update({ orchestration: { ...cur, [f.key]: n } });
                          }}
                          className="quiet-field w-20 py-1 tabular-nums"
                        />
                      }
                    />
                  );
                })}
              </SettingsSection>
              <SettingsSection id="delegation-routes" title="Delegation routes"><div className="mt-(--q-inline)"><ErrorBoundary label="Delegation routes"><DelegationRouteSettings settings={settings} update={update} /></ErrorBoundary></div></SettingsSection>
              <ErrorBoundary label="Hooks"><HooksSection settings={settings} update={update} /></ErrorBoundary>
              <ErrorBoundary label="Automations"><AutomationsSection settings={settings} update={update} /></ErrorBoundary>
              <ErrorBoundary label="Claude plan features"><ClaudePlanFeaturesSection settings={settings} update={update} /></ErrorBoundary>
            </SettingsGroup>
            <SettingsGroup id="safety">
              {/* The default chat mode is the first safety decision, so it leads (moved from Agents). */}
              <SettingsSection id="chat-modes" title={tr('settings.chatModes')} help="How chats run tools. New chats start here; each chat can change it from the composer.">
                <ChoiceList
                  label={tr('settings.chatModes')}
                  value={settings.defaultChatMode ?? 'guardrails'}
                  onChange={(mode) => void allowModeChange(settings.defaultChatMode, mode).then((ok) => { if (ok) update({ defaultChatMode: mode }); })}
                  items={CHAT_MODES.map((m) => ({ value: m.value, label: m.label, detail: m.desc, icon: React.createElement(CHAT_MODE_ICON[m.value], { className: 'h-3.5 w-3.5' }) }))}
                />
                <SettingRow
                  title="Warn before No restrictions"
                  detail="Explain what No restrictions lets through before a chat or the default switches to it."
                  control={<Toggle aria-label="Warn before No restrictions" on={settings.skipYoloWarning !== true} onChange={(v) => update({ skipYoloWarning: !v })} />}
                />
              </SettingsSection>
              <SettingsSection id="sandbox" title={tr('settings.sandbox')} help="How Nekko Agent is allowed to touch your machine.">
                <ChoiceList
                  label={tr('settings.sandbox')}
                  value={settings.sandboxMode}
                  onChange={(sandboxMode) => update({ sandboxMode })}
                  items={SANDBOX_OPTS.map((o) => ({ value: o.value, label: o.label, detail: o.desc }))}
                />
              </SettingsSection>
              <ErrorBoundary label="Guardrails"><GuardrailsSection settings={settings} update={update} updateGuardrail={updateGuardrail} /></ErrorBoundary>
              {/* Security: hardware keys and step-up (SK-4) */}
              <ErrorBoundary label="Security"><SecuritySettings /></ErrorBoundary>
            </SettingsGroup>
            <SettingsGroup id="connections">
              <ErrorBoundary label="Connections"><ConnectionsSettings settings={settings} update={update} /></ErrorBoundary>
            </SettingsGroup>
            <SettingsGroup id="tools">
              <AdvancedFold>
              <ErrorBoundary label="Git management"><GitManagementSection settings={settings} update={update} /></ErrorBoundary>
              <ErrorBoundary label="Project management"><ProjectManagementSection settings={settings} update={update} /></ErrorBoundary>
              <ErrorBoundary label="Pull requests"><PullRequestsSection settings={settings} update={update} /></ErrorBoundary>
              <ErrorBoundary label="Terminal"><TerminalSection settings={settings} update={update} /></ErrorBoundary>
              <ErrorBoundary label="MCP servers"><McpSection settings={settings} update={update} reload={reload} /></ErrorBoundary>
              </AdvancedFold>
            </SettingsGroup>
            <SettingsGroup id="system">
              <ErrorBoundary label="Nekko Agent service"><ServiceManagement settings={settings} update={update} /></ErrorBoundary>
              <ErrorBoundary label="Updates"><UpdatesSection settings={settings} update={update} /></ErrorBoundary>
              <SettingsSection id="developer" title="Developer">
                <SettingRow
                  title="Show server controls"
                  detail="Desktop only. Agent and model server toggles and Restart server in the title bar."
                  control={<Toggle aria-label="Show server controls" on={settings.developer?.serverControls === true} onChange={(v) => update({ developer: { ...settings.developer, serverControls: v } })} />}
                />
                <SettingRow
                  title="Show model-switch token notice"
                  detail="Estimate the next turn's input tokens when you change the model or effort in a chat."
                  control={<Toggle aria-label="Show model-switch token notice" on={settings.developer?.showContextChangeNotice !== false} onChange={(v) => update({ developer: { ...settings.developer, showContextChangeNotice: v } })} />}
                />
              </SettingsSection>
              <SettingsSection id="experimental" title="Experimental" help="In-progress surfaces, kept out of the sidebar until you switch them on.">
                {EXPERIMENTAL_FLAGS.map((f) => (
                  <SettingRow
                    key={f.key}
                    title={f.label}
                    detail={f.desc}
                    control={<Toggle aria-label={f.label} on={settings.experimental?.[f.key] === true} onChange={(v) => update({ experimental: { ...settings.experimental, [f.key]: v } })} />}
                  />
                ))}
              </SettingsSection>
              <ErrorBoundary label="Backup"><BackupSection settings={settings} onSettings={(s) => { useStore.setState({ settings: s }); applyTheme(); }} /></ErrorBoundary>
              <ErrorBoundary label="Data and privacy"><DataSection onSettings={(s) => { useStore.setState({ settings: s }); applyTheme(); }} /></ErrorBoundary>
            </SettingsGroup>
            <p className="mt-(--q-section) text-center text-2xs text-ink-faint">Nekko Agent · open source · MIT</p>
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
    <SettingsSection id="agent-loop" title="Agent loop" help="Agents keep working until the task is finished or you press Stop. Loop detection catches repeated calls and error streaks.">
      <InternetRecoverySetting settings={settings} update={update} />
      <SettingRow
        title="Prompt caching"
        detailId="prompt-caching-hint"
        detail="On by default. Native caching on supported cloud providers and local KV cache reuse where supported. Off stops Nekko's own cache requests; providers may still cache. Local models pick up a change when reloaded."
        control={<Toggle on={promptCachingEnabled(settings)} onChange={(v) => update({ promptCaching: v })} aria-label="Prompt caching" aria-describedby="prompt-caching-hint" />}
      />
      <SettingRow
        title="Output cap per response, local models"
        detail={<>Stops a local model that repeats itself from streaming until its context fills. Cloud providers are not capped. {MAX_OUTPUT_TOKENS_RANGE.min}–{MAX_OUTPUT_TOKENS_RANGE.max.toLocaleString()}, default {MAX_OUTPUT_TOKENS_DEFAULT.toLocaleString()}.</>}
        control={<input
          type="number"
          className="quiet-field w-[110px] py-1 tabular-nums"
          min={MAX_OUTPUT_TOKENS_RANGE.min}
          max={MAX_OUTPUT_TOKENS_RANGE.max}
          step={256}
          value={out}
          aria-label="Output cap per response"
          onChange={(e) => setOut(e.target.value)}
          onBlur={commitOut}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        />}
      />
      <SettingRow
        title="Unattended questions: decide after"
        detail="Minutes an agent's question waits before the agent picks the most reasonable option itself and says so. 0 waits for ever. Approvals of risky commands never time out."
        control={<>
          <input
            type="number"
            className="quiet-field w-[90px] py-1 tabular-nums"
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
        </>}
      />
    </SettingsSection>
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
    <SettingsSection id="hooks" title="Hooks" help="Your own commands around the agent's actions." actions={<button className="btn btn-ghost py-1 text-xs" onClick={add}>Add hook</button>}>
      <details className="mt-(--q-tight) text-xs text-ink-faint">
        <summary className="w-fit cursor-pointer transition-colors duration-(--dur-fast) hover:text-ink">How hooks run</summary>
        <p className="mt-(--q-tight)">
          Each gets the event as JSON on stdin (event, tool name and input, the result for post-hooks) and runs in the chat's
          workspace with <code>NEKKO_HOOK_EVENT</code> set; the tool name matcher is a regular expression, empty for every tool.
          While a tool hook is on, every tool runs in the host so the hook sees it.
        </p>
      </details>
      <div className="mt-(--q-inline)">
        {hooks.map((h) => {
          const ev = HOOK_EVENTS.find((e) => e.value === h.event) ?? HOOK_EVENTS[0];
          return (
            <div key={h.id} className="mt-(--q-group) first:mt-(--q-inline)" data-quiet-row>
              <div className="flex flex-wrap items-center gap-2">
                <select className="quiet-field max-w-[170px] py-1" value={h.event} aria-label="Hook event" onChange={(e) => edit(h.id, { event: e.target.value as HookEvent })}>
                  {HOOK_EVENTS.map((e) => <option key={e.value} value={e.value}>{e.label}</option>)}
                </select>
                <input className="quiet-field max-w-[150px] py-1 text-xs" placeholder="Name" aria-label="Hook name" defaultValue={h.name ?? ''} onBlur={(e) => edit(h.id, { name: e.target.value.trim() || undefined })} />
                {h.event !== 'TurnEnd' && (
                  <input className="quiet-field max-w-[170px] py-1 font-mono text-xs" placeholder="Tools (regex), empty = all" aria-label="Hook tool matcher" defaultValue={h.matcher ?? ''} onBlur={(e) => edit(h.id, { matcher: e.target.value.trim() })} />
                )}
                <div className="ml-auto flex items-center gap-2">
                  <Toggle aria-label={`Hook ${h.name || 'enabled'}`} on={h.enabled !== false} onChange={(v) => edit(h.id, { enabled: v })} />
                  <button className="btn btn-ghost quiet-row-action py-1 text-xs text-danger-text" aria-label="Remove hook" onClick={() => save(hooks.filter((x) => x.id !== h.id))}>Remove</button>
                </div>
              </div>
              <input className="quiet-field mt-(--q-inline) w-full py-1 font-mono text-xs" placeholder="Command, e.g. node scripts/check-tool.js" aria-label="Hook command" defaultValue={h.command} onBlur={(e) => edit(h.id, { command: e.target.value })} />
              <p className="mt-(--q-tight) text-xs text-ink-faint">{ev.hint}</p>
            </div>
          );
        })}
        {hooks.length === 0 && <p className="py-(--q-inline) text-xs text-ink-faint">No hooks yet.</p>}
      </div>
    </SettingsSection>
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
    <SettingsSection id="terminal" title="Terminal">
      <SettingRow htmlFor="terminal-shell" title="Default shell" control={
        <select id="terminal-shell" className="quiet-field w-[180px] py-1" aria-label="Default shell" value={settings.defaultShellPath ?? ''} onChange={(e) => update({ defaultShellPath: e.target.value || undefined })}>
          <option value="">Auto-detect</option>
          {settings.defaultShellPath && !shells.some((shell) => shell.path === settings.defaultShellPath) && <option value={settings.defaultShellPath}>{settings.defaultShellPath} (unavailable)</option>}
          {shells.map((shell) => <option key={shell.id} value={shell.path}>{shell.label}</option>)}
        </select>
      } />
      <SettingRow title="Renderer" detail="xterm.js stays smooth under heavy output. Ghostty uses the Ghostty app's terminal core but can lag on a lot of output." control={
        <select
          className="quiet-field w-[180px] py-1"
          aria-label="Terminal renderer"
          value={settings.terminal?.renderer ?? 'xterm'}
          onChange={(e) => update({ terminal: { ...settings.terminal, renderer: e.target.value as TerminalRenderer } })}
        >
          <option value="xterm">xterm.js</option>
          <option value="ghostty">Ghostty (experimental)</option>
        </select>
      } />
    </SettingsSection>
  );
}

function BackupSection({ settings, onSettings }: { settings: AppSettings; onSettings: (s: AppSettings) => void }) {
  const { pushToast, refreshProviders } = useStore(useShallow((s) => ({ pushToast: s.pushToast, refreshProviders: s.refreshProviders })));

  const exportSettings = () => {
    // API keys and tokens stay on this computer, in its keystore.
    const blob = new Blob([JSON.stringify(withoutSecrets(settings), null, 2)], { type: 'application/json' });
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
        const next = await window.nekko.updateSettings(keepSecrets(parsed, settings));
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
    <SettingsSection id="backup" title="Backup &amp; restore" help="Your configuration as a JSON file, without API keys or tokens: those stay in this computer's keystore. Importing keeps the keys you already have.">
      <div className="mt-(--q-inline) flex gap-2">
        <button className="btn btn-ghost py-1 text-xs" onClick={exportSettings}>Export settings</button>
        <button className="btn btn-ghost py-1 text-xs" onClick={importSettings}>Import settings…</button>
      </div>
    </SettingsSection>
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
  const [wiping, setWiping] = useState(false);

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

  const wipe = async (models: boolean) => {
    setBusy(true);
    try {
      const s = await wipeEverything(models);
      onSettings(s);
      await refreshSessions();
      await refreshProviders();
      useStore.setState({ activeSessionId: null });
      setWiping(false);
      pushToast('success', 'All data deleted.');
    } catch (e) {
      pushToast('error', `Delete everything stopped: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection id="data-privacy" title="Data &amp; privacy" help="Everything stays on your machine. Clean it up here whenever you want.">
      <SettingRow title="Delete chats" control={
        <div className="flex flex-wrap gap-1">
          <button className="btn btn-ghost py-1 text-xs" disabled={busy} onClick={() => clear('today', "today's chats")}>Today</button>
          <button className="btn btn-ghost py-1 text-xs" disabled={busy} onClick={() => clear('month', "this month's chats")}>This month</button>
          <button className="btn btn-ghost py-1 text-xs" disabled={busy} onClick={() => clear('all', 'all chats')}>All chats</button>
        </div>
      } />
      <SettingRow title="Reset settings to defaults" control={<button className="btn btn-ghost py-1 text-xs" disabled={busy} onClick={reset}>Reset configs</button>} />
      {/* Destructive is words in danger ink until the confirmation dialog (design system). */}
      <SettingRow
        title="Delete everything"
        detail="Chats, settings, sign-ins, keys, tasks, remote access and logs. Downloaded models only if you choose."
        control={<button className="btn btn-ghost py-1 text-xs text-danger-text" disabled={busy} data-wipe onClick={() => setWiping(true)}>Delete everything</button>}
      />
      {wiping && <DeleteEverythingDialog busy={busy} onCancel={() => setWiping(false)} onConfirm={(models) => void wipe(models)} />}
    </SettingsSection>
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
    <SettingsSection
      id="mcp-servers"
      title="MCP servers"
      help="Extra tools for the agent. Enabled servers' tools are offered in every chat."
      actions={<>
        <button className="btn btn-ghost py-1 text-xs" onClick={connect} disabled={busy || servers.length === 0}>
          {busy ? 'Connecting…' : 'Connect & refresh'}
        </button>
        <button className="btn btn-ghost py-1 text-xs" onClick={add}>+ Add</button>
        <button className="btn btn-ghost py-1 text-xs" onClick={addUrl} title="A streamable-HTTP MCP endpoint (URL + optional bearer token)">+ Add URL</button>
      </>}
    >
      {hypergate && (
        <div className="mt-(--q-group)">
          <div className="flex items-center gap-4">
            {/* min-w-0 so the prose is what gives way when the row narrows;
                without it the buttons are squeezed and their labels wrap. */}
            <div className="min-w-0">
              <p className="text-sm font-medium">
                Hypergate detected{' '}
                <span className="text-xs font-normal text-ink-faint">
                  · v{hypergate.version} · {hypergate.servers} managed server{hypergate.servers === 1 ? '' : 's'} · port {hypergate.port}
                </span>
              </p>
              <p className="mt-(--q-tight) text-xs text-ink-faint">
                {connected
                  ? `Connected${hypergate.agent ? ` as ${hypergate.agent}` : ''}. Every server it manages is one entry here, and its tools are in every chat.`
                  : 'One click registers Nekko Agent with it, adds the gateway below, and opens Hypergate as a tab in this window.'}
              </p>
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-2 whitespace-nowrap">
              {connected && (
                <button className="btn btn-ghost py-1 text-xs" onClick={openHypergatePane}>Open tab</button>
              )}
              <button className="btn btn-primary py-1 text-xs" disabled={linking} onClick={() => void link()}>
                {linking ? 'Connecting…' : connected ? 'Reconnect' : 'Connect Hypergate'}
              </button>
            </div>
          </div>
        </div>
      )}
      {hypergate === null && (
        <div className="mt-(--q-inline) flex items-center gap-2">
          <p className="min-w-0 text-xs text-ink-faint">
            Optional: <span className="font-medium text-ink-soft">Hypergate</span> runs and supervises local MCP servers behind one
            endpoint. Start its daemon and a one-click Connect appears here{connected ? ' (the saved gateway reconnects on its own)' : ''}.
          </p>
          <button
            className="btn btn-ghost ml-auto shrink-0 py-1 text-xs text-accent"
            onClick={() => window.nekko.openPath('https://hypergate.app')}
          >
            Get Hypergate ↗
          </button>
        </div>
      )}
      <div className="mt-(--q-group)">
        {servers.length === 0 && <p className="text-xs text-ink-faint">No MCP servers. Add one (e.g. <code>npx -y @modelcontextprotocol/server-filesystem .</code>).</p>}
        {servers.map((s) => {
          const st = stOf(s.id);
          return (
            <div key={s.id} className="mt-(--q-group) first:mt-0" data-quiet-row>
              <div className="flex items-center gap-2">
                <input className={`quiet-field py-1 text-sm font-medium ${s.enabled ? '' : 'text-ink-faint'}`} style={{ maxWidth: 160 }} aria-label="MCP server name" value={s.name} onChange={(e) => edit(s.id, { name: e.target.value })} />
                <span className="text-xs text-ink-faint">{s.url != null ? 'http' : 'stdio'}</span>
                {st && (
                  <span className={`inline-flex items-center gap-1.5 text-xs ${st.connected ? 'text-ink-soft' : 'text-danger-text'}`} title={st.error}>
                    <StatusDot tone={st.connected ? 'success' : 'danger'} size={7} />
                    {st.connected ? `${st.tools.length} tools` : 'offline'}
                  </span>
                )}
                <div className="ml-auto flex items-center gap-2">
                  <button className="btn btn-ghost quiet-row-action py-1 text-xs text-danger-text" onClick={() => remove(s.id)}>Remove</button>
                  <Toggle aria-label={`MCP server ${s.name}`} on={s.enabled} onChange={(v) => edit(s.id, { enabled: v })} />
                </div>
              </div>
              {s.url != null ? (
                <div className="mt-(--q-inline) flex gap-2">
                  <input className="quiet-field py-1 font-mono text-xs" value={s.url} onChange={(e) => edit(s.id, { url: e.target.value })} placeholder="http://localhost:7777/mcp" />
                  <input className="quiet-field py-1 font-mono text-xs" style={{ maxWidth: 200 }} type="password" value={s.token ?? ''} onChange={(e) => edit(s.id, { token: e.target.value })} placeholder="bearer token (optional)" />
                </div>
              ) : (
                <div className="mt-(--q-inline) flex gap-2">
                  <input className="quiet-field py-1 font-mono text-xs" style={{ maxWidth: 110 }} value={s.command} onChange={(e) => edit(s.id, { command: e.target.value })} placeholder="npx" />
                  <input className="quiet-field py-1 font-mono text-xs" value={s.args.join(' ')} onChange={(e) => edit(s.id, { args: e.target.value.split(/\s+/).filter(Boolean) })} placeholder="-y @modelcontextprotocol/server-filesystem ." />
                </div>
              )}
              {st?.error && <p className="mt-(--q-tight) text-xs text-danger-text">{st.error}</p>}
            </div>
          );
        })}
      </div>
    </SettingsSection>
  );
}

export function ProjectManagementSection({ settings, update }: { settings: AppSettings; update: (patch: Partial<AppSettings>) => void }) {
  return (
    <SettingsSection id="project-management" title="Project management" help="How agent chats track their work. A change bound for a PR gets an issue first, and the PR links to it.">
      <ProjectManagementToggles value={settings.projectManagement} onChange={(projectManagement) => update({ projectManagement })} />
    </SettingsSection>
  );
}

export function PullRequestsSection({ settings, update }: { settings: AppSettings; update: (patch: Partial<AppSettings>) => void }) {
  return (
    <SettingsSection id="pull-requests" title="Pull requests" help="What goes into the PRs agent chats open. Secrets and unrelated images are never included.">
      <PullRequestToggles value={settings.pullRequests} onChange={(pullRequests) => update({ pullRequests })} />
    </SettingsSection>
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
    <SettingsSection id="git-management" title="Git management" help="New chats get their own branch and worktree, so several agents can share a repository without touching each other's files or your checkout.">
      <SettingRow htmlFor="git-mode" title="New chat checkout" control={
        <select id="git-mode" className="quiet-field w-[230px] py-1" value={settings.gitManagement?.mode ?? 'worktree'} onChange={(e) => update({ gitManagement: { ...settings.gitManagement, mode: e.target.value as 'worktree' | 'shared' } })}>
          <option value="worktree">Isolated worktree (recommended)</option>
          <option value="shared">Shared project checkout</option>
        </select>
      } />
      <SettingRow htmlFor="git-baseline" title="Worktree baseline" detail="Copying local edits takes tracked changes only, never untracked files, secrets or build output." control={
        <select id="git-baseline" className="quiet-field w-[230px] py-1" value={settings.gitManagement?.baseline ?? 'head'} onChange={(e) => update({ gitManagement: { ...settings.gitManagement, baseline: e.target.value as 'head' | 'local-changes' } })}>
          <option value="head">Committed HEAD (recommended)</option>
          <option value="local-changes">HEAD plus tracked local edits</option>
        </select>
      } />
      <SettingRow
        title="Remove worktrees after their PR merges"
        detail="Checked hourly. One with uncommitted or untracked files, or a running chat, is kept."
        control={<Toggle aria-label="Remove worktrees after their PR merges" on={settings.gitManagement?.removeMerged !== false} onChange={(v) => update({ gitManagement: { ...settings.gitManagement, removeMerged: v } })} />}
      />

      {settings.workspaces.length > 0 && (
        <>
          <SettingsLabel>Worktree setup</SettingsLabel>
          <p className="text-xs text-ink-faint">A new worktree has only tracked files. Each project can run a command there before the chat's first turn (for example <code>npm install</code>); its output appears in the chat's Agent commands terminal. To copy ignored local files such as <code>.env</code>, list them in a <code>.worktreeinclude</code> file at the repository root (gitignore syntax).</p>
          <div className="mt-(--q-inline)">
            {settings.workspaces.map((w) => (
              <label key={w.id} className="flex min-h-(--q-row) items-center justify-between gap-4 py-(--q-inline)">
                <span className="min-w-0 truncate text-sm font-medium" title={w.path}>{w.name}</span>
                <input key={w.worktreeSetup ?? ''} className="quiet-field w-[260px] py-1 font-mono text-xs" placeholder="No setup command" aria-label={`Worktree setup command for ${w.name}`} defaultValue={w.worktreeSetup ?? ''} onBlur={(e) => setSetup(w.id, e.target.value)} />
              </label>
            ))}
          </div>
        </>
      )}

      <div>
        <div className="mt-(--q-group) mb-(--q-heading) flex items-center justify-between gap-3">
          <span className="quiet-group-label">Chat worktrees</span>
          <button className="btn btn-ghost py-1 text-xs" onClick={refresh}>Refresh</button>
        </div>
        <p className="text-xs text-ink-faint">Worktrees are kept when a chat is completed or deleted. Removing one frees the folder: Git refuses if it has uncommitted changes, and its branch is deleted only once merged.</p>
        <div className="-mx-3 mt-(--q-inline)">
          {worktrees === null && <p className="px-3 text-xs text-ink-faint">Loading...</p>}
          {worktrees?.length === 0 && <p className="px-3 text-xs text-ink-faint">No chat worktrees.</p>}
          {worktrees?.map((w) => {
            const blocked = w.running ? 'Stop the chat first.' : w.dirtyCount ? 'Has uncommitted changes.' : '';
            return (
              <div key={w.root} className="quiet-row min-h-(--q-row) justify-between gap-4" data-quiet-row>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{w.sessionTitle ?? <span className="text-ink-faint">Deleted chat</span>}{w.running && <span className="ml-2 text-xs font-normal text-ink-faint">running</span>}</div>
                  <div className="mt-(--q-tight) truncate font-mono text-2xs text-ink-faint" title={w.root}>{w.branch ?? 'detached'} · {w.dirtyCount ? `${w.dirtyCount} uncommitted` : 'clean'} · {w.unmergedCount ? `${w.unmergedCount} unmerged commit${w.unmergedCount === 1 ? '' : 's'}` : 'no new commits'}</div>
                </div>
                <button className="btn btn-ghost quiet-row-action shrink-0 py-1 text-xs text-danger-text" disabled={!!blocked || busy === w.root} title={blocked || 'Remove this worktree folder'} onClick={() => void remove(w)}>
                  {busy === w.root ? 'Removing...' : 'Remove'}
                </button>
              </div>
            );
          })}
        </div>
        {message && <p role="status" className="mt-(--q-inline) text-xs text-ink-soft">{message}</p>}
      </div>
    </SettingsSection>
  );
}

function CustomizationSection({ settings, update }: { settings: AppSettings; update: (patch: Partial<AppSettings>) => void }) {
  return (
    <SettingsSection id="customization" title="Customization" help="Sent to the selected provider on every chat turn, so leave secrets out. Edits save when you leave a field.">
      {([
        { key: 'aboutUser', label: 'About you', hint: 'Your name, role, experience, goals, language, and communication preferences.', fallback: '' },
        { key: 'systemInstructions', label: 'System prompt', hint: 'Additional standing instructions for how Nekko should work with you.', fallback: '' },
        { key: 'turnWrapper', label: 'Server prompt wrapper', hint: 'Applied server-side to each user turn without altering the saved user message. Titles and plans use app tools when available.', fallback: DEFAULT_TURN_WRAPPER },
      ] as const).map((field) => (
        <label key={field.key} className="mt-(--q-group) block">
          <span className="block text-sm font-medium">{field.label}</span>
          <p className="mt-(--q-tight) text-xs text-ink-faint">{field.hint}</p>
          <textarea key={settings[field.key] ?? field.fallback} aria-label={field.label} className="quiet-field mt-(--q-inline) min-h-[100px] resize-y text-xs leading-relaxed" defaultValue={settings[field.key] ?? field.fallback} onBlur={(e) => { if (e.target.value !== (settings[field.key] ?? field.fallback)) update({ [field.key]: e.target.value }); }} />
        </label>
      ))}
      <div className="mt-(--q-inline) flex flex-wrap items-center gap-4">
        <p className="min-w-0 flex-1 text-xs text-ink-faint">An empty wrapper turns off the extra per-turn instructions.</p>
        <button className="btn btn-ghost py-1 text-xs" onClick={() => update({ turnWrapper: DEFAULT_TURN_WRAPPER })}>Reset wrapper to recommended points</button>
      </div>
    </SettingsSection>
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
    <SettingsSection
      id="guardrails"
      title="Guardrails"
      help={<>In {CHAT_MODE_LABEL.guardrails}, only read-only commands run without asking. Allow lets a matching command run too, ask always asks, deny blocks in every mode. The dot marks each rule's default.</>}
      actions={<button className="btn btn-ghost py-1 text-xs" onClick={() => (jsonMode ? setJsonMode(false) : openJson())}>{jsonMode ? 'Visual editor' : 'Edit as JSON'}</button>}
    >

      {jsonMode ? (
        <div className="mt-(--q-group)">
          <textarea
            className="quiet-field min-h-[260px] font-mono text-xs leading-relaxed"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
          />
          {error && <p className="mt-(--q-tight) text-xs text-danger-text">{error}</p>}
          <div className="mt-(--q-inline) flex justify-end gap-2">
            <button className="btn btn-ghost" onClick={() => setJsonMode(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={apply}>Apply</button>
          </div>
        </div>
      ) : (
        <div className="mt-(--q-inline)">
          {settings.guardrails.map((g) => (
            <SettingRow
              key={g.id}
              disabled={!g.enabled}
              title={<span className="inline-flex items-center gap-2">{g.label}<StatusDot tone={g.severity === 'high' ? 'danger' : g.severity === 'medium' ? 'warning' : 'neutral'} size={7} title={`${g.severity ?? 'low'} severity`} /></span>}
              detail={<span className="block truncate">{g.description}</span>}
              control={<>
                {/* Each action in its state's words; the dot marks the rule's default. */}
                <QuietTabs
                  role="radiogroup"
                  label={`${g.label} action`}
                  value={g.action}
                  onChange={(a) => updateGuardrail({ ...g, action: a })}
                  items={(['allow', 'ask', 'deny'] as GuardrailAction[]).map((a) => ({
                    value: a,
                    title: defaultById.get(g.id)?.action === a ? 'Default' : undefined,
                    label: <span className={g.action === a ? ACTION_TEXT[a] : undefined}>{a}</span>,
                    hint: defaultById.get(g.id)?.action === a ? <span aria-label="default" className="inline-block h-1 w-1 rounded-full bg-current align-middle" /> : undefined,
                  }))}
                />
                <Toggle aria-label={g.label} on={g.enabled} onChange={(v) => updateGuardrail({ ...g, enabled: v })} />
              </>}
            />
          ))}
        </div>
      )}

      <div className="mt-(--q-inline) flex items-center justify-between gap-4">
        <p className="text-xs text-ink-faint">
          {changedCount === 0 ? 'Using the default rules.' : `${changedCount} ${changedCount === 1 ? 'rule differs' : 'rules differ'} from the defaults.`}
        </p>
        <button className="btn btn-ghost py-1 text-xs" onClick={resetToDefaults} disabled={changedCount === 0 && settings.guardrails.length === DEFAULT_GUARDRAILS.length}>
          Reset to defaults
        </button>
      </div>
    </SettingsSection>
  );
}

function UpdatesSection({ settings, update }: { settings: AppSettings; update: (patch: Partial<AppSettings>) => void }) {
  const updater = useUpdater();
  const [licensesOpen, setLicensesOpen] = useState(false);
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
    <SettingsSection
      id="updates"
      title="Updates"
      meta={info ? `Nekko Agent ${info.version} · ${info.edition} edition` : undefined}
      help={<span className="flex gap-3">
        {hasNotices() && <button className="hover:text-ink hover:underline" onClick={() => setLicensesOpen(true)}>Open-source licenses</button>}
        <a className="hover:text-ink hover:underline" href="https://nekkoagent.com/docs/credits" target="_blank" rel="noreferrer">Credits</a>
      </span>}
    >
      {licensesOpen && <OpenSourceLicenses onClose={() => setLicensesOpen(false)} />}
      <SettingRow title="App updates" detail="Connects to the internet to look for new versions." control={<Toggle aria-label="App updates" on={checks.app} onChange={(v) => void setCheck('app', v)} />} />
      <div className="mt-(--q-tight) flex flex-wrap items-center gap-2">
        <button className="btn btn-ghost py-1 text-xs" onClick={() => void updater.check(true)} disabled={stage === 'checking' || stage === 'downloading' || stage === 'installing'}>
          {stage === 'checking' ? 'Checking…' : 'Check now'}
        </button>
        {stage === 'available' && (isWeb ? (
          <button className="btn btn-primary py-1 text-xs" onClick={() => void updater.install()}>Refresh now</button>
        ) : (
          <>
            <button className="btn btn-primary py-1 text-xs" onClick={() => void updater.downloadAndInstall()}>Download &amp; install</button>
            <button className="btn btn-ghost py-1 text-xs" onClick={() => void updater.downloadOnly()}>Download only</button>
            <button className="btn btn-ghost py-1 text-xs" onClick={updater.skip}>Skip</button>
          </>
        ))}
        {stage === 'downloaded' && (
          <>
            <button className="btn btn-primary py-1 text-xs" onClick={() => void updater.install()}>Install &amp; restart</button>
            <button className="btn btn-ghost py-1 text-xs" onClick={updater.skip}>Skip</button>
          </>
        )}
        {stage === 'failed' && <button className="btn btn-ghost py-1 text-xs" onClick={() => void updater.retry()}>Retry</button>}
        {statusText && <span className={`text-xs ${stage === 'failed' ? 'text-danger-text' : 'text-ink-faint'}`} role="status" aria-live="polite">{statusText}</span>}
      </div>
      {(stage === 'downloading' || stage === 'installing') && (
        <div className="mt-(--q-inline) flex max-w-md items-center gap-3">
          <UpdateProgress percent={status?.percent} installing={stage === 'installing'} />
          <span className="min-w-10 text-right text-2xs tabular-nums text-ink-faint">
            {stage === 'downloading' ? `${status?.percent ?? 0}%` : 'restarting'}
          </span>
        </div>
      )}
      <SettingsLabel>In the background</SettingsLabel>
      <SettingRow title="Provider model lists" detail="Re-read each provider's catalog so new models appear without an app release." control={<Toggle aria-label="Provider model lists" on={checks.modelLists} onChange={(v) => void setCheck('modelLists', v)} />} />
      <SettingRow title="Skills catalog" detail="Refresh the skills marketplace shelf." control={<Toggle aria-label="Skills catalog" on={checks.skills} onChange={(v) => void setCheck('skills', v)} />} />
      <div className="mt-(--q-tight) flex flex-wrap items-center gap-2">
        <button className="btn btn-ghost py-1 text-xs" onClick={() => void runCatalogChecks()} disabled={catalogState === 'checking'}>
          {catalogState === 'checking' ? 'Refreshing…' : 'Refresh catalogs now'}
        </button>
        {catalogState === 'done' && <span className="text-xs text-ink-faint" role="status">Model lists and skills checked.</span>}
        {catalogState === 'failed' && <span className="text-xs text-danger-text" role="status">Refresh failed; try again.</span>}
      </div>
    </SettingsSection>
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
    <SettingsSection id="automations" data-settings-automations title="Automations" help="Scheduled tasks on a local model compete with you for its GPU, memory and fans. Each automation can override this in its editor.">
      <SettingRow
        title="When automations run"
        detail={<span data-settings-run-policy-hint>
          {policy
            ? RUN_POLICY_OPTIONS.find((o) => o.id === policy)?.hint
            : 'On a local model, only when you are away (after 2 hours they run anyway). On a cloud model, on time.'}
        </span>}
        control={<select
          className="quiet-field w-56 shrink-0 py-1"
          aria-label="When automations run"
          data-settings-run-policy
          value={policy ?? ''}
          onChange={(e) => update({ automationRunPolicy: (e.target.value || null) as AutomationRunPolicy | null })}
        >
          <option value="">By where the model runs</option>
          {RUN_POLICY_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>}
      />
      <SettingRow
        title="Away after"
        detail="Minutes without keyboard, mouse or touch input, with no chat of yours replying, before you count as away."
        control={<span className="flex shrink-0 items-center gap-2 text-xs text-ink-faint">
          <input
            type="number"
            min={1}
            max={240}
            className="quiet-field w-20 py-1 tabular-nums"
            aria-label="Away after, in minutes"
            data-settings-idle-minutes
            key={minutes}
            defaultValue={minutes}
            onBlur={(e) => commit(e.currentTarget)}
            onKeyDown={(e) => { if (e.key === 'Enter') commit(e.currentTarget); }}
          />
          minutes
        </span>}
      />
    </SettingsSection>
  );
}

export function NotificationsSection({ settings, update }: { settings: AppSettings; update: (patch: Partial<AppSettings>) => void }) {
  return (
    <SettingsSection id="notifications" title="Notifications">
      <SettingRow
        title="Desktop notifications"
        detail="When a chat you are not looking at finishes, fails, or stops to ask you something. Clicking it opens that chat."
        control={<Toggle aria-label="Desktop notifications" on={settings.desktopNotifications !== false} onChange={(v) => update({ desktopNotifications: v })} />}
      />
    </SettingsSection>
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
    <SettingsSection
      id="claude-plan-features"
      data-settings-claude-plan
      title="Claude plan features"
      help="On a Claude plan (Pro, Max or Team) through Claude Code, Nekko keeps these off: scheduled tasks and auto-continue, Nekko's own tools inside a Claude chat, and the project note Nekko adds to a chat. With an Anthropic API key or a cloud account they are always on."
    >
      {/* Plain words rather than a tinted box: the warning ink carries it (design system). */}
      <div role="note" id="claude-plan-features-warning" className="mt-(--q-inline) text-xs" data-settings-claude-plan-warning>
        <p className="font-medium text-warning-text">Only turn this on if Anthropic has approved it for you in writing.</p>
        <p className="mt-(--q-tight) text-ink-soft">
          Anthropic's terms don't allow third-party apps to use these features on a Claude plan without their approval,
          and Anthropic can limit or suspend an account that breaks them, without notice.
          Nekko can't check whether you have approval: turning this on is your decision and your responsibility.
          If you aren't sure, leave it off and use an API key for these features.
        </p>
      </div>
      <SettingRow
        title="Anthropic has approved my use"
        detail={<span data-settings-claude-plan-state>{on ? 'On: these features now run on your Claude plan.' : 'Off: these features need an API key or cloud account.'}</span>}
        control={<Toggle on={on} onChange={(v) => update({ claudePlanFeaturesApproved: v })}
          aria-label="Anthropic has approved my use of Claude plan features" aria-describedby="claude-plan-features-warning" />}
      />
    </SettingsSection>
  );
}

/** Explicit opt-in: unlike ordinary provider retries this can restart a call after an outage. */
export function InternetRecoverySetting({ settings, update }: { settings: AppSettings; update: (patch: Partial<AppSettings>) => void }) {
  return <SettingRow
    id="internet-recovery"
    title="Automatically resume after internet restoration"
    detailId="internet-recovery-hint"
    detail="Off by default. Continue the same interrupted online model request when this computer reconnects (up to 30 minutes). Additional provider usage may incur charges. Completed tools are not replayed."
    control={<Toggle on={settings.autoResumeOnInternetRestore === true} onChange={(v) => update({ autoResumeOnInternetRestore: v })}
      aria-label="Automatically resume after internet restoration" aria-describedby="internet-recovery-hint" />}
  />;
}
