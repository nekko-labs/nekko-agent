import type { AgentWatchView, ChatMessage, PrInfo } from '@nekko-agent/shared';

/** Only a settled assistant reply may offer a continuation, never an in-flight tool result. */
export function canOfferPrWatch(messages: ChatMessage[], busy: boolean): boolean {
  const last = messages.at(-1);
  return !busy && last?.role === 'assistant' && !!last.content.trim() && !last.interrupted && !last.toolCalls?.length;
}

export function unwatchedPrs(prs: PrInfo[], watches: AgentWatchView[]): PrInfo[] {
  return prs.filter(pr => pr.state === 'open' && !watches.some(w => w.kind === 'pr' && w.url === pr.url && w.status === 'active'));
}

/*
 * Once the user answers the offer for a PR, Watch or Skip, the chat never asks
 * about that PR again. Watcher callbacks end turns of their own, and a watcher
 * may run as a Claude Code background task rather than an agent_watch, so
 * neither the reply id nor the watch list can stand in for the answer.
 */
const ANSWERED_KEY = 'nekko.prWatchAnswered';
const ANSWERED_CAP = 200;

const readAnswered = (): string[] => {
  try {
    const v = JSON.parse(window.localStorage.getItem(ANSWERED_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : [];
  } catch { return []; }
};

const answeredKey = (sessionId: string, url: string) => `${sessionId} ${url}`;

export function prWatchAnswered(sessionId: string, url: string): boolean {
  return readAnswered().includes(answeredKey(sessionId, url));
}

export function markPrWatchAnswered(sessionId: string, url: string): void {
  const key = answeredKey(sessionId, url);
  const next = [...readAnswered().filter(k => k !== key), key].slice(-ANSWERED_CAP);
  try { window.localStorage.setItem(ANSWERED_KEY, JSON.stringify(next)); } catch { /* best effort: the offer just shows again */ }
}

export function prWatchPrompt(url: string): string {
  return `Watch CI for ${url} and merge when passing. First verify the current PR, required checks, reviews, visual evidence and release blockers. Do not bypass protections, approvals, or a draft's unfinished release requirements. Finish independent verification while CI runs. Register an agent_watch PR watch with a bounded deadline when waiting; report its id only after successful registration and re-arm as needed. Diagnose failures rather than retrying blindly. Stop and explain any blocker requiring my input. Continue until merged, closed, cancelled, or genuinely blocked. This request authorizes this PR's normal merge workflow only, not bypassing any safety gate.`;
}
