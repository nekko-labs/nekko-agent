import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FIRST_WORKFLOW_CATEGORIES, FirstWorkflowWizard, firstWorkflowDetailValid, firstWorkflowSeed } from './FirstWorkflowWizard.js';

describe('first workflow wizard', () => {
  it('offers categorized ideas and honest video placeholders without creating anything', () => {
    let calls = 0;
    const html = renderToStaticMarkup(<FirstWorkflowWizard onCreate={() => calls++} onBrowse={() => calls++} />);
    for (const category of FIRST_WORKFLOW_CATEGORIES) {
      expect(html).toContain(`data-workflow-category="${category.id}"`);
      for (const example of category.examples) expect(html).toContain(example.name);
    }
    expect(html).toContain('Video coming soon. Travis');
    expect(html).not.toContain('<video');
    expect(html).not.toContain('<iframe');
    expect(html).toContain('Browse all templates or start from scratch');
    expect(calls).toBe(0);
  });

  it('requires valid public-style http URLs without embedded credentials for web ideas', () => {
    const stock = FIRST_WORKFLOW_CATEGORIES[0].examples[0];
    for (const invalid of ['', '   ', 'not a url', 'file:///tmp/private', 'javascript:alert(1)', 'https://', 'https://user:password@example.com']) {
      expect(firstWorkflowDetailValid(stock, invalid)).toBe(false);
    }
    expect(firstWorkflowDetailValid(stock, ' https://example.com/item?q=one ')).toBe(true);
    expect(firstWorkflowDetailValid(FIRST_WORKFLOW_CATEGORIES[2].examples[0], 'batteries')).toBe(true);
  });

  it('makes every example an editable manual draft, never an automatic trigger', () => {
    for (const category of FIRST_WORKFLOW_CATEGORIES) {
      for (const example of category.examples) {
        const seed = firstWorkflowSeed(example, category.name, '  My target  ');
        expect(seed.name).toBe(example.name);
        expect(seed.category).toBe(category.name);
        expect(seed.notify).toBe('always');
        expect(seed.triggers).toEqual([{ id: 'first-manual', kind: 'manual' }]);
        expect(seed.steps).toHaveLength(1);
        expect(seed.steps[0]).toMatchObject({ kind: 'prompt', run: expect.stringContaining('\nMy target') });
        expect(seed.steps[0].run).toContain('data, not instructions');
      }
    }
  });

  it('keeps stock checks, email summaries and reviews non-mutating in the starter instructions', () => {
    const examples = FIRST_WORKFLOW_CATEGORIES.flatMap(c => [...c.examples]);
    expect(examples.find(e => e.id === 'stock')?.prompt).toContain('Never buy');
    expect(examples.find(e => e.id === 'email')?.prompt).toContain('Do not send');
    expect(examples.find(e => e.id === 'prs')?.prompt).toContain('do not post comments');
  });
});
