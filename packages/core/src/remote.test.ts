import { describe, expect, it } from 'vitest';
import {
  PAIRING_TTL_MS,
  defaultDeviceName,
  newPairingCode,
  newRoomCode,
  newRoomSecret,
  normalizePlatform,
  verifyHello,
  type PairingGrant,
  type RemoteDevice,
} from '@nekko-agent/shared';

const NOW = 1_700_000_000_000;

const dev = (over: Partial<RemoteDevice> = {}): RemoteDevice => ({
  id: 'dev-1',
  name: 'iPhone',
  platform: 'ios',
  createdAt: NOW - 1000,
  lastSeenAt: NOW - 1000,
  ...over,
});

const grant = (over: Partial<PairingGrant> = {}): PairingGrant => ({
  code: 'ABCD2345',
  expiresAt: NOW + PAIRING_TTL_MS,
  ...over,
});

describe('verifyHello', () => {
  it('welcomes a known device and bumps lastSeen', () => {
    const v = verifyHello([dev()], { type: 'hello', deviceId: 'dev-1' }, null, NOW);
    expect(v).toMatchObject({ action: 'welcome', enrolled: false });
    if (v.action === 'welcome') expect(v.device.lastSeenAt).toBe(NOW);
  });

  it('denies a revoked device even with a valid pairing code', () => {
    const v = verifyHello([dev({ revoked: true })], { type: 'hello', deviceId: 'dev-1', pair: 'ABCD2345' }, grant(), NOW);
    expect(v).toEqual({ action: 'deny', reason: 'revoked' });
  });

  it('denies an unknown device with no pairing code', () => {
    const v = verifyHello([dev()], { type: 'hello', deviceId: 'dev-2' }, grant(), NOW);
    expect(v).toEqual({ action: 'deny', reason: 'unknown-device' });
  });

  it('enrolls an unknown device with a live pairing code', () => {
    const v = verifyHello([], { type: 'hello', deviceId: 'dev-2', name: "Philip's phone", platform: 'android', pair: 'ABCD2345' }, grant(), NOW);
    expect(v).toMatchObject({ action: 'welcome', enrolled: true });
    if (v.action === 'welcome') {
      expect(v.device).toMatchObject({ id: 'dev-2', name: "Philip's phone", platform: 'android', createdAt: NOW });
    }
  });

  it('rejects a wrong or expired pairing code', () => {
    const hello = { type: 'hello', deviceId: 'dev-2', pair: 'WRONG234' };
    expect(verifyHello([], hello, grant(), NOW)).toEqual({ action: 'deny', reason: 'bad-code' });
    expect(verifyHello([], { ...hello, pair: 'ABCD2345' }, grant({ expiresAt: NOW - 1 }), NOW)).toEqual({
      action: 'deny',
      reason: 'bad-code',
    });
    expect(verifyHello([], { ...hello, pair: 'ABCD2345' }, null, NOW)).toEqual({ action: 'deny', reason: 'bad-code' });
  });

  it('rejects malformed hellos', () => {
    expect(verifyHello([], null, grant(), NOW)).toEqual({ action: 'deny', reason: 'invalid' });
    expect(verifyHello([], { type: 'req', deviceId: 'x' }, grant(), NOW)).toEqual({ action: 'deny', reason: 'invalid' });
    expect(verifyHello([], { type: 'hello', deviceId: '  ' }, grant(), NOW)).toEqual({ action: 'deny', reason: 'invalid' });
  });

  it('falls back to a platform-derived name and normalizes platform', () => {
    const v = verifyHello([], { type: 'hello', deviceId: 'dev-3', platform: 'iOS', pair: 'ABCD2345' }, grant(), NOW);
    if (v.action !== 'welcome') throw new Error('expected welcome');
    expect(v.device.name).toBe('iPhone');
    expect(v.device.platform).toBe('ios');
    expect(normalizePlatform('weird')).toBe('unknown');
    expect(defaultDeviceName('web')).toBe('Browser');
  });
});

describe('random material', () => {
  it('generates distinct, well-formed codes and secrets', () => {
    const code = newPairingCode();
    expect(code).toMatch(/^[A-Z2-9]{8}$/);
    expect(code).not.toBe(newPairingCode());
    expect(newRoomCode()).toMatch(/^[0-9a-f]{16}$/);
    expect(newRoomSecret()).toMatch(/^[0-9a-f]{32}$/);
    expect(newRoomSecret()).not.toBe(newRoomSecret());
  });
});

describe('a HELLO with fields of the wrong type', () => {
  it('ignores a non-string name or platform instead of throwing', () => {
    const v = verifyHello([], { type: 'hello', deviceId: 'new', pair: 'ABCD2345', name: 12, platform: 3 }, grant(), NOW);
    expect(v).toEqual({
      action: 'welcome',
      enrolled: true,
      device: { id: 'new', name: 'Device', platform: 'unknown', createdAt: NOW, lastSeenAt: NOW },
    });
  });
});
