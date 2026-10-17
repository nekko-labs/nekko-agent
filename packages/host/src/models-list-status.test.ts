import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderConfig } from '@nekko-agent/shared';
import type { Provider } from '@nekko-agent/core';

// A provider whose list call fails the way openai-compat does on a bad key.
vi.mock('@nekko-agent/core', async () => {
  const actual = await vi.importActual<typeof import('@nekko-agent/core')>('@nekko-agent/core');
  return {
    ...actual,
    createProvider: (config: ProviderConfig): Provider => ({
      config,
      listModels: async () => {
        if (config.id === 'bad') throw new Error('listModels 401: bad key');
        return [{ id: 'm', name: 'm', providerId: config.id }];
      },
      test: async () => ({ ok: true, message: '' }),
      // eslint-disable-next-line require-yield
      async *chat() { throw new Error('unused'); },
    }),
  };
});

const { createHost } = await import('./host.js');

describe('listModelsStatus', () => {
  const host = createHost({ dataDir: mkdtempSync(join(tmpdir(), 'nekko-list-status-')) });
  host.saveProvider({ id: 'ok', kind: 'openai-compat', label: 'Ok', baseUrl: 'http://127.0.0.1:1/v1', enabled: true });
  host.saveProvider({ id: 'bad', kind: 'openai-compat', label: 'Bad', baseUrl: 'http://127.0.0.1:1/v1', enabled: true });
  host.saveProvider({ id: 'off', kind: 'openai-compat', label: 'Off', baseUrl: 'http://127.0.0.1:1/v1', enabled: false });

  it('returns the models of a working provider with no error', async () => {
    expect(await host.listModelsStatus('ok')).toEqual({ models: [{ id: 'm', name: 'm', providerId: 'ok' }] });
  });

  it('carries the provider error, while listModels keeps returning []', async () => {
    expect(await host.listModelsStatus('bad')).toEqual({ models: [], error: 'listModels 401: bad key' });
    expect(await host.listModels('bad')).toEqual([]);
  });

  it('reports no error for a disabled or unknown provider', async () => {
    expect(await host.listModelsStatus('off')).toEqual({ models: [] });
    expect(await host.listModelsStatus('nope')).toEqual({ models: [] });
  });
});
