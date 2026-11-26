import { describe, expect, it } from 'vitest';
import { clearAppCaches } from './storageCaches.js';

describe('clearAppCaches', () => {
  it('clears only cache storage, never sign-ins, local storage or databases', async () => {
    const calls: unknown[][] = [];
    await clearAppCaches({
      clearCache: async () => { calls.push(['cache']); },
      clearCodeCaches: async (o) => { calls.push(['code', o]); },
      clearStorageData: async (o) => { calls.push(['storage', o]); },
    });
    expect(calls).toEqual([
      ['cache'],
      ['code', {}],
      ['storage', { storages: ['serviceworkers', 'cachestorage', 'shadercache'] }],
    ]);
  });
});
