/**
 * What a Claude plan includes for a model, and the two usage notices a Claude
 * Agent chat on that model shows.
 *
 * Anthropic sells most Claude models inside a plan's usage, but not Fable: on
 * Pro it runs on usage credits, on Max (and Ultra, and premium seats) it is
 * included up to half of the weekly usage, and launch offers move those lines
 * for a few days. A user who sees Fable in the picker deserves to know which
 * of those applies to them before the first message, not after the bill.
 *
 * Two sources, and the live one wins:
 *
 * 1. **The catalog** (`CLAUDE_PLAN_RULES`): dated rules, each with its source
 *    page and the day someone last checked it. A rule may carry `from` and
 *    `until`, so a known change (the end of a launch offer) happens on its own
 *    at that instant, with no release. A rule not checked for
 *    `PLAN_RULE_STALE_DAYS` reads as "check your plan" instead of stating
 *    something that may have stopped being true.
 * 2. **What the user's own Claude Code printed**: its usage windows, parsed by
 *    `parse_claude_code_usage` (decision 0035). A Fable window near its cap or
 *    spent is the fact; the catalog only predicts it.
 *
 * Nekko only informs: it never blocks a model on the catalog's word (Claude
 * Code decides what runs), never moves a turn to another account or model to
 * get around a cap, and never reads a plan endpoint or credential. The plan
 * type is `subscriptionType` from `claude auth status`. See decision 0077.
 */

import type { LimitWindow, SubscriptionLimits } from './limits.js';

/** How a plan pays for a model. */
export type ClaudePlanAccess =
  /** Part of the plan's usage, as other models are (a launch offer, for example). */
  | 'included'
  /** Part of the plan up to `capPercent` of the weekly usage, then usage credits. */
  | 'capped'
  /** Never from the plan's included usage: every message spends usage credits. */
  | 'credits'
  /** The plan does not offer the model at all. */
  | 'not-in-plan'
  /** An organization seat: premium seats are capped, standard seats use credits, and Claude Code does not say which seat this is. */
  | 'seat';

export interface ClaudePlanRule {
  /** The Claude family the rule is about (`fable`). */
  family: 'fable' | 'mythos';
  /** Model id prefixes it narrows to (`claude-fable-5-2`); absent, every model of the family. */
  models?: string[];
  /** `subscriptionType` values from `claude auth status`, lowercase. */
  plans: string[];
  access: ClaudePlanAccess;
  capPercent?: number;
  /** ISO instant the rule starts to apply (inclusive). */
  from?: string;
  /** ISO instant the rule stops applying (exclusive). */
  until?: string;
  /** Where the rule was read. */
  source: string;
  /** The day (YYYY-MM-DD) the source was last checked against the rule. */
  reviewedAt: string;
}

const PLAN_PAGE = 'https://support.claude.com/en/articles/15424964-claude-fable-models-on-your-plan';
const LAUNCH_OFFER_5_2 = 'https://support.claude.com/en/articles/17506494-claude-fable-5-2-launch-offers';

/**
 * The shipped catalog. First match wins, so a narrower or time-boxed rule goes
 * above the general one it overrides. Instants are UTC: the Fable 5.2 Pro
 * offer ends 16 November 2026, 23:59 Pacific (PST, UTC-8).
 */
export const CLAUDE_PLAN_RULES: readonly ClaudePlanRule[] = [
  { family: 'fable', plans: ['free'], access: 'not-in-plan', source: PLAN_PAGE, reviewedAt: '2026-11-10' },
  {
    family: 'fable', models: ['claude-fable-5-2'], plans: ['pro'], access: 'included',
    until: '2026-11-17T07:59:59Z', source: LAUNCH_OFFER_5_2, reviewedAt: '2026-11-10',
  },
  { family: 'fable', plans: ['pro'], access: 'credits', source: PLAN_PAGE, reviewedAt: '2026-11-10' },
  { family: 'fable', plans: ['max', 'ultra'], access: 'capped', capPercent: 50, source: PLAN_PAGE, reviewedAt: '2026-11-10' },
  { family: 'fable', plans: ['team', 'enterprise'], access: 'seat', capPercent: 50, source: PLAN_PAGE, reviewedAt: '2026-11-10' },
];

/** After this many days unchecked, a rule stops making a claim. */
export const PLAN_RULE_STALE_DAYS = 60;

const DAY_MS = 86_400_000;

/** The family of a Claude model id that has plan rules, or null. */
function ruledFamily(modelId: string): ClaudePlanRule['family'] | null {
  const m = /(?:^|[./])claude-(fable|mythos)(?:-|$)/.exec(modelId.toLowerCase());
  return m ? (m[1] as ClaudePlanRule['family']) : null;
}

/** The rule that applies to this model on this plan at `now`, or null. */
export function claudePlanRule(
  modelId: string,
  subscriptionType: string | null | undefined,
  now: number,
  rules: readonly ClaudePlanRule[] = CLAUDE_PLAN_RULES,
): ClaudePlanRule | null {
  const family = ruledFamily(modelId);
  const plan = subscriptionType?.trim().toLowerCase();
  if (!family || !plan) return null;
  const id = modelId.toLowerCase();
  return rules.find((r) =>
    r.family === family
    && r.plans.includes(plan)
    && (!r.models || r.models.some((p) => id === p || id.startsWith(`${p}-`) || id.endsWith(`.${p}`) || id.includes(`/${p}`)))
    && (!r.from || now >= Date.parse(r.from))
    && (!r.until || now < Date.parse(r.until)),
  ) ?? null;
}

