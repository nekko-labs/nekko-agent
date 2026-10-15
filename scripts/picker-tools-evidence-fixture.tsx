// Synthetic records only: no host, daemon or network. Renders the surfaces this
// change touches so before (base revision) and after captures match exactly.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../apps/desktop/src/renderer/store';
import { putCachedSession } from '../apps/desktop/src/renderer/sessionCache';
import { ModelPicker } from '../apps/desktop/src/renderer/components/agent-console/ModelPicker';
import { ToolsMenu } from '../apps/desktop/src/renderer/components/ChatControls';
import { CommandCenterView } from '../apps/desktop/src/renderer/views/CommandCenterView';
import { DEFAULT_WALL_STATE } from '../apps/desktop/src/renderer/commandWall';
import { BUILTIN_TOOLS } from '../packages/core/src/agent/tools';
import { summarizeSession } from '@nekko-agent/shared';
import '../apps/desktop/src/renderer/styles.css';

const engine = { id: 'nekko-engine', kind: 'llamacpp', enabled: true, label: 'Nekko Agent engine', baseUrl: 'http://127.0.0.1:11500/v1' };
const claude = { id: 'anthropic', kind: 'anthropic', enabled: true, label: 'Anthropic (Claude)', baseUrl: 'https://api.anthropic.com' };
// What the engine daemon sent before this change (name = the path-like id, no path)
// and what it sends now (friendly name + file path + folder).
const rows = (after: boolean) => [
  { id: 'lmstudio/lmstudio-community/Muse-Glimmer-30B-GGUF/Muse-Glimmer-30B-Q4_K_M', providerId: 'nekko-engine', name: after ? 'Muse Glimmer 30B' : 'lmstudio/lmstudio-community/Muse-Glimmer-30B-GGUF/Muse-Glimmer-30B-Q4_K_M', ...(after ? { details: { path: 'D:/models/lmstudio-community/Muse-Glimmer-30B-GGUF/Muse-Glimmer-30B-Q4_K_M.gguf', location: 'LM Studio' } } : {}), loaded: true },
  { id: 'lmstudio/lmstudio-community/Qwen3.8-27B-GGUF/Qwen3.8-27B-Q4_K_M', providerId: 'nekko-engine', name: after ? 'Qwen3.8 27B' : 'lmstudio/lmstudio-community/Qwen3.8-27B-GGUF/Qwen3.8-27B-Q4_K_M', ...(after ? { details: { path: 'D:/models/lmstudio-community/Qwen3.8-27B-GGUF/Qwen3.8-27B-Q4_K_M.gguf', location: 'LM Studio' } } : {}) },
  { id: 'gemma-4-12b', providerId: 'nekko-engine', name: after ? 'Gemma 4 12B' : 'gemma-4-12b', ...(after ? { details: { path: 'C:/Users/me/.nekko/models/chat/gemma-4-12b.gguf' } } : {}) },
];
// The base revision's daemon sent the raw rows; this one sends the friendly ones.
const ENGINE_ROWS = rows(!!(window as any).__ArtifactsView);
const cloud = [{ id: 'claude-opus-5-5', providerId: 'anthropic', name: 'Claude Opus 5.5' }, { id: 'claude-sonnet-5', providerId: 'anthropic', name: 'Claude Sonnet 5' }];

