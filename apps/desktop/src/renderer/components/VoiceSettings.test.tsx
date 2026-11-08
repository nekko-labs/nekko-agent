import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Exercise the component's handlers and effect cleanup without a browser or microphone.
const hooks = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as any[],
  effects: [] as Array<() => void>,
  writes: vi.fn(),
}));
const store = vi.hoisted(() => ({ state: { settings: { voice: { enabled: true } } }, setState: vi.fn() }));
vi.mock('react', async original => {
  const react = await original<typeof import('react')>();
  return {
    ...react,
    useRef: (value: unknown) => {
      const index = hooks.cursor++;
      return hooks.slots[index] ??= { current: value };
    },
    useState: (value: unknown) => {
      const index = hooks.cursor++;
      hooks.slots[index] ??= { value };
      return [hooks.slots[index].value, (next: unknown) => { hooks.writes(next); hooks.slots[index].value = next; }];
    },
    useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
      const index = hooks.cursor++;
      const old = hooks.slots[index];
      if (old && deps.every((dep, i) => Object.is(dep, old.deps[i]))) return;
      hooks.effects.push(() => { old?.cleanup?.(); hooks.slots[index] = { deps, cleanup: effect() }; });
    },
  };
});
vi.mock('../store.js', () => ({ useStore: Object.assign((selector: (state: typeof store.state) => unknown) => selector(store.state), { getState: () => store.state, setState: store.setState }) }));
vi.mock('../voiceCapture.js', () => ({ startVoiceCapture: vi.fn() }));
vi.mock('../voiceEngines.js', () => ({ engineRows: () => [{ id: 'whisper', active: true, installed: true, name: 'Nekko Voice', detail: 'Ready' }] }));

