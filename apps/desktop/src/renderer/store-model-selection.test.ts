import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTO_MODEL_ID } from '@nekko-agent/shared';
import type { ModelInfo } from '@nekko-agent/shared';

vi.hoisted(() => {
  Object.assign(globalThis, { window: { innerWidth: 1280, addEventListener() {} }, localStorage: { getItem: () => null } });
});
const { useStore } = await import('./store.js');
const sol: ModelInfo = { id: 'gpt-6.1-sol', providerId: 'chatgpt', name: 'GPT-6.1 Sol' };

beforeEach(() => {
  useStore.setState({ activeProviderId: 'chatgpt', activeModelId: sol.id, models: [sol], settings: null, toasts: [] });
  window.nekko = {
    listModels: vi.fn().mockResolvedValue([]),
    updateSettings: vi.fn().mockResolvedValue({ defaultProviderId: 'chatgpt', defaultModelId: sol.id }),
  } as unknown as typeof window.nekko;
});

describe('default model persistence', () => {
  it('does not associate the existing default model with a browsed provider', async () => {
    await useStore.getState().selectProvider('lmstudio');
    expect(useStore.getState().activeModelId).toBeNull();
    expect(window.nekko.updateSettings).not.toHaveBeenCalled();
  });

  it('does not rewrite defaults when loading the selected provider catalog', async () => {
    vi.mocked(window.nekko.listModels).mockResolvedValue([sol]);
    await useStore.getState().selectProvider('chatgpt');
    expect(useStore.getState().activeModelId).toBe(sol.id);
    expect(window.nekko.updateSettings).not.toHaveBeenCalled();
  });

  it('persists an explicit model choice as a pair and refreshes the default badge', async () => {
    useStore.getState().selectModel(sol.id);
    await vi.waitFor(() => expect(useStore.getState().settings?.defaultProviderId).toBe('chatgpt'));
    expect(window.nekko.updateSettings).toHaveBeenCalledWith({ defaultProviderId: 'chatgpt', defaultModelId: sol.id });
    expect(useStore.getState().settings?.defaultModelId).toBe(sol.id);
  });

  it('ignores a stale catalog after another provider was selected', async () => {
    let finish!: (models: ModelInfo[]) => void;
    vi.mocked(window.nekko.listModels).mockImplementation((id) => id === 'slow'
      ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve([sol]));
    const slow = useStore.getState().selectProvider('slow');
    await useStore.getState().selectProvider('chatgpt');
    finish([]);
    await slow;
    expect(useStore.getState().models).toEqual([sol]);
    expect(useStore.getState().activeModelId).toBe(sol.id);
  });
});

describe('window model choices', () => {
  it('persists the explicit pair without changing another pane or active catalog', async () => {
    useStore.getState().rememberModel('local', AUTO_MODEL_ID);
    await vi.waitFor(() => expect(window.nekko.updateSettings).toHaveBeenCalled());
    expect(window.nekko.updateSettings).toHaveBeenCalledExactlyOnceWith({ defaultProviderId: 'local', defaultModelId: AUTO_MODEL_ID });
    expect(useStore.getState().activeProviderId).toBe('chatgpt');
    expect(useStore.getState().activeModelId).toBe(sol.id);
    expect(useStore.getState().models).toEqual([sol]);
  });
  it('reports failed default saves and keeps the last saved settings', async () => {
    vi.mocked(window.nekko.updateSettings).mockRejectedValue(new Error('save failed'));
    useStore.getState().rememberModel('local', 'exact');
    await vi.waitFor(() => expect(useStore.getState().toasts).toHaveLength(1));
    expect(useStore.getState().settings).toBeNull();
  });
  it('does not save an incomplete pair', () => {
    useStore.getState().rememberModel('', sol.id);
    expect(window.nekko.updateSettings).not.toHaveBeenCalled();
  });
});

describe('startup default restoration', () => {
  it('loads the saved provider catalog after settings, not the first listed provider', async () => {
    useStore.setState({ activeProviderId: null, activeModelId: null, models: [] });
    window.nekko.getSettings = vi.fn().mockResolvedValue({ defaultProviderId: 'chatgpt', defaultModelId: sol.id, workspaces: [] });
    window.nekko.listProviders = vi.fn().mockResolvedValue([{ id: 'first' }, { id: 'chatgpt' }]);
    vi.mocked(window.nekko.listModels).mockResolvedValue([sol]);
    const applyTheme = useStore.getState().applyTheme;
    useStore.setState({ applyTheme: vi.fn() });
    try {
      await useStore.getState().refreshSettings().then(() => useStore.getState().refreshProviders());
    } finally { useStore.setState({ applyTheme }); }
    expect(window.nekko.listModels).toHaveBeenCalledExactlyOnceWith('chatgpt');
    expect(useStore.getState().activeModelId).toBe(sol.id);
    expect(window.nekko.updateSettings).not.toHaveBeenCalled();
  });
});
