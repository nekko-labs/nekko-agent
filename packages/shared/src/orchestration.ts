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
  /** Explicit user-selected model for sub-agents. Wins over `subagentModel`; validated, never a fallback. */
  delegationRoute?: { providerId: string; modelId: string };
  /** How a sub-agent's model is chosen when no explicit route is saved and the call names none. Unset is `auto`. */
  subagentModel?: SubagentModelChoice;
}

/**
 * The sub-agent model preference (Settings and the model selector's Subagents
 * row). The `auto` choices pick a lighter model than the chat's, so fanning
 * out does not multiply the most expensive model; `inherit` is the old
 * behaviour (the chat's own model).
 */
export type SubagentModelChoice = 'auto' | 'auto-same-provider' | 'auto-local' | 'inherit';

export const SUBAGENT_MODEL_CHOICES: { id: SubagentModelChoice; label: string; description: string }[] = [
  { id: 'auto', label: 'Auto', description: 'Lighter than the chat\'s model, on its provider. A chat on ✨ Auto may use a loaded local model.' },
  { id: 'auto-same-provider', label: 'Auto · same provider', description: 'Lighter than the chat\'s model, never leaving its provider.' },
  { id: 'auto-local', label: 'Auto · prefer local', description: 'A local model (loaded first), else lighter on the chat\'s provider.' },
  { id: 'inherit', label: 'Same model as the chat', description: 'Whatever the chat runs on.' },
];

export function subagentModelChoice(o: OrchestrationSettings | undefined): SubagentModelChoice {
  const id = o?.subagentModel;
  return SUBAGENT_MODEL_CHOICES.some((c) => c.id === id) ? id! : 'auto';
}

export const DEFAULT_ORCHESTRATION: OrchestrationSettings = {
  strategy: 'balanced',
  maxDepth: 2,
  maxParallel: 2,
};

export function getStrategy(id: OrchestrationStrategy | undefined): OrchestrationStrategyDef {
  return ORCHESTRATION_STRATEGIES.find((s) => s.id === id) ?? ORCHESTRATION_STRATEGIES[1];
}

/** A follow-up the person chose to run in a sub-agent. It is their message, shown as sent, on every engine. */
export function inSubagent(text: string): string {
  return `Do this in a subagent, then report back:\n\n${text}`;
}

/** Whether a chat can hand a follow-up to a sub-agent: its model has replied, and nothing here rules delegation out. */
export function canOfferSubagent(
  session: { messages: { role: string }[]; parentSessionId?: string; incognito?: boolean; offline?: boolean; executionMode?: string; disabledTools?: string[] },
  strategy: OrchestrationStrategy | undefined,
): boolean {
  return getStrategy(strategy).allowsSpawn
    && session.messages.some((m) => m.role === 'assistant')
    && !session.parentSessionId
    && !session.incognito
    && !session.offline
    && session.executionMode !== 'sandbox'
    && !session.disabledTools?.includes('spawn_agent');
}

