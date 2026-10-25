import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ view: 'models', setView: vi.fn() }));
vi.mock('../store.js', () => ({ useStore: (select: (s: typeof state) => unknown) => select(state) }));
vi.mock('../chrome.js', () => ({ hasAppChrome: true }));
vi.mock('./ModelsView.js', () => ({ ModelsView: ({ localOnly }: { localOnly?: boolean }) => <div data-providers={localOnly ? 'local' : 'cloud'} /> }));
vi.mock('./ModelServerView.js', () => ({ ModelServerView: ({ embedded }: { embedded?: boolean }) => <div data-server={String(embedded)} /> }));
import { ModelsWorkspace } from './ModelsWorkspace.js';

describe('Models workspace', () => {
  it('opens the cloud section for the existing models destination', () => {
    state.view = 'models';
    const html = renderToStaticMarkup(<ModelsWorkspace />);
    expect(html).toContain('aria-label="Models"');
    expect(html).toContain('aria-current="page">');
    expect(html).toContain('data-providers="cloud"');
    expect(html).not.toContain('data-server');
  });
  it('keeps the server destination and local connections together', () => {
    state.view = 'modelserver';
    const html = renderToStaticMarkup(<ModelsWorkspace />);
    expect(html).toContain('data-server="true"');
    expect(html).toContain('data-providers="local"');
    expect(html).not.toContain('data-providers="cloud"');
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  });
});
