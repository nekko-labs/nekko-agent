import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { PhoneActivityEntry, RemoteDevice } from '@nekko-agent/shared';
import { activityReason, PhoneAccessView } from './RemoteAccess.js';

vi.mock('../store.js', () => ({ useStore: Object.assign(() => undefined, { getState: () => ({ pushToast: vi.fn() }) }) }));

const NOW = 1_760_000_000_000;
const phone = (id: string, extra: Partial<RemoteDevice> = {}): RemoteDevice => ({
  id,
  name: id === 'p1' ? 'Philip’s iPhone' : 'Pixel',
  platform: 'ios',
  createdAt: 1,
  lastSeenAt: 2,
  ...extra,
});

const html = (devices: RemoteDevice[], opts: { activity?: Record<string, PhoneActivityEntry[]>; openId?: string } = {}) =>
  renderToStaticMarkup(
    <PhoneAccessView devices={devices} activity={opts.activity ?? {}} openId={opts.openId ?? null} now={NOW} onSet={vi.fn()} onOpen={vi.fn()} />,
  );

/** The `aria-checked` of each switch, in order (Read, Change per phone). */
const switches = (out: string) => [...out.matchAll(/aria-checked="(true|false)" aria-label="([^"]+)"/g)].map((m) => `${m[2]}=${m[1]}`);

describe('What phones can do', () => {
  it('shows nothing with no phone paired', () => {
    expect(html([])).toBe('');
  });

  it('has Read and Change on for a phone paired before the switches existed', () => {
    const out = html([phone('p1')]);
    expect(out).toContain('What phones can do');
    expect(out).toContain('Face ID or the passcode');
    expect(out).toContain('Revoke a phone to stop everything');
    expect(switches(out)).toEqual(['Read from Philip’s iPhone=true', 'Change from Philip’s iPhone=true']);
  });

  it('shows each phone’s own switches', () => {
    const out = html([phone('p1', { access: { change: false } }), phone('p2', { access: { read: false, change: true } })]);
    expect(switches(out)).toEqual(['Read from Philip’s iPhone=true', 'Change from Philip’s iPhone=false', 'Read from Pixel=false', 'Change from Pixel=true']);
  });

  it('lists a phone’s activity newest first, with why a change was refused', () => {
    const activity = {
      p1: [
        { at: NOW - 3 * 3600_000, channel: 'device:registerKey', ok: true },
        { at: NOW - 600_000, channel: 'file:write', ok: false, reason: 'change-off' },
        { at: NOW - 5_000, channel: 'git:push', ok: true },
      ],
    };
    const closed = html([phone('p1')], { activity });
    expect(closed).not.toContain('git:push');
    expect(closed).toContain('>Activity<');
    const out = html([phone('p1')], { activity, openId: 'p1' });
    expect(out).toContain('Hide activity');
    expect(out.indexOf('git:push')).toBeLessThan(out.indexOf('file:write'));
    expect(out.indexOf('file:write')).toBeLessThan(out.indexOf('Set up Face ID for changes'));
    expect(out).toContain('Refused: Change is off');
    expect(out).toContain('just now');
    expect(out).toContain('10 mins ago');
  });

  it('says when a phone has made no changes, and while loading', () => {
    expect(html([phone('p1')], { activity: { p1: [] }, openId: 'p1' })).toContain('No changes from this phone yet.');
    expect(html([phone('p1')], { openId: 'p1' })).toContain('Loading…');
  });

  it('words every refusal plainly', () => {
    expect(activityReason(undefined)).toBe('Done');
    for (const r of ['proof-required', 'proof-invalid', 'proof-stale', 'proof-replayed', 'key-missing']) {
      expect(activityReason(r)).toBe('Refused: no fresh Face ID or passcode');
    }
    expect(activityReason('key-mismatch')).toContain('pair it again');
    expect(activityReason('failed')).toBe('Failed on this computer');
    expect(activityReason('value-invalid')).toBe('Refused (value-invalid)');
    expect(activityReason('legacy-protocol')).toBe('Refused: update the app on the phone');
  });

  it('marks a phone still on an app from before relay replay protection', () => {
    expect(html([phone('p1')])).not.toContain('Older app');
    const out = html([phone('p1', { legacyProtocol: true })], {
      activity: { p1: [{ at: NOW - 5_000, channel: 'relay:hello', ok: true, reason: 'legacy-protocol' }] },
      openId: 'p1',
    });
    expect(out).toContain('Older app: update it on the phone');
    expect(out).toContain('Connected with an older app');
  });
});
