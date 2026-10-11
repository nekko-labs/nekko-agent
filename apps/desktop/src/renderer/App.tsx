import React, { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { navOrder, moveNav } from './nav-order.js';
import { useStore, viewEnabled, type View } from './store.js';
import { startLiveRuns } from './liveRuns.js';
import { startDesktopNotifications } from './notifications.js';
import { startCompactionStatus } from './compactionStatus.js';
import { useT } from './i18n.js';
import { SHORTCUTS } from './shortcuts.js';
import { hasAppChrome } from './chrome.js';
import { TitleBar } from './components/TitleBar.js';
import { BrandMark } from './components/BrandMark.js';
import { AutumnBackground } from './components/AutumnBackground.js';
import { syncAppActivity } from './appActivity.js';
import { Mascot, NekkoAvatar } from './components/Mascot.js';
import { ResourceHud } from './components/ResourceMonitor.js';
import { Toasts } from './components/Toasts.js';
import { CommandPalette } from './components/CommandPalette.js';
import { UpdateBanner } from './components/UpdateBanner.js';
import { RelayPairing } from './components/RelayPairing.js';
import { DeepLinkListener } from './components/DeepLink.js';
import { WorkspacesView } from './views/WorkspacesView.js';
import { DesignBoardView } from './views/DesignBoardView.js';
import { SkillsView } from './views/SkillsView.js';
import { TrainingView } from './views/TrainingView.js';
import { WorkflowsView } from './views/WorkflowsView.js';
import { CommandCenterView } from './views/CommandCenterView.js';
import { ModelsView } from './views/ModelsView.js';
import { ModelServerView } from './views/ModelServerView.js';
import { ConnectorsView } from './views/ConnectorsView.js';
import { MemoryView } from './views/MemoryView.js';
import { SettingsView } from './views/SettingsView.js';
import { OnboardingView } from './views/OnboardingView.js';
import {
  CommandHudIcon,
  SkillsColorIcon,
  TrainingColorIcon,
  WorkflowsColorIcon,
  DesignColorIcon,
  ModelsColorIcon,
  ModelServerColorIcon,
  ConnectorsColorIcon,
  MemoryColorIcon,
  SettingsColorIcon,
} from './navIcons.js';

/** The Agent destination wears Aphelion herself, so the cat is the way in. */
// The nav rail's Agents cat is a plain silhouette: no eyes, so it reads as an icon beside the others rather than a face.
const AgentCatIcon = (_p: { className?: string }) => <NekkoAvatar size={22} stationary eyes={false} />;

const NAV: Array<{ view: View; labelKey: string; Icon: (p: { className?: string }) => React.JSX.Element }> = [
  { view: 'command', labelKey: 'nav.command', Icon: AgentCatIcon },
  { view: 'chat', labelKey: 'nav.chat', Icon: CommandHudIcon },
  { view: 'skills', labelKey: 'nav.skills', Icon: SkillsColorIcon },
  { view: 'training', labelKey: 'nav.training', Icon: TrainingColorIcon },
  { view: 'workflows', labelKey: 'nav.workflows', Icon: WorkflowsColorIcon },
  { view: 'design', labelKey: 'nav.design', Icon: DesignColorIcon },
  { view: 'models', labelKey: 'nav.models', Icon: ModelsColorIcon },
  { view: 'modelserver', labelKey: 'nav.modelserver', Icon: ModelServerColorIcon },
  { view: 'connectors', labelKey: 'nav.connectors', Icon: ConnectorsColorIcon },
  { view: 'memory', labelKey: 'nav.memory', Icon: MemoryColorIcon },
  { view: 'settings', labelKey: 'nav.settings', Icon: SettingsColorIcon },
];

/** Phone bottom-tab destinations (the remote-control essentials). */
const MOBILE_NAV: View[] = ['command', 'chat', 'training', 'workflows', 'settings'];

export function App() {
  const { view, setView, mascotMood, settings, settingsLoaded, providers, onboardingOpen, refreshSettings, refreshProviders, refreshSessions, refreshTerminals } = useStore(
    useShallow((s) => ({
      view: s.view,
      setView: s.setView,
      mascotMood: s.mascotMood,
      settings: s.settings,
      settingsLoaded: s.settingsLoaded,
      providers: s.providers,
      onboardingOpen: s.onboardingOpen,
      refreshSettings: s.refreshSettings,
      refreshProviders: s.refreshProviders,
      refreshSessions: s.refreshSessions,
      refreshTerminals: s.refreshTerminals,
    })),
  );
  const t = useT();

  // Experimental surfaces only exist in the nav once their Settings flag is on.
  const [draggedNav, setDraggedNav] = useState<View | null>(null);
  const [dropNav, setDropNav] = useState<View | null>(null);
  const order = navOrder(NAV.map(n => n.view), settings?.navOrder);
  const visibleNav = order.map(v => NAV.find(n => n.view === v)!).filter(n => viewEnabled(n.view, settings));
  const reorder = async (from: View, to: View) => {
    const previous = settings;
    const nextOrder = moveNav(order, from, to);
    useStore.setState({ settings: { ...settings!, navOrder: nextOrder } });
    try { useStore.setState({ settings: await window.nekko.updateSettings({ navOrder: nextOrder }) }); }
    catch (e) { useStore.setState({ settings: previous }); useStore.getState().pushToast('error', (e as Error).message); }
  };
  const mobileNav = MOBILE_NAV.filter((v) => viewEnabled(v, settings));

  // If the surface you're looking at gets switched off (say from another
  // client over the same settings file), land somewhere real.
  useEffect(() => {
    if (!viewEnabled(view, settings)) setView('command');
  }, [view, settings, setView]);

  // Fold every running turn for the whole app, not just the visible one. A chat
  // pane is a view of this; without it, switching workspaces unmounted the only
  // listener and the run's output went nowhere until the next event arrived.
  useEffect(() => startLiveRuns(), []);
  useEffect(() => startCompactionStatus(), []);
  // An OS notification when a chat you are not looking at finishes or needs you.
  useEffect(() => startDesktopNotifications(), []);
  // Hold looping decorations still while the window is unfocused or hidden.
  useEffect(() => syncAppActivity(), []);

  // Archived chats past the retention window are deleted at launch and every
  // few hours after, whichever view the app opens on, so a long-running window
  // still lets them go on time. The list is re-read only when something went.
  useEffect(() => {
    const purge = () =>
      void window.nekko.purgeExpiredArchives?.()
        .then((n) => { if (n > 0) void useStore.getState().refreshSessions(); })
        .catch(() => { /* an older host without the channel */ });
    purge();
    const t = window.setInterval(purge, 6 * 60 * 60 * 1000);
    return () => window.clearInterval(t);
  }, []);

  // A background catalog check (Settings → Updates) can land a new provider
  // model list mid-session: re-list so pickers show it immediately.
  useEffect(
    () => window.nekko.onModelsUpdated((e) => void useStore.getState().reloadModels(e.providerId)),
    [],
  );

  useEffect(() => {
    refreshSettings();
    refreshProviders();
    refreshSessions();
    refreshTerminals();
    useStore.getState().refreshSkills();
    // Probe for Hypergate once at startup so the pairing is offered wherever
    // the user happens to be, not only after they open Settings.
    useStore.getState().refreshHypergate();
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => useStore.getState().applyTheme();
    mq.addEventListener('change', onChange);

    // Global keyboard shortcuts (chords + their hint labels live in shortcuts.ts).
    const onKey = (e: KeyboardEvent) => {
      // While the setup wizard owns the screen its own keys apply (arrows,
      // Esc); firing global shortcuts underneath it would be a surprise.
      if (useStore.getState().onboardingOpen) return;
      if (SHORTCUTS.palette.matches(e)) {
        e.preventDefault();
        useStore.getState().setPaletteOpen(!useStore.getState().paletteOpen);
      } else if (SHORTCUTS.newAgent.matches(e)) {
        e.preventDefault();
        useStore.getState().newChat();
      } else if (SHORTCUTS.newTerminal.matches(e)) {
        e.preventDefault();
        useStore.getState().newTerminal();
      } else if (SHORTCUTS.contextPanel.matches(e)) {
        e.preventDefault();
        useStore.getState().toggleContextPanel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      mq.removeEventListener('change', onChange);
      window.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Native (mobile) only: notify when an agent run finishes while the app is
  // backgrounded. Local notification, no push backend / APNs / FCM needed.
  useEffect(() => {
    const cap = (window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
    if (!cap?.isNativePlatform?.()) return;
    let off: (() => void) | undefined;
    let nid = 1;
    (async () => {
      try {
        const { LocalNotifications } = await import('@capacitor/local-notifications');
        await LocalNotifications.requestPermissions();
        off = window.nekko.onAgentEvent((e) => {
          if (e.type === 'done' && document.hidden) {
            LocalNotifications.schedule({
              notifications: [{ id: nid++, title: 'Nekko Agent finished', body: 'Your task is ready in Nekko Agent.' }],
            }).catch(() => {});
          }
        });
      } catch {
        /* plugin unavailable */
      }
    })();
    return () => off?.();
  }, []);

  // Native (mobile) only: register for remote push and hand the token to the
  // relay, so a finished run can notify the phone even when it's offline.
  useEffect(() => {
    const cap = (window as { Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string } }).Capacitor;
    if (!cap?.isNativePlatform?.()) return;
    let cancelled = false;
    (async () => {
      try {
        const { PushNotifications } = await import('@capacitor/push-notifications');
        const platform = cap.getPlatform?.() === 'android' ? 'android' : 'ios';
        const perm = await PushNotifications.requestPermissions();
        if (perm.receive !== 'granted') return;
        await PushNotifications.addListener('registration', (t) => {
          if (!cancelled) window.nekko.registerPushToken(t.value, platform).catch(() => {});
        });
        await PushNotifications.register();
      } catch {
        /* push not configured in this build */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="flex h-full w-full flex-col" style={{ background: 'var(--paper)' }}>
      {/* The window's own title bar, in the desktop shell only. */}
      <TitleBar />

      {!settingsLoaded ? (
        <div className="relative flex min-h-0 w-full flex-1 items-center justify-center">
          <span className="text-ink-faint">Loading…</span>
        </div>
      ) : (
        <>
          <div className="relative flex min-h-0 w-full flex-1">
            {/* Left rail: icon-only at rest, expands over the content on hover to
            reveal each destination's label. Hidden on phones (hover is useless on
            touch), where the bottom tab bar below takes over. */}
        <nav className="relative z-40 hidden w-16 shrink-0 md:block">
          <div className="rail absolute inset-y-0 left-0 flex flex-col gap-1 overflow-hidden bg-paper px-2.5 py-4">
            {/* The brand mark heads the rail. The wordmark joins it only where
                there is no title bar to carry it (web and phone builds), so the
                name is never shown twice. */}
            {!hasAppChrome && <div className="mb-3 flex h-9 items-center gap-2 px-1.5">
              <span className="grid h-8 w-8 shrink-0 place-items-center text-ink"><BrandMark size={24} title={hasAppChrome ? undefined : 'Nekko Agent'} /></span>
              {!hasAppChrome && <span className="rail-label text-[15px] font-semibold tracking-tight">Nekko Agent</span>}
            </div>}
            {visibleNav.map(({ view: v, labelKey, Icon }) => (
              <button
                key={v}
                className={`nav-item ${view === v ? 'active' : ''}`}
                aria-label={t(labelKey)}
                draggable
                title={`${t(labelKey)}. Drag to reorder, or use Alt+Up / Alt+Down.`}
                style={dropNav === v ? { boxShadow: 'inset 0 2px var(--accent)' } : draggedNav === v ? { opacity: 0.5 } : undefined}
                onDragStart={e => { e.dataTransfer.setData('text/plain', v); e.dataTransfer.effectAllowed = 'move'; setDraggedNav(v); }}
                onDragOver={e => { if (draggedNav) { e.preventDefault(); setDropNav(v); } }}
                onDrop={e => { e.preventDefault(); if (draggedNav) void reorder(draggedNav, v); setDraggedNav(null); setDropNav(null); }}
                onDragEnd={() => { setDraggedNav(null); setDropNav(null); }}
                onKeyDown={e => {
                  if (!e.altKey || !['ArrowUp', 'ArrowDown'].includes(e.key)) return;
                  e.preventDefault();
                  const i = visibleNav.findIndex(n => n.view === v);
                  const target = visibleNav[i + (e.key === 'ArrowUp' ? -1 : 1)];
                  if (target) void reorder(v, target.view);
                }}
                onClick={() => setView(v)}
              >
                <span className="grid h-11 w-11 shrink-0 place-items-center"><Icon /></span>
                <span className="rail-label text-[13px] font-medium">{t(labelKey)}</span>
              </button>
            ))}
          </div>
        </nav>

        {/* Main (bottom padding on phones so the tab bar never covers content) */}
        <main className="relative flex min-w-0 flex-1 flex-col pb-16 md:pb-0">
          {providers.length === 0 && view !== 'models' && view !== 'modelserver' && view !== 'settings' && (
            <button
              className="flex items-center justify-center gap-2 border-b border-line py-2.5 text-[13px]"
              style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
              onClick={() => setView('models')}
            >
              <span className="font-medium">Get started:</span> connect your first model in Model Providers →
            </button>
          )}
          {view === 'command' && <CommandCenterView />}
          {view === 'chat' && <WorkspacesView />}
          {view === 'skills' && <SkillsView />}
          {view === 'training' && <TrainingView />}
          {view === 'workflows' && <WorkflowsView />}
          {view === 'design' && <DesignBoardView />}
          {view === 'models' && <ModelsView />}
          {view === 'modelserver' && <ModelServerView />}
          {view === 'connectors' && <ConnectorsView />}
          {view === 'memory' && <MemoryView />}
          {view === 'settings' && <SettingsView />}
        </main>

        {/* First-run setup wizard: covers nav + main but leaves the window's
            title bar (and its OS buttons) reachable above it. */}
        {onboardingOpen && <OnboardingView />}
      </div>

      {/* Phone bottom tab bar: the remote-control surface. The long tail of
          destinations (models, connectors, …) stays reachable via ⌘K / More. */}
      <nav
        className="fixed inset-x-0 bottom-0 z-40 flex items-stretch justify-around border-t border-line md:hidden"
        style={{ background: 'var(--paper)', paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {mobileNav.map((v) => {
          const item = NAV.find((n) => n.view === v)!;
          const { Icon } = item;
          return (
            <button
              key={v}
              className="flex flex-1 flex-col items-center gap-0.5 py-1.5"
              style={view === v ? { color: 'var(--accent)' } : { color: 'var(--ink-faint)' }}
              aria-label={t(item.labelKey)}
              onClick={() => setView(v)}
            >
              <span className="grid h-7 w-7 place-items-center"><Icon /></span>
              <span className="text-[10px] font-medium">{t(item.labelKey)}</span>
            </button>
          );
        })}
      </nav>

      </>)}

      {/* Global overlays stay mounted even while settings load, so deep links,
          toasts, and update banners keep working on any settings failure. */}
      {settings?.themePreset === 'autumn' && <AutumnBackground />}
      <UpdateBanner />
      <RelayPairing />
      {view !== 'command' && <ResourceHud />}
      <Mascot mood={mascotMood} enabled={settings?.mascotEnabled ?? true} wizardHat={settings?.themePreset === 'autumn'} />
      <CommandPalette />
      <DeepLinkListener />
      <Toasts />
    </div>
  );
}
