import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PhoneChangesSwitch } from './RemoteAccess.js';

const state = vi.hoisted(() => ({ settings: {} as Record<string, unknown> | null }));
const refreshSettings = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../store.js', () => ({
  useStore: Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => ({ refreshSettings, pushToast: vi.fn() }) }),
}));
afterEach(() => {
  state.settings = {};
  vi.unstubAllGlobals();
});

const html = () => renderToStaticMarkup(<PhoneChangesSwitch />);

describe('Let phones see changes', () => {
  it('is off unless the setting is on, and says it is read only', () => {
    const out = html();
    expect(out).toContain('Let phones see changes');
    expect(out).toContain('aria-checked="false"');
    expect(out).toContain('Read only');
    state.settings = null;
    expect(html()).toContain('aria-checked="false"');
  });

  it('shows on when the computer allows it', () => {
    state.settings = { phoneChanges: true };
    expect(html()).toContain('aria-checked="true"');
  });
});
