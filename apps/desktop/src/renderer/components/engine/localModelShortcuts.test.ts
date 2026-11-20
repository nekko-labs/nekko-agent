import { describe, expect, it } from 'vitest';
import type { LocalModel } from '@nekko-agent/shared';
import { RECENT_SHOWN, STARRED_SHOWN, localModelShortcuts, noteLocalModelsUsed, readRecentLocalModels } from './localModelShortcuts.js';

const model = (id: string, extra: Partial<LocalModel> = {}) => ({ id, name: id.toUpperCase(), path: `/m/${id}.gguf`, sizeBytes: 1, addedAt: 0, ...extra }) as LocalModel;

function memoryStorage() {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
}

describe('localModelShortcuts', () => {
  const models = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => model(id));

  it("offers starred engine models in starred order, skipping loaded ones, other providers and models no longer on disk", () => {
    const { starred } = localModelShortcuts({ models, resident: ['b'], favorites: ['nekko-engine::c', 'openai::a', 'nekko-engine::b', 'nekko-engine::gone', 'nekko-engine::a'], seen: [], chats: [] });
    expect(starred.map((m) => m.id)).toEqual(['c', 'a']);
  });

  it('caps starred and recent', () => {
    const favorites = models.map((m) => `nekko-engine::${m.id}`);
    expect(localModelShortcuts({ models, resident: [], favorites, seen: [], chats: [] }).starred).toHaveLength(STARRED_SHOWN);
    const seen = models.map((m, i) => ({ id: m.id, at: i }));
    expect(localModelShortcuts({ models, resident: [], favorites: [], seen, chats: [] }).recent).toHaveLength(RECENT_SHOWN);
  });

  it('merges what was seen loaded with local chats, newest first, without repeating starred or loaded models', () => {
    const { recent } = localModelShortcuts({
      models,
      resident: ['e'],
      favorites: ['nekko-engine::a'],
      seen: [{ id: 'a', at: 900 }, { id: 'b', at: 100 }, { id: 'e', at: 800 }],
      chats: [
        { providerId: 'nekko-engine', modelId: 'c', updatedAt: 500 },
        { providerId: 'openai', modelId: 'd', updatedAt: 1000 },
        { providerId: 'nekko-engine', modelId: 'b', updatedAt: 700 },
      ],
    });
    expect(recent.map((m) => m.id)).toEqual(['b', 'c']);
  });

  it('counts a picture model like any other', () => {
    const pictures = [model('flux', { modality: 'image' })];
    expect(localModelShortcuts({ models: pictures, resident: [], favorites: [], seen: [{ id: 'flux', at: 1 }], chats: [] }).recent[0].id).toBe('flux');
  });
});

describe('recent local models', () => {
  it('keeps the latest time per model, newest first', () => {
    const storage = memoryStorage();
    noteLocalModelsUsed([{ id: 'a', at: 10 }, { id: 'b', at: 20 }], storage);
    noteLocalModelsUsed([{ id: 'a', at: 30 }, { id: 'b', at: 5 }], storage);
    expect(readRecentLocalModels(storage)).toEqual([{ id: 'a', at: 30 }, { id: 'b', at: 20 }]);
  });

  it('reads nothing from a missing or garbled entry', () => {
    expect(readRecentLocalModels(memoryStorage())).toEqual([]);
    expect(readRecentLocalModels({ getItem: () => '{not json' })).toEqual([]);
    expect(readRecentLocalModels({ getItem: () => JSON.stringify([{ id: 1 }, { id: 'ok', at: 2 }]) })).toEqual([{ id: 'ok', at: 2 }]);
  });
});
