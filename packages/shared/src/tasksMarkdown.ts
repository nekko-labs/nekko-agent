import type { ConnectorResource } from './connectors.js';

/**
 * Parse a Markdown checklist into tasks: each `- [ ]` / `* [ ]` line is an open
 * task, `[x]` lines are done and skipped. The nearest heading above becomes the
 * subtitle so a TASKS.md grouped by section reads the same in the panel.
 *
 * Shared so the tasks-file connector (host) and the Agent Monitor's Project
 * group (renderer, reading the chat's own repo) parse a file the same way.
 */
export function parseTasksMarkdown(text: string, path = ''): ConnectorResource[] {
  const out: ConnectorResource[] = [];
  let section = '';
  text.split(/\r?\n/).forEach((line, i) => {
    // Linear prefix checks, not one backtracking regex (CodeQL polynomial
    // ReDoS on whitespace-heavy lines); mirrors parse_tasks_markdown in Rust.
    const hashes = /^#{1,6}/.exec(line)?.[0].length ?? 0;
    if (hashes && /^\s/.test(line.slice(hashes)) && line[hashes] !== '#') { section = line.slice(hashes).trim(); return; }
    const body = line.trimStart();
    if (!'-*+'.includes(body[0] ?? 'z') || !/^\s/.test(body.slice(1))) return;
    const box = body.slice(1).trimStart();
    if (!box.startsWith('[ ]') || !/^\s/.test(box.slice(3))) return;
    out.push({ id: `${path}:${i + 1}`, title: box.slice(3).trim(), subtitle: section || 'Tasks file', url: path ? `file://${path}` : undefined, body: '' });
  });
  return out;
}

/**
 * Repo task files the Project group looks for, in preference order. Matched
 * case-insensitively against a folder's entries (TASKS.md, tasks.md, ...).
 */
export const PROJECT_TASK_FILES = ['tasks.md', 'todo.md', 'todos.md', 'backlog.md', 'roadmap.md'] as const;

/** The best task file among a folder's file names, or null. */
export function pickProjectTaskFile(names: string[]): string | null {
  const byLower = new Map(names.map((n) => [n.toLowerCase(), n]));
  for (const want of PROJECT_TASK_FILES) {
    const hit = byLower.get(want);
    if (hit) return hit;
  }
  return null;
}
