import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_RUNNER_SETTINGS, runnerWorkflowPrompt, type RunnerView, type Session } from '@nekko-agent/shared';

vi.hoisted(() => {
  (globalThis as { window?: unknown }).window = { innerWidth: 1280, addEventListener() {} };
});
const { useStore } = await import('../store.js');
const { RunnerReady, connectToWorkflow } = await import('./RunnerReady.js');

const view = {
  config: { id: 'r1', scope: { kind: 'repo', owner: 'nekko-labs', repo: 'nekko-agent' }, label: 'nekko-cloud-mac', settings: DEFAULT_RUNNER_SETTINGS },
  repos: [],
} as unknown as RunnerView;
const created: Session = { id: 'new_chat', title: 'New chat', createdAt: 1, updatedAt: 1, messages: [], providerId: 'p', modelId: 'm' };
const buttons = (html: string) => html.match(/<button/g)?.length ?? 0;
const provider = { id: 'p', kind: 'chatgpt', enabled: true };
const unset = { id: 'nekko-engine', kind: 'llamacpp', enabled: true };

beforeEach(() => {
  useStore.setState({ activeSessionId: 'old_chat', composerSeed: null, toasts: [], view: 'workflows', sessions: [], workspaces: [], providers: [], models: [], activeModelId: null, settings: { workspaces: [] } as never });
});

describe('RunnerReady', () => {
  it('ready_has_exactly_two_buttons', () => {
    const html = renderToStaticMarkup(<RunnerReady on onDone={() => {}} onWorkflow={() => {}} />);
    expect(html).toContain('This Mac is ready');
    expect(buttons(html)).toBe(2);
    for (const s of ['Done', 'Connect to a workflow now', 'runner-burst']) expect(html).toContain(s);
  });

  it('a_runner_left_off_is_never_called_ready', () => {
    const html = renderToStaticMarkup(<RunnerReady on={false} onDone={() => {}} onWorkflow={() => {}} />);
    expect(html).not.toContain('This Mac is ready');
    expect(html).not.toContain('runner-burst');
    expect(html).toContain('The runner is off.');
    expect(buttons(html)).toBe(1);
  });
});

describe('connectToWorkflow', () => {
  it('seeds_the_new_chat_and_sends_nothing', async () => {
    const send = vi.fn();
    window.nekko = { createSession: vi.fn().mockResolvedValue(created), listProviders: vi.fn().mockResolvedValue([provider]), listModels: vi.fn().mockResolvedValue([]), sendMessage: send } as unknown as typeof window.nekko;
    await connectToWorkflow(view);
    const s = useStore.getState();
    // The active id read after `newChat` is the new chat, not the one that was open.
    expect(s.activeSessionId).toBe(created.id);
    expect(s.composerSeed).toEqual({ sessionId: created.id, text: runnerWorkflowPrompt(view), images: [] });
    expect(s.view).toBe('command');
    expect(send).not.toHaveBeenCalled();
  });

  it('with_no_model_it_never_seeds_an_old_chat', async () => {
    window.nekko = { createSession: vi.fn(), listProviders: vi.fn().mockResolvedValue([unset]), listModels: vi.fn().mockResolvedValue([]) } as unknown as typeof window.nekko;
    await connectToWorkflow(view);
    const s = useStore.getState();
    expect(s.view).toBe('models');
    expect(s.composerSeed).toBeNull();
    expect(s.toasts[0]).toMatchObject({ kind: 'info' });
  });

  it('a_chat_that_cannot_open_says_so', async () => {
    window.nekko = { createSession: vi.fn().mockRejectedValue(new Error('No folder.')), listProviders: vi.fn().mockResolvedValue([provider]), listModels: vi.fn().mockResolvedValue([]) } as unknown as typeof window.nekko;
    await connectToWorkflow(view);
    expect(useStore.getState().composerSeed).toBeNull();
    expect(useStore.getState().toasts[0]).toMatchObject({ kind: 'error', message: 'Could not open a new chat: No folder.' });
  });
});
