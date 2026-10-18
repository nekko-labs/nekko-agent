import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { AgentNativePage } from './agentNativePage.js';

const nativePage = (command = vi.fn(async (_action: string, _fields?: Record<string, unknown>): Promise<any> => ({}))) => {
  const debuggerApi = Object.assign(new EventEmitter(), { sendCommand: vi.fn() });
  const win = { capturePage: vi.fn(async () => ({ toPNG: () => Buffer.from('png') })), webContents: { debugger: debuggerApi, executeJavaScript: vi.fn(async () => undefined), on: vi.fn(), getURL: () => 'http://x/', getTitle: () => 'T' } };
  return { command, win, page: new AgentNativePage({ command } as any, win as any) };
};

describe('native screenshot fidelity', () => {
  it('captures the owned hidden compositor without page mutation or emulation', async () => {
    const { command, win, page } = nativePage();
    expect(await page.screenshot()).toEqual(Buffer.from('png'));
    expect(command).not.toHaveBeenCalled();
    expect(win.webContents.debugger.sendCommand).not.toHaveBeenCalled();
    expect(win.capturePage).toHaveBeenCalledExactlyOnceWith(undefined, { stayHidden: true, stayAwake: false });
  });
});

describe('native snapshot and refs', () => {
  it('asks for a compact interactive snapshot, optionally scoped', async () => {
    const { command, page } = nativePage(vi.fn(async () => ({ snapshot: '- button "Go" [ref=e1]', refs: { e1: { role: 'button', name: 'Go' } } })));
    expect(await page.snapshot()).toEqual({ tree: '- button "Go" [ref=e1]', refs: 1 });
    expect(command).toHaveBeenLastCalledWith('snapshot', { interactive: true, compact: true });
    await page.snapshot('form');
    expect(command).toHaveBeenLastCalledWith('snapshot', { interactive: true, compact: true, selector: 'form' });
    await expect(page.snapshot('@e1')).rejects.toThrow('not a ref');
  });

  it('sends refs to the native process for every ref action, never to querySelector', async () => {
    const calls: [string, Record<string, unknown> | undefined][] = [];
    const { page } = nativePage(vi.fn(async (action: string, fields?: Record<string, unknown>) => {
      calls.push([action, fields]);
      if (action === 'gettext') return { text: 'Thanks' };
      if (action === 'isvisible') return { visible: true };
      return {};
    }));
    const ref = page.locator('@e3').first();
    await ref.click();
    await ref.fill('a@b.c');
    await ref.pressSequentially('hi');
    await ref.press('Enter');
    expect(await ref.innerText()).toBe('Thanks');
    await ref.waitFor({ state: 'visible', timeout: 100 });
    expect(calls).toEqual([
      ['click', { selector: '@e3' }],
      ['fill', { selector: '@e3', value: 'a@b.c' }],
      ['type', { selector: '@e3', text: 'hi' }],
      ['type', { selector: '@e3', text: '' }], ['press', { key: 'Enter' }],
      ['gettext', { selector: '@e3' }],
      ['isvisible', { selector: '@e3' }],
    ]);
    await expect(ref.scrollIntoViewIfNeeded()).rejects.toThrow('CSS selector');
    // A CSS selector that only looks similar is not a ref.
    calls.length = 0;
    await page.locator('#e3').first().click();
    expect(calls).toEqual([['click', { selector: '#e3' }]]);
  });

  it('turns a stale or unknown ref into advice to snapshot again, and a vanished ref into detached', async () => {
    const { page } = nativePage(vi.fn(async (action: string) => { if (action !== 'snapshot') throw new Error('Unknown ref: e9'); return {}; }));
    await expect(page.locator('@e9').first().click()).rejects.toThrow('Unknown ref: e9. Take a new snapshot; refs expire when the page changes.');
    await expect(page.locator('@e9').first().waitFor({ state: 'detached', timeout: 100 })).resolves.toBeUndefined();
    await expect(page.locator('@e9').first().waitFor({ state: 'visible', timeout: 60 })).rejects.toThrow('Take a new snapshot');
  });
});
