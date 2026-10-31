import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ view: 'models', setView: vi.fn() }));
vi.mock('../store.js', () => ({ useStore: (select: (s: typeof state) => unknown) => select(state) }));
vi.mock('../chrome.js', () => ({ hasAppChrome: true }));
vi.mock('./ModelsView.js', () => ({ ModelsView: ({ localOnly }: { localOnly?: boolean }) => <div data-providers={localOnly ? 'local' : 'cloud'} /> }));
vi.mock('../components/engine/FirstLocalModel.js', () => ({ FirstLocalModel: () => <div data-first-run /> }));
vi.mock('./ModelServerView.js', () => ({ ModelServerView: ({ embedded }: { embedded?: boolean }) => <div data-server={String(embedded)} /> }));
import { guideFirstModel, ModelsWorkspace } from './ModelsWorkspace.js';

describe('Models workspace', () => {
  it('shows the local and cloud sections together from either destination', () => {
    for (const view of ['models', 'modelserver']) {
      state.view = view;
      const html = renderToStaticMarkup(<ModelsWorkspace />);
      expect(html).toContain('aria-label="Models"');
      expect(html).toContain('id="models-local-title"');
      expect(html).toContain('id="models-cloud-title"');
      expect(html).toContain('data-providers="cloud"');
      expect(html.indexOf('models-local-title')).toBeLessThan(html.indexOf('models-cloud-title'));
      expect(html.match(/aria-current="location"/g)).toHaveLength(1);
    }
  });
  it('waits for the engine before choosing between the guided screen and the full page', () => {
    state.view = 'modelserver';
    const html = renderToStaticMarkup(<ModelsWorkspace />);
    expect(html).toContain('aria-label="Models"');
    expect(html).not.toContain('data-server');
    expect(html).not.toContain('data-first-run');
    expect(html).toContain('data-providers="cloud"');
    expect(html.match(/aria-current="location"/g)).toHaveLength(1);
  });
  it('guides only someone with no local model and no local server of their own', () => {
    const engine = { enabled: true, kind: 'llamacpp' } as const;
    expect(guideFirstModel([engine], [])).toBe(true);
    expect(guideFirstModel([engine, { enabled: true, kind: 'anthropic' }], [])).toBe(true);
    expect(guideFirstModel([engine], [{ id: 'borrowed from Ollama' }])).toBe(false);
    expect(guideFirstModel([{ enabled: true, kind: 'ollama' }], [])).toBe(false);
    expect(guideFirstModel([{ enabled: false, kind: 'lmstudio' }], [])).toBe(true);
  });
});
