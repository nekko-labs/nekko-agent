import React from 'react';
import { createRoot } from 'react-dom/client';
import { ModelsView } from '../src/renderer/views/ModelsView';
import { useStore } from '../src/renderer/store';

// Synthetic providers only: no credentials, every host call answers locally.
const local = [{ id: 'lms', kind: 'lmstudio', label: 'LM Studio', baseUrl: 'http://localhost:1234/v1', enabled: true }];
// The nine-provider case: 4 local servers and 5 cloud providers.
const moreLocal = [
  { id: 'ollama', kind: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434', enabled: true },
  { id: 'lms2', kind: 'lmstudio', label: 'lmstudio (local)', baseUrl: 'http://127.0.0.1:1234/v1', enabled: false },
  { id: 'vllm', kind: 'vllm', label: 'vLLM', baseUrl: 'http://localhost:8000/v1', enabled: true },
];
const moreClouds = [
  { id: 'gemini', kind: 'openai', label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com', enabled: true },
  { id: 'groq', kind: 'openai', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', enabled: false },
];
const clouds = [
  { id: 'anthropic', kind: 'anthropic', label: 'Anthropic (Claude)', baseUrl: 'https://api.anthropic.com', enabled: true },
  { id: 'openai', kind: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', enabled: true },
  { id: 'openrouter', kind: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', enabled: true },
];
let providers: any[] = [];
const models = (id: string) => ['model-a', 'model-b', 'model-c'].map((m) => ({ id: `${id}-${m}`, providerId: id, name: `${id}-${m}` }));
(window as any).nekko = new Proxy({
  listProviders: async () => providers,
  listModels: async (id: string) => models(id),
  getSettings: async () => ({ theme: 'dark', favoriteModels: [] }),
  testProvider: async () => ({ ok: true, message: 'Connected' }),
  lmsAvailable: async () => ({ available: false }),
  oauthStatus: async () => null,
  getLimits: async () => null,
  runtimeStatus: async () => null,
  runtimeFacts: async () => [],
}, { get(target: any, key: string) { if (key in target) return target[key]; if (key.startsWith('on')) return () => () => {}; return async () => null; } });

const root = createRoot(document.getElementById('root')!);
function show(cloudCount: number, theme: 'light' | 'dark') {
  providers = cloudCount >= 5 ? [...local, ...moreLocal, ...clouds, ...moreClouds] : [...local, ...clouds.slice(0, cloudCount)];
  useStore.setState({ view: 'models', providers, activeModelId: 'lms-model-a', models: models('lms') as any, settings: { theme } as any, settingsLoaded: true, onboardingOpen: false });
  document.documentElement.dataset.theme = theme;
  root.render(<div key={`${cloudCount}-${theme}`} style={{ height: '100vh' }}><ModelsView /></div>);
}
(window as any).__fixture = { show };
