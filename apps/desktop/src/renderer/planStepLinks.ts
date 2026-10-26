import { applyPlanUpdate, collectSessionPrUrls, extractPrUrls, type ChatMessage, type PlanStep, type PlanUpdateInput } from '@nekko-agent/shared';
import { chatArtifacts, type ChatArtifact } from './chatArtifacts.js';

export interface PlanStepLinks {
  prs: string[];
  artifacts: ChatArtifact[];
}

/**
 * What each plan step produced, worked out by the app rather than reported by
 * the model: the transcript's update_plan calls are replayed in order, and a PR
 * the agent opened or a file it linked belongs to the step active at that point.
 * Replayed steps map onto the live plan by title, so ids never need to agree.
 */
export function planStepLinks(messages: ChatMessage[], plan: PlanStep[] | undefined, basePath?: string): Map<string, PlanStepLinks> {
  const links = new Map<string, PlanStepLinks>();
  if (!plan?.length) return links;
  const byTitle = new Map(plan.map(step => [step.title.trim().toLowerCase(), step.id]));
  const created = new Set(collectSessionPrUrls(messages));
  let replay: PlanStep[] | undefined;
  let active: string | undefined;
  const add = (item: (entry: PlanStepLinks) => void) => {
    if (!active) return;
    const entry = links.get(active) ?? { prs: [], artifacts: [] };
    item(entry);
    links.set(active, entry);
  };
  for (const message of messages) {
    if (message.role === 'assistant') for (const artifact of chatArtifacts(message.content, basePath).filter(a => !a.inlineImage)) add(e => { if (!e.artifacts.some(a => a.path === artifact.path)) e.artifacts.push(artifact); });
    for (const call of message.toolCalls ?? []) {
      if (call.name !== 'update_plan') continue;
      const result = applyPlanUpdate(replay, call.input as unknown as PlanUpdateInput);
      if ('error' in result) continue;
      replay = result.plan;
      // With parallel active steps, the latest one in the plan is the one being worked.
      const current = replay.filter(step => step.status === 'active').pop();
      active = current ? byTitle.get(current.title.trim().toLowerCase()) : undefined;
    }
    for (const url of extractPrUrls(message.toolResult?.output ?? '')) if (created.has(url)) add(e => { if (!e.prs.includes(url)) e.prs.push(url); });
  }
  return links;
}
