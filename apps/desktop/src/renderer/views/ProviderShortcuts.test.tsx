import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProviderShortcuts } from './ModelsView.js';

describe('provider chooser shortcut', () => {
  it('exposes its collapsed and expanded states for both provider sections', () => {
    for (const localOnly of [false, true]) {
      for (const moreExpanded of [false, true]) {
        const html = renderToStaticMarkup(<ProviderShortcuts localOnly={localOnly} moreExpanded={moreExpanded} onAdd={() => {}} />);
        expect(html).toContain(`aria-label="More providers" aria-expanded="${moreExpanded}"`);
        expect(html).toContain(localOnly ? 'Add Ollama' : 'Add ChatGPT');
      }
    }
  });
});
