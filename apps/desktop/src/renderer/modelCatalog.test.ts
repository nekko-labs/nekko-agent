import { describe, expect, it, vi } from 'vitest';
import type { DownloadJob, ProviderConfig } from '@nekko-agent/shared';
import { modelCatalogVersion, newlyFinished, notifyModelsChanged, subscribeModelCatalog } from './modelCatalog.js';
import { useStore } from './store.js';

const job = (id: string, state: DownloadJob['state']): DownloadJob => ({ id, kind: 'model', label: id, target: id, state, receivedBytes: 0, startedAt: 0 });
const provider = (id: string, enabled = true) => ({ id, kind: 'openai', label: id, baseUrl: 'http://x', enabled }) as unknown as ProviderConfig;

describe('the model catalog signal (#3121)', () => {
  it('counts a finished download once', () => {
    const seen = new Set<string>();
    expect(newlyFinished(seen, [job('a', 'downloading')])).toBe(false);
    expect(newlyFinished(seen, [job('a', 'done')])).toBe(true);
    expect(newlyFinished(seen, [job('a', 'done'), job('b', 'failed')])).toBe(false);
    expect(newlyFinished(seen, [job('a', 'done'), job('c', 'done')])).toBe(true);
  });

  it('moves when a download lands, a catalog changes or a provider changes, and not otherwise', () => {
    let onDownloads!: (jobs: DownloadJob[]) => void;
    let onModels!: (e: { providerId: string }) => void;
    const offDownloads = vi.fn();
    vi.stubGlobal('window', { nekko: {
      onDownloadsUpdated: (cb: typeof onDownloads) => { onDownloads = cb; return offDownloads; },
      onModelsUpdated: (cb: typeof onModels) => { onModels = cb; return () => {}; },
    } });
    useStore.setState({ providers: [provider('p1')] });
    const heard = vi.fn();
    const off = subscribeModelCatalog(heard);
    const start = modelCatalogVersion();

    onDownloads([job('qwen-image', 'downloading')]);
    expect(heard).not.toHaveBeenCalled();
    onDownloads([job('qwen-image', 'done')]);
    expect(modelCatalogVersion()).toBe(start + 1);
    onDownloads([job('qwen-image', 'done')]);
    expect(modelCatalogVersion()).toBe(start + 1);

    onModels({ providerId: 'p1' });
    expect(modelCatalogVersion()).toBe(start + 2);

    // The same providers again (every refresh is a new array) is no change.
    useStore.setState({ providers: [provider('p1')] });
    expect(modelCatalogVersion()).toBe(start + 2);
    useStore.setState({ providers: [provider('p1', false)] });
    expect(modelCatalogVersion()).toBe(start + 3);
    useStore.setState({ providers: [provider('p1', false), provider('p2')] });
    expect(modelCatalogVersion()).toBe(start + 4);

    notifyModelsChanged();
    expect(heard).toHaveBeenCalledTimes(5);

    off();
    expect(offDownloads).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
});
