import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
vi.mock('../store.js', () => ({ useStore: (select: (state: unknown) => unknown) => select({ providers: [{ id: 'local', label: 'Ollama (local)' }], sessions: [{ id: 'child', title: 'Local review' }] }) }));
import { SubagentRoute } from './SubagentRoute.js';
import { SubagentBanner } from './SubagentBanner.js';
import { subagentModel } from './agent-console/SubagentCue.js';
import type { SessionSummary, ToolCall } from '@nekko-agent/shared';

it('shows the provider label and short model, preserving exact identity in the tooltip', () => {
  const html = renderToStaticMarkup(<SubagentRoute child={{ providerId: 'local', modelId: 'org/qwen3:latest' }} />);
  expect(html).toContain('Ollama (local) · org/qwen3:latest');
  expect(html).toContain('Ollama (local) · qwen3');
});
it('falls back to the provider ID without inventing a model or provider', () => {
  expect(renderToStaticMarkup(<SubagentRoute child={{ providerId: 'removed', modelId: 'qwen3:8b' }} />)).toContain('removed · qwen3:8b');
  expect(renderToStaticMarkup(<SubagentRoute child={{ providerId: '', modelId: '' }} />)).toBe('');
});
it('shows a nested child route alongside its immediate source link', () => {
  const html = renderToStaticMarkup(<SubagentBanner parentId="child" child={{ providerId: 'local', modelId: 'qwen3:8b' }} onOpenParent={() => {}} />);
  expect(html).toContain('title="Open Local review"');
  expect(html).toContain('Ollama (local) · qwen3:8b');
  expect(html).not.toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*<button/);
});
it('prefers persisted child provider and model to requested routing', () => {
  const call: ToolCall = { id: 'call', name: 'spawn_agent', input: { title: 'Review', provider_id: 'cloud', model_id: 'cloud-model' } };
  const child = { title: 'Review', providerId: 'local', modelId: 'qwen3:8b' } as SessionSummary;
  expect(subagentModel(call, child, [child])).toEqual({ id: 'qwen3:8b', source: 'child', providerId: 'local' });
  expect(subagentModel(call, undefined, [child])).toEqual({ id: 'qwen3:8b', source: 'child', providerId: 'local' });
  expect(subagentModel(call, undefined, [])).toEqual({ id: 'cloud-model', source: 'requested', providerId: 'cloud' });
});
