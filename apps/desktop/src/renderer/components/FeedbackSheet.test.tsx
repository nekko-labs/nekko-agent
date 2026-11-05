import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FEEDBACK_CONTRIBUTING_URL, FEEDBACK_ISSUES_URL } from '@nekko-agent/shared';
import { FeedbackBody, FeedbackSheet } from './FeedbackSheet.js';

// The real Modal portals into document.body, which server rendering has none of.
vi.mock('./primitives/index.js', async (original) => ({
  ...await original<typeof import('./primitives/index.js')>(),
  Modal: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div>,
}));

describe('Send feedback sheet', () => {
  const html = () => renderToStaticMarkup(<FeedbackBody onClose={() => {}} />);

  it('stays closed until something opens it', () => {
    expect(renderToStaticMarkup(<FeedbackSheet />)).toBe('');
  });

  it('opens on the choice, with nothing chosen for the person', () => {
    expect(html()).toContain('Needs improvement');
    expect(html()).toContain('data-testid="feedback-kind-good"');
    expect(html()).not.toMatch(/<input[^>]*checked/);
  });

  it('keeps the other ways in and the contributing line in view from the start', () => {
    expect(html()).toContain('Let an agent help you write it');
    expect(html()).toContain('File the issue only after I approve');
    expect(html()).toContain('Create a GitHub issue yourself');
    expect(html()).toContain(`href="${FEEDBACK_ISSUES_URL}"`);
    expect(html()).toContain(`href="${FEEDBACK_CONTRIBUTING_URL}"`);
  });

  it('holds back the fields and Send until a choice is made', () => {
    expect(html()).not.toContain('data-testid="feedback-fields"');
    expect(html()).not.toContain('data-testid="feedback-send"');
    expect(html()).not.toContain('Include app info');
  });
});
