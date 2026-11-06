import { PROVIDER_DEFAULTS, type ProviderKind } from '@nekko-agent/shared';

/** Setup choices are not new wire kinds: these services expose compatible APIs. */
export type ProviderSetupKind = ProviderKind | 'gemini' | 'ollama-cloud';

export const CLOUD_PROVIDER_PRESETS = {
  gemini: { kind: 'openai-compat' as const, label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', needsKey: true, keyUrl: 'https://aistudio.google.com/apikey', description: 'Use a Google AI Studio API key. Gemini API usage is billed separately from Google AI subscriptions.' },
  'ollama-cloud': { kind: 'openai-compat' as const, label: 'Ollama Cloud', baseUrl: 'https://ollama.com/v1', needsKey: true, keyUrl: 'https://ollama.com/settings/keys', description: 'Run models hosted by Ollama with an Ollama Cloud API key. No Ollama app or model download is needed.' },
};

export function providerSetupDefaults(choice: ProviderSetupKind) {
  return choice in CLOUD_PROVIDER_PRESETS
    ? CLOUD_PROVIDER_PRESETS[choice as keyof typeof CLOUD_PROVIDER_PRESETS]
    : { kind: choice as ProviderKind, ...PROVIDER_DEFAULTS[choice as ProviderKind] };
}

export function vertexEndpoint(project: string, location: string): string {
  const region = location.trim() || 'global';
  const host = region === 'global' ? 'aiplatform.googleapis.com' : `${region}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${encodeURIComponent(project.trim())}/locations/${encodeURIComponent(region)}`;
}
