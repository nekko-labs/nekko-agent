import { describe, expect, it, vi } from 'vitest';
import type { Session } from '@nekko-agent/shared';
import { setChatOptionsAndDefaults, settingsPatchWithModeReset } from './chatDefaults.js';

const chat = (patch = {}) => ({ id: 'chat', effort: 'normal', ...patch }) as Session;
const api = () => ({ setSessionOptions: vi.fn(async (_id: string, patch: object) => chat(patch)), updateSettings: vi.fn(async () => ({} as any)) });

describe('desktop mode defaults', () => {
  it('saves every changed mode choice, including effort, but not identity or task data', async () => {
    const client = api();
    const mode = { effort: 'max', mode: 'ask', executionMode: 'unified', gitIsolation: false, offline: true, incognito: true,
      cloudOnly: false, disabledTools: ['bash'], disabledMcpServers: ['fs'], disabledConnectors: ['github'],
      memory: 'off', guidance: 'root', toolApproach: 'code', workMode: 'default', autoModel: true, autoProviderSwitch: true } as const;
    await setChatOptionsAndDefaults(client, 'chat', { ...mode, disabledTools: ['bash'], disabledMcpServers: ['fs'], disabledConnectors: ['github'], title: 'Private task', providerId: 'p', modelId: 'm' });
    expect(client.updateSettings).toHaveBeenCalledExactlyOnceWith({ defaultSessionOptions: mode });
    expect(client.setSessionOptions.mock.invocationCallOrder[0]).toBeLessThan(client.updateSettings.mock.invocationCallOrder[0]);
  });

  it('does not copy unrelated choices from an old window', async () => {
    const client = api();
    client.setSessionOptions.mockResolvedValue(chat({ mode: 'yolo', effort: 'low' }));
    await setChatOptionsAndDefaults(client, 'chat', { effort: 'low' });
    expect(client.updateSettings).toHaveBeenCalledExactlyOnceWith({ defaultSessionOptions: { effort: 'low' } });
  });

  it('records normalized results, including clearing a choice', async () => {
    const client = api();
    client.setSessionOptions.mockResolvedValue(chat({ executionMode: 'sandbox', mode: 'ask', effort: undefined }));
    await setChatOptionsAndDefaults(client, 'chat', { mode: 'yolo', effort: null } as any);
    expect(client.updateSettings).toHaveBeenCalledExactlyOnceWith({ defaultSessionOptions: { mode: 'ask', effort: null } });
  });

  it('never changes defaults for a missing or rejected chat', async () => {
    const client = api();
    client.setSessionOptions.mockResolvedValueOnce(null as any);
    expect(await setChatOptionsAndDefaults(client, 'gone', { effort: 'high' })).toBeNull();
    client.setSessionOptions.mockRejectedValueOnce(new Error('refused'));
    await expect(setChatOptionsAndDefaults(client, 'chat', { effort: 'high' })).rejects.toThrow('refused');
    expect(client.updateSettings).not.toHaveBeenCalled();
  });

  it('ignores non-mode writes and reports persistence failures', async () => {
    const client = api();
    await setChatOptionsAndDefaults(client, 'chat', { archivedAt: 42, title: 'Task' });
    expect(client.updateSettings).not.toHaveBeenCalled();
    client.updateSettings.mockRejectedValueOnce(new Error('disk full'));
    await expect(setChatOptionsAndDefaults(client, 'chat', { effort: 'high' })).rejects.toThrow('disk full');
  });
});

it('persists both normalized execution fields when only one was patched', async () => {
  const client = api();
  client.setSessionOptions.mockResolvedValue(chat({ executionMode: 'unified', gitIsolation: false }));
  await setChatOptionsAndDefaults(client, 'chat', { gitIsolation: false });
  expect(client.updateSettings).toHaveBeenCalledExactlyOnceWith({ defaultSessionOptions: { executionMode: 'unified', gitIsolation: false } });
});

it('sends an explicit unstar through JSON without clearing it on unrelated writes', () => {
  expect(JSON.parse(JSON.stringify(settingsPatchWithModeReset({ defaultSavedModeId: undefined }))))
    .toEqual({ defaultSavedModeId: null });
  expect(settingsPatchWithModeReset({ defaultSavedModeId: 'fusion' })).toEqual({ defaultSavedModeId: 'fusion' });
  expect(settingsPatchWithModeReset({ effort: 'low' })).toEqual({ effort: 'low' });
});
