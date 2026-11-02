/*
 * Simple and Expert (spec desktop/desktop-simple-and-expert-modes): the
 * controls each mode shows. Philip's rule is contextual relevance: a control
 * that means nothing right now is not on screen, and capability never goes
 * away, only what sits on screen. Each listed control has one visibility,
 * chosen per device in Settings > Simple mode. The iPhone (SimpleMode.swift)
 * and Android (SimpleMode.kt) apps keep copies of this list and of
 * `simpleShown`; keep the ids and the rules in step.
 */

/**
 * Where a control shows: in both modes, in Expert only, nowhere, or (`auto`) in
 * both modes but only while its `when` condition holds.
 */
export type SimpleVisibility = 'show' | 'expert' | 'hide' | 'auto';

export type SimplePlatform = 'desktop' | 'phone';

/** What is true right now that can make a control relevant. */
export interface SimpleContext {
  /** A local model is running on this device: see `localModelRunning`. */
  localModel?: boolean;
  /** This chat has changed files. */
  changes?: boolean;
  /** This chat has a pull request. */
  pr?: boolean;
  /** Agents are at work in the background: see `agentMonitorRelevant`. */
  agents?: boolean;
}

export type SimpleCondition = keyof SimpleContext;

export interface SimpleItem {
  id: string;
  /** The page and area it sits in, as Settings groups it. */
  area: string;
  label: string;
  hint: string;
  platforms: readonly SimplePlatform[];
  default: SimpleVisibility;
  /** It has nothing to show without this, in any mode and whatever is chosen. */
  needs?: SimpleCondition;
  /** What makes it relevant: `auto` waits for this, and `expert` also shows in Simple while it holds. */
  when?: SimpleCondition;
}

const D = ['desktop'] as const;
const P = ['phone'] as const;
const DP = ['desktop', 'phone'] as const;

export const SIMPLE_ITEMS: readonly SimpleItem[] = [
  { id: 'worktree', area: 'Chat · header', label: 'Git checkout chip', hint: 'Which branch or worktree the chat works in', platforms: D, default: 'expert' },
  { id: 'changes', area: 'Chat · header', label: 'Changes', hint: 'Says how many files the agent changed. Only while this chat has changed files', platforms: DP, default: 'show', needs: 'changes' },
  { id: 'logs', area: 'Chat · header', label: 'Agent logs', hint: 'The raw command log', platforms: D, default: 'expert' },
  { id: 'agent-monitor', area: 'Chat · header', label: 'Agent Monitor', hint: 'Sub-agents, queued work and artifacts. In Simple, only while agents run in the background', platforms: D, default: 'expert', when: 'agents' },
  { id: 'hardware', area: 'Chat · header', label: 'Hardware strip', hint: 'CPU, memory and GPU dials under the title', platforms: DP, default: 'auto', when: 'localModel' },
  { id: 'ph-subtitle', area: 'Chat · header', label: 'Model and computer under the title', hint: 'Like "Opus 5.5 · Studio Mac"', platforms: P, default: 'expert' },
  { id: 'model', area: 'Chat · message box', label: 'Model name and picker', hint: 'Switch between Claude, ChatGPT or a local model', platforms: DP, default: 'show' },
  { id: 'effort', area: 'Chat · message box', label: 'Effort', hint: 'How hard the model thinks before it answers. Inside the model menu in Simple', platforms: DP, default: 'show' },
  { id: 'asks', area: 'Chat · message box', label: 'Asks first', hint: 'When the agent stops to ask you, in plain words', platforms: DP, default: 'show' },
  { id: 'context', area: 'Chat · message box', label: 'Usage ring', hint: 'How full this chat is. Simple shows only the ring; the numbers are in its tooltip', platforms: DP, default: 'show' },
  { id: 'cost', area: 'Chat · message box', label: 'Cost and limits', hint: 'What this chat has cost, and plan limits', platforms: D, default: 'expert' },
  { id: 'mode', area: 'Chat · message box', label: 'Mode panel', hint: 'Environment, approvals, tools and rules in one panel', platforms: D, default: 'expert' },
  { id: 'privacy', area: 'Chat · message box', label: 'Privacy Shield', hint: 'What is masked before a message leaves this computer', platforms: D, default: 'expert' },
  { id: 'tools', area: 'Chat · message box', label: 'Tools and MCP menus', hint: 'Turn single tools and MCP servers on or off', platforms: D, default: 'expert' },
  { id: 'internet', area: 'Chat · message box', label: 'Internet switch', hint: 'Turn the internet off for this chat. Stays on screen while it is off', platforms: D, default: 'expert' },
  { id: 'suggest', area: 'Chat · message box', label: 'Prompt suggestions', hint: 'Tips to make a request clearer', platforms: D, default: 'show' },
  { id: 'thinking', area: 'Chat · conversation', label: 'Reasoning and tool steps', hint: 'What the model thought, and each step it took', platforms: DP, default: 'expert' },
  { id: 'stats', area: 'Chat · conversation', label: 'Reply stats', hint: 'Tokens, speed and time under each reply', platforms: D, default: 'expert' },
  { id: 'pr-status', area: 'Chat · conversation', label: 'Pull request status', hint: 'The PR dock and PR chips. Only while this chat has a pull request', platforms: DP, default: 'show', needs: 'pr' },
  { id: 'ph-git', area: 'Chat · conversation', label: 'Git', hint: 'The Git screen and commits', platforms: P, default: 'expert' },
  { id: 'terminal', area: 'Agents wall', label: 'Terminal', hint: 'Open a terminal from New or the More menu', platforms: DP, default: 'expert' },
  { id: 'cardmeta', area: 'Agents wall', label: 'Model and tokens on window cards', hint: 'Like "Opus 5.5 · 48k context"', platforms: D, default: 'expert' },
  { id: 'mon-hw', area: 'Agents wall', label: 'Hardware and local models monitors', hint: 'Dials and resident models in the dock', platforms: D, default: 'auto', when: 'localModel' },
  { id: 'mon-budget', area: 'Agents wall', label: 'Budget, cost and utilization', hint: 'Spending and token use in the dock', platforms: D, default: 'expert' },
  { id: 'ci', area: 'Workflows', label: 'CI runners', hint: 'Use this computer as a CI runner', platforms: D, default: 'expert' },
  { id: 'engine', area: 'Models', label: 'Model server details', hint: 'Engine, load settings and advanced flags', platforms: D, default: 'expert' },
  { id: 'set-tools', area: 'Settings', label: 'Advanced settings', hint: 'Tools, agent loop, hooks, sandbox and developer pages', platforms: D, default: 'expert' },
  { id: 'ph-monitors', area: 'Phone · chats list', label: 'Monitors row', hint: 'Hardware and loaded models in Chats', platforms: P, default: 'auto', when: 'localModel' },
];

