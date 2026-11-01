import { CLAUDE_CODE_PROVIDER_KIND, type ChatMessage, type PlanStep, type PlanStepKind, type ProviderConfig, type Session, type ToolCall } from '@nekko-agent/shared';

/** The id prefix of a step in a Claude Agent chat's activity plan (`phase:build`). */
export const PHASE_STEP_PREFIX = 'phase:';

/** Where one of Claude Code's tool calls sits in the work loop; `null` for its own bookkeeping. */
export type ClaudeCodePhase = PlanStepKind;

const EXPLORE_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebSearch', 'WebFetch', 'NotebookRead']);
const BUILD_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHIP_COMMAND = /\b(gh\s+pr\s+(create|merge|ready)|git\s+push)\b/;
const VERIFY_COMMAND = /\b(test|tests|vitest|jest|pytest|tsc|typecheck|lint|eslint|clippy|cargo\s+(test|check|build|clippy|fmt)|npm\s+(run\s+)?(test|build|lint|typecheck|check)|go\s+(test|build|vet)|gh\s+pr\s+checks)\b/;
const BUILD_COMMAND = /\bgit\s+(add|commit|mv|rm)\b/;

/** The phase of one of Claude Code's tool calls, by tool, and for `Bash` by its command. */
export function claudeCodePhase(call: Pick<ToolCall, 'name' | 'input'>): ClaudeCodePhase | null {
  if (EXPLORE_TOOLS.has(call.name)) return 'explore';
  if (BUILD_TOOLS.has(call.name)) return 'build';
  if (call.name !== 'Bash') return null;
  const command = String((call.input as Record<string, unknown> | undefined)?.command ?? '');
  if (SHIP_COMMAND.test(command)) return 'ship';
  if (VERIFY_COMMAND.test(command)) return 'verify';
  if (BUILD_COMMAND.test(command)) return 'build';
  return 'explore';
}

const PHASES: Array<{ kind: PlanStepKind; title: string; note: (n: number) => string }> = [
  { kind: 'explore', title: 'Look through the code', note: n => `${n} read${n === 1 ? '' : 's'} and searches` },
  { kind: 'build', title: 'Make the changes', note: n => `${n} edit${n === 1 ? '' : 's'}` },
  { kind: 'verify', title: 'Check the work', note: n => `${n} check${n === 1 ? '' : 's'} run` },
  { kind: 'ship', title: 'Open a pull request', note: () => '' },
];
const SENT = PHASE_STEP_PREFIX + 'sent';

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
 * A Claude Agent chat's plan when Claude Code wrote none: the work loop of
 * the latest request, read from what Claude Code is doing. The request goes
 * to Claude Code, then each phase (explore, build, verify, ship) is done once
 * it has calls and the work moved on, active while it is the latest, pending
 * ahead of it while Claude Code works. A finished turn keeps only the phases
 * it touched, and a turn that only answered shows no plan.
 */
export function claudeCodeActivityPlan(messages: ChatMessage[], working: boolean): PlanStep[] | undefined {
  let start = -1;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') { start = i; break; }
  if (start < 0) return undefined;
  const request = messages[start];
  const after = messages.slice(start + 1);
  const counts = new Map<PlanStepKind, number>();
  let latest: PlanStepKind | undefined;
  let updatedAt = request.createdAt;
  for (const m of after) for (const call of m.toolCalls ?? []) {
    const phase = claudeCodePhase(call);
    if (!phase) continue;
    counts.set(phase, (counts.get(phase) ?? 0) + 1);
    latest = phase;
    updatedAt = m.createdAt;
  }
  if (!latest && !working) return undefined;
  const heard = after.some(m => m.role === 'assistant');
  const order = PHASES.map(p => p.kind);
  const at = latest ? order.indexOf(latest) : -1;
  const steps: PlanStep[] = [{
    id: SENT,
    title: 'Send the request to Claude Code',
    status: heard ? 'done' : 'active',
    note: firstLine(request.content).slice(0, 160) || undefined,
    createdAt: request.createdAt,
    updatedAt: request.createdAt,
  }];
  PHASES.forEach((phase, i) => {
    const n = counts.get(phase.kind) ?? 0;
    let status: PlanStep['status'] | undefined;
    if (working && phase.kind === latest) status = 'active';
    else if (n > 0) status = 'done';
    // Claude Code has answered but not reached for a tool yet: it is working out where to look.
    else if (working && !latest && heard && i === 0) status = 'active';
    else if (working && i > at) status = 'pending';
    if (!status) return;
    const note = n > 0 ? phase.note(n) : '';
    steps.push({ id: PHASE_STEP_PREFIX + phase.kind, title: phase.title, kind: phase.kind, status, ...(note ? { note } : {}), createdAt: request.createdAt, updatedAt });
  });
  return steps;
}

/**
 * The plan the composer's sheet shows: the chat's own (`agentPlan`, which a
 * Claude Agent chat keeps from Claude Code's own plan calls); on a Claude
 * Agent chat without one, Claude Code's plan rebuilt from the transcript,
 * else the activity plan of its latest request.
 */
export function sheetPlan(session: Session | null | undefined, providers: ProviderConfig[] | undefined, working: boolean): PlanStep[] | undefined {
  if (session?.agentPlan?.length) return session.agentPlan;
  const kind = providers?.find(p => p.id === session?.providerId)?.kind;
  if (!session || kind !== CLAUDE_CODE_PROVIDER_KIND) return undefined;
  const messages = session.messages ?? [];
  return claudeCodeOwnPlan(messages) ?? claudeCodeActivityPlan(messages, working);
}
