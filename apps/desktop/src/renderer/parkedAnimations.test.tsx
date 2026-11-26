// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useParkedAnimations } from './parkedAnimations.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Just enough of an Animation for the hook: a play state that pause() and play() move. */
function fakeAnimation(playState: AnimationPlayState) {
  const a = { playState, pause: vi.fn(() => { a.playState = 'paused'; }), play: vi.fn(() => { a.playState = 'running'; }) };
  return a;
}

let root: Root | undefined;
let animations: ReturnType<typeof fakeAnimation>[] = [];
let getAnimations: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16) as unknown as number);
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
  animations = [];
  getAnimations = vi.fn(() => animations);
});
afterEach(() => { act(() => root?.unmount()); root = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); });

function Pane({ shown }: { shown: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useParkedAnimations(ref, shown);
  return <div ref={(el) => { if (el) (el as unknown as { getAnimations: unknown }).getAnimations = getAnimations; ref.current = el; }} />;
}

function render(shown: boolean) {
  root ??= createRoot(document.createElement('div'));
  act(() => root!.render(<Pane shown={shown} />));
}

describe('useParkedAnimations', () => {
  it('leaves a shown pane alone', () => {
    animations = [fakeAnimation('running')];
    render(true);
    act(() => { vi.advanceTimersByTime(100); });
    expect(getAnimations).not.toHaveBeenCalled();
    expect(animations[0].pause).not.toHaveBeenCalled();
  });

  it('pauses the running animations after the switch has painted, and plays them when shown again', () => {
    const running = fakeAnimation('running');
    const heldByDecorClock = fakeAnimation('paused');
    animations = [running, heldByDecorClock];
    render(true);
    render(false);
    // Not inside the switch: nothing is read or paused until a frame has passed.
    expect(getAnimations).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(100); });
    expect(getAnimations).toHaveBeenCalledWith({ subtree: true });
    expect(running.pause).toHaveBeenCalledTimes(1);
    expect(heldByDecorClock.pause).not.toHaveBeenCalled();
    render(true);
    expect(running.play).toHaveBeenCalledTimes(1);
    expect(running.playState).toBe('running');
    // Only what the hook paused is played: the decor clock keeps its own.
    expect(heldByDecorClock.play).not.toHaveBeenCalled();
  });

  it('does nothing when the pane is shown again before the pause ran', () => {
    animations = [fakeAnimation('running')];
    render(true);
    render(false);
    render(true);
    act(() => { vi.advanceTimersByTime(100); });
    expect(getAnimations).not.toHaveBeenCalled();
    expect(animations[0].pause).not.toHaveBeenCalled();
  });
});
