import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FEEDBACK_CONTRIBUTING_URL, FEEDBACK_ISSUES_URL } from '@nekko-agent/shared';
import { FeedbackBody, FeedbackSheet, OtherWays } from './FeedbackSheet.js';

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

  it('keeps the contributing line in view from the start, and the other ways back until a choice', () => {
    expect(html()).toContain(`href="${FEEDBACK_CONTRIBUTING_URL}"`);
    expect(html()).not.toContain('Other ways');
    expect(html()).not.toContain('data-testid="feedback-email"');
    expect(renderToStaticMarkup(<OtherWays kind={null} info={null} />)).toBe('');
  });

  it('offers the agent, GitHub and email routes under Other ways on Needs improvement', () => {
    const improve = renderToStaticMarkup(<OtherWays kind="improve" info={null} />);
    expect(improve).toContain('Let an agent help you write it');
    expect(improve).toContain('File the issue only after I approve');
    expect(improve).toContain('Create a GitHub issue yourself');
    expect(improve).toContain(`href="${FEEDBACK_ISSUES_URL}"`);
    expect(improve).toMatch(/<details[\s\S]*Email us at[\s\S]*feedback@nekkoagent\.com[\s\S]*<\/details>/);
  });

  it('offers only the email address on Good, in place of the other ways', () => {
    const good = renderToStaticMarkup(<OtherWays kind="good" info={null} />);
    expect(good).toContain('Email us at');
    expect(good).toContain('feedback@nekkoagent.com');
    expect(good).toContain('data-testid="feedback-email-copy"');
    expect(good).not.toContain('Other ways');
    expect(good).not.toContain('<details');
  });

  it('holds back the fields and Send until a choice is made', () => {
    expect(html()).not.toContain('data-testid="feedback-fields"');
    expect(html()).not.toContain('data-testid="feedback-send"');
    expect(html()).not.toContain('Include app info');
  });
});
