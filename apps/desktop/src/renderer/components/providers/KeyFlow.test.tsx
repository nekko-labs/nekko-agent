import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { KEY_SOURCES, looksLikeKey } from './providerPresets.js';
import { KeyFlow, keyFlowSteps } from './KeyFlow.js';
import { AddProvider } from './AddProvider.js';

describe('key shapes', () => {
  const gemini = 'AIza' + 'S'.repeat(35);
  it.each([
    ['gemini', gemini, true],
    ['gemini', gemini + 'x', false],
    ['gemini', 'sk-proj-abcdefghijklmnopqrstuvwxyz', false],
    ['openai', 'sk-proj-abcdefghijklmnopqrstuvwxyz', true],
    ['openai', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz', false],
    ['openai', 'sk-or-v1-abcdefghijklmnopqrstuvwxyz', false],
    ['anthropic', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz', true],
    ['openrouter', 'sk-or-v1-abcdefghijklmnopqrstuvwxyz', true],
    ['anthropic', '  sk-ant-api03-abcdefghijklmnopqrstuvwxyz\n', true],
  ] as const)('%s takes %s: %s', (kind, text, ok) => {
    expect(looksLikeKey(KEY_SOURCES[kind], text)).toBe(ok);
  });
  it('never picks up a key for a service without a known shape', () => {
    expect(looksLikeKey(KEY_SOURCES['ollama-cloud'], 'anything-at-all-1234567890')).toBe(false);
  });
});

describe('key flow steps', () => {
  it('starts on getting a key, with the field already usable', () => {
    expect(keyFlowSteps({ opened: false, hasKey: false, check: { state: 'idle' } })).toEqual(['active', 'active', 'waiting']);
  });
  it('moves on once the key page was opened or a key is in', () => {
    expect(keyFlowSteps({ opened: true, hasKey: false, check: { state: 'idle' } })[0]).toBe('done');
    expect(keyFlowSteps({ opened: false, hasKey: true, check: { state: 'idle' } })).toEqual(['done', 'active', 'active']);
  });
  it('keeps Connect current while checking and after a failure', () => {
    expect(keyFlowSteps({ opened: true, hasKey: true, check: { state: 'checking' } })).toEqual(['done', 'done', 'active']);
    expect(keyFlowSteps({ opened: true, hasKey: true, check: { state: 'failed', message: 'x' } })[2]).toBe('active');
  });
  it('is all done once connected', () => {
    expect(keyFlowSteps({ opened: false, hasKey: true, check: { state: 'connected' } })).toEqual(['done', 'done', 'done']);
  });
  it('shows a failure in words, as an alert', () => {
    const html = renderToStaticMarkup(<KeyFlow name="Google Gemini" source={KEY_SOURCES.gemini!} value="AIza-bad" onChange={() => {}} onConnect={() => {}} check={{ state: 'failed', message: 'API key not valid.' }} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('API key not valid.');
    expect(html).toContain('Try again');
  });
});

describe('guided provider setup', () => {
  it('connects Google Gemini through AI Studio, with no manual test or save', () => {
    const html = renderToStaticMarkup(<AddProvider fixedKind="gemini" onDone={() => {}} />);
    expect(html).toContain('Open Google AI Studio');
    expect(html).toContain('Bring the key back');
    expect(html).toContain('aria-label="Google Gemini API key"');
    expect(html).not.toContain('Test connection');
    expect(html).not.toContain('Connect provider');
    expect(html).not.toContain('class="card');
  });
  it.each([['openai', 'Open OpenAI'], ['ollama-cloud', 'Open Ollama']] as const)('guides %s the same way', (kind, open) => {
    expect(renderToStaticMarkup(<AddProvider fixedKind={kind} onDone={() => {}} />)).toContain(open);
  });
  it('keeps OpenRouter on its one-click sign-in, with a key behind a choice', () => {
    const html = renderToStaticMarkup(<AddProvider fixedKind="openrouter" onDone={() => {}} />);
    expect(html).toContain('Sign in with OpenRouter');
    expect(html.match(/Sign in with OpenRouter/g)).toHaveLength(1);
    expect(html).toContain('Use a key you already have');
    expect(html).not.toContain('Open OpenRouter');
  });
  it('lets a framed caller (onboarding) keep its own title', () => {
    const html = renderToStaticMarkup(<AddProvider fixedKind="anthropic" apiKeyOnly bare onDone={() => {}} />);
    expect(html).not.toContain('provider-setup-heading');
    expect(html).toContain('Open Claude Console');
  });
});
