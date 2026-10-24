import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ProviderConfig } from '@nekko-agent/shared';
import { needsProviderSetup } from './providerSetup.js';
import { ProviderChoices } from './ProviderChoices.js';
const engine: ProviderConfig = { id: 'nekko-engine', kind: 'llamacpp', label: 'Engine', enabled: true, baseUrl: 'http://localhost:8080' };
describe('first provider setup', () => {
  it('does not mistake the empty built-in engine for completed setup', () => {
    expect(needsProviderSetup([])).toBe(true);
    expect(needsProviderSetup([engine])).toBe(true);
    expect(needsProviderSetup([engine], 'loaded-model')).toBe(false);
    expect(needsProviderSetup([{ ...engine, kind: 'chatgpt' }])).toBe(false);
    expect(needsProviderSetup([{ ...engine, kind: 'chatgpt', enabled: false }])).toBe(true);
  });
  it('offers eight accessible provider cards with bundled brand marks', () => {
    const html = renderToStaticMarkup(<ProviderChoices value="chatgpt" onPick={() => {}} />);
    expect((html.match(/<button /g) ?? []).length).toBe(8);
    expect((html.match(/aria-pressed="true"/g) ?? []).length).toBe(1);
    expect(html).toContain('./providers/openai.svg');
    expect(html).toContain('billed separately');
    // One Claude card: its setup offers the subscription (Claude Code) or an API account.
    expect(html).toContain('<strong>Claude</strong>');
    expect(html).toContain('Your subscription or an API account');
    expect(html).not.toContain('Claude Agent');
    expect(html).not.toContain('Sign in with your Claude plan');
  });
});
