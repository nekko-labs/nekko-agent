import type { AgentEvent, PendingInput, SessionSummary, ToolCall, ToolResult } from '@nekko-agent/shared';
import { summarizeDelegation, summarizeToolCall } from '@nekko-agent/shared';

/** The detail `childActivity` gives a child with no live run to report. */
export const NO_STATUS = 'No current run status recorded.';

export type SubagentStatus = 'working' | 'waiting' | 'completed' | 'failed' | 'stopped';
export interface SubagentActivity { status: SubagentStatus; detail: string; toolId?: string; text?: string }
const activities = new Map<string, SubagentActivity>();
export type SubagentWait = 'approval' | 'question' | 'secret';
/**
 * What each chat is waiting on the person for, by call id. Kept apart from the
 * last-event activity: a sibling tool's result that lands after an approval
 * request must not hide the approval (#3270).
 */
const waits = new Map<string, Map<string, SubagentWait>>();
const WAIT_DETAIL: Record<SubagentWait, string> = { approval: 'Waiting for approval.', question: 'Waiting for your answer.', secret: 'Waiting for a secret.' };
function addWait(id: string, callId: string, kind: SubagentWait): void {
  const mine = waits.get(id) ?? new Map<string, SubagentWait>();
  mine.set(callId, kind);
  waits.set(id, mine);
}
function dropWait(id: string, callId?: string): void {
  const mine = waits.get(id);
  if (!mine) return;
  if (callId === undefined) mine.clear(); else mine.delete(callId);
  if (!mine.size) waits.delete(id);
}
/** What a chat waits on the person for right now, approval first. */
export function waitingOn(id: string): SubagentWait | undefined {
  const kinds = [...(waits.get(id)?.values() ?? [])];
  return kinds.includes('approval') ? 'approval' : kinds.includes('question') ? 'question' : kinds[0];
}
/**
 * Seed the waits from the host's pending inputs: a window that connects after
 * a request never gets its event (the engine does not resend waits).
 */
export function seedSubagentWaits(pending: Record<string, PendingInput>): void {
  for (const [id, input] of Object.entries(pending)) {
    if (input.approval) addWait(id, input.approval.call.id, 'approval');
    if (input.question) addWait(id, input.question.callId, 'question');
    if (input.secret) addWait(id, input.secret.callId, 'secret');
  }
}
const delegations = new Map<string, { parentId: string; title: string; startedAt: number; endedAt?: number; childId?: string }>();
const delegationKey = (parentId: string, callId: string) => JSON.stringify([parentId, callId]);
const terminal = (activity?: SubagentActivity) => !!activity && ['completed', 'failed', 'stopped'].includes(activity.status);

export function startSubagentActivity(id: string): void {
  activities.set(id, { status: 'working', detail: 'Working on the task.' });
}

/** Local, plain-text, one-sentence excerpts. Never render prompts as markup. */
export function compactSentence(text: string, limit = 140): string {
  // Only the visible prefix and one lookahead character can affect the excerpt.
  // Avoid rescanning the full streaming tail on every token.
  let clean = '';
  let space = false;
  for (let i = 0, end = Math.min(text.length, 2000); i < end; i++) {
    const char = text[i];
    if (char <= ' ' || char === '\u007f' || (char > '\u007f' && /\s/.test(char))) {
      if (clean) space = true;
      continue;
    }
    if (space) clean += ' ';
    clean += char;
    space = false;
    if (clean.length > limit) break;
  }
  const sentence = clean.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? clean;
  return sentence.length > limit ? `${sentence.slice(0, limit - 1).trimEnd()}…` : sentence;
}

