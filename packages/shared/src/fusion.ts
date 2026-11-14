import type { ModelInfo } from './models.js';
import rules from './model-tiers.json' with { type: 'json' };

/** Workload-relative capability, not parameter count or a benchmark guarantee. */
export type ModelCapability = 'small' | 'medium' | 'large' | 'frontier';
export const MODEL_CAPABILITIES: ModelCapability[] = ['small', 'medium', 'large', 'frontier'];
export const CAPABILITY_RANK: Record<ModelCapability, number> = { small: 2, medium: 3, large: 4, frontier: 5 };
export type ModelTierOverrides = Record<string, ModelCapability>;
export type FusionStrategy = 'balanced' | 'economical' | 'quality' | 'local-first' | 'capacity';
export interface FusionSettings {
  strategy?: FusionStrategy;
  /** Keys are providerId::modelId, matching favorites. Never shared between accounts. */
  modelTiers?: ModelTierOverrides;
}
export const FUSION_STRATEGIES: { id: FusionStrategy; label: string; description: string }[] = [
  { id: 'balanced', label: 'Balanced', description: 'Match capability to the task, then prefer value.' },
  { id: 'economical', label: 'Economical', description: 'Lowest known per-turn cost among suitable tiers.' },
  { id: 'quality', label: 'Quality first', description: 'Strongest available tier.' },
  { id: 'local-first', label: 'Local first', description: 'Prefer a suitable local model; cloud when needed.' },
  { id: 'capacity', label: 'Capacity fallback', description: 'Stay on this provider unless capacity is exhausted.' },
];
export function fusionStrategy(settings?: FusionSettings): FusionStrategy {
  return FUSION_STRATEGIES.find((s) => s.id === settings?.strategy)?.id ?? 'balanced';
}
const compiled = rules.map((r) => ({ pattern: new RegExp(r.pattern, 'i'), tier: r.tier as ModelCapability }));
export function modelCapability(model: ModelInfo, overrides?: ModelTierOverrides): { tier?: ModelCapability; source: 'user' | 'suggested' | 'unknown' } {
  const override = overrides?.[`${model.providerId}::${model.id}`];
  if (override && MODEL_CAPABILITIES.includes(override)) return { tier: override, source: 'user' };
  const suggested = compiled.find((r) => r.pattern.test(`${model.id} ${model.name}`));
  return suggested ? { tier: suggested.tier, source: 'suggested' } : { source: 'unknown' };
}
/** Auto changes models. Only Fusion grants provider switching. */
export function fusionEnabled(session?: { autoModel?: boolean; autoProviderSwitch?: boolean; offline?: boolean; incognito?: boolean } | null): boolean {
  return session?.autoModel === true && session.autoProviderSwitch === true && !session.offline && !session.incognito;
}
