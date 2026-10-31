import { CLAUDE_CODE_PROVIDER_KIND, type ChatMessage, type PlanStep, type ProviderConfig, type Session } from '@nekko-agent/shared';

/** The id prefix of a step made from one of a Claude Agent chat's turns. */
export const TURN_STEP_PREFIX = 'turn:';

/** Turns shown when Claude Code has written no plan; older ones are history. */
const MAX_TURNS = 8;

function firstLine(text: string): string {
  return text.split('\n').map(line => line.trim()).find(Boolean)?.slice(0, 160) ?? '';
}

/**
 * A Claude Agent chat's plan when Claude Code has written none of its own:
 * one step per request handed to Claude Code, the newest active while it
 * works. PRs, files and task links land on the turn they came from
 * (planStepLinks), so the sheet still says where the work went.
 */
export function claudeCodeTurnPlan(messages: ChatMessage[], working: boolean): PlanStep[] {
  const asks = messages.filter(m => m.role === 'user' && firstLine(m.content)).slice(-MAX_TURNS);
  return asks.map((m, i): PlanStep => ({
    id: TURN_STEP_PREFIX + m.id,
    title: `Ask Claude Code: ${firstLine(m.content)}`,
    status: working && i === asks.length - 1 ? 'active' : 'done',
    createdAt: m.createdAt,
    updatedAt: m.createdAt,
  }));
}

/**
 * The plan the composer's sheet shows: the chat's own (`agentPlan`, which a
 * Claude Agent chat keeps from Claude Code's own plan calls), else, on a
 * Claude Agent chat, its turns.
 */
export function sheetPlan(session: Session | null | undefined, providers: ProviderConfig[] | undefined, working: boolean): PlanStep[] | undefined {
  if (session?.agentPlan?.length) return session.agentPlan;
  const kind = providers?.find(p => p.id === session?.providerId)?.kind;
  if (!session || kind !== CLAUDE_CODE_PROVIDER_KIND) return undefined;
  const turns = claudeCodeTurnPlan(session.messages ?? [], working);
  return turns.length ? turns : undefined;
}
