import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@nekko-agent/shared';

/** The settings as the engine holds them; `updateSettings` merges like nekkod. */
let engine: AppSettings;
let store: { settings: AppSettings };
const updatesJoin = vi.fn();

vi.mock('react', async (original) => {
  const React = await original<typeof import('react')>();
  // Called outside React: state keeps its first value, effects never run.
  return { ...React, useState: (v: unknown) => [typeof v === 'function' ? (v as () => unknown)() : v, () => {}], useEffect: () => {} };
});
vi.mock('../../store.js', () => ({
  useStore: Object.assign((f: (s: unknown) => unknown) => f(store), {
    getState: () => store,
    setState: (s: Partial<typeof store>) => { store = { ...store, ...s }; },
  }),
}));
vi.mock('../cloud/useCloudAccountEmail.js', () => ({ useCloudAccountEmail: () => '' }));

const { saveEmail } = await import('./AboutYouSteps.js');
const { AboutYouSection } = await import('../../views/AboutYouSettings.js');

beforeEach(() => {
  engine = {} as AppSettings;
  store = { settings: engine };
  updatesJoin.mockReset();
  (globalThis as { window?: unknown }).window = {
    nekko: {
      updateSettings: async (patch: Partial<AppSettings>) => (engine = { ...engine, ...patch }),
      getSettings: async () => engine,
      updatesJoin,
    },
  };
});

/** What nekkod's `updates:join` does to the settings: pending while a retry can help. */
const offline = () => updatesJoin.mockImplementation(async (email: string) => {
  engine = { ...engine, userEmailPending: email };
  throw new Error("Error invoking remote method 'updates:join': Error: Couldn't reach Nekko Cloud. Nekko will try again later.");
});
const online = () => updatesJoin.mockImplementation(async () => {
  engine = { ...engine, userEmailPending: null };
  return { ok: true };
});

describe('saveEmail', () => {
  it('sends a new address once', async () => {
    online();
    expect(await saveEmail(' ada@example.com ', 'Ada')).toBeNull();
    expect(updatesJoin).toHaveBeenCalledWith('ada@example.com', 'Ada');
    expect(await saveEmail('ADA@example.com')).toBeNull();
    expect(updatesJoin).toHaveBeenCalledTimes(1);
  });

  it('keeps an address that did not arrive, and sends it again when saved again', async () => {
    offline();
    expect(await saveEmail('ada@example.com')).toBe("Couldn't reach Nekko Cloud. Nekko will try again later.");
    expect(engine.userEmail).toBe('ada@example.com');
    // The store follows the engine, so Settings can show it is still unsent.
    expect(store.settings.userEmailPending).toBe('ada@example.com');
    online();
    expect(await saveEmail('ada@example.com')).toBeNull();
    expect(updatesJoin).toHaveBeenCalledTimes(2);
    expect(store.settings.userEmailPending).toBeNull();
  });

  it('clearing forgets the address and anything pending, and sends nothing', async () => {
    offline();
    await saveEmail('ada@example.com');
    updatesJoin.mockClear();
    expect(await saveEmail('  ')).toBeNull();
    expect(engine).toMatchObject({ userEmail: '', userEmailPending: null });
    expect(updatesJoin).not.toHaveBeenCalled();
  });
});

describe('Settings > About you', () => {
  it('says when the saved email has not reached Nekko Cloud yet', () => {
    const html = (s: Partial<AppSettings>) => renderToStaticMarkup(<AboutYouSection settings={s as AppSettings} update={() => {}} />);
    expect(html({ userEmail: 'ada@example.com', userEmailPending: 'ada@example.com' })).toContain("hasn&#x27;t reached Nekko Cloud yet");
    expect(html({ userEmail: 'ada@example.com', userEmailPending: null })).toContain('At most one email a month');
    // A stale pending address for an email since changed is not shown as unsent.
    expect(html({ userEmail: 'new@example.com', userEmailPending: 'ada@example.com' })).not.toContain('reached Nekko Cloud');
  });
});
