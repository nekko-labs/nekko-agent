import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ProviderConfig } from '@nekko-agent/shared';
import { ClaudeHowItWorks, ClaudeSetup, claudeInstallCommand, claudeSourceLine } from './ClaudeSetup.js';

const noop = () => {};
const setup = (props: Partial<React.ComponentProps<typeof ClaudeSetup>> = {}) =>
  renderToStaticMarkup(<ClaudeSetup apiOpen={false} connected={null} onChoice={noop} onConnectApi={noop} onConnected={noop} onDone={noop} {...props} />);

describe('Claude setup', () => {
  it('starts by looking for Claude Code, with both columns pickable and neither chosen', () => {
    const html = setup();
    expect(html).toContain('Checking if Claude Code is already installed');
    expect(html).toContain('aria-checked="false"');
    expect(html).not.toContain('aria-checked="true"');
    expect(html).toContain('Subscription');
    expect(html).toContain('>API<');
    // No Connect button and no diagram until a column is chosen.
    expect(html).not.toContain('<tfoot>');
    expect(html).not.toContain('How Nekko works with Claude');
    // Nekko never asks for a Claude login.
    expect(html).not.toContain('type="password"');
  });

  it('puts Connect under the chosen column and shows its diagram', () => {
    const html = setup({ initialChoice: 'api' });
    expect(html).toContain('Connect: add a key or cloud account');
    expect(html).toContain('Claude, built in');
    expect(html).not.toContain('Hands the turn to Claude Code');
  });

  it('shows the connected banner clearly', () => {
    const html = setup({ connected: { title: 'Claude is connected', detail: 'Using Work.' } });
    expect(html).toContain('role="status"');
    expect(html).toContain('Claude is connected');
    expect(html).toContain('Start a chat');
  });

  it('draws the subscription with the gated features off and Claude Code outside Nekko', () => {
    const sub = renderToStaticMarkup(<ClaudeHowItWorks choice="subscription" />);
    expect((sub.match(/class="claude-feat" data-on="true"/g) ?? []).length).toBe(2);
    expect(sub).toContain('Hands the turn to Claude Code');
    expect(sub).toContain('Your computer');
    expect(sub).toContain('Cloud');
    const api = renderToStaticMarkup(<ClaudeHowItWorks choice="api" />);
    expect((api.match(/class="claude-feat" data-on="true"/g) ?? []).length).toBe(6);
  });
});

describe('Claude setup helpers', () => {
  it('uses Anthropic\'s installer for the terminal\'s platform', () => {
    expect(claudeInstallCommand('darwin')).toBe('curl -fsSL https://claude.ai/install.sh | bash');
    expect(claudeInstallCommand('linux')).toBe('curl -fsSL https://claude.ai/install.sh | bash');
    expect(claudeInstallCommand('win32')).toBe('irm https://claude.ai/install.ps1 | iex');
  });

  it('says where each Claude account comes from', () => {
    const p = (kind: ProviderConfig['kind'], extra: Partial<ProviderConfig> = {}): ProviderConfig => ({ id: kind, kind, label: kind, baseUrl: '', enabled: true, ...extra });
    expect(claudeSourceLine(p('claude-code'))).toBe('Subscription · through Claude Code · ~/.claude (your usual login)');
    expect(
      claudeSourceLine(p('claude-code', { claudeCode: { account: 'work' } }), {
        installed: true, version: '2.1.263', loggedIn: true, authMethod: 'claude.ai', auth: 'subscription', email: 'me@work.com', subscriptionType: 'team',
      }),
    ).toBe('Subscription · Claude Code 2.1.263 · ~/.claude-work · me@work.com · Team plan');
    expect(claudeSourceLine(p('bedrock', { baseUrl: 'https://bedrock-mantle.eu-west-1.api.aws/anthropic' }))).toBe('API · Amazon Bedrock · eu-west-1');
    expect(claudeSourceLine(p('anthropic'))).toBe('API · Anthropic API key');
  });
});
