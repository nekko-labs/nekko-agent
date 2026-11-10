import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ModelInfo, ProviderConfig } from '@nekko-agent/shared';
import { ModelPicker } from '../src/renderer/components/agent-console/ModelPicker';
import { SubagentModelControl } from '../src/renderer/components/SubagentModelControl';
import { useStore } from '../src/renderer/store';
import '../src/renderer/styles.css';

// The model selector with the Subagents row in its footer, as ChatPane places
// it (#2487). Synthetic providers only; no host, model or network.
// `?before` renders the selector without the row (the base revision has none).
const providers: ProviderConfig[] = [
  { id: 'anthropic', kind: 'anthropic', label: 'Anthropic', baseUrl: 'https://api.anthropic.com', enabled: true },
  { id: 'openai', kind: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', enabled: true },
  { id: 'server', kind: 'llamacpp', label: 'Model Server', baseUrl: 'http://127.0.0.1:8080', enabled: true },
];
const catalog: Record<string, ModelInfo[]> = {
  anthropic: [{ id: 'claude-opus-5-5', providerId: 'anthropic', name: 'Claude Opus 5.5' }, { id: 'claude-sonnet-5-5', providerId: 'anthropic', name: 'Claude Sonnet 5.5' }, { id: 'claude-haiku-5-5', providerId: 'anthropic', name: 'Claude Haiku 5.5' }],
  openai: [{ id: 'gpt-5.5', providerId: 'openai', name: 'GPT-5.5' }, { id: 'gpt-5.5-mini', providerId: 'openai', name: 'GPT-5.5 mini' }],
  server: [{ id: 'qwen3-32b', providerId: 'server', name: 'Qwen3 32B', loaded: true }, { id: 'gemma-3-12b', providerId: 'server', name: 'Gemma 3 12B' }],
};
const saved: Record<string, unknown>[] = [];
let settings = { providers, favoriteModels: [], orchestration: { strategy: 'balanced', maxDepth: 2, maxParallel: 2 } };
Object.assign(window, { nekko: {
  listModels: async (id: string) => catalog[id] ?? [],
  getLimits: async () => null,
  getLimitsProblem: async () => null,
  onLimitsUpdated: () => () => {},
  oauthStatus: async () => null,
  onOAuthStatus: () => () => {},
  updateSettings: async (patch: Record<string, unknown>) => {
    saved.push(patch);
    settings = { ...settings, ...patch } as typeof settings;
    useStore.setState({ settings } as never);
    return settings;
  },
} });
useStore.setState({ providers, settings, refreshProviders: async () => {}, refreshSettings: async () => {} } as never);
const before = location.search.includes('before');

function Fixture() {
  const [open, setOpen] = useState(true);
  Object.assign(window, { integration: { saved, open: () => setOpen(true) } });
  return <main className="bg-paper text-ink" style={{ minHeight: '100vh', padding: 16, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <ModelPicker open={open} onOpenChange={setOpen} providers={providers} providerId="anthropic" modelId="claude-opus-5-5" models={catalog.anthropic} recent={[]}
        onProvider={() => {}} onModel={() => {}}
        footer={before ? undefined : <div className="mt-1 shrink-0 border-t border-line px-1 pt-1"><SubagentModelControl /></div>} />
    </div>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
