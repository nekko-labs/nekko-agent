/**
 * Agent orchestration, how the lead agent delegates work to sub-agents.
 *
 * A *strategy* shapes two things: whether the `spawn_agent` tool is available
 * at all, and the guidance injected into the system prompt about when to fan
 * work out. The depth/parallelism knobs bound the sub-agent tree. Everything
 * here is pure config so the host (prompt + tool gating) and the renderer
 * (settings UI) share one source of truth.
 */

export type OrchestrationStrategy = 'solo' | 'balanced' | 'swarm';

export interface OrchestrationStrategyDef {
  id: OrchestrationStrategy;
  label: string;
  /** One-line description for the settings UI. */
  description: string;
  /** Whether the `spawn_agent` tool is offered to the agent. */
  allowsSpawn: boolean;
  /** Guidance appended to the system prompt (omitted when spawning is off). */
  promptHint: string;
}

export const ORCHESTRATION_STRATEGIES: OrchestrationStrategyDef[] = [
  {
    id: 'solo',
    label: 'Solo',
    description: 'One agent does everything. No sub-agents.',
    allowsSpawn: false,
    promptHint: '',
  },
  {
    id: 'balanced',
    label: 'Balanced',
    description: 'Delegate only clearly separable or heavy sub-tasks.',
    allowsSpawn: true,
    promptHint:
      'You may delegate with `spawn_agent`, but prefer handling work yourself. Only spawn a sub-agent for a clearly separable, well-scoped chunk (a focused investigation, or an independent piece of implementation) that would otherwise bloat your own context. Do the lightweight work directly.',
  },
  {
    id: 'swarm',
    label: 'Swarm',
    description: 'Proactively decompose into parallel sub-agents.',
    allowsSpawn: true,
    promptHint:
      'Act as an orchestrator. When a task has independent parts, decompose it and `spawn_agent` for each part so they progress in parallel, then synthesize their results. Give each sub-agent a single, self-contained objective with enough context to act alone. Reserve your own turns for planning and integration rather than doing every part yourself.',
  },
];

export interface OrchestrationSettings {
  strategy: OrchestrationStrategy;
  /** Max sub-agent nesting depth (root = 0). */
  maxDepth: number;
  /** Advisory cap on how many sub-agents to run at once (surfaced in the prompt). */
  maxParallel: number;
  /** Explicit user-selected default. Unset inherits the parent's route; never a fallback. */
  delegationRoute?: { providerId: string; modelId: string };
}

export const DEFAULT_ORCHESTRATION: OrchestrationSettings = {
  strategy: 'balanced',
  maxDepth: 2,
  maxParallel: 4,
};

export function getStrategy(id: OrchestrationStrategy | undefined): OrchestrationStrategyDef {
  return ORCHESTRATION_STRATEGIES.find((s) => s.id === id) ?? ORCHESTRATION_STRATEGIES[1];
}
