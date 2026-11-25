// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PaneVisibleContext } from './paneVisibility.js';
import { runningTickers, useSharedTick, useVisibleInterval } from './visibleInterval.js';
import { watchEventFilter } from './agentWatches.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let hidden = false;
const setHidden = (value: boolean) => { hidden = value; act(() => { document.dispatchEvent(new Event('visibilitychange')); }); };

beforeEach(() => {
  vi.useFakeTimers();
  hidden = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
});
afterEach(() => { act(() => root?.unmount()); root = undefined; vi.useRealTimers(); });

function mount(node: React.ReactElement) {
  root = createRoot(document.createElement('div'));
  act(() => root!.render(node));
}

describe('useVisibleInterval', () => {
  it('ticks while visible, stops while the window is hidden, and reads at once on return', () => {
    const fn = vi.fn();
    function C() { useVisibleInterval(fn, 1000); return null; }
    mount(<C />);
    act(() => { vi.advanceTimersByTime(3000); });
    expect(fn).toHaveBeenCalledTimes(3);
    setHidden(true);
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(fn).toHaveBeenCalledTimes(3);
    setHidden(false);
    expect(fn).toHaveBeenCalledTimes(4);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(fn).toHaveBeenCalledTimes(5);
  });

  it('stops while its pane is parked and reads at once when it is shown', () => {
    const fn = vi.fn();
    function C() { useVisibleInterval(fn, 500); return null; }
    const view = (shown: boolean) => <PaneVisibleContext.Provider value={shown}><C /></PaneVisibleContext.Provider>;
    mount(view(false));
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(fn).not.toHaveBeenCalled();
    act(() => root!.render(view(true)));
    expect(fn).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('runs once on mount with immediate, and not at all with a null period', () => {
    const fn = vi.fn();
    function C({ ms }: { ms: number | null }) { useVisibleInterval(fn, ms, { immediate: true }); return null; }
    mount(<C ms={null} />);
    expect(fn).not.toHaveBeenCalled();
    act(() => root!.render(<C ms={1000} />));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('tells a late answer its run is over once it is cleaned up', () => {
    let live: (() => boolean) | undefined;
    function C() { useVisibleInterval((l) => { live = l; }, 1000, { immediate: true }); return null; }
    mount(<C />);
    expect(live!()).toBe(true);
    act(() => root!.unmount());
    root = undefined;
    expect(live!()).toBe(false);
  });
});

describe('useSharedTick', () => {
  it('runs every subscriber off one timer, and none while hidden', () => {
    const a = vi.fn(); const b = vi.fn();
    function A() { useSharedTick(a); return null; }
    function B() { useSharedTick(b); return null; }
    mount(<><A /><B /></>);
    expect(runningTickers()).toBe(1);
    act(() => { vi.advanceTimersByTime(2000); });
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(2);
    setHidden(true);
    expect(runningTickers()).toBe(0);
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(a).toHaveBeenCalledTimes(2);
    setHidden(false);
    expect(runningTickers()).toBe(1);
    expect(a).toHaveBeenCalledTimes(3);
  });
});

describe('watchEventFilter', () => {
  const call = (id: string, name: string) => ({ type: 'tool_call', sessionId: 's', call: { id, name, input: {} } }) as never;
  const result = (id: string) => ({ type: 'tool_result', sessionId: 's', result: { toolCallId: id, output: '', isError: false } }) as never;
  it('reads only on an agent_watch result or a turn end, not on every tool result', () => {
    const changes = watchEventFilter();
    expect(changes(call('1', 'shell'))).toBe(false);
    expect(changes(result('1'))).toBe(false);
    expect(changes(call('2', 'agent_watch'))).toBe(false);
    expect(changes(result('2'))).toBe(true);
    expect(changes({ type: 'done', sessionId: 's', messageId: 'm' } as never)).toBe(true);
    expect(changes({ type: 'error', sessionId: 's', message: 'x' } as never)).toBe(true);
    expect(changes({ type: 'text', sessionId: 's', delta: 'x' } as never)).toBe(false);
  });
});
