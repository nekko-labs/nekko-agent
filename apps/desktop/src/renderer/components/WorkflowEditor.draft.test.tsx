import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Workflow } from '@nekko-agent/shared';

vi.mock('../store.js', () => {
  const state = {
    settings: {
      providers: [
        { id: 'cloud', kind: 'anthropic', label: 'Anthropic', enabled: true, baseUrl: 'https://api.anthropic.com' },
        { id: 'engine', kind: 'llamacpp', label: 'Nekko engine', enabled: true, baseUrl: 'http://127.0.0.1:8080/v1' },
      ],
      defaultProviderId: 'cloud', defaultModelId: 'claude', workspaces: [], connectors: [],
    },
    setView: () => {}, refreshSettings: () => {},
  };
  const useStore = (sel: (s: typeof state) => unknown) => sel(state);
  useStore.getState = () => state;
  return { useStore };
});

vi.mock('./primitives/index.js', () => ({ Modal: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

const { WorkflowEditor, draftPatch, parseAllowedTools, toDraft } = await import('./WorkflowEditor.js');

const wf: Workflow = {
  id: 'w', name: 'Diagnose', category: 'Build & test', enabled: true, createdAt: 1, updatedAt: 1, triggers: [],
  providerId: 'engine', modelId: 'qwen', localModelOnly: true, toolAccess: 'allowlist',
  steps: [
    { id: 'a', name: 'A', kind: 'prompt', run: 'x', providerId: 'cloud', modelId: 'claude', allowedTools: ['Read', 'Bash(gh:*)'] },
    { id: 'b', name: 'B', kind: 'shell', run: 'ls', providerId: 'cloud', modelId: 'claude', allowedTools: ['Read'] },
  ],
};

describe('workflow editor draft', () => {
  it('saves and reloads model, override, local-only and tool access', () => {
    const patch = draftPatch(toDraft(wf));
    expect(patch).toMatchObject({ providerId: 'engine', modelId: 'qwen', localModelOnly: true, toolAccess: 'allowlist' });
    expect(patch.steps![0]).toMatchObject({ providerId: 'cloud', modelId: 'claude', allowedTools: ['Read', 'Bash(gh:*)'] });
    // A shell step carries no model or allowlist.
    expect(patch.steps![1]).toEqual({ id: 'b', name: 'B', kind: 'shell', run: 'ls' });
    const reloaded = toDraft({ ...wf, ...patch } as Workflow);
    expect(draftPatch(reloaded)).toEqual(patch);
  });

  it('clears settings with explicit undefined so an update drops them', () => {
    const d = toDraft(wf);
    const patch = draftPatch({ ...d, providerId: undefined, modelId: undefined, localModelOnly: false, toolAccess: 'workspace' });
    for (const k of ['providerId', 'modelId', 'localModelOnly', 'toolAccess'] as const) {
      expect(k in patch).toBe(true);
      expect(patch[k]).toBeUndefined();
    }
    // Allowed tools only mean something under allowlist access.
    expect(patch.steps![0].allowedTools).toBeUndefined();
    expect(patch.steps![0]).toMatchObject({ providerId: 'cloud', modelId: 'claude' });
  });

  it('defaults an existing workflow to full workspace access and the default model', () => {
    const d = toDraft({ ...wf, providerId: undefined, modelId: undefined, localModelOnly: undefined, toolAccess: undefined });
    expect(d).toMatchObject({ toolAccess: 'workspace', localModelOnly: false, providerId: undefined });
  });

  it('parses an allowed-tools field without splitting inside parentheses', () => {
    expect(parseAllowedTools('Read, Grep\nBash(gh pr view:*), Bash(git log, x)')).toEqual(['Read', 'Grep', 'Bash(gh pr view:*)', 'Bash(git log, x)']);
    expect(parseAllowedTools('  ')).toEqual([]);
  });

  it('renders the run settings with the auto-deny note and a local-only warning', () => {
    vi.stubGlobal('window', { nekko: { listModels: async () => [] } });
    const html = renderToStaticMarkup(<WorkflowEditor workflow={wf} workflows={[wf]} skills={[]} onClose={() => {}} onSave={() => {}} />);
    expect(html).toContain('data-wf-run-settings');
    expect(html).toContain('Approvals are denied automatically');
    expect(html).toContain('Local models only');
    expect(html).toContain('is not local; this step will be refused.');
    expect(html).toContain('data-step-allowed-tools');
    expect(html).toContain('Use workflow model');
    vi.unstubAllGlobals();
  });
});
