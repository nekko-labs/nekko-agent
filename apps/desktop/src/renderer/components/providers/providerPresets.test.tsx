import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { cloudProviderAllowed, offlineProviderAllowed } from '@nekko-agent/shared';
import { providerSetupDefaults, vertexEndpoint } from './providerPresets.js';
import { ProviderChoices } from './ProviderChoices.js';
import { AddProvider } from './AddProvider.js';

describe('cloud provider setup presets', () => {
  it.each([
    ['gemini', 'Google Gemini', 'https://generativelanguage.googleapis.com/v1beta/openai'],
    ['ollama-cloud', 'Ollama Cloud', 'https://ollama.com/v1'],
  ] as const)('routes %s through the hosted compatible API', (choice, label, baseUrl) => {
    const defaults = providerSetupDefaults(choice);
    expect(defaults).toMatchObject({ kind: 'openai-compat', label, baseUrl, needsKey: true });
    expect(cloudProviderAllowed(defaults)).toBe(true);
    expect(offlineProviderAllowed(defaults)).toBe(false);
    const html = renderToStaticMarkup(<AddProvider fixedKind={choice} onDone={() => {}} />);
    expect(html).toContain(label);
    expect(html).toContain('type="password"');
    expect(html).not.toContain('Claude subscription');
    expect(html).not.toContain('localhost');
  });

  it('opens Vertex directly on Google credentials, never Claude sign-in', () => {
    const html = renderToStaticMarkup(<AddProvider fixedKind="vertex" onDone={() => {}} />);
    expect(html).toContain('Google Cloud project ID');
    expect(html).toContain('Google Cloud location');
    expect(html).toContain('gcloud auth application-default login');
    expect(html).not.toContain('PICK ONE');
    expect(html).not.toContain('Check again');
    expect(html).not.toContain('type="password"');
  });

  it('separates cloud choices from local servers', () => {
    const cloud = renderToStaticMarkup(<ProviderChoices scope="cloud" onPick={() => {}} />);
    expect(cloud).toContain('Google Gemini');
    expect(cloud).toContain('Claude on Vertex AI');
    expect(cloud).toContain('Ollama Cloud');
    expect(cloud).not.toContain('Connect Ollama on your computer');
    expect(cloud).not.toContain('LM Studio');
    const local = renderToStaticMarkup(<ProviderChoices scope="local" onPick={() => {}} />);
    expect(local).toContain('Connect Ollama on your computer');
    expect(local).not.toContain('Ollama Cloud');
    expect(providerSetupDefaults('ollama').baseUrl).toBe('http://localhost:11434');
  });

  it('uses the global or regional Vertex host without allowing path injection', () => {
    expect(vertexEndpoint('my-project', 'global')).toBe('https://aiplatform.googleapis.com/v1/projects/my-project/locations/global');
    expect(vertexEndpoint(' my-project ', 'us-east5')).toBe('https://us-east5-aiplatform.googleapis.com/v1/projects/my-project/locations/us-east5');
    expect(vertexEndpoint('a/b', '')).toContain('projects/a%2Fb/locations/global');
  });
});
