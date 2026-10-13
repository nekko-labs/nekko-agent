import './wall-polish-chrome';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../src/renderer/store';
import { CommandCenterView } from '../src/renderer/views/CommandCenterView';
import { DEFAULT_WALL_STATE } from '../src/renderer/commandWall';
import { PaneFrame } from '../src/renderer/components/PaneFrame';
import { WorkspacesView } from '../src/renderer/views/WorkspacesView';
import { SettingsView } from '../src/renderer/views/SettingsView';
import { UpdateProvider } from '../src/renderer/components/UpdateBanner';
import { summarizeSession, type RemoteStatus } from '@nekko-agent/shared';
import '../src/renderer/styles.css';

// Real UI/store with synthetic chats and an optional isolated host PTY. No user data or OS input.
let records: any[] = [];
let terminals: any[] = [];
const calls: any[] = [];
let failSave = false, failPreference = false;
const provider = { id: 'fixture', kind: 'ollama', enabled: true, baseUrl: 'http://fixture.invalid', label: 'Fixture provider' };
const bridge: any = {
  getRemoteStatus: async (): Promise<RemoteStatus> => ({ enabled: false, online: false, connected: [], devices: [] }),
  getRemotePairing: async () => null,
  getSettings: async () => useStore.getState().settings,
  updateSettings: async (patch: any) => { calls.push({ method: 'settings', patch }); if (failPreference) throw Error('Fixture preference save failed'); return { ...useStore.getState().settings, ...patch }; },
  abortChat: async (id: string) => { calls.push({ method: 'abort', id }); },
  setSessionOptions: async (id: string, options: any) => { calls.push({ method: 'save', id, options }); if (failSave) throw Error('Fixture completion save failed'); const s = records.find(s => s.id === id); Object.assign(s, options); return { ...s }; },
  deleteSession: async (id: string) => { calls.push({ method: 'delete', id }); records = records.filter(s => s.id !== id); },
  closeTerminal: async (id: string) => { calls.push({ method: 'closeTerminal', id }); if ((window as any).lifecycleTerminal && id !== 'term') await (window as any).lifecycleTerminal.close(id); terminals = terminals.filter(t => t.id !== id); },
  listSessionSummaries: async () => records.map(summarizeSession), listTerminals: async () => terminals,
  getUsageSummary: async () => null, previewContext: async () => ({ items: [], totalTokens: 0, budget: 128000 }), getGitStatus: async () => ({ repo: false }), listFiles: async () => [], listTools: async () => [],
  getSession: async (id: string) => records.find(s => s.id === id),
  runningSessions: async () => [], pendingInput: async () => ({}), listModels: async () => [],
  listShells: async () => [], listTasks: async () => [], listChanges: async () => [], listSkills: async () => [], getMcpStatus: async () => [],
  getUpdateInfo: async () => null, getAppInfo: async () => ({ platform: 'win32', version: 'fixture' }),
};
Object.assign(window, { nekko: new Proxy(bridge, { get(t, k: string) { if (k in t) return t[k]; if (k.startsWith('on')) return () => () => {}; return () => Promise.resolve(null); } }) });
let redraw: () => void;
let setRoute: (value: 'panes' | 'settings' | 'command') => void;
let minimized: string[] = [];
function reset(opts: any = {}) {
  records = ['alpha', 'beta'].map(id => ({ id, title: id === 'alpha' ? 'Review lifecycle shortcuts' : 'Check isolated second window', createdAt: Date.now(), updatedAt: Date.now(), providerId: 'fixture', modelId: 'model', mode: 'agent', messages: [], attachments: [], queuedPrompts: [] }));
  terminals = [{ id: 'term', title: 'Synthetic running terminal', pid: 4242, shell: 'pwsh', createdAt: Date.now() }];
  calls.length = 0; minimized = []; failSave = !!opts.failSave; failPreference = !!opts.failPreference;
  localStorage.clear(); setRoute?.(opts.command ? 'command' : 'panes');
  useStore.setState({ sessions: records.map(summarizeSession), terminals, workspaces: [], activeWorkspaceId: null, activeSessionId: null, activeProjectId: null, view: 'command', settingsError: null, completionTipSessionId: null, toasts: [], providers: [provider], models: [], statuses: {}, settings: { providers: [provider], workspaceFolders: [], workspaces: [], guardrails: [], agent: {}, ui: {}, experimental: {}, monitors: {}, theme: 'dark', themePreset: 'default', mascotEnabled: false, showTips: opts.showTips !== false, completionTipSeen: false, skipDeleteConfirmation: false, chatPaneAction: opts.action || 'complete', commandWall: { ...DEFAULT_WALL_STATE, root: { id: 'command-alpha', kind: 'chat', refId: 'alpha' }, autoAdd: false, watermark: Date.now(), dock: { ...DEFAULT_WALL_STATE.dock, show: false } } } } as any);
  redraw?.();
}
function Fixture() {
  const [route, updateRoute] = React.useState<'panes' | 'settings' | 'command'>('panes'); setRoute = updateRoute;
  const [epoch, setEpoch] = React.useState(0); redraw = () => setEpoch(e => e + 1);
  const sessions = useStore(s => s.sessions);
  const settings = useStore(s => s.settings);
  React.useEffect(() => reset(), []);
  Object.assign(window, { lifecycle: { reset, calls, state: () => useStore.getState(), records: () => records, terminals: () => terminals, minimized: () => minimized, useRealTerminal: async () => { terminals = await (window as any).lifecycleTerminal.list(); useStore.setState({ terminals }); redraw(); }, route: (v: 'panes' | 'settings' | 'command') => setRoute(v), patch: (v: any) => useStore.setState({ settings: { ...useStore.getState().settings, ...v } } as any) } });
  return <UpdateProvider><div data-lifecycle-route={route === 'command' ? 'panes' : route} className="bg-paper text-ink" style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
    <header className="border-b border-line p-3 text-sm">Isolated lifecycle verification <span className="text-ink-faint">Synthetic host, Windows shortcuts</span></header>
    {route === 'command' ? <CommandCenterView key={epoch} /> : route === 'settings' ? <SettingsView /> : <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
      <aside style={{ width: 280, flexShrink: 0 }} className="border-r border-line"><WorkspacesView sidebarOnly /></aside>
      <main style={{ flex: 1, minWidth: 0, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', flex: 1, minHeight: 0, gap: 12 }}>
          {['alpha', 'beta'].filter(id => sessions.some(s => s.id === id && !s.archivedAt) && !minimized.includes(id)).map(id => <div key={id} style={{ flex: 1, minWidth: 0 }}>
            <PaneFrame pane={{ id: 'pane-' + id, kind: 'chat', refId: id }} title={records.find(s => s.id === id)?.title || id} icon={null} isActive={id === 'alpha'} dragging={null} canSplit={() => false} onSplit={() => {}} onClose={() => { minimized.push(id); redraw(); }} onMinimize={() => { minimized.push(id); redraw(); }} onFocus={() => {}} onDragStart={() => {}} onDragEnd={() => {}} onDrop={() => {}} hideSplit>
              <div className="p-4 text-sm"><p>Safe synthetic chat body inside the actual PaneFrame.</p><textarea aria-label={'Input ' + id} className="mt-4 w-full border border-line bg-paper p-2" placeholder="DOM focus target" /></div>
            </PaneFrame>
          </div>)}
        </div>
        {!minimized.includes('term') && <div style={{ height: 180 }}><PaneFrame pane={{ id: 'pane-term', kind: 'terminal', refId: terminals[0]?.id || 'term' }} title="Synthetic running terminal" icon={null} isActive={false} dragging={null} canSplit={() => false} onSplit={() => {}} onClose={() => { minimized.push('term'); redraw(); }} onMinimize={() => { minimized.push('term'); redraw(); }} onFocus={() => {}} onDragStart={() => {}} onDragEnd={() => {}} onDrop={() => {}} hideSplit><div className="p-4 font-mono text-sm">Synthetic PID 4242 remains in the host until closeTerminal is called.<input aria-label="Terminal input" className="mt-2 block bg-paper" /></div></PaneFrame></div>}
        <div className="text-xs text-ink-faint">Tips: {settings?.showTips === false ? 'off' : 'on'}. No host connections.</div>
      </main>
    </div>}
  </div></UpdateProvider>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
