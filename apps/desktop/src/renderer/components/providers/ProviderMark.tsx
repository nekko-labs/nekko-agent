import type { ProviderConfig } from '@nekko-agent/shared';
import type { ProviderSetupKind } from './providerPresets.js';

/** One identity across setup shortcuts, choices, and connected cards. */
const MARKS: Partial<Record<ProviderSetupKind, { icon: string; color: string }>> = {
  chatgpt: { icon: 'openai', color: '#167d65' },
  openai: { icon: 'openai', color: '#354759' },
  anthropic: { icon: 'anthropic', color: '#bc694d' },
  'claude-code': { icon: 'anthropic', color: '#bc694d' },
  gemini: { icon: 'google', color: '#315db0' },
  vertex: { icon: 'google', color: '#315db0' },
  openrouter: { icon: 'openrouter', color: '#5555a6' },
  'ollama-cloud': { icon: 'ollama', color: '#42424c' },
  ollama: { icon: 'ollama', color: '#42424c' },
  lmstudio: { icon: 'lmstudio', color: '#6850b8' },
  vllm: { icon: 'vllm', color: '#246676' },
};

export function providerMarkKind(provider: Pick<ProviderConfig, 'kind' | 'baseUrl'>): ProviderSetupKind {
  if (provider.kind === 'openai-compat') {
    try {
      const host = new URL(provider.baseUrl ?? '').hostname;
      if (host === 'generativelanguage.googleapis.com') return 'gemini';
      if (host === 'ollama.com') return 'ollama-cloud';
    } catch { /* A custom endpoint keeps its generic icon. */ }
  }
  return provider.kind;
}

export function providerColor(kind: ProviderSetupKind): string {
  return MARKS[kind]?.color ?? '#485064';
}

export function ProviderMark({ kind, tile = false, inline = false }: { kind: ProviderSetupKind; tile?: boolean; inline?: boolean }) {
  const mark = MARKS[kind];
  // Inline, the logo takes the text's colour; a custom endpoint has no logo and shows nothing.
  if (inline) return mark ? <span className="provider-mark-inline" style={{ ['--mark' as string]: `url(./providers/${mark.icon}.svg)` }} data-provider-mark={mark.icon} aria-hidden="true" /> : null;
  return <span className={`provider-mark${tile ? ' provider-mark-tile' : ''}`} style={tile ? { background: providerColor(kind) } : undefined} aria-hidden="true">
    {mark ? <img src={`./providers/${mark.icon}.svg`} alt="" width="22" height="22" /> : <span>↗</span>}
  </span>;
}
