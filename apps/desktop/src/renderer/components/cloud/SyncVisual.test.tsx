import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SyncVisual } from './SyncVisual.js';

const html = (phase: React.ComponentProps<typeof SyncVisual>['phase'], others = 2) => renderToStaticMarkup(<SyncVisual phase={phase} others={others} />);

describe('SyncVisual', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('moves only while a sync runs', () => {
    const syncing = html('syncing');
    expect(syncing).toContain('is-moving');
    expect(syncing).toContain('<animateMotion');
    expect(syncing).toContain('sync-visual-cipher');
    for (const still of ['idle', 'off', 'error', 'awaiting-approval', 'signed-out'] as const) {
      const out = html(still);
      expect(out, still).not.toContain('<animateMotion');
      expect(out, still).not.toContain('sync-visual-cipher');
    }
  });

  it('is still under reduced motion, even mid-sync', () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) });
    expect(html('syncing')).not.toContain('<animateMotion');
  });

  it('shows the state and one node per other device, up to three', () => {
    expect(html('idle')).toContain('tone-ok');
    expect(html('error')).toContain('tone-error');
    expect(html('off')).toContain('is-dim');
    const count = (s: string) => (s.match(/class="sv-device[ "]/g) ?? []).length;
    expect(count(html('idle', 0))).toBe(2);
    expect(count(html('idle', 2))).toBe(3);
    expect(count(html('idle', 9))).toBe(4);
  });
});
