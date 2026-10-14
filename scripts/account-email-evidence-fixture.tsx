import React from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../apps/desktop/src/renderer/store';
import { ModelPicker } from '../apps/desktop/src/renderer/components/agent-console/ModelPicker';
import { WallDock } from '../apps/desktop/src/renderer/components/WallDock';
import { DEFAULT_WALL_STATE } from '../apps/desktop/src/renderer/commandWall';
import '../apps/desktop/src/renderer/styles.css';

// Two Claude plans and one ChatGPT plan, all synthetic: no credentials, no network.
const providers: any[] = [
  { id: 'claude-personal', kind: 'anthropic', label: 'Anthropic (Claude)', baseUrl: '', enabled: true, auth: 'subscription', tokenKey: 'claude:personal' },
  { id: 'claude-work', kind: 'anthropic', label: 'Anthropic (Claude)', baseUrl: '', enabled: true, auth: 'subscription', tokenKey: 'claude:work' },
  { id: 'chatgpt', kind: 'chatgpt', label: 'ChatGPT (subscription)', baseUrl: '', enabled: true, auth: 'subscription', tokenKey: 'chatgpt:acct', accountId: 'acct' },
];
const emails: Record<string, string> = { 'claude-personal': 'davide@example.com', 'claude-work': 'davide.rossi@company.example', chatgpt: 'davide@example.com' };
const catalog: Record<string, any[]> = {
  'claude-personal': [{ id: 'claude-opus', providerId: 'claude-personal', name: 'Claude Opus' }, { id: 'claude-sonnet', providerId: 'claude-personal', name: 'Claude Sonnet' }],
  'claude-work': [{ id: 'claude-opus', providerId: 'claude-work', name: 'Claude Opus' }, { id: 'claude-sonnet', providerId: 'claude-work', name: 'Claude Sonnet' }],
  chatgpt: [{ id: 'gpt', providerId: 'chatgpt', name: 'GPT' }],
};
const now = Date.UTC(2026, 9, 14, 12);
const limits: Record<string, any> = {
  'claude:personal': { windows: [{ label: '5-hour', usedPercent: 22, resetAt: now + 3 * 3600e3 }, { label: '7-day', usedPercent: 41, resetAt: now + 4 * 864e5 }], updatedAt: now, staleAfterMs: 6e5 },
  'claude:work': { windows: [{ label: '5-hour', usedPercent: 67, resetAt: now + 3600e3 }, { label: '7-day', usedPercent: 85, resetAt: now + 2 * 864e5 }], updatedAt: now, staleAfterMs: 6e5 },
  'chatgpt:acct': { windows: [{ label: '5-hour', usedPercent: 10, resetAt: now + 2 * 3600e3 }], updatedAt: now, staleAfterMs: 6e5 },
};
const bridge: any = {
  listModels: async (id: string) => catalog[id] ?? [],
  getLimits: async (key: string) => limits[key],
  getLimitsProblem: async () => undefined,
  oauthStatus: async (id: string) => {
    const p = providers.find((x) => x.id === id);
    return { tokenKey: p.tokenKey, provider: p.kind === 'chatgpt' ? 'chatgpt' : 'claude', connected: true, state: 'success', accountEmail: emails[id] };
  },
  updateSettings: async (p: any) => ({ ...useStore.getState().settings, ...p }),
};
Object.assign(window, { nekko: new Proxy(bridge, { get(t, k: string) { if (k in t) return t[k]; if (k.startsWith('on')) return () => () => {}; return () => Promise.resolve(null); } }) });
localStorage.clear();
useStore.setState({ providers, settings: { providers, theme: 'light', experimental: {}, agent: {}, ui: {} } as any, sessions: [] } as any);

const wall = { ...DEFAULT_WALL_STATE, dock: { ...DEFAULT_WALL_STATE.dock, show: true, side: 'right', panels: { automations: false, utilization: true, budget: false, insights: false, hardware: false } } } as any;
function Fixture() {
  return <main data-evidence-route="accounts" className="bg-paper" style={{ height: '100vh', width: '100vw', display: 'flex', gap: 24, padding: 24, boxSizing: 'border-box' }}>
    <section data-shot="picker" style={{ width: 380, height: 520, display: 'flex' }}>
      <ModelPicker expanded open providers={providers} providerId="claude-personal" modelId="claude-opus" models={catalog['claude-personal']} onOpenChange={() => {}} onProvider={() => {}} onModel={() => {}} recent={['claude-work::claude-sonnet']} />
    </section>
    <section data-shot="utilization" style={{ width: 408, display: 'flex' }}>
      <WallDock state={wall} setState={() => {}} tasks={[]} running={new Set()} now={now} sessions={[]} providers={providers} usage={null} vitals={{ working: 0, waiting: 0, automations: 0, terminals: 0, tokensToday: 0, spend: '$0', fleet: [] } as any} onOpenChat={() => {}} onOpenModels={() => {}} />
    </section>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