import { VoiceSettings } from './VoiceSettings.js';
import { startVoiceCapture } from '../voiceCapture.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function render() {
  hooks.cursor = 0;
  const tree = VoiceSettings({});
  hooks.effects.splice(0).forEach(effect => effect());
  const elements: React.ReactElement<Record<string, any>>[] = [];
  const walk = (node: React.ReactNode) => React.Children.forEach(node, child => {
    if (!React.isValidElement<Record<string, any>>(child)) return;
    elements.push(child); walk(child.props.children);
  });
  walk(tree);
  return {
    click: (text: string) => {
      const button = elements.find(element => element.type === 'button' && element.props.children === text);
      expect(button, text).toBeDefined();
      button!.props.onClick();
    },
  };
}
function unmount() {
  for (const slot of hooks.slots) { slot?.cleanup?.(); if (slot) slot.cleanup = undefined; }
}
let api: { voiceStatus: ReturnType<typeof vi.fn>; updateSettings: ReturnType<typeof vi.fn> };
let enumerateDevices: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  hooks.cursor = 0; hooks.slots = []; hooks.effects = []; hooks.writes.mockClear();
  store.state = { settings: { voice: { enabled: true } } };
  api = { voiceStatus: vi.fn(async () => ({ installed: true })), updateSettings: vi.fn(async () => ({ voice: { enabled: false } })) };
  enumerateDevices = vi.fn(async () => []);
  vi.stubGlobal('window', { nekko: api });
  vi.stubGlobal('navigator', { mediaDevices: { enumerateDevices } });
  vi.mocked(startVoiceCapture).mockReset();
});
afterEach(() => { unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Settings microphone test lifetime', () => {
  it.each(['unmount', 'second-click', 'turn-off', 'external-off'] as const)('aborts startup resolving after %s, ignoring late callbacks', async cancel => {
    const startup = deferred<Awaited<ReturnType<typeof startVoiceCapture>>>();
    vi.mocked(startVoiceCapture).mockReturnValueOnce(startup.promise);
    let view = render();
    view.click('Test microphone / grant access');
    expect(startVoiceCapture).toHaveBeenCalledOnce();
    const options = vi.mocked(startVoiceCapture).mock.calls[0][0];
    await flush();
    if (cancel === 'unmount') unmount();
    else if (cancel === 'second-click') view.click('Test microphone / grant access');
    else if (cancel === 'turn-off') view.click('Turn off');
    else { store.state.settings.voice.enabled = false; view = render(); }
    await flush();
    const writes = hooks.writes.mock.calls.length;
    const local = { abort: vi.fn(), stop: vi.fn(() => []) };
    startup.resolve(local);
    await flush();
    options.onLevel(0.8); options.onSilence();
    expect(local.abort).toHaveBeenCalledOnce();
    expect(enumerateDevices).not.toHaveBeenCalled();
    expect(hooks.writes).toHaveBeenCalledTimes(writes);
    expect(startVoiceCapture).toHaveBeenCalledOnce();
  });
  it('does not let stale startup or silence callbacks replace or stop a newer test', async () => {
    const old = deferred<Awaited<ReturnType<typeof startVoiceCapture>>>();
    const fresh = { abort: vi.fn(), stop: vi.fn(() => []) };
    const stale = { abort: vi.fn(), stop: vi.fn(() => []) };
    vi.mocked(startVoiceCapture).mockReturnValueOnce(old.promise).mockResolvedValueOnce(fresh);
    let view = render();
    view.click('Test microphone / grant access');
    const options = vi.mocked(startVoiceCapture).mock.calls[0][0];
    view.click('Test microphone / grant access');
    view.click('Test microphone / grant access');
    await flush();
    old.resolve(stale);
    await flush();
    options.onLevel(0.9); options.onSilence();
    expect(stale.abort).toHaveBeenCalledOnce();
    expect(fresh.abort).not.toHaveBeenCalled();
    expect(enumerateDevices).toHaveBeenCalledOnce();
    view = render();
    view.click('Test microphone / grant access');
    expect(fresh.abort).toHaveBeenCalledOnce();
  });
  it('ignores stale startup failure and permits a later test', async () => {
    const old = deferred<Awaited<ReturnType<typeof startVoiceCapture>>>();
    const fresh = { abort: vi.fn(), stop: vi.fn(() => []) };
    vi.mocked(startVoiceCapture).mockReturnValueOnce(old.promise).mockResolvedValueOnce(fresh);
    const view = render();
    view.click('Test microphone / grant access');
    view.click('Test microphone / grant access');
    view.click('Test microphone / grant access');
    await flush();
    old.reject(new Error('stale permission denial'));
    await flush();
    expect(hooks.writes).not.toHaveBeenCalledWith('stale permission denial');
    unmount();
    expect(fresh.abort).toHaveBeenCalledOnce();
  });
  it('cleans up a live test if device enumeration fails', async () => {
    const local = { abort: vi.fn(), stop: vi.fn(() => []) };
    vi.mocked(startVoiceCapture).mockResolvedValue(local);
    enumerateDevices.mockRejectedValueOnce(new Error('devices unavailable'));
    const view = render();
    view.click('Test microphone / grant access');
    await flush();
    expect(local.abort).toHaveBeenCalledOnce();
    expect(hooks.writes).toHaveBeenCalledWith('devices unavailable');
  });
  it('does not publish device or permission state when enumeration resolves after unmount', async () => {
    const devices = deferred<MediaDeviceInfo[]>();
    const local = { abort: vi.fn(), stop: vi.fn(() => []) };
    vi.mocked(startVoiceCapture).mockResolvedValue(local);
    enumerateDevices.mockReturnValueOnce(devices.promise);
    render().click('Test microphone / grant access');
    await flush();
    unmount();
    const writes = hooks.writes.mock.calls.length;
    devices.resolve([]);
    await flush();
    expect(local.abort).toHaveBeenCalledOnce();
    expect(hooks.writes).toHaveBeenCalledTimes(writes);
  });
  it('retains level updates and silence teardown for the current test', async () => {
    const local = { abort: vi.fn(), stop: vi.fn(() => []) };
    vi.mocked(startVoiceCapture).mockResolvedValue(local);
    render().click('Test microphone / grant access');
    await flush();
    const options = vi.mocked(startVoiceCapture).mock.calls[0][0];
    options.onLevel(0.4);
    expect(hooks.writes).toHaveBeenCalledWith(0.4);
    render().click('Stop microphone test');
    expect(local.abort).toHaveBeenCalledOnce();
    options.onSilence();
    expect(local.abort).toHaveBeenCalledOnce();
    expect(hooks.writes).toHaveBeenLastCalledWith(null);
  });
});
