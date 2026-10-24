import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../src/renderer/App';
import { UpdateProvider } from '../src/renderer/components/UpdateBanner';
import { useStore } from '../src/renderer/store';
import { summarizeSession } from '@nekko-agent/shared';

// Real App and store actions; only the host boundary is synthetic.
const provider = { id: 'fixture', kind: 'ollama', enabled: true, baseUrl: 'http://invalid.local' };
const models = [{ id: 'fixture-model', providerId: 'fixture', name: 'Fixture', contextWindow: 32000 }];
let settings = { providers: [provider], defaultProviderId: 'fixture', defaultModelId: 'fixture-model', workspaces: [], workspaceFolders: [], onboarding: { completedAt: 1 }, experimental: {}, agent: {}, ui: {} };
const records: any[] = [];
const terminals: any[] = [];
const calls: any[] = [];
const bridge: Record<string, any> = {
  getSettings: async () => settings, listProviders: async () => [provider], listModels: async () => models,
  listSessionSummaries: async () => records.map(summarizeSession), listTerminals: async () => terminals,
  createSession: async (workspaceId: string) => {
    const s = { id: `agent-${records.length}`, title: 'Synthetic agent', createdAt: 1, updatedAt: 1, providerId: 'fixture', modelId: 'fixture-model', mode: 'agent', messages: [], attachments: [], queuedPrompts: [] };
    records.push(s); calls.push({ method: 'createSession', workspaceId }); return s;
  },
  createTerminal: async (options: any) => { const t = { id: `terminal-${terminals.length}`, title: 'Synthetic terminal', ...options }; terminals.push(t); calls.push({ method: 'createTerminal', options }); return t; },
  getSession: async (id: string) => records.find(s => s.id === id),
  updateSettings: async (patch: any) => (settings = { ...settings, ...patch }),
  getAppInfo: async () => ({ version: 'shortcut-fixture', platform: 'win32' }),
  pendingInput: async () => ({}), runningSessions: async () => [],
};
const unexpectedCalls: string[] = [];
const subscriptions = ['onModelsUpdated', 'onAgentEvent', 'onLimitsUpdated', 'onSkillsUpdated', 'onTerminalEvent', 'onUpdateEvent', 'onDeepLink', 'onTasksUpdated', 'onChangesUpdated', 'onDownloadsUpdated', 'onWorkflowsUpdated', 'onTrainingUpdated'];
for (const name of subscriptions) bridge[name] = () => () => {};
for (const name of ['listInstalledSkills', 'listExternalSkills', 'listTasks', 'listShells', 'listTools', 'listChatWorktrees']) bridge[name] = async () => [];
for (const name of ['getRemotePairing', 'getRemoteStatus', 'getSystemStats', 'getGpuStats', 'getLimits', 'getLimitsProblem', 'getUsageSummary']) bridge[name] = async () => null;
bridge.openTerminalStream = async () => null;
bridge.terminalSnapshot = async () => null;
bridge.resizeTerminal = async () => null;
bridge.listSessionPrs = async () => [];
bridge.listChanges = async () => [];
bridge.getGitStatus = async () => null;
bridge.previewContext = async () => null;
bridge.nextAgentWatchAt = async () => null;
bridge.detectHypergate = async () => null;
bridge.purgeExpiredArchives = async () => 0;
Object.assign(window, { nekko: new Proxy(bridge, { get(target, key: string) {
  if (key in target) return target[key];
  return () => { unexpectedCalls.push(key); throw new Error('Unsupported fixture bridge method: ' + key); };
} }) });
let shortcutHandlerInstalled = false;
const addEventListener = window.addEventListener.bind(window);
window.addEventListener = ((type: string, listener: any, options: any) => {
  if (type === 'keydown') shortcutHandlerInstalled = true;
  addEventListener(type, listener, options);
}) as typeof window.addEventListener;
let ready = false;
let resetGeneration = 0;
let committedGeneration = -1;
function CommitSignal() {
  const state = useStore();
  React.useEffect(() => { ready = true; committedGeneration = resetGeneration; }, [state]);
  return null;
}
useStore.setState({ settings: settings as any, settingsLoaded: true, providers: [provider] as any, models, activeProviderId: 'fixture', activeModelId: 'fixture-model', view: 'skills' });
Object.assign(window, { shortcutTest: {
  reset(onboardingOpen = false) {
    resetGeneration++;
    records.length = 0; terminals.length = 0; calls.length = 0;
    useStore.setState({ view: 'skills', sessions: [], terminals: [], workspaces: [], activeWorkspaceId: null, activeSessionId: null, activeProjectId: 'synthetic-project', onboardingOpen });
    return resetGeneration;
  },
  dispatch(init: KeyboardEventInit, focusTag?: string) {
    let target: HTMLElement | Window = window;
    if (focusTag) {
      const element = document.createElement(focusTag);
      if (focusTag === 'div') element.contentEditable = 'true';
      document.body.appendChild(element); element.focus(); target = element;
      if (document.activeElement !== element) throw new Error('Synthetic element did not focus');
    }
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    const dispatched = target.dispatchEvent(event);
    if (target !== window) (target as HTMLElement).remove();
    return { defaultPrevented: event.defaultPrevented, dispatched };
  },
  snapshot() {
    const s = useStore.getState();
    return { ready, shortcutHandlerInstalled, resetGeneration, committedGeneration, unexpectedCalls: [...unexpectedCalls], calls: [...calls], view: s.view, sessions: s.sessions, terminals: s.terminals, workspaces: s.workspaces, activeSessionId: s.activeSessionId, activeWorkspaceId: s.activeWorkspaceId, focusRequest: s.focusRequest, onboardingOpen: s.onboardingOpen };
  },
} });
createRoot(document.getElementById('root')!).render(<UpdateProvider><App /><CommitSignal /></UpdateProvider>);
