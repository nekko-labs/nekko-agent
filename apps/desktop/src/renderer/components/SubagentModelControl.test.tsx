import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppSettings } from '@nekko-agent/shared';
import { DEFAULT_ORCHESTRATION, subagentModelChoice } from '@nekko-agent/shared';
import { SubagentModelControl, subagentModelLabel, subagentModelPatch } from './SubagentModelControl.js';

const settings = (orchestration?: AppSettings['orchestration']) => ({
  providers: [
    { id: 'a', kind: 'anthropic', label: 'Anthropic', enabled: true, baseUrl: 'https://api.anthropic.com' },
    { id: 'l', kind: 'llamacpp', label: 'Model Server', enabled: true, baseUrl: 'http://127.0.0.1:8080' },
  ],
  orchestration,
}) as unknown as AppSettings;

describe('subagent model preference', () => {
  it('defaults to Auto, and the parallel cap to two', () => {
    expect(subagentModelChoice(undefined)).toBe('auto');
    expect(subagentModelChoice({ ...DEFAULT_ORCHESTRATION, subagentModel: 'bogus' as never })).toBe('auto');
    expect(DEFAULT_ORCHESTRATION.maxParallel).toBe(2);
    expect(subagentModelLabel(undefined, {})).toBe('Auto');
  });

  it('a model pick saves a route; an auto pick clears it', () => {
    const route = subagentModelPatch(undefined, { providerId: 'l', modelId: 'qwen' });
    expect(route.delegationRoute).toEqual({ providerId: 'l', modelId: 'qwen' });
    expect(subagentModelLabel(route, { l: [{ id: 'qwen', providerId: 'l', name: 'Qwen 3' }] })).toBe('Qwen 3');
    const local = subagentModelPatch(route, 'auto-local');
    expect(local.delegationRoute).toBeUndefined();
    expect(local.subagentModel).toBe('auto-local');
    expect(subagentModelLabel(local, {})).toBe('Auto · prefer local');
  });

  it('lists the auto choices with Auto as the default, and hides on Solo', () => {
    const open = renderToStaticMarkup(<SubagentModelControl settingsOverride={settings()} update={async () => {}} defaultOpen />);
    for (const id of ['auto', 'auto-same-provider', 'auto-local', 'inherit']) expect(open).toContain(`data-subagent-choice="${id}"`);
    expect(open).toMatch(/data-subagent-choice="auto"[^>]*aria-selected="true"|aria-selected="true"[^>]*data-subagent-choice="auto"/);
    expect(open).toContain('Search subagent models');
    const solo = renderToStaticMarkup(<SubagentModelControl settingsOverride={settings({ ...DEFAULT_ORCHESTRATION, strategy: 'solo' })} update={async () => {}} defaultOpen />);
    expect(solo).toBe('');
  });
});
