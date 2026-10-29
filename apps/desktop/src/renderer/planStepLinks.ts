import { applyPlanUpdate, collectSessionPrUrls, extractPrUrls, type ChatMessage, type PlanStep, type PlanUpdateInput } from '@nekko-agent/shared';
import { chatArtifacts, type ChatArtifact } from './chatArtifacts.js';

/** A task in a project-management tool that the chat linked to. */
export interface ProjectLink {
  url: string;
  /** The task's own key where it has one ("NEK-412", "o/r#12"), else what it is ("Trello card"). */
  label: string;
}

export interface PlanStepLinks {
  prs: string[];
  artifacts: ChatArtifact[];
  /** Project-management tasks linked from the chat. */
  projects: ProjectLink[];
  /** Sub-agent chats started while the step was being worked. */
  subagents: string[];
}

const PROJECT_LINKS: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  [/^https:\/\/linear\.app\/[^/]+\/issue\/([A-Z][A-Z0-9]*-\d+)/i, (m) => m[1].toUpperCase()],
  [/^https:\/\/[a-z0-9-]+\.atlassian\.net\/browse\/([A-Z][A-Z0-9]*-\d+)/i, (m) => m[1].toUpperCase()],
  [/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)(?:[/?#]|$)/i, (m) => `${m[1]}#${m[2]}`],
  [/^https:\/\/trello\.com\/c\/[A-Za-z0-9]+/i, () => 'Trello card'],
  [/^https:\/\/app\.asana\.com\/\d+\/\d+\/\d+/i, () => 'Asana task'],
  [/^https:\/\/app\.clickup\.com\/t\/[\w-]+/i, () => 'ClickUp task'],
  [/^https:\/\/(?:app\.)?todoist\.com\/(?:app\/)?(?:task|showTask)/i, () => 'Todoist task'],
];

/** Task links (Linear, Jira, GitHub issues, Trello, Asana, ClickUp, Todoist) in a message's text. */
export function projectLinks(text: string): ProjectLink[] {
  const found: ProjectLink[] = [];
  for (const raw of text.match(/https:\/\/[^\s<>()[\]"'`]+/g) ?? []) {
    const url = raw.replace(/[.,;:!?]+$/, '');
    for (const [pattern, label] of PROJECT_LINKS) {
      const m = url.match(pattern);
      if (m) { if (!found.some((l) => l.url === url)) found.push({ url, label: label(m) }); break; }
    }
  }
  return found;
}

/**
 * What each plan step produced, worked out by the app rather than reported by
 * the model: the transcript's update_plan calls are replayed in order, and a PR
 * the agent opened or a file it linked belongs to the step active at that point.
 * Replayed steps map onto the live plan by title, so ids never need to agree.
 *
 * Task links and sub-agents follow the same clock (a sub-agent by when its chat
 * was created). Those that came before any step was active, such as the task
 * the chat was started from, belong to the first step.
 */
export function planStepLinks(messages: ChatMessage[], plan: PlanStep[] | undefined, basePath?: string, children: Array<{ id: string; createdAt: number }> = []): Map<string, PlanStepLinks> {
  const links = new Map<string, PlanStepLinks>();
  if (!plan?.length) return links;
  const byTitle = new Map(plan.map(step => [step.title.trim().toLowerCase(), step.id]));
  const created = new Set(collectSessionPrUrls(messages));
  let replay: PlanStep[] | undefined;
  let active: string | undefined;
  // When each step became the one being worked, for anything placed by time.
  const timeline: Array<{ at: number; step: string | undefined }> = [];
  const entry = (step: string) => {
    const e = links.get(step) ?? { prs: [], artifacts: [], projects: [], subagents: [] };
    links.set(step, e);
    return e;
  };
  const add = (item: (entry: PlanStepLinks) => void) => { if (active) item(entry(active)); };
  for (const message of messages) {
    if (message.role === 'assistant') for (const artifact of chatArtifacts(message.content, basePath).filter(a => !a.inlineImage)) add(e => { if (!e.artifacts.some(a => a.path === artifact.path)) e.artifacts.push(artifact); });
    if (message.role === 'user' || message.role === 'assistant') {
      for (const link of projectLinks(message.content)) {
        const e = entry(active ?? plan[0].id);
        if (![...links.values()].some(other => other.projects.some(p => p.url === link.url))) e.projects.push(link);
      }
    }
    for (const call of message.toolCalls ?? []) {
      if (call.name !== 'update_plan') continue;
      const result = applyPlanUpdate(replay, call.input as unknown as PlanUpdateInput);
      if ('error' in result) continue;
      replay = result.plan;
      // With parallel active steps, the latest one in the plan is the one being worked.
      const current = replay.filter(step => step.status === 'active').pop();
      active = current ? byTitle.get(current.title.trim().toLowerCase()) : undefined;
      timeline.push({ at: message.createdAt, step: active });
    }
    for (const url of extractPrUrls(message.toolResult?.output ?? '')) if (created.has(url)) add(e => { if (!e.prs.includes(url)) e.prs.push(url); });
  }
  for (const child of [...children].sort((a, b) => a.createdAt - b.createdAt)) {
    // The step being worked when it started, or the last one worked before then.
    const at = timeline.filter(t => t.at <= child.createdAt && t.step).pop();
    entry(at?.step ?? plan[0].id).subagents.push(child.id);
  }
  for (const [id, e] of links) if (!e.prs.length && !e.artifacts.length && !e.projects.length && !e.subagents.length) links.delete(id);
  return links;
}
