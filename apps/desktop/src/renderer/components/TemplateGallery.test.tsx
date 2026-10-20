import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { WORKFLOW_TEMPLATES } from '@nekko-agent/shared';

const state = {
  settings: {
    connectors: [{ kind: 'github', connected: true }],
    workspaces: [{ id: 'ws1', path: '/work/app' }],
    defaultProviderId: 'p',
    defaultModelId: 'm',
    providers: [{ id: 'p', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', enabled: true }],
  },
};
vi.mock('../store.js', () => ({ useStore: Object.assign((pick: (s: typeof state) => unknown) => pick(state), { getState: () => state }) }));

const { TemplateCards, templateSeed } = await import('./TemplateGallery.js');

describe('template gallery', () => {
  it('shows every featured template with what it needs and what is ready', () => {
    const html = renderToStaticMarkup(<TemplateCards onPick={() => {}} />);
    for (const t of WORKFLOW_TEMPLATES.filter((x) => x.featured)) expect(html).toContain(`data-template="${t.id}"`);
    expect(html).not.toContain('data-template="blank"');
    expect(html).toContain('✓ GitHub connected');
    expect(html).not.toContain('data-template="ticket-digest"');
    // The default model is a cloud one, so the CI template still needs a local model.
    expect(html).toContain('data-template="diagnose-failed-ci"');
    expect(html).toContain('>A local model<');
  });

  it('seeds the CI template local-only, with no tools and the chosen model', () => {
    const t = WORKFLOW_TEMPLATES.find((x) => x.id === 'diagnose-failed-ci')!;
    const seed = templateSeed(t, { repo: 'o/r' }, { providerId: 'local', modelId: 'qwen' });
    expect(seed).toMatchObject({ localModelOnly: true, toolAccess: 'none', providerId: 'local', modelId: 'qwen', category: 'Code review' });
    expect(seed.triggers[0]).toMatchObject({ event: 'workflow_run_failed', repo: 'o/r', enabled: true });
  });

  it('seeds a workflow that remembers its template and notify setting', () => {
    const t = WORKFLOW_TEMPLATES.find((x) => x.id === 'nightly-dependency-check')!;
    const seed = templateSeed(t, { time: '04:15' }, { workspaceId: 'ws1' });
    expect(seed).toMatchObject({ name: t.name, templateId: t.id, notify: 'always', workspaceId: 'ws1' });
    expect(seed.triggers[0].cron).toBe('15 4 * * *');
    const blank = templateSeed(WORKFLOW_TEMPLATES.find((x) => x.id === 'blank')!);
    expect(blank).toMatchObject({ name: '', templateId: undefined });
  });
});
