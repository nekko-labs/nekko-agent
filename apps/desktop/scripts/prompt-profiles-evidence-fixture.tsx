import React from 'react';
import { createRoot } from 'react-dom/client';
import { PromptProfilesSettings } from '../src/renderer/components/PromptProfilesSettings.js';
import { useStore } from '../src/renderer/store.js';
import '../src/renderer/styles.css';

// The Settings section with a stubbed bridge: no daemon, network or real data.
const texts = {
  small: 'You are Nekko, a coding agent on the user\'s computer. Use tools instead of guessing.\n\n- Check before you claim it works.\n- Ask first before anything risky.',
  medium: 'You are Nekko, a local-first coding agent.\n\nWorking rules, with the pull request and CI detail shortened.',
  large: 'You are Nekko, a local-first coding agent.\n\nEvery rule, in full, including pull request, CI and verification process.',
};
(window as any).nekko = { promptProfileTexts: async () => texts };
useStore.setState({ activeProviderId: 'lm', models: [{ id: 'qwen3-8b', providerId: 'lm', name: 'qwen3-8b' }, { id: 'gemma-4-31b', providerId: 'lm', name: 'gemma-4-31b' }] } as never);
let settings: any = { providers: [{ id: 'lm', label: 'LM Studio' }, { id: 'an', label: 'Anthropic' }], promptProfiles: { auto: true, providers: { lm: 'small' }, models: { 'lm::gemma-4-31b': 'medium' } } };
const root = createRoot(document.getElementById('root')!);
const draw = () => root.render(<main className="min-h-screen bg-surface p-8 text-ink" style={{ maxWidth: 720 }}><PromptProfilesSettings settings={settings} update={(p) => { settings = { ...settings, ...p }; draw(); }} /></main>);
draw();
