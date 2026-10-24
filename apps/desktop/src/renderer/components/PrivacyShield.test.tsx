import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PrivacyPreview } from '@nekko-agent/shared';
import { PrivacyShieldPanel } from './PrivacyShield.js';
import { ChatControls } from './ChatControls.js';

const preview = (patch: Partial<PrivacyPreview> = {}): PrivacyPreview => ({
  enabled: true,
  reach: 'cloud',
  draft: 'send to [PII_EMAIL_2]',
  findings: [
    { kind: 'email', value: 'bob@example.com', token: '[PII_EMAIL_1]', count: 2, inDraft: false, inChat: true },
    { kind: 'email', value: 'jane@example.com', token: '[PII_EMAIL_2]', count: 1, inDraft: true, inChat: false },
  ],
  allowed: [{ kind: 'phone', value: '+81 90-1234-5678' }],
  disabledKinds: ['ip'],
  terms: ['Acme Corp'],
  kinds: ['email', 'phone', 'card', 'ssn', 'my-number', 'ip', 'secret', 'username', 'term'],
  ...patch,
});

const noop = () => {};
const panel = (p: Partial<React.ComponentProps<typeof PrivacyShieldPanel>> = {}) =>
  renderToStaticMarkup(
    <PrivacyShieldPanel on preview={preview()} error={null} draft="send to jane@example.com" terms={['Acme Corp']}
      disabled={new Set(['ip'])} onToggleShield={noop} onAllow={noop} onToggleKind={noop} onTerms={noop} {...p} />,
  );

describe('Privacy Shield panel', () => {
  it('lists each value with the placeholder the model reads and where it occurs', () => {
    const html = panel();
    expect(html).toContain('What the model reads instead');
    expect(html).toContain('bob@example.com');
    expect(html).toContain('[PII_EMAIL_1]');
    expect(html).toMatch(/>chat</);
    expect(html).toMatch(/>draft</);
    expect(html).toContain('role="switch" aria-checked="true"');
  });

  it('shows allowed values, kind switches and the user terms', () => {
    const html = panel();
    expect(html).toContain('Sent as written');
    expect(html).toContain('+81 90-1234-5678');
    expect(html).toContain('Hide again');
    expect(html).toMatch(/aria-pressed="false"[^>]*><span class="ctl-dot"><\/span>Public IP addresses/);
    expect(html).toMatch(/aria-pressed="true"[^>]*><span class="ctl-dot"><\/span>Email addresses/);
    expect(html).toContain('Acme Corp');
  });

  it('says what it would hide while off, and why a local or Claude Agent chat needs no shield', () => {
    const off = panel({ on: false });
    expect(off).toContain('What the shield would hide');
    expect(off).toContain('role="switch" aria-checked="false"');
    expect(panel({ preview: preview({ reach: 'local' }) })).toContain('runs on this computer');
    expect(panel({ preview: preview({ reach: 'external' }) })).toContain('Claude subscription chats are sent by Claude Code');
  });

  it('reports a clean chat and a failed preview', () => {
    expect(panel({ preview: preview({ findings: [], allowed: [] }) })).toContain('Nothing private found');
    expect(panel({ preview: null, error: 'engine down' })).toContain('Could not preview: engine down');
  });

  it('sits with the privacy switches in the composer, lit when the chat is shielded', () => {
    const session = { id: 's', title: 'Chat', messages: [], createdAt: 0, updatedAt: 0 };
    const off = renderToStaticMarkup(<ChatControls session={session as never} isCloudModel onChange={noop} only="privacy" />);
    expect(off).toMatch(/data-privacy-shield-button[^>]*aria-pressed="false"/);
    const on = renderToStaticMarkup(<ChatControls session={{ ...session, privacy: { mode: 'redact' } } as never} isCloudModel onChange={noop} only="privacy" />);
    expect(on).toMatch(/data-privacy-shield-button[^>]*aria-pressed="true"/);
  });
});
