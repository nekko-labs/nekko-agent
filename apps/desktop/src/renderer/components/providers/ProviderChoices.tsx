import React from 'react';
import type { ProviderKind } from '@nekko-agent/shared';
import { PROVIDER_DEFAULTS } from '@nekko-agent/shared';

// Claude is an API-key provider here. The Claude Agent choice (runs the user's
// installed Claude Code) joins this list beside it in the harness UI step.
const choices: { kind: ProviderKind; icon?: string; description: string }[] = [
  { kind: 'chatgpt', icon: 'openai', description: 'Sign in with your ChatGPT plan' },
  { kind: 'anthropic', icon: 'anthropic', description: 'Use an Anthropic API key · billed separately' },
  { kind: 'openrouter', icon: 'openrouter', description: 'Many models · pay for what you use' },
  { kind: 'openai', icon: 'openai', description: 'Use an API key · billed separately' },
  { kind: 'ollama', icon: 'ollama', description: 'Connect Ollama on your computer' },
  { kind: 'lmstudio', icon: 'lmstudio', description: 'Connect your LM Studio server' },
  { kind: 'vllm', icon: 'vllm', description: 'Connect an existing vLLM server' },
  { kind: 'openai-compat', description: 'Other services · custom connection' },
];

export function ProviderChoices({ value, onPick }: { value?: ProviderKind; onPick: (kind: ProviderKind) => void }) {
  return <div className="provider-choices" role="group" aria-label="Choose a model provider">
    {choices.map(({ kind, icon, description }) => <button key={kind} type="button" className="provider-choice" aria-pressed={value === kind} onClick={() => onPick(kind)}>
      <span className="provider-choice-icon" aria-hidden="true">{icon ? <img src={`./providers/${icon}.svg`} alt="" width="28" height="28" /> : <span>↗</span>}</span>
      <span><strong>{kind === 'anthropic' ? 'Claude' : PROVIDER_DEFAULTS[kind].label}</strong><small>{description}</small></span>
    </button>)}
  </div>;
}

export function SetupIllustration() {
  return <svg className="setup-illustration" width="200" height="112" viewBox="0 0 200 112" fill="none" aria-hidden="true">
    <ellipse cx="100" cy="59" rx="88" ry="43" stroke="currentColor" strokeDasharray="4 7" opacity=".25" />
    <path d="M39 62h122M100 18v78" stroke="currentColor" opacity=".2" />
    <rect x="65" y="22" width="70" height="70" rx="23" fill="var(--accent-soft)" stroke="currentColor" />
    <path d="M82 66V43l12 7h12l12-7v23l-9 10H91z" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" />
    <path d="M91 60h2m14 0h2m-13 8h8" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    <circle cx="27" cy="62" r="9" fill="var(--surface-2)" stroke="currentColor" />
    <path d="m165 43 4 8 9 2-9 3-4 8-3-8-8-3 8-2z" fill="currentColor" />
  </svg>;
}
