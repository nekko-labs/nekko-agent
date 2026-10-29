/**
 * How the Agents panel arranges its cards: what it groups them by, what order
 * each group is in, and what it shows. A per-window preference, remembered like
 * the panel's width, not a setting.
 *
 * The defaults group the cards by activity (what each agent is doing), in the
 * order cards were dragged into (newest first for the rest), every detail and
 * every group shown.
 */

export type AgentGroupBy = 'project' | 'status' | 'date' | 'none';
export type AgentSortBy = 'manual' | 'updated' | 'created' | 'name';
export type SortDirection = 'desc' | 'asc';

export type AgentPanelView = {
  groupBy: AgentGroupBy;
  sortBy: AgentSortBy;
  direction: SortDirection;
  /** The model, context, git and sub-agent lines under each card's title. */
  showMetadata: boolean;
  /** The model provider ("Claude", "Local") as subtext under the model. */
  showProvider: boolean;
  /** Chats an automation started (they carry a task id). */
  showAutomations: boolean;
  /** Groups with nothing in them, shown with their "No active agents" line. */
  showEmptyGroups: boolean;
};

export const DEFAULT_AGENT_PANEL_VIEW: AgentPanelView = {
  groupBy: 'status',
  sortBy: 'manual',
  direction: 'desc',
  showMetadata: true,
  showProvider: true,
  showAutomations: true,
  showEmptyGroups: true,
};

export const GROUP_BY_LABELS: Record<AgentGroupBy, string> = {
  project: 'Project',
  status: 'Activity',
  date: 'Date',
  none: 'None',
};

export const SORT_BY_LABELS: Record<AgentSortBy, string> = {
  manual: 'Manual',
  updated: 'Last updated',
  created: 'Date created',
  name: 'Name',
};

export const AGENT_PANEL_VIEW_KEY = 'nekko.agentPanelView';

const GROUPS: AgentGroupBy[] = ['project', 'status', 'date', 'none'];
const SORTS: AgentSortBy[] = ['manual', 'updated', 'created', 'name'];

/** Read a saved view, keeping only fields that are still valid. */
export function parseAgentPanelView(raw: string | null): AgentPanelView {
  if (!raw) return DEFAULT_AGENT_PANEL_VIEW;
  let saved: Partial<Record<keyof AgentPanelView, unknown>>;
  try { saved = JSON.parse(raw); } catch { return DEFAULT_AGENT_PANEL_VIEW; }
  if (!saved || typeof saved !== 'object') return DEFAULT_AGENT_PANEL_VIEW;
  const d = DEFAULT_AGENT_PANEL_VIEW;
  const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
  return {
    groupBy: GROUPS.includes(saved.groupBy as AgentGroupBy) ? saved.groupBy as AgentGroupBy : d.groupBy,
    sortBy: SORTS.includes(saved.sortBy as AgentSortBy) ? saved.sortBy as AgentSortBy : d.sortBy,
    direction: saved.direction === 'asc' || saved.direction === 'desc' ? saved.direction : d.direction,
    showMetadata: bool(saved.showMetadata, d.showMetadata),
    showProvider: bool(saved.showProvider, d.showProvider),
    showAutomations: bool(saved.showAutomations, d.showAutomations),
    showEmptyGroups: bool(saved.showEmptyGroups, d.showEmptyGroups),
  };
}

export function readAgentPanelView(): AgentPanelView {
  try { return parseAgentPanelView(localStorage.getItem(AGENT_PANEL_VIEW_KEY)); } catch { return DEFAULT_AGENT_PANEL_VIEW; }
}

export function saveAgentPanelView(view: AgentPanelView): void {
  try { localStorage.setItem(AGENT_PANEL_VIEW_KEY, JSON.stringify(view)); } catch { /* private mode */ }
}

export function isDefaultView(view: AgentPanelView): boolean {
  return (Object.keys(DEFAULT_AGENT_PANEL_VIEW) as Array<keyof AgentPanelView>).every((k) => view[k] === DEFAULT_AGENT_PANEL_VIEW[k]);
}

/**
 * Cards keep their dragged order only when they sit in their projects in
 * manual order; anywhere else a drop would write an order nobody can see.
 */
export function canReorder(view: AgentPanelView): boolean {
  return view.groupBy === 'project' && view.sortBy === 'manual';
}

/**
 * Pick a sort. Names start A to Z and dates start newest first, so choosing a
 * sort reads the natural way round without a second trip for the direction.
 */
export function withSort(view: AgentPanelView, sortBy: AgentSortBy): AgentPanelView {
  if (sortBy === view.sortBy) return view;
  return { ...view, sortBy, direction: sortBy === 'name' ? 'asc' : 'desc' };
}

/** What a card is sorted and dated by. */
export type SortableCard = { title: string; updatedAt: number; createdAt: number; order?: number };

/** Compare two cards for the chosen order. */
export function compareCards(view: Pick<AgentPanelView, 'sortBy' | 'direction'>) {
  return (a: SortableCard, b: SortableCard): number => {
    if (view.sortBy === 'manual') {
      // Dragged cards above never-dragged ones, which fall back to recency.
      if (a.order != null && b.order != null) return a.order - b.order;
      if (a.order != null) return -1;
      if (b.order != null) return 1;
      return b.updatedAt - a.updatedAt;
    }
    const sign = view.direction === 'asc' ? 1 : -1;
    if (view.sortBy === 'name') {
      const byName = a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true });
      return byName === 0 ? b.updatedAt - a.updatedAt : sign * byName;
    }
    const at = (c: SortableCard) => (view.sortBy === 'created' ? c.createdAt : c.updatedAt);
    return sign * (at(a) - at(b));
  };
}

/** The activity groups, most urgent first. */
export const STATUS_GROUPS = [
  { key: 'status:input', name: 'Needs input' },
  { key: 'status:working', name: 'Working' },
  { key: 'status:error', name: 'Error' },
  { key: 'status:done', name: 'Done' },
] as const;

export function statusGroupOf(status: 'working' | 'input' | 'error' | 'done' | 'idle' | undefined): string {
  return !status || status === 'idle' ? 'status:done' : `status:${status}`;
}

/** The date groups, newest first. */
export const DATE_GROUPS = [
  { key: 'date:today', name: 'Today' },
  { key: 'date:yesterday', name: 'Yesterday' },
  { key: 'date:week', name: 'Previous 7 days' },
  { key: 'date:month', name: 'Previous 30 days' },
  { key: 'date:older', name: 'Older' },
] as const;

/** The date group a time falls in, counted in local calendar days. */
export function dateGroupOf(at: number, now: number): string {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const today = startOfToday.getTime();
  const day = 24 * 60 * 60 * 1000;
  if (at >= today) return 'date:today';
  if (at >= today - day) return 'date:yesterday';
  if (at >= today - 7 * day) return 'date:week';
  if (at >= today - 30 * day) return 'date:month';
  return 'date:older';
}
