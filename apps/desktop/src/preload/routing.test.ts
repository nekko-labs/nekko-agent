import { describe, expect, it } from 'vitest';
import { IpcEvents } from '@nekko-agent/shared';
import { MAIN_EVENTS } from './routing.js';

describe('preload routing', () => {
  it('hears deep links from main and update events from the engine', () => {
    expect(MAIN_EVENTS.has(IpcEvents.deepLink)).toBe(true);
    expect(MAIN_EVENTS.has(IpcEvents.updateEvent)).toBe(false);
  });
});
