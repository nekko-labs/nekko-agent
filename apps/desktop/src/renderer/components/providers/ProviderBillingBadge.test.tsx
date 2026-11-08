import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ClaudeCodeStatus, ProviderConfig, ProviderKind } from '@nekko-agent/shared';
import { ProviderBillingBadge } from './ProviderBillingBadge.js';

const provider = (kind: ProviderKind, extra: Partial<ProviderConfig> = {}): ProviderConfig => ({ id: kind, kind, label: 'Subscription-looking name', baseUrl: '', enabled: true, ...extra });
const status = (auth: 'subscription' | 'api_key' | 'cloud' | 'unknown'): ClaudeCodeStatus => ({ installed: true, version: '2.1.319', loggedIn: true, auth, authMethod: auth });
const render = (p: ProviderConfig, claudeStatus?: ClaudeCodeStatus | null) => renderToStaticMarkup(<ProviderBillingBadge provider={p} claudeStatus={claudeStatus} />);

describe('provider billing chips', () => {
  it('uses the reported Claude Code login, not a saved mode or a provider label', () => {
    expect(render(provider('claude-code'), status('subscription'))).toContain('>Subscription<');
    for (const auth of ['api_key', 'cloud'] as const) {
      const html = render(provider('claude-code', { auth: 'subscription' }), status(auth));
      expect(html).toContain('>API<');
      expect(html).not.toContain('>Subscription<');
    }
  });
  it.each([null, undefined, { installed: false, message: 'No CLI' }, { installed: true, version: '2', loggedIn: false, auth: 'subscription' }, status('unknown')] as (ClaudeCodeStatus | null | undefined)[])('does not guess a Claude Code billing mode from %j', (s) => {
    expect(render(provider('claude-code', { auth: 'subscription' }), s)).toBe('');
  });
  it('keeps ChatGPT subscription semantics, including older cards with no auth flag', () => {
    expect(render(provider('chatgpt', { auth: 'subscription' }))).toContain('>Subscription<');
    expect(render(provider('chatgpt'))).toContain('>Subscription<');
  });
  it.each(['anthropic', 'openai', 'openrouter', 'bedrock', 'vertex', 'foundry', 'openai-compat'] as ProviderKind[])('labels %s as API', kind => {
    expect(render(provider(kind))).toContain('>API<');
  });
  it('does not confuse an OpenRouter OAuth-minted API key with a subscription', () => {
    const html = render(provider('openrouter', { tokenKey: 'router', auth: 'subscription' }));
    expect(html).toContain('>API<');
    expect(html).not.toContain('>Subscription<');
  });
  it.each(['ollama', 'lmstudio', 'vllm', 'llamacpp'] as ProviderKind[])('does not label a %s server as API billing', kind => {
    expect(render(provider(kind))).toBe('');
  });
  it('hides billing chips on disabled and retired Claude-plan cards', () => {
    expect(render(provider('anthropic', { auth: 'subscription' }))).toBe('');
    for (const kind of ['openai', 'chatgpt', 'claude-code'] as ProviderKind[]) {
      expect(render(provider(kind, { enabled: false }), status('subscription'))).toBe('');
    }
  });
  it('keeps older enabled cards without an explicit flag visible', () => {
    expect(render({ ...provider('openai'), enabled: undefined } as unknown as ProviderConfig)).toContain('>API<');
  });
});
