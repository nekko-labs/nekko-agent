import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SupportStarStatus } from '@nekko-agent/shared';
import { GitHubStarSupport } from './GitHubStarSupport.js';

// Server rendering reads a zustand store's initial state, so the status comes from here.
let status: SupportStarStatus | null = null;
vi.mock('../supportStar.js', () => ({
  refreshSupportStar: () => Promise.resolve(),
  useSupportStar: () => ({ status, busy: false, celebrating: false }),
}));

describe('GitHub star support', () => {
  it('asks for a star until GitHub shows one', () => {
    status = { state: 'not-starred', login: 'nekko-tester' };
    expect(renderToStaticMarkup(<GitHubStarSupport feedback />)).toContain('Give us a GitHub star!');
    expect(renderToStaticMarkup(<GitHubStarSupport />)).toContain('Support by starring the project on GitHub');
  });

  it('thanks a stargazer in Feedback and Settings, with no star button', () => {
    status = { state: 'starred', login: 'nekko-tester' };
    for (const html of [renderToStaticMarkup(<GitHubStarSupport feedback />), renderToStaticMarkup(<GitHubStarSupport />)]) {
      expect(html).toContain('Thanks for the Star!');
      expect(html).not.toContain('Give us a GitHub star!');
      expect(html).not.toContain('data-testid="support-star-action"');
      expect(html).not.toContain('Starred');
    }
  });
});
