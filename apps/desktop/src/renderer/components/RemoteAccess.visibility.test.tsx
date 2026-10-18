import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { NetworkVisibilityStatus } from '@nekko-agent/shared';
import { NetworkVisibilityView } from './RemoteAccess.js';

vi.mock('../store.js', () => ({ useStore: Object.assign(() => undefined, { getState: () => ({ pushToast: vi.fn() }) }) }));

const off: NetworkVisibilityStatus = { available: true, enabled: false, advertising: false };
const html = (vis: NetworkVisibilityStatus) => renderToStaticMarkup(<NetworkVisibilityView vis={vis} onChange={vi.fn()} />);

describe('Visible on this network', () => {
  it('is off by default and says what the network can see', () => {
    const out = html(off);
    expect(out).toContain('Visible on this network');
    expect(out).toContain('aria-checked="false"');
    expect(out).toContain('Pairing still takes');
    expect(out).not.toContain('Showing as');
  });

  it('shows the name phones see while advertising', () => {
    const out = html({ ...off, enabled: true, advertising: true, name: 'Studio', addresses: ['192.168.1.20'], relayUrl: 'ws://studio.tail1234.ts.net:4400' });
    expect(out).toContain('aria-checked="true"');
    expect(out).toContain('Studio');
    expect(out).toContain('192.168.1.20');
    expect(out).toContain('relay address');
  });

  it('says why it is not advertising', () => {
    const out = html({ ...off, enabled: true, error: 'This computer isn’t on a local network right now.' });
    expect(out).toContain('local network right now');
    expect(out).not.toContain('Showing as');
  });
});
