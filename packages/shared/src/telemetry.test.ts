import { describe, expect, it } from 'vitest';
import { telemetryChoice } from './telemetry.js';

describe('telemetry choice', () => {
  it('gives a fresh random id each time it is turned on, and none when off', () => {
    const a = telemetryChoice(true);
    const b = telemetryChoice(true);
    expect(a.enabled).toBe(true);
    expect(a.installId).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.installId).not.toBe(b.installId);
    expect(telemetryChoice(false)).toEqual({ enabled: false });
  });
});
