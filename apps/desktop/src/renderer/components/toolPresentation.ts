/** Plain-language picker labels; tool identifiers and host descriptions stay intact. */
export const TOOL_LABELS: Readonly<Record<string, string>> = {
  read_file: 'Read a file',
  write_file: 'Write a file',
  edit_file: 'Edit a file',
  glob: 'Find files',
  grep: 'Search file contents',
  list_dir: 'List folder contents',
  bash: 'Run a command',
  start_process: 'Start a background process',
  read_process: 'Read process output',
  kill_process: 'Stop a background process',
  fetch_url: 'Read a web page',
  browser: 'Use the browser',
  capture: 'Capture the screen',
  delegation_targets: 'Find available agent models',
  spawn_agent: 'Delegate to an agent',
  ask_user: 'Ask a question',
  report_experiment: 'Report an experiment',
  update_plan: 'Update the plan',
  report_artifact: 'Report an artifact',
  decide: 'Classify or score content',
  agent_watch: 'Schedule a follow-up',
  set_chat_title: 'Name this chat',
  complete_session: 'Mark this chat complete',
};

function humanize(name: string): string {
  const words = name.replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/[_./:-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : 'Unnamed tool';
}

export function toolPickerLabel(name: string): string {
  if (name.startsWith('mcp__')) {
    const [, server, ...tool] = name.split('__');
    return `${humanize(tool.join(' '))} (${humanize(server || 'MCP')})`;
  }
  return TOOL_LABELS[name] ?? humanize(name);
}

export function toolMatchesQuery(tool: { name: string; description: string }, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || [toolPickerLabel(tool.name), tool.name, tool.description].some((text) => text.toLowerCase().includes(q));
}
