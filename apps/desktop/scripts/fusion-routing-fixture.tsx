import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AppSettings, ModelInfo, ProviderConfig } from '@nekko-agent/shared';
import { AUTO_MODEL_ID } from '@nekko-agent/shared';
import { DelegationRouteSettings } from '../src/renderer/components/DelegationRouteSettings';
import { ModelPicker, AutoQualityMenu } from '../src/renderer/components/agent-console/ModelPicker';
import { SubagentModelControl } from '../src/renderer/components/SubagentModelControl';
import { useStore } from '../src/renderer/store';
import '../src/renderer/styles.css';

// Production components; isolated in-memory bridge. No host, credentials, model or external calls.
const providers: ProviderConfig[] = [
  { id: 'cloud', kind: 'chatgpt', label: 'ChatGPT · Personal', baseUrl: 'https://chatgpt.com', enabled: true },
  { id: 'local', kind: 'lmstudio', label: 'LM Studio', baseUrl: 'http://127.0.0.1:1234', enabled: true },
];
const catalogs: Record<string, ModelInfo[]> = {
  cloud: ['gpt-5', 'gpt-5-mini'].map((id) => ({ id, providerId: 'cloud', name: id })),
  local: [{ id: 'qwen-8b', name: 'Qwen 8B', providerId: 'local', loaded: true }, { id: 'qwen-32b', name: 'Qwen 32B', providerId: 'local' }, { id: 'custom-coder', name: 'Local coding model', providerId: 'local' }],
};
let current = { providers, favoriteModels: [], workspaces: [], orchestration: { strategy: 'balanced', maxDepth: 2, maxParallel: 2, subagentModel: 'auto' } } as AppSettings;
const saved: Partial<AppSettings>[] = [];
Object.assign(window, { nekko: {
  listModels: async (id: string) => catalogs[id] ?? [], getLimits: async () => null,
  getLimitsProblem: async () => null, onLimitsUpdated: () => () => {},
  oauthStatus: async () => null, onOAuthStatus: () => () => {},
  updateSettings: async (patch: Partial<AppSettings>) => {
    saved.push(patch); current = { ...current, ...patch }; useStore.setState({ settings: current }); return current;
  },
} });
useStore.setState({ providers, settings: current, refreshProviders: async () => {}, refreshSettings: async () => {} } as never);
function Fixture() {
  const settings = useStore((s) => s.settings)!;
  const [open, setOpen] = useState(true);
  const [model, setModel] = useState('gpt-5');
  const [fusion, setFusion] = useState(false);
  const surface = new URLSearchParams(location.search).get('surface') ?? 'picker';
  const update = async (patch: Partial<AppSettings>) => { await window.nekko.updateSettings(patch); };
  Object.assign(window, { integration: { saved, reopen: () => setOpen(true), state: () => ({ settings: current, model, fusion }) } });
  if (surface === 'settings') return <main className="min-h-screen bg-paper p-4 text-ink"><div className="mx-auto max-w-lg"><h2 className="mb-6 text-lg font-medium">Agents</h2><DelegationRouteSettings settings={settings} update={update} /></div></main>;
  return <main className="fixed inset-0 flex flex-col justify-end bg-paper p-4 text-ink"><p className="mb-4 text-xs text-ink-faint">Synthetic routing fixture · no provider requests</p><div className="flex gap-2">
    <ModelPicker open={open} onOpenChange={setOpen} providers={providers} providerId="cloud" modelId={model} models={catalogs.cloud!} recent={[]}
      fusionActive={fusion} onFusion={() => { setFusion(true); setModel(AUTO_MODEL_ID); }}
      onProvider={() => {}} onModel={(_pid, id) => { setFusion(false); setModel(id); }}
      footer={<div className="mt-1 shrink-0 border-t border-line pt-1"><SubagentModelControl fusionAllowed={fusion} /></div>} />
    {model === AUTO_MODEL_ID && <AutoQualityMenu quality="normal" onQuality={() => {}} followCapacity={fusion} onFollowCapacity={setFusion} strategy={settings.fusion?.strategy ?? 'balanced'} onStrategy={(strategy) => { void update({ fusion: { ...settings.fusion, strategy } }); }} />}
  </div></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
