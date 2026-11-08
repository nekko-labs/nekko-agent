import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ view: 'models' }));
vi.mock('../store.js', () => ({ useStore: (select: (s: typeof state) => unknown) => select(state) }));
vi.mock('../chrome.js', () => ({ hasAppChrome: true }));
vi.mock('./ModelsView.js', () => ({ ModelsView: ({ localOnly }: { localOnly?: boolean }) => <div data-providers={localOnly ? 'local' : 'cloud'} /> }));
vi.mock('../components/engine/FirstLocalModel.js', () => ({ FirstLocalModel: () => <div data-first-run /> }));
vi.mock('./ModelServerView.js', () => ({ ModelServerView: ({ embedded }: { embedded?: boolean }) => <div data-server={String(embedded)} /> }));
import { activeModelsSection, guideFirstModel, MODELS_SECTIONS, ModelsWorkspace } from './ModelsWorkspace.js';

describe('Models workspace', () => {
  it('stacks Cloud above Local on one page from either destination, with a side menu for both', () => {
    for (const view of ['models', 'modelserver']) {
      state.view = view;
      const html = renderToStaticMarkup(<ModelsWorkspace />);
      expect(html).toContain('aria-label="Models sections"');
      expect(html).toContain('id="models-local-title"');
      expect(html).toContain('id="models-cloud-title"');
      expect(html).toContain('data-providers="cloud"');
      // Cloud first, Local after, in the menu and on the page.
      expect(html.indexOf('>Cloud providers</button>')).toBeLessThan(html.indexOf('>Local model server</button>'));
      expect(html.indexOf('models-cloud-title')).toBeLessThan(html.indexOf('models-local-title'));
    }
  });
  it('waits for the engine before choosing between the guided screen and the full page', () => {
    state.view = 'modelserver';
    const html = renderToStaticMarkup(<ModelsWorkspace />);
    expect(html).not.toContain('data-server');
    expect(html).not.toContain('data-first-run');
    expect(html).toContain('data-providers="cloud"');
    // Local's own sections are not listed until the full local page is shown.
    expect(html).not.toContain('>Agent server</button>');
  });
  it('lists the local sections in page order under Local model server', () => {
    const ids = MODELS_SECTIONS.map((s) => s.id);
    expect(ids).toEqual(['cloud', 'local', 'model-server', 'agent-server', 'library', 'connections']);
    expect(MODELS_SECTIONS.filter((s) => 'parent' in s).every((s) => s.parent === 'local')).toBe(true);
  });
  it('spies the section at the top of the page, and the last one at the end', () => {
    const scroller = { scrollTop: 0, clientHeight: 300, scrollHeight: 2000, getBoundingClientRect: () => ({ top: 0 }), querySelectorAll: () => sections };
    const sections = ([['cloud', 0], ['local', 500], ['model-server', 560]] as const).map(([id, top]) => (
      { dataset: { modelsSection: id }, getBoundingClientRect: () => ({ top: top - scroller.scrollTop }) }
    ));
    const spy = () => activeModelsSection(scroller as unknown as HTMLElement);
    expect(spy()).toBe('cloud');
    scroller.scrollTop = 510;
    expect(spy()).toBe('local');
    scroller.scrollTop = 1700;
    expect(spy()).toBe('model-server');
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
