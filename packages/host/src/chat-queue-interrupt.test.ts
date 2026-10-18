import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderConfig } from '@nekko-agent/shared';
import type { Provider } from '@nekko-agent/core';

let started: (() => void) | undefined;
let calls = 0;
vi.mock('@nekko-agent/core', async () => {
  const actual = await vi.importActual<typeof import('@nekko-agent/core')>('@nekko-agent/core');
  return {
    ...actual,
    createProvider: (config: ProviderConfig): Provider => ({
      config,
      listModels: async () => [],
      test: async () => ({ ok: true, message: '' }),
      async *chat(request) {
        const signal = request.signal;
        calls++;
        started?.();
        if (calls === 1) {
          await new Promise<void>((resolve) => {
            if (signal?.aborted) resolve();
            else signal?.addEventListener('abort', () => resolve(), { once: true });
          });
        }
        yield { type: 'text' as const, delta: 'reply' };
        yield { type: 'done' as const };
      },
    }),
  };
});

const { createHost } = await import('./host.js');
const { getSession } = await import('./sessions.js');
const { IpcChannels } = await import('@nekko-agent/shared');
const { createDispatcher } = await import('./dispatch.js');

beforeEach(() => { calls = 0; started = undefined; });

describe('session options', () => {
  it('rejects git isolation switches while a chat is running', async () => {
    const host = createHost({ dataDir: mkdtempSync(join(tmpdir(), 'nekko-options-')) });
    host.saveProvider({ id: 'p', kind: 'openai-compat', label: 'Test', baseUrl: 'http://localhost:1/v1', enabled: true });
    const s = host.createSession();
    host.setSessionOptions(s.id, { providerId: 'p', modelId: 'm' });
    let ready!: () => void;
    const entered = new Promise<void>((resolve) => { ready = resolve; });
    started = ready;
    const running = host.sendChat({ sessionId: s.id, providerId: 'p', modelId: 'm', text: 'old' });
    await entered;
    expect(() => host.setSessionOptions(s.id, { gitIsolation: false })).toThrow(/Git isolation/);
    expect(() => host.setSessionOptions(s.id, { title: 'Still allowed' })).not.toThrow();
    host.abortChat(s.id);
    await running;
    // A finished turn is still nonempty: execution environment remains immutable.
    expect(() => host.setSessionOptions(s.id, { gitIsolation: false })).toThrow(/empty, idle chat/);
    const empty = host.createSession();
    expect(host.setSessionOptions(empty.id, { gitIsolation: false })?.gitIsolation).toBe(false);
  });
});

