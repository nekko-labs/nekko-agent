import { describe, expect, it } from 'vitest';
import { parseSpaces, readSpaces, switchScript } from './spaces.js';

const space = (id: number, type = 0) => ({ ManagedSpaceID: id, id64: id, type, uuid: `u${id}` });
// The shape `plutil -extract SpacesDisplayConfiguration json` gives on macOS.
const config = (monitors: unknown[]) => ({ 'Management Data': { Monitors: monitors } });

describe('macOS desktops', () => {
  it('lists the main screen’s desktops in order, skipping full-screen apps, with the current one', () => {
    const parsed = parseSpaces(config([
      { 'Display Identifier': 'Main', 'Current Space': space(4), Spaces: [space(1), space(4), space(9, 4), space(5)] },
      { 'Display Identifier': '37D8', 'Collapsed Space': space(126) },
    ]));
    expect(parsed).toEqual({ current: '4', desktops: ['1', '4', '5'] });
  });
  it('falls back to the first screen with desktops, and to no current desktop when a full-screen app is in front', () => {
    expect(parseSpaces(config([{ 'Display Identifier': 'A', 'Current Space': space(9, 4), Spaces: [space(2), space(3)] }])))
      .toEqual({ current: null, desktops: ['2', '3'] });
    expect(parseSpaces({})).toBeNull();
    expect(parseSpaces(config([{ 'Display Identifier': 'Main' }]))).toBeNull();
  });
  it('jumps with Ctrl+number when that shortcut is on, else steps with Ctrl+arrows', () => {
    expect(switchScript(1, 2, true)).toBe('tell application "System Events" to key code 19 using control down');
    expect(switchScript(3, 1, false)).toBe('tell application "System Events"\nkey code 123 using control down\ndelay 0.35\nkey code 123 using control down\nend tell');
    expect(switchScript(1, 11, true)).toContain('key code 124');
    expect(switchScript(2, 2, true)).toBeNull();
  });
  it('takes the current desktop from the window server, since the preference lags a switch', async () => {
    if (process.platform !== 'darwin') return;
    const json = JSON.stringify(config([{ 'Display Identifier': 'Main', 'Current Space': space(1), Spaces: [space(1), space(2)] }]));
    expect(await readSpaces(async (file) => (file === 'osascript' ? '2\n' : json))).toEqual({ current: '2', desktops: ['1', '2'] });
    // A full-screen app's space is not a desktop.
    expect(await readSpaces(async (file) => (file === 'osascript' ? '9\n' : json))).toEqual({ current: null, desktops: ['1', '2'] });
  });
  it('reads through defaults and plutil, and gives up quietly', async () => {
    if (process.platform !== 'darwin') return;
    const json = JSON.stringify(config([{ 'Display Identifier': 'Main', 'Current Space': space(1), Spaces: [space(1), space(2)] }]));
    expect(await readSpaces(async (file) => (file === 'osascript' ? Promise.reject(new Error('no JXA')) : json))).toEqual({ current: '1', desktops: ['1', '2'] });
    expect(await readSpaces(async () => { throw new Error('no defaults'); })).toBeNull();
  });
});
