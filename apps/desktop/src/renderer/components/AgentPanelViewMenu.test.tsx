import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AgentCardPreview, CARD_DETAIL_OPTIONS } from './AgentPanelViewMenu.js';
import { DEFAULT_AGENT_PANEL_VIEW } from '../views/agentPanelView.js';

describe('interactive agent card preview', () => {
  it('offers each independent detail as an accessible toggle', () => {
    const html = renderToStaticMarkup(<AgentCardPreview view={DEFAULT_AGENT_PANEL_VIEW} onChange={() => {}} />);
    expect(html.match(/role="menuitemcheckbox"/g)).toHaveLength(7);
    for (const [, label] of CARD_DETAIL_OPTIONS) expect(html).toContain(`aria-label="${label}"`);
    expect(html).toContain('Sample card');
  });
  it('lays the details out as a real card does: title line, model line, branch, then spawn line with the PR', () => {
    const html = renderToStaticMarkup(<AgentCardPreview view={DEFAULT_AGENT_PANEL_VIEW} onChange={() => {}} />);
    const order = ['Polish the app layout', 'data-detail="showUpdated"', 'data-detail="showModel"', 'data-detail="showContext"',
      'data-detail="showGit"', 'data-detail="showSubagents"', 'data-detail="showWindows"', 'data-detail="showPullRequests"'];
    const at = order.map((s) => html.indexOf(s));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(html.match(/agent-card-preview__line/g)).toHaveLength(4);
  });
  it('keeps hidden details discoverable without showing sample values', () => {
    const view = { ...DEFAULT_AGENT_PANEL_VIEW, showModel: false, showContext: false };
    const html = renderToStaticMarkup(<AgentCardPreview view={view} onChange={() => {}} />);
    expect(html).toContain('aria-label="Model" aria-checked="false"');
    expect(html).toContain('aria-label="Context window" aria-checked="false"');
    expect(html).not.toContain('24k / 128k context');
  });
  it('reflects the metadata master choice but keeps reply time and PRs independent', () => {
    const html = renderToStaticMarkup(<AgentCardPreview view={{ ...DEFAULT_AGENT_PANEL_VIEW, showMetadata: false, showUpdated: true }} onChange={() => {}} />);
    expect(html).toContain('aria-label="Model" aria-checked="false"');
    expect(html).toContain('aria-label="Last reply time" aria-checked="true"');
    expect(html).toContain('aria-label="Pull requests" aria-checked="true"');
  });
});
