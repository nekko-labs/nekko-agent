import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TerminalEvent, TerminalSnapshot } from '@nekko-agent/shared';

const fixture = vi.hoisted(() => ({
  effect: undefined as (() => (() => void) | void) | undefined,
  write: vi.fn(), reset: vi.fn(), dispose: vi.fn(),
}));
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useRef: () => ({ current: {} }),
  useState: () => [null, vi.fn()],
  useEffect: (effect: () => (() => void) | void) => { fixture.effect = effect; },
}));
vi.mock('../store.js', () => ({ useStore: () => 'xterm' }));
vi.mock('./PaneFrame.js', () => ({ PaneActions: () => null, useInPaneFrame: () => false }));
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  cols = 80; rows = 24; options = {};
  write = fixture.write; reset = fixture.reset; dispose = fixture.dispose;
  open() {} focus() {} loadAddon() {} attachCustomKeyEventHandler() {} hasSelection() { return false; }
  onData() { return { dispose() {} }; }
  onResize() { return { dispose() {} }; }
} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { onContextLoss() {} } }));
import { TerminalPane } from './TerminalPane.js';

let cleanup: (() => void) | void;
afterEach(() => { cleanup?.(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

async function mount(snapshot: Promise<TerminalSnapshot | null>) {
  let listener: (e: TerminalEvent) => void = () => {};
  const api = {
    terminalSnapshot: vi.fn(() => snapshot),
    onTerminalEvent: vi.fn((cb: typeof listener) => { listener = cb; return vi.fn(); }),
    openTerminalStream: vi.fn(), resizeTerminal: vi.fn(), writeTerminal: vi.fn(),
  };
  vi.stubGlobal('window', { nekko: api });
  vi.stubGlobal('document', { documentElement: {} });
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }));
  const Observer = class { observe() {} disconnect() {} };
  vi.stubGlobal('ResizeObserver', Observer);
  vi.stubGlobal('MutationObserver', Observer);
  TerminalPane({ terminalId: 'agent_test' });
  cleanup = fixture.effect!();
  await vi.waitFor(() => expect(api.onTerminalEvent).toHaveBeenCalled());
  await new Promise(resolve => setTimeout(resolve, 0));
  return { api, emit: (event: TerminalEvent) => listener(event) };
}

describe('agent command log attachment', () => {
  it('explains missing lazy or restarted logs and replaces the notice on first output', async () => {
    const { api, emit } = await mount(Promise.resolve(null));
    expect(api.openTerminalStream).not.toHaveBeenCalled();
    expect(fixture.write).toHaveBeenCalledWith(expect.stringContaining('new command logs are saved alongside this session'));
    emit({ type: 'data', terminalId: 'agent_other', data: 'unrelated' });
    expect(fixture.reset).not.toHaveBeenCalled();
    emit({ type: 'data', terminalId: 'agent_test', data: '$ echo hello\r\nhello\r\n' });
    expect(fixture.reset).toHaveBeenCalledOnce();
    expect(fixture.write).toHaveBeenLastCalledWith('$ echo hello\r\nhello\r\n');
  });

  it('replays retained output without opening a daemon PTY stream', async () => {
    const { api } = await mount(Promise.resolve({
      info: { id: 'agent_test', title: 'Agent commands', cwd: '/', shell: 'agent', agentSessionId: 'test', createdAt: 1, running: false },
      buffer: '$ echo retained\r\nretained\r\n', cols: 80, rows: 24,
    }));
    expect(api.openTerminalStream).not.toHaveBeenCalled();
    expect(fixture.write).toHaveBeenCalledExactlyOnceWith('$ echo retained\r\nretained\r\n');
  });

  it('shows a failed snapshot read rather than a blank pane', async () => {
    // Delay rejection until the pane has installed its catch handler.
    const snapshot = new Promise<null>((_, reject) => setTimeout(() => reject(new Error('backend down')), 20));
    await mount(snapshot);
    await vi.waitFor(() => expect(fixture.write).toHaveBeenCalledWith(expect.stringContaining('Terminal output unavailable')));
  });

  it('does not overwrite live output with a late missing-snapshot notice', async () => {
    let resolve!: (value: null) => void;
    const { emit } = await mount(new Promise<null>(r => { resolve = r; }));
    emit({ type: 'data', terminalId: 'agent_test', data: 'live output' });
    resolve(null);
    await new Promise(r => setTimeout(r, 0));
    expect(fixture.write).toHaveBeenCalledExactlyOnceWith('live output');
  });
});
