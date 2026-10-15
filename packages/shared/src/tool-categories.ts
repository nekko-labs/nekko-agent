/**
 * What kind of thing each agent tool touches, so the Tools menu can group them
 * and the chat's internet switch can turn off exactly the ones that go online.
 *
 * Blocking the internet keeps every local category (files, shell, desktop and
 * the agent's own bookkeeping) and drops `online`: tools whose job is to reach
 * a network service. MCP servers are treated as online because a server can
 * be remote and the app cannot tell. Delegation, watches and `decide` are
 * dropped too: each can route to a cloud provider. The shell stays a local
 * tool; a command it runs is not network-sandboxed, which the UI says.
 */

export type ToolCategory = 'files' | 'shell' | 'online' | 'desktop' | 'agent' | 'mcp';

/** Display order and labels for the Tools menu. */
export const TOOL_CATEGORIES: ReadonlyArray<{ id: ToolCategory; label: string; description: string }> = [
  { id: 'files', label: 'File system', description: 'Read, search and edit files in the chat’s folders.' },
  { id: 'shell', label: 'Shell & processes', description: 'Run commands and background processes on this computer.' },
  { id: 'desktop', label: 'Desktop', description: 'Capture local app windows.' },
  { id: 'online', label: 'Online', description: 'Reach the internet: fetch pages, drive a browser.' },
  { id: 'agent', label: 'Agent', description: 'Plans, questions, sub-agents and watches.' },
  { id: 'mcp', label: 'MCP servers', description: 'Tools from connected MCP servers, which may be remote.' },
];

/** The category of every tool the app ships. Unknown names fall back by prefix (see `toolCategory`). */
export const TOOL_CATEGORY_OF: Readonly<Record<string, ToolCategory>> = {
  read_file: 'files',
  write_file: 'files',
  edit_file: 'files',
  glob: 'files',
  grep: 'files',
  list_dir: 'files',
  bash: 'shell',
  start_process: 'shell',
  read_process: 'shell',
  kill_process: 'shell',
  fetch_url: 'online',
  browser: 'online',
  capture: 'desktop',
  delegation_targets: 'agent',
  spawn_agent: 'agent',
  agent_watch: 'agent',
  update_plan: 'agent',
  set_chat_title: 'agent',
  complete_session: 'agent',
  ask_user: 'agent',
  decide: 'agent',
  report_experiment: 'agent',
  report_artifact: 'agent',
};

/** Agent tools that can reach a cloud provider, so an offline chat goes without them. */
export const OFFLINE_BLOCKED_AGENT_TOOLS: readonly string[] = ['delegation_targets', 'spawn_agent', 'agent_watch', 'decide'];

export function toolCategory(name: string): ToolCategory {
  if (name.startsWith('mcp__')) return 'mcp';
  return TOOL_CATEGORY_OF[name] ?? 'agent';
}

/**
 * Whether an offline (internet-blocked) chat may still offer this tool. A tool
 * missing from `TOOL_CATEGORY_OF` is refused: a new tool has to be classified
 * before an offline chat can use it, so one that reaches a network cannot slip
 * through by default.
 */
export function toolAllowedOffline(name: string): boolean {
  if (!name.startsWith('mcp__') && !(name in TOOL_CATEGORY_OF)) return false;
  const category = toolCategory(name);
  if (category === 'online' || category === 'mcp') return false;
  return !OFFLINE_BLOCKED_AGENT_TOOLS.includes(name);
}

/** Tools grouped in menu order, empty groups dropped. */
export function groupToolsByCategory<T extends { name: string }>(tools: readonly T[]): Array<{ category: (typeof TOOL_CATEGORIES)[number]; tools: T[] }> {
  return TOOL_CATEGORIES
    .map((category) => ({ category, tools: tools.filter((t) => toolCategory(t.name) === category.id) }))
    .filter((g) => g.tools.length > 0);
}
