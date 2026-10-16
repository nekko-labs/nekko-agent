// Synthetic records only: no host, daemon or network. Renders the surfaces the
// composer-media change touches so before (base revision) and after captures
// match: the wall composer with its + menu and attachment strip, and a chat
// transcript holding a Mermaid diagram, a table and a code block.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../apps/desktop/src/renderer/store';
import { putCachedSession } from '../apps/desktop/src/renderer/sessionCache';
import { CommandCenterView } from '../apps/desktop/src/renderer/views/CommandCenterView';
import { Markdown } from '../apps/desktop/src/renderer/components/Markdown';
import { MessageBubble } from '../apps/desktop/src/renderer/components/agent-console/MessageBubble';
import { DEFAULT_WALL_STATE } from '../apps/desktop/src/renderer/commandWall';
import { summarizeSession } from '@nekko-agent/shared';
import '../apps/desktop/src/renderer/styles.css';

const engine = { id: 'nekko-engine', kind: 'llamacpp', enabled: true, label: 'Nekko Agent engine', baseUrl: 'http://127.0.0.1:11500/v1' };
const claude = { id: 'anthropic', kind: 'anthropic', enabled: true, label: 'Anthropic (Claude)', baseUrl: 'https://api.anthropic.com' };
const openrouter = { id: 'openrouter', kind: 'openrouter', enabled: true, label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' };
const MODELS: Record<string, any[]> = {
  'nekko-engine': [
    { id: 'qwen2.5-coder-7b', providerId: 'nekko-engine', name: 'Qwen2.5 Coder 7B', loaded: true },
    { id: 'gemma3-12b', providerId: 'nekko-engine', name: 'Gemma 3 12B' },
  ],
  anthropic: [{ id: 'claude-opus-5-5', providerId: 'anthropic', name: 'Claude Opus 5.5' }],
  openrouter: [{ id: 'google/gemini-2.5-pro', providerId: 'openrouter', name: 'Google: Gemini 2.5 Pro', details: { inputModalities: 'text,image,video,audio' } }],
};

const now = Date.UTC(2026, 9, 15, 10);
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=';
const diagramReply = [
  'Here is how a pasted file travels through the composer.',
  '',
  '```mermaid',
  'flowchart LR',
  '  P[Paste / drop / pick] --> C{Photo or video?}',
  '  C -- model can see --> M[Pending media on the message]',
  '  C -- no --> F{Has a disk path?}',
  '  F -- yes --> A[Attach in place]',
  '  F -- no --> I[Import to data dir] --> A',
  '  A --> S[Strip chip, name only when unreadable]',
  '```',
  '',
  '| Kind | Travels as | Model sees |',
  '| --- | --- | --- |',
  '| Photo | data URL | pixels |',
  '| Video | `video_url` part | frames (Gemini) |',
  '| PDF | attached path | name only |',
  '',
  '```ts',
  'const plan = planAttachment(file, window.nekko.pathForFile(file), mediaSupport);',
  '```',
].join('\n');
const chat = (id: string, providerId: string, modelId: string, attached: string[] = []) => ({
  id, title: 'Composer media evidence', createdAt: now - 86400000, updatedAt: now, providerId, modelId, mode: 'guardrails', chatType: 'multimodal', workspaceId: 'proj',
  messages: [
    { id: 'u1', role: 'user', content: 'How does a pasted file travel?', createdAt: now - 7200000, images: [PNG] },
    { id: 'a1', role: 'assistant', content: diagramReply, createdAt: now - 7100000 },
  ],
  attachments: [], attachedPaths: attached, queue: [],
});
let sessions: any[] = [chat('local', 'nekko-engine', 'qwen2.5-coder-7b'), chat('cloud', 'anthropic', 'claude-opus-5-5'), chat('gemini', 'openrouter', 'google/gemini-2.5-pro')];
const bridge: any = {
  listModels: async (id: string) => MODELS[id] ?? [],
  listSessionSummaries: async () => sessions.map(summarizeSession as any),
  getSession: async (id: string) => sessions.find((s) => s.id === id) ?? null,
  setSessionAttachments: async (id: string, paths: string[]) => { const s = sessions.find((x) => x.id === id); if (s) s.attachedPaths = paths; return s; },
  pathForFile: (file: File) => ((file as any).__path ?? ''),
  importAttachment: async (_id: string, name: string) => `C:/Users/me/AppData/Roaming/Nekko Agent/attachments/local/${name}`,
  listTerminals: async () => [], pendingInput: async () => ({}), runningSessions: async () => [], listTasks: async () => [],
  getUsageSummary: async () => null, listShells: async () => [], getMcpStatus: async () => [], listSkills: async () => [], listTools: async () => [],
  previewContext: async () => ({ items: [], totalTokens: 0, budget: 128000 }), getGitStatus: async () => ({ repo: false }),
  updateSettings: async (p: any) => ({ ...useStore.getState().settings, ...p }),
};
Object.assign(window, { nekko: new Proxy(bridge, { get(t, k: string) { if (k in t) return t[k]; if (k.startsWith('on')) return () => () => {}; return () => Promise.resolve(null); } }) });
localStorage.clear();
const settings: any = { providers: [engine, claude, openrouter], workspaceFolders: [], workspaces: [{ id: 'proj', name: 'nekko-agent', path: 'C:/code/nekko-agent' }], theme: 'dark', experimental: {}, developer: {}, agent: {}, ui: {}, commandWall: { ...DEFAULT_WALL_STATE, root: { id: 'pane_1', kind: 'chat', refId: 'local' }, hero: 'local', autoAdd: false, watermark: now, dock: { ...DEFAULT_WALL_STATE.dock, show: false }, agentPanel: { show: false, orientation: 'vertical' } } };
useStore.setState({ view: 'command', providers: [engine, claude, openrouter] as any, models: MODELS['nekko-engine'] as any, activeProviderId: 'nekko-engine', sessions: sessions.map(summarizeSession as any), terminals: [], workspaces: [], settings, settingsLoaded: true, activeSkillBySession: {}, prsBySession: {}, installedSkillDefs: [], contextPanelOpen: false, planRailOpen: false } as any);
sessions.forEach((s) => putCachedSession(s as any));

function Fixture() {
  const [route, setRoute] = useState<string>('wall');
  const [epoch, setEpoch] = useState(0);
  Object.assign(window, {
    evidence: {
      route: (r: string) => { setRoute(r); setEpoch((e) => e + 1); },
      /** Point the wall at another chat (and so another model). */
      hero: (id: string) => {
        const st = useStore.getState();
        useStore.setState({ settings: { ...st.settings, commandWall: { ...st.settings!.commandWall!, root: { id: 'pane_1', kind: 'chat', refId: id }, hero: id } } } as any);
        setEpoch((e) => e + 1);
      },
      state: () => useStore.getState(),
      png: PNG,
    },
  });
  return (
    <main key={epoch} data-route={route} style={{ height: '100vh', width: '100vw', display: 'flex', flexDirection: 'column' }} className="bg-paper text-ink">
      {route === 'wall' && <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}><CommandCenterView /></div>}
      {route === 'reply' && (
        <div data-reply style={{ width: 760, padding: 24 }}>
          <MessageBubble message={sessions[0].messages[0] as any} />
          <div className="msg-ai mt-3" style={{ maxWidth: 'none' }}><Markdown text={diagramReply} /></div>
        </div>
      )}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
