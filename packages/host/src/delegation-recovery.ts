import type { ChatMessage, ToolResult } from '@nekko-agent/shared';

/**
 * What a sub-agent's run comes back as, as pure functions: the TS route
 * (chat.ts `runSubAgent`) and the engine daemon's (crates/nekko-turn
 * `delegate`) both use them, held together by `delegation.golden.test.ts`.
 */

/** Recovery after a child turn exhausted its own stream retries. Never changes route. */
export const MAX_CHILD_RESUMES = 1;

export function canResumeChildFailure(message: string): boolean {
  if (/stopped$|cancel|abort|credential|unauthoriz|forbidden|permission|approval|model.*(?:unavailable|not found)|\b(?:400|401|403|404)\b/i.test(message)) return false;
  return /engine (?:stopped driving|could not be reached)|stopped sending|stream ended unexpectedly|network error|ECONNRESET|ETIMEDOUT|fetch failed|terminated|\b(?:408|429|500|502|503|504|529)\b/i.test(message);
}

/** A finished child's answer: its last written assistant message. */
export function subAgentAnswer(messages: ChatMessage[] | undefined): string {
  const last = [...(messages ?? [])].reverse().find((m) => m.role === 'assistant' && m.content.trim());
  return last?.content ?? 'Sub-agent finished without producing a written answer.';
}

/** Why a child that failed did not finish, with its last saved progress. */
export function childInterruptedMessage(childId: string, failure: string, messages: ChatMessage[] | undefined): string {
  const progress = [...(messages ?? [])].reverse().find(m => m.role === 'assistant' && m.content.trim())?.content.slice(-2000);
  return `Child session ${childId} interrupted: ${failure}. Saved work remains in the shared project. No provider/model fallback was used. Continue the delegated task directly from its checkpoint, or explain the concrete blocker; do not assume it is complete.${progress ? '\nLast saved progress:\n' + progress : ''}`;
}

/** `spawn_agent`'s result when the delegation failed, with a code the model can act on. */
export function subAgentFailure(callId: string, message: string): ToolResult {
  const code = message.includes('exact model ID is not available') ? 'model_unavailable'
    : message.includes('not a chat model') ? 'not_chat_model'
    : message.includes('model list') ? 'model_list_unavailable'
    : message.includes('unknown or disabled') ? 'provider_unavailable'
    : message.includes('endpoint') ? 'invalid_endpoint'
    : message.includes('cancelled') ? 'cancelled' : 'delegation_failed';
  return { toolCallId: callId, output: JSON.stringify({ ok: false, code, message: `Sub-agent failed: ${message}`, fallbackUsed: false }), isError: true };
}
