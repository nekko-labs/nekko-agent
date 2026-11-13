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

/**
 * Where a key-based provider's key comes from, for the guided key flow. None
 * of these services offers a browser sign-in that hands an app a key (OpenRouter
 * does, and keeps its sign-in as the first path), so the flow opens the key
 * page, picks the key up when the person comes back, and checks it by itself.
 *
 * `pattern` is the key's shape. Only a key that matches it is taken from the
 * clipboard without a paste; a service with no stable shape has none, and its
 * key is checked when pasted or on Connect.
 */
export interface KeySource {
  /** The site the key page belongs to, as people know it. */
  site: string;
  url: string;
  /** One line under "Get a key": what to do on that page. */
  how: string;
  pattern?: RegExp;
  /** The one line under the panel's title. */
  line: string;
}

export const KEY_SOURCES: Partial<Record<ProviderSetupKind, KeySource>> = {
  gemini: {
    site: 'Google AI Studio',
    url: CLOUD_PROVIDER_PRESETS.gemini.keyUrl,
    how: 'Sign in with Google, press Create API key and copy it. Starting is free.',
    pattern: /^AIza[0-9A-Za-z_-]{35}$/,
    line: 'Gemini models with a Google AI Studio key, billed apart from Google AI plans.',
  },
  openai: {
    site: 'OpenAI',
    url: 'https://platform.openai.com/api-keys',
    how: 'Sign in, press Create new secret key and copy it.',
    pattern: /^sk-(?!ant-|or-)[A-Za-z0-9_-]{20,}$/,
    line: 'GPT models with an OpenAI API key, billed per token to your OpenAI account.',
  },
  anthropic: {
    site: 'Claude Console',
    url: 'https://console.anthropic.com/settings/keys',
    how: 'Sign in, press Create Key and copy it.',
    pattern: /^sk-ant-[A-Za-z0-9_-]{20,}$/,
    line: 'Claude with an Anthropic API key, billed per token to your Anthropic account.',
  },
  openrouter: {
    site: 'OpenRouter',
    url: 'https://openrouter.ai/settings/keys',
    how: 'Sign in, press Create Key and copy it.',
    pattern: /^sk-or-[A-Za-z0-9_-]{20,}$/,
    line: 'Hundreds of models on one account. You pay for what you use.',
  },
  'ollama-cloud': {
    site: 'Ollama',
    url: CLOUD_PROVIDER_PRESETS['ollama-cloud'].keyUrl,
    how: 'Sign in, press Add API key and copy it.',
    line: 'Models hosted by Ollama. No Ollama app or download needed.',
  },
};

/** Whether `text` (trimmed) looks like a key for `source`. */
export function looksLikeKey(source: KeySource | undefined, text: string): boolean {
  return !!source?.pattern && source.pattern.test(text.trim());
}

/** The one line under a setup panel's title, for kinds without a key flow. */
export const SETUP_LINES: Partial<Record<ProviderSetupKind, string>> = {
  chatgpt: 'Runs on your ChatGPT Plus, Pro or Business plan, with no API fees.',
  vertex: 'Claude on your Google Cloud project, billed to Google Cloud.',
  bedrock: 'Claude through your AWS account, billed to AWS.',
  foundry: 'Claude through your Azure account, billed to Azure.',
  'openai-compat': 'Any service with an OpenAI-compatible API.',
  ollama: 'Ollama running on this computer or your network.',
  lmstudio: 'An LM Studio server on this computer or your network.',
  vllm: 'A vLLM server you already run.',
};

export function vertexEndpoint(project: string, location: string): string {
  const region = location.trim() || 'global';
  const host = region === 'global' ? 'aiplatform.googleapis.com' : `${region}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${encodeURIComponent(project.trim())}/locations/${encodeURIComponent(region)}`;
}
