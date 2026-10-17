import { describe, expect, it } from 'vitest';
import { IpcChannels, IpcEvents } from '@nekko-agent/shared';
import { PICK_FOLDER_CHANNEL } from '../engineChannels.js';
import { BOTH_EVENTS, MAIN_EVENTS, routeToMain } from './routing.js';

describe('preload routing', () => {
  const daemon = async () => 'daemon' as const;
  const backend = async () => 'backend' as const;
  const stopped = async () => null;
  const native = [IpcChannels.dialogOpenFiles, IpcChannels.openPath, IpcChannels.voicePermission, IpcChannels.updateCheck, IpcChannels.updateDownload, IpcChannels.updateInstall, IpcChannels.appInfo, PICK_FOLDER_CHANNEL];

  it('sends the native channels to nekkod when it runs', async () => {
    for (const c of native) expect(await routeToMain(c, daemon), c).toBe(false);
  });

  it('keeps them on main only without the daemon', async () => {
    for (const c of native) expect(await routeToMain(c, backend), c).toBe(true);
    expect(await routeToMain(IpcChannels.dialogOpenFiles, stopped)).toBe(true);
  });

  it('never sends an engine channel to main', async () => {
    for (const c of [IpcChannels.settingsGet, IpcChannels.sessionSetOptions, IpcChannels.workspaceAdd]) {
      expect(await routeToMain(c, backend), c).toBe(false);
    }
  });

  it('hears update events from either side, deep links from main', () => {
    expect(BOTH_EVENTS.has(IpcEvents.updateEvent)).toBe(true);
    expect(MAIN_EVENTS.has(IpcEvents.deepLink)).toBe(true);
    expect(MAIN_EVENTS.has(IpcEvents.updateEvent)).toBe(false);
  });
});
