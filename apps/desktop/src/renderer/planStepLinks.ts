import { applyPlanUpdate, collectSessionPrUrls, extractPrUrls, type ChatMessage, type PlanStep, type PlanUpdateInput } from '@nekko-agent/shared';
import { chatArtifacts, type ChatArtifact } from './chatArtifacts.js';
import { PHASE_STEP_PREFIX, claudeCodePhase } from './claudeAgentPlan.js';

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
 *
 * A Claude Agent chat's clock is Claude Code's own plan calls (`TodoWrite`,
 * `TaskCreate`/`TaskUpdate`), and on its activity plan (claudeAgentPlan.ts)
 * the phase of each call it makes in the latest request.
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
  const ids = new Set(plan.map(step => step.id));
  const work = (title: string | undefined, at: number) => {
    active = title ? byTitle.get(title.trim().toLowerCase()) : undefined;
    timeline.push({ at, step: active });
  };
  // Claude Code's tasks by id, from each TaskCreate's input and its result.
  const creating = new Map<string, string>();
  const tasks = new Map<string, string>();
  // An activity plan covers the latest request only.
  const phased = ids.has(PHASE_STEP_PREFIX + 'sent');
  const lastAsk = phased ? messages.map(m => m.role).lastIndexOf('user') : -1;
  for (const [index, message] of messages.entries()) {
    if (phased && index === lastAsk) { active = PHASE_STEP_PREFIX + 'sent'; timeline.push({ at: message.createdAt, step: active }); }
    const subject = message.toolResult && !message.toolResult.isError ? creating.get(message.toolResult.toolCallId) : undefined;
    const taskId = subject && /Task #(\S+) created/.exec(message.toolResult?.output ?? '')?.[1];
    if (subject && taskId) tasks.set(taskId, subject);
    if (message.role === 'assistant') for (const artifact of chatArtifacts(message.content, basePath).filter(a => !a.inlineImage)) add(e => { if (!e.artifacts.some(a => a.path === artifact.path)) e.artifacts.push(artifact); });
    if (message.role === 'user' || message.role === 'assistant') {
      for (const link of projectLinks(message.content)) {
        const e = entry(active ?? plan[0].id);
        if (![...links.values()].some(other => other.projects.some(p => p.url === link.url))) e.projects.push(link);
      }
    }
    for (const call of message.toolCalls ?? []) {
      const input = (call.input ?? {}) as Record<string, unknown>;
      const phase = phased && index > lastAsk ? claudeCodePhase(call) : null;
      if (phase && ids.has(PHASE_STEP_PREFIX + phase)) { active = PHASE_STEP_PREFIX + phase; timeline.push({ at: message.createdAt, step: active }); continue; }
      if (call.name === 'TodoWrite') {
        const todos = Array.isArray(input.todos) ? input.todos as Array<{ content?: unknown; status?: unknown }> : [];
        work(todos.find(t => t.status === 'in_progress')?.content as string | undefined, message.createdAt);
        continue;
      }
      if (call.name === 'TaskCreate' && typeof input.subject === 'string') { creating.set(call.id, input.subject); continue; }
      if (call.name === 'TaskUpdate' && input.status === 'in_progress') { work(tasks.get(String(input.taskId)), message.createdAt); continue; }
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
