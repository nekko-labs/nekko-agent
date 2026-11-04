import { CLAUDE_CODE_PROVIDER_KIND, type ChatMessage, type PlanStep, type ProviderConfig, type Session, type ToolCall } from '@nekko-agent/shared';

function firstLine(text: string): string {
  return text.split('\n').map(line => line.trim()).find(Boolean) ?? '';
}

/**
 * Claude Code's own plan, rebuilt from the transcript's `TodoWrite` and
 * `TaskCreate`/`TaskUpdate` calls that succeeded: the same steps nekkod
 * keeps as `agentPlan` (crates/nekko-harness/src/plan.rs), for a chat whose
 * plan was never saved (one from before nekkod kept it).
 */
export function claudeCodeOwnPlan(messages: ChatMessage[]): PlanStep[] | undefined {
  const calls = new Map<string, ToolCall>();
  for (const m of messages) for (const c of m.toolCalls ?? []) calls.set(c.id, c);
  const status = (s: unknown): PlanStep['status'] => s === 'completed' ? 'done' : s === 'in_progress' ? 'active' : 'pending';
  let plan: PlanStep[] | undefined;
  for (const m of messages) {
    const r = m.toolResult;
    const call = r && !r.isError && !r.denied ? calls.get(r.toolCallId) : undefined;
    if (!call) continue;
    const input = (call.input ?? {}) as Record<string, unknown>;
    const at = m.createdAt;
    if (call.name === 'TodoWrite' && Array.isArray(input.todos)) {
      const todos = (input.todos as Array<{ content?: unknown; status?: unknown }>).filter(t => typeof t.content === 'string' && t.content.trim());
      if (todos.length) plan = todos.map((t, i) => ({ id: `todo_${i + 1}`, title: String(t.content).trim(), status: status(t.status), createdAt: at, updatedAt: at }));
    } else if (call.name === 'TaskCreate' && typeof input.subject === 'string' && input.subject.trim()) {
      const id = /Task #(\S+) created/.exec(r!.output ?? '')?.[1];
      if (!id) continue;
      const note = firstLine(String(input.description ?? '')) || undefined;
      plan = [...(plan ?? []), { id: `task_${id}`, title: input.subject.trim(), status: 'pending', ...(note ? { note } : {}), createdAt: at, updatedAt: at }];
    } else if (call.name === 'TaskUpdate' && plan) {
      const id = `task_${String(input.taskId ?? '').trim()}`;
      if (input.status === 'deleted') { plan = plan.filter(s => s.id !== id); continue; }
      plan = plan.map(s => s.id !== id ? s : {
        ...s,
        ...(typeof input.status === 'string' ? { status: status(input.status) } : {}),
        ...(typeof input.subject === 'string' && input.subject.trim() ? { title: input.subject.trim() } : {}),
        updatedAt: at,
      });
    }
  }
  return plan?.length ? plan : undefined;
}

/**
 * The plan the composer's sheet shows: the chat's own (`agentPlan`, which a
 * Claude Agent chat keeps from Claude Code's own plan calls); on a Claude
 * Agent chat without one, Claude Code's plan rebuilt from the transcript.
 * When Claude Code wrote no plan (most turns: it rarely calls its task tools
 * headless, and Nekko adds no prompt to make it), there is no plan to show.
 */
export function sheetPlan(session: Session | null | undefined, providers: ProviderConfig[] | undefined): PlanStep[] | undefined {
  if (session?.agentPlan?.length) return session.agentPlan;
  const kind = providers?.find(p => p.id === session?.providerId)?.kind;
  if (!session || kind !== CLAUDE_CODE_PROVIDER_KIND) return undefined;
  return claudeCodeOwnPlan(session.messages ?? []);
}
