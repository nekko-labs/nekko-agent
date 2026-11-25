// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { __resetLiveRuns, applyEvent, useLiveRunsVersion } from './liveRuns.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; __resetLiveRuns(); vi.unstubAllGlobals(); });

it('wakes a rail when a run starts or ends, not for each streamed token', () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal('cancelAnimationFrame', () => {});
  __resetLiveRuns();
  let renders = 0;
  function Rail() { useLiveRunsVersion(); renders += 1; return null; }
  root = createRoot(document.createElement('div'));
  act(() => root!.render(<Rail />));
  const flush = () => act(() => { frames.splice(0).forEach((cb) => cb(0)); });
  const base = renders;
  applyEvent({ type: 'text', sessionId: 'chat', delta: 'a' });
  flush();
  expect(renders).toBe(base + 1);
  for (let i = 0; i < 50; i++) { applyEvent({ type: 'text', sessionId: 'chat', delta: 'x' }); flush(); }
  expect(renders).toBe(base + 1);
  applyEvent({ type: 'done', sessionId: 'chat', messageId: 'm' });
  flush();
  expect(renders).toBe(base + 2);
});

it('wakes a rail when a sub-agent starts waiting on the person', () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal('cancelAnimationFrame', () => {});
  __resetLiveRuns();
  let renders = 0;
  function Rail() { useLiveRunsVersion(); renders += 1; return null; }
  root = createRoot(document.createElement('div'));
  act(() => root!.render(<Rail />));
  const flush = () => act(() => { frames.splice(0).forEach((cb) => cb(0)); });
  applyEvent({ type: 'text', sessionId: 'child', delta: 'a' });
  flush();
  const base = renders;
  applyEvent({ type: 'question', sessionId: 'child', callId: 'q1', question: 'Which one?' } as never);
  flush();
  expect(renders).toBe(base + 1);
});
