import React from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../apps/desktop/src/renderer/store';
import { ModelPicker } from '../apps/desktop/src/renderer/components/agent-console/ModelPicker';
import '../apps/desktop/src/renderer/styles.css';
const providers = [
  { id: 'cloud', kind: 'openai', label: 'Cloud fixture', enabled: true, baseUrl: '' },
  { id: 'local', kind: 'ollama', label: 'Local fixture', enabled: true, baseUrl: 'http://localhost:11434' },
] as any;
const models = [
  { id: 'gpt-fixture', providerId: 'cloud', name: 'Cloud fixture model' },
  { id: 'qwen-fixture', providerId: 'local', name: 'Local fixture model' },
];
Object.assign(window, { nekko: new Proxy({}, { get: (_t, k: string) => k === 'listModels' ? (id: string) => Promise.resolve(models.filter(m => m.providerId === id)) : k.startsWith('on') ? () => () => {} : () => Promise.resolve(null) }) });
useStore.setState({ providers, models, settings: { favoriteModels: ['local::qwen-fixture'], defaultProviderId: 'cloud', defaultModelId: 'gpt-fixture' } } as any);
createRoot(document.getElementById('root')!).render(
  <main className="bg-paper" style={{ minHeight: '100vh', padding: 24 }}>
    <h1 className="mb-4 text-[20px] font-semibold">Choose a model</h1>
    <div style={{ width: '100%', maxWidth: 390, height: 420 }}>
      <ModelPicker expanded open providers={providers} providerId="cloud" modelId="gpt-fixture" models={models.filter(m => m.providerId === 'cloud')} onOpenChange={() => {}} onProvider={() => {}} onModel={() => {}} />
    </div>
  </main>,
);
