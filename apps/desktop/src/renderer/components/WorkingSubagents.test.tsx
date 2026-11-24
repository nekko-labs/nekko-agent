import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { SessionSummary } from '@nekko-agent/shared';
import { WallSubagentsContext, WallSubagentsSlot, WorkingSubagents } from './WorkingSubagents.js';

it('appears at bottom right only for running children with accessible expand control', () => {
  const child = { id: 'child', title: 'Tests' } as SessionSummary;
  const props = { children: [child], pending: {}, onOpen: () => {} };
  expect(renderToStaticMarkup(<WorkingSubagents {...props} running={new Set()} />)).toBe('');
  const html = renderToStaticMarkup(<WorkingSubagents {...props} running={new Set(['child'])} />);
  expect(html).toContain('bottom-3 right-3');
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('var(--success)');
  expect(html).not.toContain('Tests');
});

it('sits in the composer bar, not the window corner, when the wall hands it to the slot', () => {
  const child = { id: 'child', title: 'Tests' } as SessionSummary;
  const props = { children: [child], pending: {}, onOpen: () => {}, running: new Set(['child']) };
  expect(renderToStaticMarkup(<WallSubagentsSlot />)).toBe('');
  const html = renderToStaticMarkup(<WallSubagentsContext.Provider value={props}><WallSubagentsSlot /></WallSubagentsContext.Provider>);
  expect(html).toContain('data-working-subagents');
  expect(html).not.toContain('bottom-3 right-3');
  expect(html).toContain('h-7');
});
