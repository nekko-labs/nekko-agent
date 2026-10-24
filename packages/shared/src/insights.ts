/**
 * Usage optimization insights, pure heuristics that turn the usage summary +
 * sessions + provider config into a small set of actionable, prioritized tips
 * ("you're spending $X on Opus for short chats, try a smaller model"). No
 * model calls, no I/O: just analysis of data the app already has, so it's
 * trivially unit-testable and safe to run on every Agent board render.
 */

import type { UsageSummary } from './settings.js';
import { estimateCostUSD } from './limits.js';
import type { ProviderConfig, ProviderKind } from './models.js';
import type { Session } from './chat.js';
import type { SessionSummary } from './session-summary.js';

export type TipSeverity = 'info' | 'suggest' | 'warn';

export interface OptimizationTip {
  id: string;
  severity: TipSeverity;
  title: string;
  detail: string;
  /** Rough monthly/observed dollars this tip could save, if quantifiable. */
  saving?: number;
}

const LOCAL_KINDS: ProviderKind[] = ['ollama', 'lmstudio', 'vllm'];

export interface InsightsInput {
  usage: UsageSummary | null;
  sessions: Array<Session | SessionSummary>;
  providers: ProviderConfig[];
}

/** A cheaper model name to suggest, given the priciest model in use. */
function cheaperAlternative(modelId: string): string | null {
  const id = modelId.toLowerCase();
  if (id.includes('opus')) return 'Sonnet or Haiku';
  if (id.includes('sonnet')) return 'Haiku';
  if (id.includes('gpt-4o') && !id.includes('mini')) return 'gpt-4o-mini';
  if (id.includes('o1') || id.includes('o3')) return 'a smaller GPT model';
  return null;
}

/**
 * Compute prioritized optimization tips. Returns at most `limit` tips, warnings
 * first, then by estimated saving.
 */
export function optimizationTips(input: InsightsInput, limit = 5): OptimizationTip[] {
  const { usage, sessions, providers } = input;
  const tips: OptimizationTip[] = [];
  if (!usage) return tips;

  const hasLocal = providers.some((p) => p.enabled && LOCAL_KINDS.includes(p.kind));

  // Per-model cost, to find the biggest spender. Prefer the pre-computed
  // value from usageSummary, which zeroes subscription providers.
  const modelCosts = Object.entries(usage.byModel)
    .map(([model, v]) => ({ model, cost: v.cost ?? estimateCostUSD(model, v.input, v.output), tokens: v.input + v.output }))
    .filter((m) => m.cost > 0)
    .sort((a, b) => b.cost - a.cost);
  const totalCost = modelCosts.reduce((s, m) => s + m.cost, 0);

  // 1. Cloud spend while a local model is available.
  if (hasLocal && totalCost > 0.01) {
    tips.push({
      id: 'use-local',
      severity: 'suggest',
      title: 'Route light chats to your local model',
      detail: `You've spent about ${money(totalCost)} on cloud models while a local server is connected. Sending quick questions to the local model would cost nothing.`,
      saving: totalCost * 0.5,
    });
  }

  // 2. Expensive model on short chats. Prefer pre-computed session cost
  // (which is $0 for subscription providers) so we don't flag them.
  const sessionCost = (s: Session | SessionSummary) => {
    const t = usage.bySession[s.id];
    return t ? (t.cost ?? estimateCostUSD(s.modelId, t.input, t.output)) : 0;
  };
  const pricedSessions = sessions.filter((s) => sessionCost(s) > 0);
  const shortExpensive = pricedSessions.filter((s) => {
    const msgs = 'messages' in s
      ? s.messages.filter((m) => m.role === 'user' || m.role === 'assistant').length
      : s.exchangeCount;
    return msgs <= 4 && sessionCost(s) > 0.02;
  });
  if (shortExpensive.length >= 2) {
    const spend = shortExpensive.reduce((sum, s) => sum + sessionCost(s), 0);
    const alt = cheaperAlternative(shortExpensive[0].modelId ?? '');
    tips.push({
      id: 'cheaper-for-short',
      severity: 'suggest',
      title: 'Use a smaller model for quick chats',
      detail: `${shortExpensive.length} short chats ran on a premium model (~${money(spend)}).${alt ? ` ${alt} would likely handle these for a fraction of the cost.` : ''}`,
      saving: spend * 0.7,
    });
  }

  // 3. Context-heavy prompts (input dwarfs output).
  const ratio = usage.totalOutput > 0 ? usage.totalInput / usage.totalOutput : 0;
  if (ratio >= 12 && usage.totalInput > 50000) {
    tips.push({
      id: 'prune-context',
      severity: 'warn',
      title: 'Your prompts are mostly context',
      detail: `Input tokens outweigh output ${Math.round(ratio)}:1. Trim attached files and use the Context Inspector to exclude sources you don't need, you pay for every context token each turn.`,
    });
  }

  // 4. Biggest cost driver (informational), only if non-trivial.
  if (modelCosts.length > 0 && totalCost > 0.05) {
    const top = modelCosts[0];
    const pct = Math.round((top.cost / totalCost) * 100);
    if (pct >= 50 && modelCosts.length > 1) {
      tips.push({
        id: 'top-driver',
        severity: 'info',
        title: 'One model drives most of your cost',
        detail: `${top.model} accounts for ~${pct}% of estimated spend (${money(top.cost)}). Worth checking it's the right default.`,
      });
    }
  }

  // 5. No favorites pinned but many models used, minor nudge.
  if (Object.keys(usage.byModel).length >= 4) {
    tips.push({
      id: 'pin-favorites',
      severity: 'info',
      title: 'Pin the models you actually use',
      detail: `You've used ${Object.keys(usage.byModel).length} different models. Star your go-to models so they sort to the top of the picker.`,
    });
  }

  const order: Record<TipSeverity, number> = { warn: 0, suggest: 1, info: 2 };
  return tips
    .sort((a, b) => order[a.severity] - order[b.severity] || (b.saving ?? 0) - (a.saving ?? 0))
    .slice(0, limit);
}

function money(n: number): string {
  if (n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
}