const now = Date.UTC(2026, 9, 15, 10);
const msg = (id: string, role: string, content: string, at: number, extra: object = {}) => ({ id, role, content, createdAt: at, ...extra });
const chat = (id: string, title: string, messages: any[], extra: object = {}) => ({ id, title, createdAt: now - 86400000, updatedAt: messages.at(-1)?.createdAt ?? now, providerId: 'nekko-engine', modelId: rows(true)[0].id, mode: 'guardrails', chatType: 'multimodal', workspaceId: 'proj', messages, attachments: [], queue: [], ...extra });
const write = (path: string) => ({ id: path, name: 'write_file', input: { path, content: '…' } });
const sessions = [
  chat('audit', 'Disk audit and cleanup', [msg('u1', 'user', 'Audit my disk', now - 7200000), msg('a1', 'assistant', '', now - 7100000, { toolCalls: [write('reports/disk-audit/README.md'), write('reports/disk-audit/usage.csv'), write('src/cleanup.ts')] }), msg('a2', 'assistant', 'Wrote [Disk audit and cleanup proposal](reports/disk-audit/README.md) with the [usage table](reports/disk-audit/usage.csv).', now - 7000000)]),
  chat('login', 'Login page redesign', [msg('u1', 'user', 'Design a login page', now - 3600000), msg('a1', 'assistant', '', now - 3500000, { toolCalls: [write('nekko-designs/login/index.html'), write('nekko-designs/login/flow.mmd')] }), msg('a2', 'assistant', 'Prototype: [Login prototype](nekko-designs/login/index.html). Flow: [Sign-in flow](docs/sign-in-flow.mmd).', now - 3400000)]),
  chat('plan', 'Q4 roadmap', [msg('u1', 'user', 'Plan Q4', now - 600000), msg('a1', 'assistant', 'See [Q4 roadmap](reports/q4-roadmap.html) and [Budget](reports/q4-budget.xlsx).', now - 500000)]),
];
const tools = BUILTIN_TOOLS.map((t) => ({ name: t.name, description: t.description }));
const bridge: any = {
  listModels: async (id: string) => (id === 'nekko-engine' ? ENGINE_ROWS : cloud),
  listTools: async () => tools,
  listSessionSummaries: async () => sessions.map(summarizeSession as any),
  getSession: async (id: string) => sessions.find((s) => s.id === id) ?? null,
  listTerminals: async () => [], pendingInput: async () => ({}), runningSessions: async () => [], listTasks: async () => [],
  getUsageSummary: async () => null, listShells: async () => [], getMcpStatus: async () => [], listSkills: async () => [],
  readFile: async (p: string) => ({ path: p, content: '# Disk audit and cleanup proposal\n\nFreed 48 GB across three folders.\n\n| Folder | Size |\n| --- | --- |\n| Downloads | 31 GB |\n| Temp | 12 GB |', size: 120, binary: false }),
  listComments: async () => [],
  setSessionOptions: async (_id: string, patch: any) => ({ ...(window as any).evidence.session, ...patch }),
  updateSettings: async (p: any) => ({ ...useStore.getState().settings, ...p }),
};
Object.assign(window, { nekko: new Proxy(bridge, { get(t, k: string) { if (k in t) return t[k]; if (k.startsWith('on')) return () => () => {}; return () => Promise.resolve(null); } }) });
localStorage.clear();
const settings: any = { providers: [engine, claude], workspaceFolders: [], workspaces: [{ id: 'proj', name: 'nekko-agent', path: 'C:/code/nekko-agent' }], theme: 'dark', experimental: {}, developer: {}, agent: {}, ui: {}, favoriteModels: ['nekko-engine::' + rows(true)[0].id, 'nekko-engine::' + rows(true)[1].id], commandWall: { ...DEFAULT_WALL_STATE, root: { id: 'pane_1', kind: 'chat', refId: 'audit' }, hero: 'audit', autoAdd: false, watermark: now, dock: { ...DEFAULT_WALL_STATE.dock, show: false }, agentPanel: { show: false, orientation: 'vertical' } } };
useStore.setState({ view: 'command', providers: [engine, claude] as any, models: rows(true) as any, activeProviderId: 'nekko-engine', sessions: sessions.map(summarizeSession as any), terminals: [], workspaces: [], settings, settingsLoaded: true, activeSkillBySession: {}, prsBySession: {}, installedSkillDefs: [], contextPanelOpen: false } as any);
sessions.forEach((s) => putCachedSession(s as any));

function Fixture() {
  const [route, setRoute] = useState<string>('picker');
  const [epoch, setEpoch] = useState(0);
  const [offline, setOffline] = useState(false);
  const session: any = { ...sessions[0], offline, disabledTools: [] };
  Object.assign(window, { evidence: { route: (r: string) => { setRoute(r); setEpoch((e) => e + 1); }, setOffline, session, engineRows: ENGINE_ROWS, state: () => useStore.getState() } });
  const ArtifactsView = (window as any).__ArtifactsView;
  return (
    <main key={epoch} data-route={route} style={{ height: '100vh', width: '100vw', display: 'flex', flexDirection: 'column' }} className="bg-paper text-ink">
      {route === 'picker' && <div style={{ width: 460, height: 560, padding: 16 }}><ModelPicker expanded open providers={[engine, claude] as any} providerId="nekko-engine" modelId={rows(true)[0].id} models={ENGINE_ROWS} onOpenChange={() => {}} onProvider={() => {}} onModel={() => {}} /></div>}
      {route === 'tools' && <div style={{ padding: 16, paddingTop: 520, display: 'flex', justifyContent: 'flex-start' }}><div data-tools-anchor style={{ marginLeft: 280 }}><ToolsMenu session={session} onChange={() => {}} /></div></div>}
      {route === 'wall' && <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}><CommandCenterView /></div>}
      {route === 'artifacts' && (ArtifactsView ? <ArtifactsView /> : <p data-no-artifacts style={{ padding: 24 }}>No Artifacts tab in this revision.</p>)}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
