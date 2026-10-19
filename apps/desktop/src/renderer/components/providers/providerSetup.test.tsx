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
  it('offers nine accessible provider cards with bundled brand marks', () => {
    const html = renderToStaticMarkup(<ProviderChoices value="chatgpt" onPick={() => {}} />);
    expect((html.match(/<button /g) ?? []).length).toBe(9);
    expect((html.match(/aria-pressed="true"/g) ?? []).length).toBe(1);
    expect(html).toContain('./providers/openai.svg');
    expect(html).toContain('billed separately');
    // Claude on a key or cloud, and Claude Agent on the user's own Claude Code.
    expect(html).toContain('Claude Agent');
    expect(html).toContain('sign in there');
    expect(html).not.toContain('Sign in with your Claude plan');
  });
});