export interface ClaudePlanNote {
  access: ClaudePlanAccess | 'unchecked';
  /** A few words for the picker row. */
  label: string;
  /** One sentence for its tooltip. */
  detail: string;
  source?: string;
}

const planName = (t: string) => `${t[0].toUpperCase()}${t.slice(1)}`;
const shortDateTime = (iso: string) =>
  new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(iso));
const dayOf = (iso: string) =>
  new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(new Date(iso));
const shortDate = (day: string) =>
  new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`));

/**
 * What the picker says beside a model on a Claude plan, or null when the plan
 * has nothing special for it (the model is simply part of the plan).
 */
export function claudePlanNote(
  modelId: string,
  subscriptionType: string | null | undefined,
  now: number,
  rules: readonly ClaudePlanRule[] = CLAUDE_PLAN_RULES,
): ClaudePlanNote | null {
  const rule = claudePlanRule(modelId, subscriptionType, now, rules);
  if (!rule) return null;
  const plan = planName(subscriptionType!.trim().toLowerCase());
  if (now - Date.parse(`${rule.reviewedAt}T00:00:00Z`) > PLAN_RULE_STALE_DAYS * DAY_MS) {
    return {
      access: 'unchecked',
      label: 'Check your plan',
      detail: `What the ${plan} plan includes for this model was last checked on ${shortDate(rule.reviewedAt)}.`,
      source: rule.source,
    };
  }
  const cap = rule.capPercent ?? 50;
  switch (rule.access) {
    case 'included':
      return rule.until
        ? {
          access: 'included',
          label: `Included until ${dayOf(rule.until)}`,
          detail: `A launch offer includes this model in the ${plan} plan until ${shortDateTime(rule.until)}. After that it uses usage credits.`,
          source: rule.source,
        }
        : { access: 'included', label: 'Included in your plan', detail: `Part of the ${plan} plan's usage.`, source: rule.source };
    case 'capped':
      return {
        access: 'capped',
        label: `Up to ${cap}% of weekly usage`,
        detail: `Included in the ${plan} plan for up to ${cap}% of your weekly usage, then it uses usage credits.`,
        source: rule.source,
      };
    case 'credits':
      return {
        access: 'credits',
        label: 'Uses usage credits',
        detail: `On the ${plan} plan this model runs on usage credits, not on the plan's included usage.`,
        source: rule.source,
      };
    case 'not-in-plan':
      return { access: 'not-in-plan', label: 'Not in your plan', detail: `The ${plan} plan does not include this model.`, source: rule.source };
    case 'seat':
      return {
        access: 'seat',
        label: 'Depends on your seat',
        detail: `Premium seats include this model up to ${cap}% of weekly usage; standard seats run it on usage credits.`,
        source: rule.source,
      };
  }
}

/** A notice above a Claude Agent chat's composer about the model's plan usage. */
export interface ClaudePlanUsageNotice {
  kind: 'near-limit' | 'on-credits';
  text: string;
}

/** The usage window Claude Code reported for this model's family, if any. */
function familyWindow(modelId: string, limits: SubscriptionLimits | null | undefined): LimitWindow | undefined {
  const family = ruledFamily(modelId);
  if (!family) return undefined;
  return limits?.windows.find((w) => w.scope === 'model' && w.modelFamily === family);
}

const familyName = (f: string) => `${f[0].toUpperCase()}${f.slice(1)}`;

/** Whether the account has usage credits it can still spend, as far as Claude Code said. */
export function claudeCreditsAvailable(limits: SubscriptionLimits | null | undefined): boolean {
  if (limits?.creditsState === 'unlimited') return true;
  return limits?.creditsState === 'balance' && (limits.creditsBalance ?? 0) > 0;
}

/**
 * The notice a Claude Agent chat on a ruled model shows, or null:
 * - `near-limit`: Claude Code reports the model's own window close to its cap.
 * - `on-credits`: that window is spent and the account has credits, or the
 *   plan never includes the model (Pro), so from here every message spends
 *   usage credits.
 * Live windows win over the catalog; with neither, nothing is said.
 */
export function claudePlanUsageNotice(input: {
  modelId: string;
  subscriptionType?: string | null;
  limits?: SubscriptionLimits | null;
  now: number;
  rules?: readonly ClaudePlanRule[];
}): ClaudePlanUsageNotice | null {
  const { modelId, subscriptionType, limits, now } = input;
  const family = ruledFamily(modelId);
  if (!family) return null;
  const name = familyName(family);
  const w = familyWindow(modelId, limits);
  if (w && (w.status === 'rate_limited' || w.usedPercent >= 100)) {
    return claudeCreditsAvailable(limits)
      ? { kind: 'on-credits', text: `Your plan's ${name} allowance for this week is used up. From here ${name} uses your usage credits.` }
      : null; // Spent with no credits: the model reads as "Limit reached" already.
  }
  if (w && w.status === 'warning') {
    return { kind: 'near-limit', text: `You're close to your ${name} limit for this week (${Math.round(w.usedPercent)}% used).` };
  }
  const rule = claudePlanRule(modelId, subscriptionType, now, input.rules);
  if (rule?.access === 'credits') {
    return { kind: 'on-credits', text: `On the ${planName(subscriptionType!.trim().toLowerCase())} plan, ${name} uses your usage credits for every message.` };
  }
  return null;
}
