import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProviderShortcuts, LimitsPanel } from './ModelsView.js';
import { ProviderMark, providerColor, providerMarkKind } from '../components/providers/ProviderMark.js';

describe('compact providers', () => {
  it('offers five cloud shortcuts and More, without duplicate provider chips', () => {
    const html = renderToStaticMarkup(<ProviderShortcuts onAdd={() => {}} />);
    expect(html.match(/aria-label="Add /g)).toHaveLength(6); // group plus five buttons
    expect(html).toContain('aria-label="More providers"');
    expect(html).not.toContain('models-connected');
    expect(html).not.toContain('provider-choices');
  });
  it('names each provider and marks the one whose setup is open', () => {
    const html = renderToStaticMarkup(<ProviderShortcuts onAdd={() => {}} open="gemini" />);
    expect(html).toContain('>Google Gemini</span>');
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-label="Add Google Gemini" aria-pressed="true"/);
  });
  it('shows the More providers when a setup opens on one of them', () => {
    const html = renderToStaticMarkup(<ProviderShortcuts onAdd={() => {}} open="vertex" />);
    expect(html).toContain('Add Claude on Vertex AI');
    expect(html).not.toContain('More providers');
  });
  it('shows all three local runtimes without a redundant overflow', () => {
    const html = renderToStaticMarkup(<ProviderShortcuts localOnly onAdd={() => {}} />);
    for (const name of ['Ollama', 'LM Studio', 'vLLM']) expect(html).toContain(`Add ${name}`);
    expect(html).not.toContain('More providers');
  });
  it('uses the same brand colors and icons for shortcuts, cards, and compatible vendors', () => {
    expect(providerColor('claude-code')).toBe(providerColor('anthropic'));
    expect(providerMarkKind({ kind: 'openai-compat', baseUrl: 'https://ollama.com/v1' })).toBe('ollama-cloud');
    expect(providerMarkKind({ kind: 'openai-compat', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' })).toBe('gemini');
    expect(providerMarkKind({ kind: 'openai-compat', baseUrl: 'https://ollama.com.example.test' })).toBe('openai-compat');
    const html = renderToStaticMarkup(<ProviderMark kind="chatgpt" tile />);
    expect(html).toContain(providerColor('chatgpt'));
    expect(html).toContain('providers/openai.svg');
  });
  it('labels reported resets, keeps unknown resets honest, and never invents unlimited credits', () => {
    const limits = { provider: 'chatgpt', planType: 'pro', windows: [{ id: 'weekly', label: '7-day', usedPercent: 41, status: 'allowed', resetAt: 3601000 }] } as any;
    const html = renderToStaticMarkup(<LimitsPanel limits={limits} now={1000} subName="ChatGPT" />);
    expect(html).toContain('Resets in 1h');
    expect(html).not.toContain('Live reads');
    expect(html).not.toContain('Unlimited');
    limits.windows[0].resetAt = 0;
    expect(renderToStaticMarkup(<LimitsPanel limits={limits} now={1000} subName="ChatGPT" />)).toContain('Reset unavailable');
    limits.windows[0].resetAt = 500;
    expect(renderToStaticMarkup(<LimitsPanel limits={limits} now={1000} subName="ChatGPT" />)).toContain('Resets soon');
  });
});
