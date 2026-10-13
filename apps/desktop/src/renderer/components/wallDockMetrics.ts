import { isLocalProvider } from '@nekko-agent/shared';
import type { ResidentModel, RuntimeStatus } from '@nekko-agent/shared';
import { formatBytes } from './runtimes/verdict.js';
import { insightDays, type InsightRange } from '../insightRanges.js';

export function localRuntimeMetrics(statuses: RuntimeStatus[], now = Date.now()): { loadedModels: string; memoryLabel: string; lastTokPerSecond: string; recent: Array<{ id: string; placement?: string; lastUsed?: string }> } {
  const resident = statuses.flatMap((s) => s.resident ?? []);
  const vram = resident.reduce((n, r) => n + (r.vramBytes ?? 0), 0);
  const total = resident.reduce((n, r) => n + (r.sizeBytes ?? 0), 0);
  const byRecent = [...resident].sort((a, b) => (b.lastUsedAt ?? b.startedAt ?? 0) - (a.lastUsedAt ?? a.startedAt ?? 0)).slice(0, 3);
  return {
    loadedModels: resident.length ? String(resident.length) : statuses.some((s) => s.running) ? 'None loaded' : 'Runtime stopped or unavailable',
    memoryLabel: resident.length === 0 ? 'Unavailable' : [vram > 0 ? formatBytes(vram) + ' VRAM' : null, total > 0 ? formatBytes(total) + ' total' : null].filter(Boolean).join(' / ') || 'Reported without byte totals',
    lastTokPerSecond: runtimeTokPerSecond(statuses) ?? 'Unavailable',
    recent: byRecent.map((r) => ({ id: r.id, placement: placementSummary(r), lastUsed: r.lastUsedAt ? age(now - r.lastUsedAt) : undefined })),
  };
}

function runtimeTokPerSecond(_statuses: RuntimeStatus[]): string | null {
  // RuntimeStatus currently reports queue/KV-cache highlights and residency, not throughput.
  return null;
}

function placementSummary(r: ResidentModel): string | undefined {
  if (r.loadedOn === 'gpu') return 'GPU';
  if (r.loadedOn === 'gpu+cpu') return 'GPU + CPU';
  if (r.loadedOn === 'cpu') return 'CPU';
  return undefined;
}

function age(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' min ago';
  const h = Math.floor(m / 60);
  return h + ' hr ago';
}

/**
 * Spend and tokens over one of the Insights time ranges, from the usage
 * summary's UTC daily buckets. `null` when there is no usage snapshot.
 */
export function budgetRange(usage: import('@nekko-agent/shared').UsageSummary | null, range: InsightRange, now = new Date()) {
  if (!usage) return null;
  const daily = insightDays(usage.daily, range, now);
  const bySessionCost: Record<string, number> = {};
  const avoided = { local: 0, subscription: 0, benchmarkTokens: 0, unpricedTokens: 0 };
  for (const d of daily) {
    for (const [id, cost] of Object.entries(d.bySessionCost ?? {})) bySessionCost[id] = (bySessionCost[id] ?? 0) + cost;
    for (const key of ['local', 'subscription', 'benchmarkTokens', 'unpricedTokens'] as const) avoided[key] += d.avoidedCosts?.[key] ?? 0;
  }
  return {
    daily,
    spend: daily.reduce((sum, d) => sum + (d.cost ?? 0), 0),
    input: daily.reduce((sum, d) => sum + d.input, 0),
    output: daily.reduce((sum, d) => sum + d.output, 0),
    bySessionCost: daily.every(d => d.bySessionCost != null) ? bySessionCost : null,
    localTokens: daily.every(d => d.localTokens != null) ? daily.reduce((sum, d) => sum + d.localTokens!, 0) : null,
    avoidedCosts: daily.every(d => d.avoidedCosts != null) ? avoided : null,
    modelIds: [...new Set(daily.flatMap(d => d.modelIds ?? []))],
  };
}

/** How a range reads in the Budget panel's labels. */
export const BUDGET_RANGE_LABEL: Record<InsightRange, string> = { today: 'Today', '1wk': 'Last 7 days', '1m': 'Last 30 days', '6m': 'Last 6 months', '1y': 'Last year', 'all-time': 'All time' };

export function recordedBudgetMetrics(usage: import('@nekko-agent/shared').UsageSummary | null, sessions: import('@nekko-agent/shared').SessionSummary[], providers: import('@nekko-agent/shared').ProviderConfig[]) {
  if (!usage) return { topAgent: 'Unavailable', localTokens: 'Unavailable' };
  const top = Object.entries(usage.bySession).sort((a, b) => (b[1].input + b[1].output) - (a[1].input + a[1].output))[0];
  const localIds = new Set(providers.filter(p => isLocalProvider(p.kind)).map(p => p.id));
  const tokens = Object.entries(usage.byProvider).filter(([id]) => localIds.has(id)).reduce((sum, [, v]) => sum + v.input + v.output, 0);
  return { topAgent: top ? (sessions.find(s => s.id === top[0])?.title ?? top[0]) + ' · ' + (top[1].input + top[1].output).toLocaleString() + ' tokens' : 'No recorded usage', localTokens: tokens.toLocaleString() };
}
 

/** Display-only dedupe; keep independently configured accounts and API entries. */
export function utilizationProviders(providers: import('@nekko-agent/shared').ProviderConfig[]) {
  const enabled = providers.filter(p => p.enabled && !isLocalProvider(p.kind));
  const claude = (p: import('@nekko-agent/shared').ProviderConfig) => p.auth === 'subscription' && (p.kind === 'anthropic' || p.tokenKey === 'claude' || p.tokenKey?.startsWith('claude:'));
  return enabled.filter((p, index) => {
    if (!claude(p) || !p.tokenKey) return true;
    const peers = enabled.filter(other => claude(other) && other.tokenKey === p.tokenKey);
    const preferred = peers.find(other => other.kind === 'anthropic') ?? peers[0];
    return enabled.indexOf(preferred) === index;
  });
}