export function foldSubagentActivity(event: AgentEvent, now = Date.now()): void {
  if (event.type === 'tool_call' && event.call.name === 'spawn_agent') {
    delegations.set(delegationKey(event.sessionId, event.call.id), { parentId: event.sessionId, title: typeof event.call.input.title === 'string' && event.call.input.title.trim() ? event.call.input.title.trim() : typeof event.call.input.task === 'string' ? event.call.input.task.trim().slice(0, 40) : '', startedAt: now });
    if (delegations.size > 512) delegations.delete(delegations.keys().next().value!);
  } else if (event.type === 'tool_result') {
    const delegation = delegations.get(delegationKey(event.sessionId, event.result.toolCallId));
    if (delegation) delegation.endedAt = now;
  }
  switch (event.type) {
    case 'tool_approval_required': addWait(event.sessionId, event.call.id, 'approval'); break;
    case 'question': addWait(event.sessionId, event.request?.callId ?? '', 'question'); break;
    case 'secret_request': addWait(event.sessionId, event.request?.callId ?? '', 'secret'); break;
    case 'approval_resolved': case 'question_resolved': case 'secret_resolved': dropWait(event.sessionId, event.callId); break;
    case 'done': case 'error': dropWait(event.sessionId); break;
  }
  const prev = activities.get(event.sessionId);
  let next: SubagentActivity | undefined;
  switch (event.type) {
    case 'tool_call': next = { status: 'working', detail: compactSentence(`Running ${event.call.name}: ${summarizeToolCall(event.call, 100)}`), toolId: event.call.id }; break;
    case 'tool_approval_required': next = { status: 'waiting', detail: 'Waiting for approval.', toolId: event.call.id }; break;
    case 'question': next = { status: 'waiting', detail: 'Waiting for your answer.' }; break;
    case 'question_resolved': next = { status: 'working', detail: 'Continuing after your answer.' }; break;
    case 'approval_resolved': next = { status: 'working', detail: 'Continuing after your answer.' }; break;
    case 'text': {
      const text = `${prev?.text ?? ''}${event.delta}`.slice(-2000);
      next = { status: 'working', detail: compactSentence(text) || 'Writing a reply.', text };
      break;
    }
    case 'reasoning': next = { status: 'working', detail: 'Thinking through the task.' }; break;
    case 'retry': next = { status: 'waiting', detail: event.paused ? 'Paused while someone uses this computer.' : 'Waiting to retry the provider.' }; break;
    case 'tool_result': next = { status: 'working', detail: event.result.isError ? 'A tool failed; the child is still working.' : 'Reviewing the tool result.' }; break;
    case 'error': {
      const stopped = /^(aborted|stopped)$/i.test(event.message.trim());
      next = { status: stopped ? 'stopped' : 'failed', detail: stopped ? 'The run was stopped.' : compactSentence(event.message) || 'The child could not continue.' };
      break;
    }
    case 'done':
      // Both engines can close a failed turn with done. It is not a success.
      if (prev?.status === 'failed' || prev?.status === 'stopped') return;
      next = { status: event.stop && event.stop !== 'complete' ? 'stopped' : 'completed', detail: event.stop && event.stop !== 'complete' ? 'Stopped before completing the task.' : 'Task finished.' }; break;
  }
  if (next) {
    activities.set(event.sessionId, next);
    // Bound retained terminal state, without evicting active children.
    if (activities.size > 512) for (const [id, value] of activities) {
      if (value.status === 'completed' || value.status === 'failed' || value.status === 'stopped') { activities.delete(id); break; }
    }
  } else if (prev) return;
}
export function stopSubagentActivity(id: string): void {
  if (activities.has(id)) activities.set(id, { status: 'stopped', detail: 'The run was stopped.' });
}
export function resetSubagentActivity(): void { activities.clear(); delegations.clear(); waits.clear(); }
/** Forget one chat's own activity (its delegations stay): a replay folds it again. */
export function resetSubagentActivityFor(id: string): void { activities.delete(id); waits.delete(id); }

export function childActivity(child: SessionSummary, running = false, pending?: PendingInput): SubagentActivity {
  if (pending?.question || pending?.approval) return { status: 'waiting', detail: pending.question ? 'Waiting for your answer.' : 'Waiting for approval.' };
  const wait = waitingOn(child.id);
  if (wait) return { status: 'waiting', detail: WAIT_DETAIL[wait] };
  const live = activities.get(child.id);
  if (running && (!live || terminal(live))) return { status: 'working', detail: 'Working on the task.' };
  if (live) return live;
  if (child.stalled) return { status: 'stopped', detail: 'Stopped before completing the task.' };
  // A stored reply alone does not prove successful completion.
  return { status: 'waiting', detail: NO_STATUS };
}
export function activitySentence(activity: SubagentActivity): string {
  return `Subagent ${activity.status} · ${activity.detail}`;
}

export function delegationChild(call: ToolCall, sessions: SessionSummary[]): SessionSummary | undefined {
  const named = sessions.find(child => child.spawnCallId === call.id);
  if (named) return named;
  // A child made before the engine recorded its call: matched by title and time.
  const title = typeof call.input.title === 'string' && call.input.title.trim() ? call.input.title.trim() : typeof call.input.task === 'string' ? call.input.task.trim().slice(0, 40) : '';
  // The host exposes no spawn-call ID in child metadata or successful results.
  // Only associate observed live calls, within their parent-scoped time window.
  const scopes = [...delegations.values()].filter(scope => sessions.some(child => child.parentSessionId === scope.parentId) && delegations.get(delegationKey(scope.parentId, call.id)) === scope);
  if (scopes.length !== 1) return undefined;
  const scope = scopes[0];
  if (scope.childId) return sessions.find(child => child.id === scope.childId && child.parentSessionId === scope.parentId);
  const matches = sessions.filter(child => child.parentSessionId === scope.parentId && child.title === title && child.createdAt >= scope.startedAt && child.createdAt <= (scope.endedAt ?? Date.now()));
  if (matches.length !== 1) return undefined;
  // Concurrent same-title calls cannot be distinguished safely by timing alone.
  const competing = [...delegations.entries()].some(([key, other]) => key !== delegationKey(scope.parentId, call.id) && other.parentId === scope.parentId && other.title === title && other.startedAt <= matches[0].createdAt && (other.endedAt ?? Date.now()) >= matches[0].createdAt);
  if (competing) return undefined;
  scope.childId = matches[0].id;
  return matches[0];
}
/** What the delegation is for: its first real instruction and the project, never a path. */
export function delegationTaskSummary(call: ToolCall): string {
  const { what, project } = summarizeDelegation(call.input);
  const sentence = what ? compactSentence(what) : '';
  return sentence ? (project ? `${sentence.replace(/[.!?]$/, '')} · ${project}` : sentence) : project;
}
export function delegationActivity(call: ToolCall, child?: SessionSummary, result?: ToolResult, running = false): SubagentActivity {
  if (child) {
    const activity = childActivity(child, running);
    // A child with nothing to report still has a job: say what it is.
    return activity.detail === NO_STATUS ? { ...activity, detail: delegationTaskSummary(call) || activity.detail } : activity;
  }
  if (result?.isError) return { status: 'failed', detail: compactSentence(result.output) || 'Delegation could not start.' };
  return { status: 'waiting', detail: delegationTaskSummary(call) || 'Waiting for child status.' };
}
