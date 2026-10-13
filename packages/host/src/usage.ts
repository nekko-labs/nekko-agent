import { appendFileSync, existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import type { UsageRecord, UsageSummary } from '@nekko-agent/shared';
import { DEFAULT_LOCAL_COST_BENCHMARK, estimateCost, isLocalProvider } from '@nekko-agent/shared';
import { getSettings } from './store.js';
import { dataDir } from './store.js';
import { clearReplies, replyStats } from './replies.js';

const LOG = () => join(dataDir(), 'usage.jsonl');

/** Delete the usage analytics log. */
export function clearUsage(): void {
  if (existsSync(LOG())) rmSync(LOG());
  clearReplies();
}

export function recordUsage(rec: UsageRecord): void {
  try {
    appendFileSync(LOG(), JSON.stringify(rec) + '\n', 'utf8');
  } catch {
    /* non-fatal */
  }
}

export function usageSummary(): UsageSummary {
  const summary: UsageSummary = { totalInput: 0, totalOutput: 0, totalCost: 0, byModel: {}, byProvider: {}, bySession: {}, bySessionCost: {}, daily: [] };
  const settings = getSettings();
  summary.avoidedCosts = { subscription: 0, local: 0, unpricedTokens: 0, benchmarkTokens: 0 };
  summary.bySessionAvoidedCosts = {};
  const replies = replyStats();
  if (replies) summary.replies = replies;
  if (!existsSync(LOG())) return summary;

  const dailyMap = new Map<string, UsageSummary['daily'][number]>();
  for (const line of readFileSync(LOG(), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r: UsageRecord;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    // Subscription providers charge through the user's plan, not per API token.
    const provider = settings.providers.find((p) => p.id === r.providerId);
    const local = r.local ?? (provider ? isLocalProvider(provider.kind) : false);
    const tokens = { inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadTokens: r.cacheReadTokens, cacheWriteTokens: r.cacheWriteTokens };
    const totalInput = r.inputTokens + (r.cacheReadTokens ?? 0) + (r.cacheWriteTokens ?? 0);
    const listCost = estimateCost(r.modelId, tokens) ?? 0;
    const cost = local || r.auth === 'subscription' ? 0 : listCost;
    const day = new Date(r.ts).toISOString().slice(0, 10);
    const d = dailyMap.get(day) ?? { date: day, input: 0, output: 0, cost: 0, bySessionCost: {}, localTokens: 0, avoidedCosts: { subscription: 0, local: 0, unpricedTokens: 0, benchmarkTokens: 0 }, modelIds: [] };
    if (local || r.auth === 'subscription') {
      const exact = estimateCost(r.modelId, tokens);
      const benchmark = local && exact == null ? estimateCost(settings.localCostBenchmark ?? DEFAULT_LOCAL_COST_BENCHMARK, tokens) : undefined;
      const equivalent = exact ?? benchmark;
      const buckets = [summary.avoidedCosts, d.avoidedCosts!];
      if (r.sessionId) buckets.push(summary.bySessionAvoidedCosts[r.sessionId] ??= { subscription: 0, local: 0, unpricedTokens: 0, benchmarkTokens: 0 });
      for (const bucket of buckets) {
        if (equivalent == null) bucket.unpricedTokens += totalInput + r.outputTokens;
        else bucket[local ? 'local' : 'subscription'] += equivalent;
        if (benchmark != null) bucket.benchmarkTokens += totalInput + r.outputTokens;
      }
    }
    summary.totalCacheRead = (summary.totalCacheRead ?? 0) + (r.cacheReadTokens ?? 0);
    summary.totalCacheWrite = (summary.totalCacheWrite ?? 0) + (r.cacheWriteTokens ?? 0);
    summary.totalInput += totalInput;
    summary.totalOutput += r.outputTokens;
    summary.totalCost += cost;

    const bm = (summary.byModel[r.modelId] ??= { input: 0, output: 0 });
    bm.input += totalInput;
    bm.output += r.outputTokens;
    bm.cost = (bm.cost ?? 0) + cost;
    if (r.auth === 'subscription') bm.subscription = true;

    const bp = (summary.byProvider[r.providerId] ??= { input: 0, output: 0 });
    bp.input += totalInput;
    bp.output += r.outputTokens;

    if (r.sessionId) {
      const bs = (summary.bySession[r.sessionId] ??= { input: 0, output: 0 });
      bs.input += totalInput;
      bs.output += r.outputTokens;
      bs.cost = (bs.cost ?? 0) + cost;
      bs.listCost = (bs.listCost ?? 0) + listCost;
      summary.bySessionCost[r.sessionId] = (summary.bySessionCost[r.sessionId] ?? 0) + cost;
    }

    if (r.auth === 'subscription') summary.hasSubscriptionUsage = true;

    if (r.sessionId) d.bySessionCost![r.sessionId] = (d.bySessionCost![r.sessionId] ?? 0) + cost;
    if (local) d.localTokens! += totalInput + r.outputTokens;
    if (!d.modelIds!.includes(r.modelId)) d.modelIds!.push(r.modelId);
    d.input += totalInput;
    d.output += r.outputTokens;
    d.cost += cost;
    dailyMap.set(day, d);
  }

  summary.daily = [...dailyMap.entries()]
    .map(([, v]) => v)
    .sort((a, b) => a.date.localeCompare(b.date));
  return summary;
}
