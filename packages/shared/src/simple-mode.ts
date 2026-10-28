/*
 * Simple and Expert (spec desktop/desktop-simple-and-expert-modes): the
 * controls each mode shows. Every listed control is shown in both modes, in
 * Expert only, or nowhere, chosen per device in Settings > Simple mode. The
 * iPhone (SimpleMode.swift) and Android (SimpleMode.kt) apps keep copies of
 * this list; keep the ids in step.
 */

/** Where a control shows: in both modes, in Expert only, or in neither. */
export type SimpleVisibility = 'show' | 'expert' | 'hide';

export type SimplePlatform = 'desktop' | 'phone';

export interface SimpleItem {
  id: string;
  /** The page and area it sits in, as Settings groups it. */
  area: string;
  label: string;
  hint: string;
  platforms: readonly SimplePlatform[];
  default: SimpleVisibility;
}

const D = ['desktop'] as const;
const P = ['phone'] as const;
const DP = ['desktop', 'phone'] as const;

export const SIMPLE_ITEMS: readonly SimpleItem[] = [
  { id: 'worktree', area: 'Chat · header', label: 'Git checkout chip', hint: 'Which branch or worktree the chat works in', platforms: D, default: 'expert' },
  { id: 'changes', area: 'Chat · header', label: 'Changes', hint: 'Review the files the agent changed', platforms: DP, default: 'expert' },
  { id: 'logs', area: 'Chat · header', label: 'Agent logs', hint: 'The raw command log', platforms: D, default: 'expert' },
  { id: 'hardware', area: 'Chat · header', label: 'Hardware strip', hint: 'CPU, memory and GPU dials under the title', platforms: DP, default: 'expert' },
  { id: 'ph-subtitle', area: 'Chat · header', label: 'Model and computer under the title', hint: 'Like "Opus 5.5 · Studio Mac"', platforms: P, default: 'expert' },
  { id: 'model', area: 'Chat · message box', label: 'Model name and picker', hint: 'Switch between Claude, ChatGPT or a local model', platforms: DP, default: 'show' },
  { id: 'effort', area: 'Chat · message box', label: 'Effort', hint: 'How hard the model thinks before it answers', platforms: DP, default: 'expert' },
  { id: 'context', area: 'Chat · message box', label: 'Context ring and token count', hint: 'How full this chat is, in tokens', platforms: DP, default: 'expert' },
  { id: 'cost', area: 'Chat · message box', label: 'Cost and limits', hint: 'What this chat has cost, and plan limits', platforms: D, default: 'expert' },
  { id: 'mode', area: 'Chat · message box', label: 'Mode panel', hint: 'Environment, approvals, tools and rules in one panel', platforms: D, default: 'expert' },
  { id: 'privacy', area: 'Chat · message box', label: 'Privacy Shield', hint: 'What is masked before a message leaves this computer', platforms: D, default: 'expert' },
  { id: 'ph-policy', area: 'Chat · message box', label: 'Tool policy', hint: 'Ask, Guardrails or YOLO, in the More menu and New chat', platforms: P, default: 'expert' },
  { id: 'tools', area: 'Chat · message box', label: 'Tools and MCP menus', hint: 'Turn single tools and MCP servers on or off', platforms: D, default: 'expert' },
  { id: 'suggest', area: 'Chat · message box', label: 'Prompt suggestions', hint: 'Tips to make a request clearer', platforms: D, default: 'show' },
  { id: 'thinking', area: 'Chat · conversation', label: 'Reasoning and tool steps', hint: 'What the model thought, and each step it took', platforms: DP, default: 'expert' },
  { id: 'stats', area: 'Chat · conversation', label: 'Reply stats', hint: 'Tokens, speed and time under each reply', platforms: D, default: 'expert' },
  { id: 'ph-git', area: 'Chat · conversation', label: 'Git and pull requests', hint: 'Commits, PR cards and the PR dock', platforms: DP, default: 'expert' },
  { id: 'terminal', area: 'Agents wall', label: 'Terminal', hint: 'Open a terminal from New or the More menu', platforms: DP, default: 'expert' },
  { id: 'cardmeta', area: 'Agents wall', label: 'Model and tokens on window cards', hint: 'Like "Opus 5.5 · 48k context"', platforms: D, default: 'expert' },
  { id: 'mon-hw', area: 'Agents wall', label: 'Hardware and local models monitors', hint: 'Dials and resident models in the dock', platforms: D, default: 'expert' },
  { id: 'mon-budget', area: 'Agents wall', label: 'Budget, cost and utilization', hint: 'Spending and token use in the dock', platforms: D, default: 'expert' },
  { id: 'ci', area: 'Workflows', label: 'CI runners', hint: 'Use this computer as a CI runner', platforms: D, default: 'expert' },
  { id: 'engine', area: 'Models', label: 'Model server details', hint: 'Engine, load settings and advanced flags', platforms: D, default: 'expert' },
  { id: 'set-tools', area: 'Settings', label: 'Advanced settings', hint: 'Tools, agent loop, hooks, sandbox and developer pages', platforms: D, default: 'expert' },
  { id: 'ph-monitors', area: 'Phone · chats list', label: 'Monitors row', hint: 'Hardware and loaded models at the top of Chats', platforms: P, default: 'expert' },
];

/** Choices that differ from the defaults, by item id. */
export type SimpleChoices = Readonly<Record<string, SimpleVisibility>>;

const BY_ID = new Map(SIMPLE_ITEMS.map((i) => [i.id, i]));
const VALUES = new Set<string>(['show', 'expert', 'hide']);

/** Where an item shows, after the person's choice. Unknown ids always show. */
export function simpleVisibility(id: string, choices: SimpleChoices = {}): SimpleVisibility {
  const item = BY_ID.get(id);
  if (!item) return 'show';
  return choices[id] ?? item.default;
}

/** Whether an item is on screen in the given mode. */
export function simpleShown(id: string, expert: boolean, choices: SimpleChoices = {}): boolean {
  const v = simpleVisibility(id, choices);
  return v === 'show' || (v === 'expert' && expert);
}

/** Saved choices, keeping only known ids with valid values. Never throws. */
export function parseSimpleChoices(raw: unknown): Record<string, SimpleVisibility> {
  let value = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw); } catch { return {}; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, SimpleVisibility> = {};
  for (const [id, v] of Object.entries(value)) {
    if (BY_ID.has(id) && typeof v === 'string' && VALUES.has(v) && v !== BY_ID.get(id)!.default) out[id] = v as SimpleVisibility;
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
