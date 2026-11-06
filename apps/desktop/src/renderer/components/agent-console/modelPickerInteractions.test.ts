import { describe, expect, it } from 'vitest';
import type { ModelInfo, ProviderConfig } from '@nekko-agent/shared';
import { AUTO_MODEL_ID } from '@nekko-agent/shared';
import {
  filteredModelGroups,
  isModelPickerEscape,
  matchesModelQuery,
  modelRowLabel,
  nextFavoriteModels,
  reconcileModelAfterList,
  shouldDismissModelPickerPointer,
} from './modelPickerInteractions.js';

const providers = [
  { id: 'openai', kind: 'openai', label: 'OpenAI', enabled: true, baseUrl: 'https://example.invalid' },
  { id: 'local', kind: 'lmstudio', label: 'Local', enabled: true, baseUrl: 'http://127.0.0.1' },
] as ProviderConfig[];

const modelsByProvider: Record<string, ModelInfo[]> = {
  openai: [
    { id: 'gpt-5.1', providerId: 'openai', name: 'GPT 5.1' },
    { id: 'o4-mini', providerId: 'openai', name: 'Reasoning Mini' },
  ],
  local: [
    { id: 'qwen3-coder', providerId: 'local', name: 'Qwen Coder' },
  ],
};

describe('model picker focused interactions', () => {
  it('filters models by case-insensitive name or id and omits empty provider groups', () => {
    expect(matchesModelQuery(modelsByProvider.openai[0], '  GPT ')).toBe(true);
    expect(matchesModelQuery(modelsByProvider.openai[1], 'O4-MINI')).toBe(true);
    expect(matchesModelQuery(modelsByProvider.local[0], 'claude')).toBe(false);

    const groups = filteredModelGroups(providers, (providerId) => modelsByProvider[providerId] ?? [], 'coder');
    expect(groups).toHaveLength(1);
    expect(groups[0].provider.id).toBe('local');
    expect(groups[0].models.map((model) => model.id)).toEqual(['qwen3-coder']);
  });

  it('splits a local path-like id into a short name and its folder, and matches the file path', () => {
    expect(modelRowLabel({ id: 'lmstudio/pub/Qwen3-8B.gguf', name: 'lmstudio/pub/Qwen3-8B.gguf' }, true)).toEqual({ name: 'Qwen3-8B', sub: 'lmstudio/pub' });
    expect(modelRowLabel({ id: 'a/b', name: 'Friendly', details: { path: 'C:/m/b.gguf' } }, true)).toEqual({ name: 'Friendly', sub: 'C:/m/b.gguf' });
    expect(modelRowLabel({ id: 'meta/llama', name: 'meta/llama' }, false)).toEqual({ name: 'meta/llama', sub: undefined });
    expect(matchesModelQuery({ id: 'x', name: 'X', details: { path: 'D:/models/community/x.gguf' } }, 'community')).toBe(true);
  });

  it('adds and removes favorites without mutating the current settings list', () => {
    const current = ['openai::gpt-5.1'];
    expect(nextFavoriteModels(current, 'local::qwen3-coder')).toEqual(['openai::gpt-5.1', 'local::qwen3-coder']);
    expect(nextFavoriteModels(current, 'openai::gpt-5.1')).toEqual([]);
    expect(current).toEqual(['openai::gpt-5.1']);
  });

  it('dismisses for outside pointer targets but not trigger, popup, or context-menu targets', () => {
    const triggerChild = new EventTarget();
    const popupChild = new EventTarget();
    const menuItem = Object.assign(new EventTarget(), { closest: (selector: string) => selector === '[role=menu]' ? {} : null });
    const outside = new EventTarget();
    const trigger = { contains: (target: EventTarget) => target === triggerChild };
    const popup = { contains: (target: EventTarget) => target === popupChild };

    expect(shouldDismissModelPickerPointer(triggerChild, trigger, popup)).toBe(false);
    expect(shouldDismissModelPickerPointer(popupChild, trigger, popup)).toBe(false);
    expect(shouldDismissModelPickerPointer(menuItem, trigger, popup)).toBe(false);
    expect(shouldDismissModelPickerPointer(outside, trigger, popup)).toBe(true);
    expect(shouldDismissModelPickerPointer(null, trigger, popup)).toBe(true);
  });

  it('recognizes Escape as the only keyboard dismissal key', () => {
    expect(isModelPickerEscape({ key: 'Escape' } as KeyboardEvent)).toBe(true);
    expect(isModelPickerEscape({ key: 'Esc' } as KeyboardEvent)).toBe(false);
    expect(isModelPickerEscape({ key: 'Enter' } as KeyboardEvent)).toBe(false);
  });
});


describe('reconcileModelAfterList', () => {
  const listed = [{ id: 'a/b:free', providerId: 'or', name: 'B' }] as ModelInfo[];

  it('keeps a pick the list cannot confirm: the list failed or came back empty', () => {
    expect(reconcileModelAfterList('x/y', null, 'x/y')).toEqual({ modelId: 'x/y', unavailable: null });
    expect(reconcileModelAfterList('x/y', [], 'x/y')).toEqual({ modelId: 'x/y', unavailable: null });
  });

  it('marks a saved model unavailable when nobody just picked it and the list cannot confirm it', () => {
    expect(reconcileModelAfterList('x/y', null, null)).toEqual({ modelId: null, unavailable: 'x/y' });
    expect(reconcileModelAfterList('x/y', [], 'other')).toEqual({ modelId: null, unavailable: 'x/y' });
  });

  it('drops even a fresh pick when the provider answered without it', () => {
    expect(reconcileModelAfterList('x/y', listed, 'x/y')).toEqual({ modelId: null, unavailable: 'x/y' });
  });

  it('keeps a listed model, Auto and no model without marking anything', () => {
    expect(reconcileModelAfterList('a/b:free', listed, null)).toEqual({ modelId: 'a/b:free', unavailable: null });
    expect(reconcileModelAfterList(AUTO_MODEL_ID, null, null)).toEqual({ modelId: AUTO_MODEL_ID, unavailable: null });
    expect(reconcileModelAfterList(null, null, null)).toEqual({ modelId: null, unavailable: null });
  });
});