describe('interrupt queued prompt', () => {
  it('rejects overlapping sends even during admission, without losing queued follow-ups', async () => {
    const host = createHost({ dataDir: mkdtempSync(join(tmpdir(), 'nekko-busy-')) });
    host.saveProvider({ id: 'p', kind: 'openai-compat', label: 'Test', baseUrl: 'http://localhost:1/v1', enabled: true });
    const s = host.createSession();
    host.setSessionOptions(s.id, { providerId: 'p', modelId: 'm' });
    let ready!: () => void;
    const entered = new Promise<void>((resolve) => { ready = resolve; });
    started = ready;
    const options = { sessionId: s.id, providerId: 'p', modelId: 'm', text: 'first' };
    const running = host.sendChat(options);
    expect(() => host.sendChat({ ...options, text: 'overlap' })).toThrow(/already running/);
    await entered;
    expect(() => host.sendChat({ ...options, text: 'overlap' })).toThrow(/already running/);
    host.queuePrompt(s.id, 'queued follow-up');
    host.abortChat(s.id);
    await running;
    expect(getSession(s.id)?.queue).toEqual(['queued follow-up']);
    await host.interruptQueuedPrompt(s.id, 0);
    expect(getSession(s.id)?.queue).toEqual([]);
    expect(getSession(s.id)?.messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['first', 'queued follow-up']);
  });

  it('rejects invalid indices without stopping the active turn', async () => {
    const host = createHost({ dataDir: mkdtempSync(join(tmpdir(), 'nekko-queue-')) });
    const s = host.createSession();
    host.queuePrompt(s.id, 'one');
    await expect(host.interruptQueuedPrompt(s.id, -1)).rejects.toThrow('Queued prompt not found');
    await expect(host.interruptQueuedPrompt(s.id, 1)).rejects.toThrow('Queued prompt not found');
    expect(getSession(s.id)?.queue).toEqual(['one']);
  });

  it('keeps a selected prompt queued when the provider cannot start', async () => {
    const host = createHost({ dataDir: mkdtempSync(join(tmpdir(), 'nekko-queue-')) });
    const s = host.createSession();
    host.setSessionOptions(s.id, { providerId: 'missing', modelId: 'm' });
    host.queuePrompt(s.id, 'one');
    await host.interruptQueuedPrompt(s.id, 0);
    expect(getSession(s.id)?.queue).toEqual(['one']);
    expect(getSession(s.id)?.messages).toEqual([]);
  });

  it('uses the concrete model selected for an Auto queued message', async () => {
    const host = createHost({ dataDir: mkdtempSync(join(tmpdir(), 'nekko-queue-')) });
    host.saveProvider({ id: 'p', kind: 'openai-compat', label: 'Test', baseUrl: 'http://localhost:1/v1', enabled: true });
    const s = host.createSession();
    host.setSessionOptions(s.id, { providerId: 'p', modelId: 'old', autoModel: true });
    host.queuePrompt(s.id, 'selected');
    calls = 1; // the mock only parks its first provider call
    const events: string[] = [];
    host.events.on('agentEvent', (event) => { if (event.sessionId === s.id) events.push(event.type); });
    await createDispatcher(host)(IpcChannels.chatInterruptQueued, [s.id, 0, { providerId: 'p', modelId: 'new' }]);
    expect(events).toContain('session_meta');
    expect(getSession(s.id)?.modelId).toBe('new');
    expect(getSession(s.id)?.queue).toEqual([]);
  });

  it('does not consume a queued item when Auto has no concrete model', async () => {
    const host = createHost({ dataDir: mkdtempSync(join(tmpdir(), 'nekko-queue-')) });
    const s = host.createSession();
    host.setSessionOptions(s.id, { autoModel: true });
    host.queuePrompt(s.id, 'selected');
    await expect(host.interruptQueuedPrompt(s.id, 0, { providerId: 'p', modelId: '__auto__' })).rejects.toThrow('Choose a provider');
    expect(getSession(s.id)?.queue).toEqual(['selected']);
  });

  it('preserves queued images and skill metadata through interrupt send', async () => {
    const host = createHost({ dataDir: mkdtempSync(join(tmpdir(), 'nekko-queue-')) });
    host.saveProvider({ id: 'p', kind: 'openai-compat', label: 'Test', baseUrl: 'http://localhost:1/v1', enabled: true });
    const s = host.createSession();
    host.setSessionOptions(s.id, { providerId: 'p', modelId: 'm' });
    calls = 1;
    host.queuePrompt(s.id, { text: 'with metadata', images: ['data:image/png;base64,abc'], skill: { name: 'review', input: 'with metadata' } });
    await host.interruptQueuedPrompt(s.id, 0);
    const user = getSession(s.id)?.messages.find((m) => m.role === 'user');
    expect(user).toMatchObject({ content: 'with metadata', images: ['data:image/png;base64,abc'], skill: { name: 'review', input: 'with metadata' } });
    expect(getSession(s.id)?.queue).toEqual([]);
  });

  it('auto-drains queued images and skill metadata after the current turn', async () => {
    const host = createHost({ dataDir: mkdtempSync(join(tmpdir(), 'nekko-queue-')) });
    host.saveProvider({ id: 'p', kind: 'openai-compat', label: 'Test', baseUrl: 'http://localhost:1/v1', enabled: true });
    const s = host.createSession();
    host.setSessionOptions(s.id, { providerId: 'p', modelId: 'm' });
    host.queuePrompt(s.id, { text: 'next', images: ['img'], skill: { name: 'summarize', input: 'next' } });
    calls = 1;
    await host.sendChat({ sessionId: s.id, providerId: 'p', modelId: 'm', text: 'first' });
    expect(getSession(s.id)?.messages.filter((m) => m.role === 'user').map((m) => ({ content: m.content, images: m.images, skill: m.skill }))).toEqual([
      { content: 'first', images: undefined, skill: undefined },
      { content: 'next', images: ['img'], skill: { name: 'summarize', input: 'next' } },
    ]);
    expect(getSession(s.id)?.queue).toEqual([]);
  });

  it('stops the old turn then starts only the selected item, retaining the others', async () => {
    const host = createHost({ dataDir: mkdtempSync(join(tmpdir(), 'nekko-queue-')) });
    host.saveProvider({ id: 'p', kind: 'openai-compat', label: 'Test', baseUrl: 'http://localhost:1/v1', enabled: true });
    const s = host.createSession();
    host.setSessionOptions(s.id, { providerId: 'p', modelId: 'm' });
    let ready!: () => void;
    const entered = new Promise<void>((resolve) => { ready = resolve; });
    started = ready;
    const old = host.sendChat({ sessionId: s.id, providerId: 'p', modelId: 'm', text: 'old' });
    await entered;
    host.queuePrompt(s.id, 'first');
    host.queuePrompt(s.id, 'selected');
    host.queuePrompt(s.id, 'last');
    await createDispatcher(host)(IpcChannels.chatInterruptQueued, [s.id, 1]);
    await old;
    expect(getSession(s.id)?.messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['old', 'selected', 'first', 'last']);
    expect(getSession(s.id)?.queue).toEqual([]);
  });
});
