import { describe, expect, it } from 'vitest';
import { IpcChannels } from './ipc.js';
import { PHONE_SETTINGS_KEYS, phoneAccessPolicy, phoneChannelAllowed, phoneChannelClass } from './phone-access.js';
import { SERVICE_CHANNELS, SERVICE_CHANGE_CHANNELS, SERVICE_READ_CHANNELS, SERVICE_STEP_UP_CHANNELS } from './service-management.js';
import { STEP_UP_PHONE_GUARDED } from './step-up.js';

describe('remote service contract', () => {
  it('registers exactly the narrow service surface in IPC and the phone allowlist', () => {
    expect(SERVICE_CHANNELS).toHaveLength(6);
    for (const channel of SERVICE_CHANNELS) {
      expect(Object.values(IpcChannels)).toContain(channel);
      expect(phoneChannelAllowed(channel)).toBe(true);
    }
    for (const channel of SERVICE_READ_CHANNELS) expect(phoneChannelClass(channel)).toBe('read');
    for (const channel of SERVICE_CHANGE_CHANNELS) expect(phoneChannelClass(channel)).toBe('change');
    for (const channel of ['service:reboot', 'service:stop', 'service:start', 'update:state', 'update:check', 'update:download', 'update:install']) {
      expect(phoneChannelAllowed(channel)).toBe(false);
    }
  });

  it('keeps the opt-in owner-only and guards only restart/install with step-up', () => {
    expect(PHONE_SETTINGS_KEYS).not.toContain('manageServiceFromPhone');
    expect(PHONE_SETTINGS_KEYS).not.toContain('quitFromPhone');
    expect(STEP_UP_PHONE_GUARDED.service).toEqual(SERVICE_STEP_UP_CHANNELS);
    expect(phoneAccessPolicy().stepUp.phoneGuarded.serviceChannels).toEqual(['service:restart', 'service:updateInstall']);
  });
});
