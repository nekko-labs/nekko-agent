import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { AgentNativePage } from './agentNativePage.js';

describe('native screenshot fidelity', () => {
  it('captures the owned hidden compositor without page mutation or emulation', async () => {
    const command = vi.fn();
    const sendCommand = vi.fn();
    const capturePage = vi.fn(async () => ({ toPNG: () => Buffer.from('png') }));
    const debuggerApi = Object.assign(new EventEmitter(), { sendCommand });
    const page = new AgentNativePage({ command } as any, { capturePage, webContents: { debugger: debuggerApi, executeJavaScript: vi.fn(async () => undefined) } } as any);
    expect(await page.screenshot()).toEqual(Buffer.from('png'));
    expect(command).not.toHaveBeenCalled();
    expect(sendCommand).not.toHaveBeenCalled();
    expect(capturePage).toHaveBeenCalledExactlyOnceWith(undefined, { stayHidden: true, stayAwake: false });
  });
});
