import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  (globalThis as { window?: unknown }).window = { innerWidth: 1280, addEventListener() {} };
});

const { useStore } = await import('./store.js');

beforeEach(() => {
  useStore.setState({ settings: {} as never, view: 'command', localModelFocus: null });
});

describe('openLocalModelSettings', () => {
  it('goes to Model Server and asks for that model', () => {
    useStore.getState().openLocalModelSettings('qwen3-8b');
    expect(useStore.getState().view).toBe('modelserver');
    expect(useStore.getState().localModelFocus).toBe('qwen3-8b');
  });

  it('replaces an earlier request rather than queueing it', () => {
    useStore.getState().openLocalModelSettings('qwen3-8b');
    useStore.getState().openLocalModelSettings('gemma3-27b');
    expect(useStore.getState().localModelFocus).toBe('gemma3-27b');
  });

  it('is cleared once served', () => {
    useStore.getState().openLocalModelSettings('qwen3-8b');
    useStore.getState().clearLocalModelFocus();
    expect(useStore.getState().localModelFocus).toBeNull();
    expect(useStore.getState().view).toBe('modelserver');
  });
});
