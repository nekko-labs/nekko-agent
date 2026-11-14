import { describe, expect, it } from 'vitest';
import type { ModelInfo } from './models.js';
import { fusionEnabled, modelCapability, fusionStrategy, FUSION_STRATEGIES } from './fusion.js';
import { pickAcrossProviders, modelTier } from './model-select.js';
import type { ProviderPool } from './model-select.js';
const model = (id: string, providerId = 'cloud'): ModelInfo => ({ id, providerId, name: id });
const pool = (providerId: string, ids: string[], local = false): ProviderPool => ({ providerId, providerLabel: providerId, models: ids.map((id) => model(id, providerId)), local });

describe('Fusion permissions and capability scale', () => {
  it('requires both saved flags and never overrides privacy', () => {
    for (const autoModel of [false, true]) for (const autoProviderSwitch of [false, true]) {
      expect(fusionEnabled({ autoModel, autoProviderSwitch })).toBe(autoModel && autoProviderSwitch);
    }
    for (const privacy of ['offline', 'incognito']) expect(fusionEnabled({ autoModel: true, autoProviderSwitch: true, [privacy]: true })).toBe(false);
    expect(fusionEnabled()).toBe(false);
  });
  it('classifies small variants before top families, with provider-scoped overrides', () => {
    expect(modelCapability(model('gpt-5-mini')).tier).toBe('small');
    expect(modelCapability(model('claude-sonnet')).tier).toBe('medium');
    expect(modelCapability(model('claude-opus')).tier).toBe('large');
    expect(modelCapability(model('qwen-32b')).tier).toBe('medium');
    expect(modelCapability(model('qwen-8b')).tier).toBe('small');
    expect(modelCapability(model('llama-70b')).tier).toBe('large');
    expect(modelCapability(model('llama-405b')).tier).toBe('frontier');
    expect(modelCapability(model('mystery')).source).toBe('unknown');
    const overrides = { 'cloud::mystery': 'frontier' as const };
    expect(modelCapability(model('mystery'), overrides)).toEqual({ tier: 'frontier', source: 'user' });
    expect(modelCapability(model('mystery', 'another'), overrides).tier).toBeUndefined();
    expect(modelTier(model('gpt-5-mini'), { 'cloud::gpt-5-mini': 'small' })).toBeLessThan(modelTier(model('gpt-5')));
  });
  it('defaults safely when a persisted strategy is unknown', () => {
    expect(fusionStrategy({ strategy: 'invalid' as never })).toBe('balanced');
  });
});

describe('Fusion strategies', () => {
  const cloud = pool('cloud', ['claude-haiku', 'claude-sonnet', 'claude-opus']);
  const local = pool('local', ['qwen-8b', 'qwen-32b'], true);
  const pick = (strategy: typeof FUSION_STRATEGIES[number]['id'], prompt = 'hello', pools = [cloud, local]) => pickAcrossProviders(pools, prompt, { strategy, switchOnCapacity: true, homeProviderId: 'cloud' });
  it('does not grant switching just because a strategy was saved', () => {
    expect(pickAcrossProviders([cloud, local], 'hello', { strategy: 'local-first', homeProviderId: 'cloud' })?.providerId).toBe('cloud');
  });
  it('quality chooses the strongest; balanced and economical choose suitable lower tiers', () => {
    expect(pick('quality')?.modelId).toBe('claude-opus');
    expect(pick('balanced')?.modelId).toBe('qwen-8b');
    expect(pick('economical')?.tier).toBe(2);
    expect(pick('balanced', 'Architect a distributed system')?.tier).toBe(3);
  });
  it('local-first requires a suitable tier, rather than silently downgrading', () => {
    expect(pick('local-first', 'Architect a distributed system')?.modelId).toBe('qwen-32b');
    expect(pick('local-first', 'Architect a distributed system', [cloud, pool('local', ['qwen-8b'], true)])?.modelId).toBe('claude-sonnet');
  });
  it('capacity fallback stays home while healthy', () => {
    expect(pick('capacity')?.providerId).toBe('cloud');
  });
  it('unknown and non-chat models are excluded from tier routing', () => {
    expect(pick('quality', 'hello', [pool('cloud', ['mystery', 'text-embedding-3-small'])])).toBeNull();
  });
  it('routes even if the home catalog is empty', () => {
    expect(pick('balanced', 'hello', [pool('cloud', []), local])?.modelId).toBe('qwen-8b');
  });
  it('reports no eligible model rather than pretending the blocked home pick can run', () => {
    const blocked = { ...cloud, models: cloud.models.map((m) => ({ ...m, availability: { status: 'blocked' as const, reason: 'rate-limited' as const, detail: 'Blocked' } })) };
    expect(pick('quality', 'hello', [blocked])).toBeNull();
  });
  it('economical can prefer a cheaper larger model while balanced prefers the closest tier', () => {
    const pools = [pool('cloud', ['gpt-5-mini']), pool('local', ['llama-70b'], true)];
    expect(pick('balanced', 'hello', pools)?.modelId).toBe('gpt-5-mini');
    expect(pick('economical', 'hello', pools)?.modelId).toBe('llama-70b');
  });
  it('capacity fallback retains a ready model on a partly blocked provider', () => {
    const partiallyBlocked = { ...cloud, models: cloud.models.map((m) => m.id === 'claude-opus' ? { ...m, availability: { status: 'blocked' as const, reason: 'rate-limited' as const } } : m) };
    expect(pick('capacity', 'hello', [partiallyBlocked, local])?.providerId).toBe('cloud');
  });
  it('manual tiers affect Fusion selection without classifying a same-named model on another provider', () => {
    const pools = [cloud, pool('local', ['custom'], true), pool('other', ['custom'], true)];
    expect(pickAcrossProviders(pools, 'hello', { strategy: 'quality', switchOnCapacity: true, homeProviderId: 'cloud', tierOverrides: { 'local::custom': 'frontier' } })?.providerId).toBe('local');
  });

});
