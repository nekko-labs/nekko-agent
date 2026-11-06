import type { ProviderConfig } from '@nekko-agent/shared';

/** The automatically registered engine is not connected until it has a model. */
export function providerConnected(provider: Pick<ProviderConfig, 'kind' | 'enabled'>, modelId?: string | null): boolean {
  return provider.enabled && (provider.kind !== 'llamacpp' || Boolean(modelId));
}

/** The automatically registered engine is not a completed setup without a model. */
export function needsProviderSetup(providers: ProviderConfig[], modelId?: string | null): boolean {
  return !providers.some((p) => providerConnected(p, modelId));
}
