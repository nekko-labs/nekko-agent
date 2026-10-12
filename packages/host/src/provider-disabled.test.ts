import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderConfig } from '@nekko-agent/shared';
import type { Provider } from '@nekko-agent/core';

// Every contact with a provider goes through createProvider; count them.
const contacted: string[] = [];
vi.mock('@nekko-agent/core', async () => {
  const actual = await vi.importActual<typeof import('@nekko-agent/core')>('@nekko-agent/core');
  return {
    ...actual,
    createProvider: (config: ProviderConfig): Provider => ({
      config,
      listModels: async () => { contacted.push(`list:${config.id}`); return [{ id: 'm', name: 'm', providerId: config.id }]; },
      test: async () => { contacted.push(`test:${config.id}`); return { ok: true, message: '' }; },
      // eslint-disable-next-line require-yield
      async *chat() { throw new Error('unused'); },
    }),
  };
});

const { createHost } = await import('./host.js');

describe('a disabled provider', () => {
  it('is never contacted: no test, no model list, no lms or runtime probe', async () => {
    const host = createHost({ dataDir: mkdtempSync(join(tmpdir(), 'nekko-disabled-')) });
    host.saveProvider({ id: 'lms', kind: 'lmstudio', label: 'LM Studio', baseUrl: 'http://127.0.0.1:1/v1', enabled: false });
    host.saveProvider({ id: 'on', kind: 'openai-compat', label: 'On', baseUrl: 'http://127.0.0.1:1/v1', enabled: true });

    expect(await host.testProvider('lms')).toMatchObject({ ok: false, message: expect.stringContaining('disabled') });
    expect(await host.listModels('lms')).toEqual([]);
    expect(await host.lmsAvailable('lms')).toMatchObject({ available: false, reason: expect.stringContaining('disabled') });
    expect(await host.runtimeStatus('lms')).toBeNull();
    expect(await host.runtimeFacts('lms')).toEqual([]);
    expect(contacted).toEqual([]);

    // Turning it back on restores the normal path.
    expect(await host.testProvider('on')).toMatchObject({ ok: true });
    expect(await host.listModels('on')).toHaveLength(1);
    expect(contacted).toEqual(['test:on', 'list:on']);
  });
});
