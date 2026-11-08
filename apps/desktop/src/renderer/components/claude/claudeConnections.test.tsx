import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ClaudeCodeStatus, ProviderConfig } from '@nekko-agent/shared';
import { claudeAccountName } from '@nekko-agent/shared';
import { ClaudeConnectionPicker } from './ClaudeConnectionPicker.js';
import { claudeConnectionDetail, claudeConnectionLabel, claudeProfileConflict, filterClaudeConnections, isClaudeConnection } from './claudeConnections.js';

const p = (id: string, kind: ProviderConfig['kind'], extra: Partial<ProviderConfig> = {}): ProviderConfig => ({ id, kind, label: id, baseUrl: '', enabled: true, ...extra });
const personal = p('Personal', 'claude-code');
const work = p('Work', 'claude-code', { claudeCode: { account: 'work' } });
const production = p('Production', 'anthropic', { apiKey: 'do-not-render', workspaceId: 'workspace-prod' });
const sandbox = p('Sandbox', 'anthropic');
const local = p('Local', 'ollama');
const providers = [personal, work, production, sandbox, local];
const identity: ClaudeCodeStatus = { installed: true, version: '2', loggedIn: true, authMethod: 'claude.ai', auth: 'subscription', email: 'same@example.test', orgName: 'Example org', subscriptionType: 'team' };

describe('Claude connection filtering and identity', () => {
  it('recognizes every supported Claude source but not retired subscription tokens', () => {
    for (const kind of ['claude-code', 'anthropic', 'bedrock', 'vertex', 'foundry'] as const) expect(isClaudeConnection(p(kind, kind))).toBe(true);
    expect(isClaudeConnection(local)).toBe(false);
    expect(isClaudeConnection(p('retired', 'anthropic', { auth: 'subscription' }))).toBe(false);
  });
  it('keeps same-vendor API keys distinct and never falls back from an absent destination', () => {
    expect(filterClaudeConnections(providers, 'Production')).toEqual([production]);
    expect(filterClaudeConnections(providers, 'Sandbox')).toEqual([sandbox]);
    expect(filterClaudeConnections(providers, 'missing')).toEqual([]);
    expect(filterClaudeConnections([{ ...work, enabled: false }], work.id)).toEqual([]);
  });
  it('can return to all providers, including local servers', () => {
    expect(filterClaudeConnections(providers, 'all')).toEqual(providers);
  });
  it('shows same-email organization and plan, not an inferred personal label', () => {
    expect(claudeConnectionDetail(work, identity)).toBe('same@example.test · Example org · Team plan · Profile: work');
    expect(claudeConnectionDetail(personal, { ...identity, orgName: 'Personal', subscriptionType: 'max' })).toContain('Personal · Max plan');
  });
  it('does not present pending, failed or signed-out identity as authenticated', () => {
    expect(claudeConnectionDetail(work)).toContain('Checking');
    expect(claudeConnectionDetail(work, { installed: false, message: 'failed' })).toContain('unavailable');
    expect(claudeConnectionDetail(work, { ...identity, loggedIn: false })).toContain('Sign-in required');
    expect(claudeConnectionDetail(work, { ...identity, auth: 'api_key', authMethod: 'api_key' })).toContain('not a subscription');
  });
  it('names API billing and workspace without exposing the key', () => {
    expect(claudeConnectionLabel(production)).toBe('Production · Anthropic API');
    expect(claudeConnectionDetail(production)).toContain('Workspace: workspace-prod');
    expect(claudeConnectionDetail(production)).not.toContain(production.apiKey);
  });
  it('uses a labelled native selector and explains that filtering is not a switch', () => {
    const html = renderToStaticMarkup(<ClaudeConnectionPicker providers={[personal, work, production, sandbox]} selected={work.id} currentId={personal.id} onSelect={() => {}} />);
    expect(html).toContain('Claude connection</label>');
    expect(html).toContain('Work · Subscription');
    expect(html).toContain('Production · Anthropic API');
    expect(html).toContain('Sandbox · Anthropic API');
    expect(html).toContain('No account changes until you pick a model');
    expect(html).toContain('starts a new Claude Code conversation');
    expect(html).not.toContain('do-not-render');
  });
});

describe('subscription profile collision guard', () => {
  it('blocks normalized and disabled saved profiles before sign-in', () => {
    expect(claudeProfileConflict(providers, claudeAccountName('Work!!'))).toBe(work);
    expect(claudeProfileConflict([{ ...work, enabled: false }], 'work')).toEqual({ ...work, enabled: false });
    expect(claudeProfileConflict([p('Old', 'claude-code', { claudeCode: { account: 'WORK' } })], 'work')?.id).toBe('Old');
  });
  it('permits a new profile without requiring a default connection', () => {
    expect(claudeProfileConflict([work], claudeAccountName('Client A'))).toBeUndefined();
    expect(claudeProfileConflict(providers, '')).toBeUndefined();
  });
});
