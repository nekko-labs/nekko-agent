import type { AgentWatchView, ChatMessage, PrInfo } from '@nekko-agent/shared';

/** Only a settled assistant reply may offer a continuation, never an in-flight tool result. */
export function canOfferPrWatch(messages: ChatMessage[], busy: boolean): boolean {
  const last = messages.at(-1);
  return !busy && last?.role === 'assistant' && !!last.content.trim() && !last.interrupted && !last.toolCalls?.length;
}

export function unwatchedPrs(prs: PrInfo[], watches: AgentWatchView[]): PrInfo[] {
  return prs.filter(pr => pr.state === 'open' && !watches.some(w => w.kind === 'pr' && w.url === pr.url && w.status === 'active'));
}

export function prWatchPrompt(url: string): string {
  return `Watch CI for ${url} and merge when passing. First verify the current PR, required checks, reviews, visual evidence and release blockers. Do not bypass protections, approvals, or a draft's unfinished release requirements. Finish independent verification while CI runs. Register an agent_watch PR watch with a bounded deadline when waiting; report its id only after successful registration and re-arm as needed. Diagnose failures rather than retrying blindly. Stop and explain any blocker requiring my input. Continue until merged, closed, cancelled, or genuinely blocked. This request authorizes this PR's normal merge workflow only, not bypassing any safety gate.`;
}