/** Choices that differ from the defaults, by item id. */
export type SimpleChoices = Readonly<Record<string, SimpleVisibility>>;

const BY_ID = new Map(SIMPLE_ITEMS.map((i) => [i.id, i]));

/**
 * Whether a local model is running on this device. The one check everything
 * contextual reads. It answers for this device only; a connected computer
 * running a local model belongs here too once that link exists.
 */
export function localModelRunning(engine?: { running?: boolean; resident?: readonly unknown[] } | null): boolean {
  return !!engine?.running && (engine.resident?.length ?? 0) > 0;
}

/**
 * Whether Simple's Agent Monitor button means anything: a sub-agent of this
 * chat is running, or its Claude Code has background tasks. Queued messages
 * and artifacts stay out: the first are already above the message box, and the
 * second are not news.
 */
export function agentMonitorRelevant(work: { runningSubAgents: number; backgroundTasks: number }): boolean {
  return work.runningSubAgents > 0 || work.backgroundTasks > 0;
}

/** The choices an item offers. Show pins an `auto` control on, so it takes the place of Expert only. */
export function simpleOptions(item: SimpleItem): readonly SimpleVisibility[] {
  return item.default === 'auto' ? ['auto', 'show', 'hide'] : ['show', 'expert', 'hide'];
}

/** Where an item shows, after the person's choice. Unknown ids always show. */
export function simpleVisibility(id: string, choices: SimpleChoices = {}): SimpleVisibility {
  const item = BY_ID.get(id);
  if (!item) return 'show';
  return choices[id] ?? item.default;
}

/**
 * Whether an item is on screen now. Hide always wins. `needs` is required in
 * every mode. Otherwise Show is always on, `auto` waits for its condition, and
 * Expert only is on in Expert, plus in Simple while its condition holds.
 */
export function simpleShown(id: string, expert: boolean, choices: SimpleChoices = {}, context: SimpleContext = {}): boolean {
  const item = BY_ID.get(id);
  const v = simpleVisibility(id, choices);
  if (v === 'hide' || (item?.needs && !context[item.needs])) return false;
  const relevant = !!item?.when && !!context[item.when];
  if (v === 'auto') return relevant;
  return v === 'show' || expert || relevant;
}

/** Saved choices, keeping only known ids with values that item offers. Never throws. */
export function parseSimpleChoices(raw: unknown): Record<string, SimpleVisibility> {
  let value = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw); } catch { return {}; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, SimpleVisibility> = {};
  for (const [id, v] of Object.entries(value)) {
    const item = BY_ID.get(id);
    if (item && simpleOptions(item).includes(v as SimpleVisibility) && v !== item.default) out[id] = v as SimpleVisibility;
  }
  return out;
}

/** The items for one platform, grouped by area in catalogue order. */
export function simpleAreas(platform: SimplePlatform): Array<{ area: string; items: SimpleItem[] }> {
  const areas: Array<{ area: string; items: SimpleItem[] }> = [];
  for (const item of SIMPLE_ITEMS) {
    if (!item.platforms.includes(platform)) continue;
    const last = areas.find((a) => a.area === item.area);
    if (last) last.items.push(item); else areas.push({ area: item.area, items: [item] });
  }
  return areas;
}
