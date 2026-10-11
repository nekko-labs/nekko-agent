/** Local quota observations, deliberately separate from credentials and content. */
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderConfig, SubscriptionLimits } from '@nekko-agent/shared';
import { dataDir } from './paths.js';
import { getSettings } from './store.js';

/**
 * The history line for one observation: only explicitly selected quota fields,
 * and nothing for a key no configured provider owns. Pure, so the engine
 * daemon's port (crates/nekko-usage) is held to it by a golden set.
 */
export function quotaHistoryRecord(
  providers: ProviderConfig[],
  tokenKey: string,
  source: 'poll' | 'headers',
  limits: SubscriptionLimits,
): Record<string, unknown> | undefined {
  const provider = providers.find((p) => p.tokenKey === tokenKey)
    ?? providers.find((p) => tokenKey === `provider:${p.id}` && p.enabled);
  if (!provider) return undefined;
  return {
    timestamp: limits.updatedAt,
    providerId: provider.id,
    source,
    windows: limits.windows.map((window) => ({
      id: window.id,
      scope: window.scope,
      usedPercent: window.usedPercent,
      resetsAt: window.resetAt,
      status: window.status,
    })),
  };
}

/** Append only explicitly selected quota fields. Unknown providers are not recorded. */
export function recordQuotaHistory(tokenKey: string, source: 'poll' | 'headers', limits: SubscriptionLimits): void {
  try {
    const record = quotaHistoryRecord(getSettings().providers, tokenKey, source, limits);
    if (!record) return;
    appendFileSync(join(dataDir(), 'quota-history.jsonl'), JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch {
    // History must never interrupt a limits read or a chat response.
  }
}
