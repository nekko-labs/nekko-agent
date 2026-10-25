import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { RemoteDevice } from '@nekko-agent/shared';
import { LockPhonesView, ProtectComputerPromptView, QuitFromPhoneView, RemoteStoppedBanner } from './RemoteAccess.js';

vi.mock('../store.js', () => ({ useStore: Object.assign(() => undefined, { getState: () => ({ pushToast: vi.fn() }) }) }));

const phone = (id: string, access?: RemoteDevice['access']): RemoteDevice => ({ id, name: id, platform: 'ios', createdAt: 1, lastSeenAt: 2, access });

describe('Remote access card: safety', () => {
  it('says who stopped remote access from a phone, and when', () => {
    const out = renderToStaticMarkup(<RemoteStoppedBanner stoppedBy={{ name: 'Philip’s iPhone', at: 1 }} time={() => '14:02'} />);
    expect(out).toContain('Remote access was stopped from Philip’s iPhone at 14:02. Turn it on again from here.');
  });

  it('locks phones when every phone has Change off, and hides with no phone', () => {
    const sw = (devices: RemoteDevice[]) => renderToStaticMarkup(<LockPhonesView devices={devices} onChange={vi.fn()} />);
    expect(sw([])).toBe('');
    expect(sw([phone('a'), phone('b', { change: false })])).toContain('aria-checked="false" aria-label="Lock phones"');
    expect(sw([phone('a', { change: false }), phone('b', { read: true, change: false })])).toContain('aria-checked="true" aria-label="Lock phones"');
  });

  it('keeps quitting from a phone off unless the owner turns it on', () => {
    expect(renderToStaticMarkup(<QuitFromPhoneView on={false} onChange={vi.fn()} />)).toContain('aria-checked="false" aria-label="Let a phone quit Nekko Agent"');
  });

  it('prompts once to protect this computer, linking to the docs page', () => {
    const out = renderToStaticMarkup(<ProtectComputerPromptView onSetUp={vi.fn()} onDismiss={vi.fn()} />);
    expect(out).toContain('Protect this computer');
    expect(out).toContain('href="https://nekkoagent.com/docs/protect-this-computer-with-a-security-key"');
    expect(out).toContain('Not now');
  });
});
