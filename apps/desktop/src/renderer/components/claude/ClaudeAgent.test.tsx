import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CLAUDE_PLAN_SHEET } from '@nekko-agent/shared';
import { useStore } from '../../store.js';
import { ClaudeAgentSetup, ClaudeComparison, ClaudePlanSheet, ClaudeReasonLine, claudeAuthLabel } from './ClaudeAgent.js';

describe('Claude Agent', () => {
  it('renders the comparison from the policy table, not hand-written cells', () => {
    const html = renderToStaticMarkup(<ClaudeComparison />);
    expect(html).toContain('Claude (API or cloud)');
    expect(html).toContain('Claude Agent with a Claude plan');
    expect(html).toContain('Scheduled tasks and watches');
    expect(html).toContain('Not yet');
    expect(html).toContain('Your Claude plan');
    // Header row plus six capabilities plus "Billed to".
    expect((html.match(/<tr>/g) ?? []).length).toBe(8);
  });

  it('starts the setup panel by looking for Claude Code and never offers a Nekko sign-in', () => {
    const html = renderToStaticMarkup(<ClaudeAgentSetup onSave={() => {}} saving={false} />);
    expect(html).toContain('Looking for Claude Code');
    expect(html).toContain('Sign-in happens in Claude Code, not in Nekko');
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain('<input');
  });

  it('names how Claude Code is signed in, in plain words', () => {
    const base = { installed: true as const, version: '2.1.284', loggedIn: true as const };
    expect(claudeAuthLabel({ ...base, authMethod: 'api_key', auth: 'api_key' })).toBe('an Anthropic API key');
    expect(claudeAuthLabel({ ...base, authMethod: 'claude.ai', auth: 'subscription' })).toBe('your Claude plan');
    expect(claudeAuthLabel({ ...base, authMethod: 'api_key', apiProvider: 'bedrock', auth: 'cloud' })).toBe('a cloud account (bedrock)');
    expect(claudeAuthLabel({ installed: false, message: 'missing' })).toBe('');
  });

  it('shows the plan sheet only while open, with a reason line that links to it', () => {
    useStore.setState({ claudePlanSheet: false });
    expect(renderToStaticMarkup(<ClaudePlanSheet />)).toBe('');
    const line = renderToStaticMarkup(<ClaudeReasonLine message="Scheduled runs need Claude with an API key." />);
    expect(line).toContain('Scheduled runs need Claude with an API key.');
    expect(line).toContain('Why?');
    expect(CLAUDE_PLAN_SHEET.paragraphs[0]).toContain('Nekko never sees your Claude login');
  });
});
