import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ChatMode, Session } from '@nekko-agent/shared';
import { CHAT_MODE_ICON } from '../gentleface-icons.js';
import { ASKS_FIRST, ASKS_MENU_WIDTH, permissionMarks, PermissionRows, PRIVACY_SHIELD_DOCS, privacyToggles } from './AsksFirstMenu.js';

describe('the approvals selector', () => {
  it('offers exactly the tool policy values, in plain words', () => {
    const values: Record<ChatMode, string> = { ask: 'Always ask', guardrails: 'Ask when it matters', yolo: 'No restrictions' };
    expect(Object.fromEntries(ASKS_FIRST.map((o) => [o.mode, o.label]))).toEqual(values);
  });

  it('draws each choice with its Gentleface icon, the same ones the Mode panel uses', () => {
    const icons: Record<ChatMode, string> = { ask: 'hand', guardrails: 'shield-check', yolo: 'running' };
    for (const o of ASKS_FIRST) {
      expect(o.icon).toBe(CHAT_MODE_ICON[o.mode]);
      expect(renderToStaticMarkup(<o.icon />)).toContain(`data-gf-icon="${icons[o.mode]}"`);
    }
  });

  it('opens wide enough for a hint per line, not the old 280px menu', () => {
    expect(ASKS_MENU_WIDTH).toBeGreaterThanOrEqual(400);
  });

  it('ends with Incognito, Privacy Shield and Internet access rows, in that order', () => {
    const session = { id: 's', incognito: true, offline: false } as unknown as Session;
    const row = privacyToggles(session, { shieldOn: false, isCloudModel: false });
    expect(row.map((t) => [t.key, t.on, t.disabled])).toEqual([
      ['incognito', true, false],
      ['shield', false, false],
      ['internet', true, false],
    ]);
  });

  it('keeps the internet on for a cloud model, but lets an offline chat come back online', () => {
    const online = privacyToggles({ id: 's', offline: false } as unknown as Session, { shieldOn: true, isCloudModel: true });
    expect(online.find((t) => t.key === 'internet')).toMatchObject({ on: true, disabled: true });
    expect(online.find((t) => t.key === 'shield')).toMatchObject({ on: true });
    const offline = privacyToggles({ id: 's', offline: true } as unknown as Session, { shieldOn: false, isCloudModel: true });
    expect(offline.find((t) => t.key === 'internet')).toMatchObject({ on: false, disabled: false });
  });
});


describe('switch marks on the closed menu', () => {
  const marks = (session: Partial<Session>, shieldOn: boolean) =>
    permissionMarks(privacyToggles({ id: 's', ...session } as Session, { shieldOn, isCloudModel: false })).map((m) => m.key);
  it('shows nothing extra for a chat with the defaults', () => {
    expect(marks({}, false)).toEqual([]);
  });
  it('shows Incognito and Privacy Shield when on, and Internet access only when off', () => {
    expect(marks({ incognito: true }, true)).toEqual(['incognito', 'shield']);
    expect(marks({ offline: true }, false)).toEqual(['internet']);
    expect(marks({ incognito: true, offline: true }, true)).toEqual(['incognito', 'shield', 'internet']);
  });
  it('names an off internet as off, for the button label', () => {
    expect(permissionMarks(privacyToggles({ id: 's', offline: true } as Session, { shieldOn: false, isCloudModel: false })))
      .toEqual([{ key: 'internet', on: false, label: 'Internet access off' }]);
  });
});

describe('quiet permission rows', () => {
  const toggles = privacyToggles({ id: 's', incognito: true } as Session, { shieldOn: false, isCloudModel: true });
  it('gives each permission a named checkbox, leading check slot and separate info action', () => {
    const html = renderToStaticMarkup(<PermissionRows toggles={toggles} onToggle={() => {}} />);
    expect(html.match(/role="menuitemcheckbox"/g)).toHaveLength(3);
    expect(html.match(/class="permission-check"/g)).toHaveLength(3);
    expect(html.match(/class="permission-info"/g)).toHaveLength(3);
    for (const label of ['Incognito', 'Privacy Shield', 'Internet access']) {
      expect(html).toContain('aria-label="' + label + '"');
      expect(html).toContain('About ' + label);
      expect(html).toContain('>' + label + '</span>');
    }
    expect(html).not.toContain('role="switch"');
    expect(html).not.toContain('permission-detail');
  });
  it('leaves info enabled for locked cloud internet access', () => {
    const html = renderToStaticMarkup(<PermissionRows toggles={toggles.filter(t => t.key === 'internet')} onToggle={() => {}} />);
    // Locked but hoverable, so the reason shows on hover.
    expect(html).toMatch(/aria-disabled="true" data-asks-toggle="internet"/);
    expect(html).not.toMatch(/ disabled=""/);
    expect(html).toContain('This cloud model needs an internet connection');
    const info = html.slice(html.indexOf('class="permission-info"'));
    expect(info).toContain('aria-expanded="false"');
    expect(info).not.toContain('disabled');
  });
  it('disables mutations while saving without disabling explanations', () => {
    const html = renderToStaticMarkup(<PermissionRows toggles={toggles} onToggle={() => {}} busy />);
    expect(html.match(/disabled=""/g)).toHaveLength(3);
  });
  it('links to the canonical Privacy Shield guide', () => {
    expect(PRIVACY_SHIELD_DOCS).toBe('https://nekkoagent.com/docs/privacy-shield');
  });
});
