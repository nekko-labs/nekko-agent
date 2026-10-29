import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FEEDBACK_ISSUES_URL } from '@nekko-agent/shared';
import { FeedbackBody, FeedbackSheet } from './FeedbackSheet.js';

// The real Modal portals into document.body, which server rendering has none of.
vi.mock('./primitives/index.js', async (original) => ({
  ...await original<typeof import('./primitives/index.js')>(),
  Modal: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div>,
}));

describe('Send feedback sheet', () => {
  it('stays closed until something opens it', () => {
    expect(renderToStaticMarkup(<FeedbackSheet />)).toBe('');
  });

  it('offers all three routes', () => {
    const html = renderToStaticMarkup(<FeedbackBody onClose={() => {}} />);
    expect(html).toContain('Copy for an agent');
    expect(html).toContain('File the issue only after I approve');
    expect(html).toContain('Quick note');
    expect(html).toContain('data-testid="feedback-text"');
    expect(html).toContain(`href="${FEEDBACK_ISSUES_URL}"`);
  });

  it('starts with app info off, says what it would share, and Send off for an empty note', () => {
    const html = renderToStaticMarkup(<FeedbackBody onClose={() => {}} />);
    expect(html).toMatch(/role="switch" aria-checked="false" aria-label="Include app info"/);
    expect(html).toContain('App, version, OS and version, and CPU type. Nothing that identifies you.');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="feedback-send"/);
  });
});
