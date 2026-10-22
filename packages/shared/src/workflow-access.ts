/**
 * What an unattended workflow run may do with tools.
 *
 * A workflow run has nobody watching it, so it can never wait on an approval
 * (an approval it would need is denied at once) and its tool access is set by
 * the workflow, not the chat defaults:
 *
 * - `none`: no tools at all; the step answers from its prompt alone.
 * - `read`: read, search and list files in the workspace, nothing else.
 * - `allowlist`: only the tools the step lists in `allowedTools`, in Claude
 *   Code's allowed-tools syntax (`Read`, `Grep`, `Bash(gh pr view:*)`). A
 *   shell call runs only when its parsed command matches a `Bash(...)` entry,
 *   whatever the chat mode; `gh` and `git` are further held to reads.
 * - `workspace` (the default, and what a workflow without the field gets):
 *   the normal tool set under the chat's mode, with approvals auto-denied.
 *
 * The daemon's port is crates/nekko-turn/src/workflow_access.rs; the shared
 * cases in crates/nekko-turn/tests/golden/workflow-access.json, checked by
 * workflow-access.golden.test.ts here and by the crate, keep the two the same.
 */

import { TOOL_CATEGORY_OF } from './tool-categories.js';

export type WorkflowToolAccess = 'none' | 'read' | 'allowlist' | 'workspace';

export const WORKFLOW_TOOL_ACCESS: ReadonlyArray<{ id: WorkflowToolAccess; label: string; hint: string }> = [
  { id: 'none', label: 'None', hint: 'No tools. Steps answer from their prompt and context only.' },
  { id: 'read', label: 'Read files', hint: 'Read, search and list files in the workspace. No writes, no commands.' },
  { id: 'allowlist', label: 'Allowlist', hint: 'Only the tools each step lists (Read, Grep, Bash(gh pr view:*)…). gh and git stay read-only.' },
  { id: 'workspace', label: 'Full workspace', hint: 'Every tool, under the default chat mode.' },
];

/** The file tools `read` access keeps. */
export const WORKFLOW_READ_TOOLS: readonly string[] = ['read_file', 'glob', 'grep', 'list_dir'];

/** Bookkeeping tools every run keeps: they touch nothing outside the run's chat. */
export const WORKFLOW_ALWAYS_TOOLS: readonly string[] = ['update_plan', 'set_chat_title'];

/** Claude Code tool names and the Nekko tool each one stands for. */
const CLAUDE_TOOL_NAMES: Readonly<Record<string, string>> = {
  Read: 'read_file',
  Write: 'write_file',
  Edit: 'edit_file',
  MultiEdit: 'edit_file',
  Glob: 'glob',
  Grep: 'grep',
  LS: 'list_dir',
  WebFetch: 'fetch_url',
  Bash: 'bash',
};

/** The reason an unattended run gives when it refuses a call. */
export function unattendedDenial(tool: string, reason: string): string {
  return `Denied: unattended automation run (${tool}: ${reason})`;
}

/**
 * Tools a run session turns off: every classified tool (TOOL_CATEGORY_OF) the
 * access does not keep, so a tool added there later is off under `none`,
 * `read` and `allowlist` until something lists it. `workspace` (or no setting)
 * turns nothing off. Under `allowlist` the step's `allowedTools` decide.
 */
export function workflowDisabledTools(access: WorkflowToolAccess | undefined, allowed?: readonly string[]): string[] {
  if (!access || access === 'workspace') return [];
  const names = Object.keys(TOOL_CATEGORY_OF);
  if (access === 'none') return names;
  return names.filter((name) => !workflowToolAllowed(access, name, allowed));
}

/** One parsed `allowedTools` entry. */
type AllowedEntry = { tool: string; bash?: { prefix: string[]; any: boolean } | null };

/**
 * Parse an allowed-tools entry: `Read`, `Bash`, `Bash(gh:*)`, `Bash(gh pr view:*)`,
 * `Bash(gh pr view *)`, `Bash(npm test)`, or an MCP tool name. Unknown names
 * yield null and allow nothing.
 */
function parseAllowed(entry: string): AllowedEntry | null {
  const text = entry.trim();
  const m = /^([A-Za-z_][\w-]*)(?:\((.*)\))?$/s.exec(text);
  if (!m) return null;
  const [, name, inner] = m;
  if (name.startsWith('mcp__')) return inner === undefined ? { tool: name } : null;
  const tool = CLAUDE_TOOL_NAMES[name];
  if (!tool) return null;
  if (tool !== 'bash') return inner === undefined ? { tool } : null;
  if (inner === undefined) return { tool, bash: null };
  let spec = inner.trim();
  let any = false;
  if (spec.endsWith(':*')) {
    spec = spec.slice(0, -2);
    any = true;
  } else if (spec === '*') {
    return { tool, bash: null };
  } else if (spec.endsWith(' *')) {
    spec = spec.slice(0, -2);
    any = true;
  }
  const prefix = tokenizeCommand(spec);
  if (!prefix || prefix.length === 0) return null;
  return { tool, bash: { prefix, any } };
}

/** The Nekko tools an allowlist offers. */
export function allowlistTools(allowed: readonly string[] | undefined): string[] {
  const out = new Set<string>();
  for (const entry of allowed ?? []) {
    const p = parseAllowed(entry);
    if (!p) continue;
    out.add(p.tool);
    // A background process runs a command too; the same Bash entries govern it.
    if (p.tool === 'bash') out.add('start_process');
  }
  return [...out];
}

/** Whether `access` offers this tool at all. */
export function workflowToolAllowed(access: WorkflowToolAccess | undefined, name: string, allowed?: readonly string[]): boolean {
  if (WORKFLOW_ALWAYS_TOOLS.includes(name)) return true;
  switch (access ?? 'workspace') {
    case 'workspace': return true;
    case 'none': return false;
    case 'read': return WORKFLOW_READ_TOOLS.includes(name);
    case 'allowlist': {
      const tools = allowlistTools(allowed);
      return tools.includes(name) || ((name === 'read_process' || name === 'kill_process') && tools.includes('start_process'));
    }
  }
  return false;
}

/**
 * Split a command line into words, or null when it is anything but one plain
 * command: chaining (`&&`, `||`, `;`, `|`, `&`), substitution (backticks,
 * `$(…)`, any `$` expansion), redirection (`<`, `>`), subshells, newlines and
 * unbalanced quotes never parse, even inside quotes, so a match can't be
 * smuggled past the check.
 */
export function tokenizeCommand(command: string): string[] | null {
  if (/[;&|<>`$\n\r()\\]/.test(command)) return null;
  const words: string[] = [];
  let cur = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (inWord) words.push(cur);
      cur = '';
      inWord = false;
      continue;
    }
    cur += ch;
    inWord = true;
  }
  if (quote) return null;
  if (inWord) words.push(cur);
  return words;
}

const GIT_READ = new Set(['diff', 'log', 'show', 'status', 'rev-parse', 'fetch']);

/** Why a `gh` or `git` command is not a read, or null when it is one (or is neither). */
export function readOnlyViolation(words: readonly string[]): string | null {
  const bin = words[0]?.split('/').pop();
  if (bin === 'gh') {
    const [, group, sub] = words;
    if (group === 'pr' && ['view', 'diff', 'checks'].includes(sub ?? '')) return null;
    if (group === 'repo' && sub === 'view') return null;
    if (group === 'api') {
      for (let i = 2; i < words.length; i++) {
        const w = words[i];
        const method = w === '-X' || w === '--method' ? words[i + 1]
          : w.startsWith('--method=') ? w.slice(9)
          : w.startsWith('-X') && w.length > 2 ? w.slice(2)
          : undefined;
        if (method !== undefined && method.toUpperCase() !== 'GET') return 'gh api may only GET';
        if (['-f', '-F', '--field', '--raw-field', '--input'].includes(w) || /^(-f|-F).|^--(field|raw-field|input)=/.test(w)) return 'gh api may not send fields or input';
      }
      return null;
    }
    return 'gh is limited to pr view|diff|checks, repo view and api GETs';
  }
  if (bin === 'git') {
    const sub = words[1];
    if (!sub || !GIT_READ.has(sub)) return 'git is limited to diff, log, show, status, rev-parse and fetch';
    if (words.some((w) => /^--(output|upload-pack|exec|receive-pack)/.test(w))) return 'git option not allowed';
    return null;
  }
  return null;
}

/** Whether a command line matches one of the `Bash(...)` entries and stays a read for gh/git. */
export function commandAllowed(command: string, allowed: readonly string[] | undefined): { ok: true } | { ok: false; reason: string } {
  const words = tokenizeCommand(command);
  if (!words || words.length === 0) return { ok: false, reason: 'only a single plain command can match the allowlist (no chaining, substitution or redirection)' };
  const violation = readOnlyViolation(words);
  if (violation) return { ok: false, reason: violation };
  for (const entry of allowed ?? []) {
    const p = parseAllowed(entry);
    if (!p || p.tool !== 'bash') continue;
    if (p.bash === null || p.bash === undefined) return { ok: true };
    const { prefix, any } = p.bash;
    if (words.length < prefix.length || (!any && words.length !== prefix.length)) continue;
    if (prefix.every((w, i) => words[i] === w)) return { ok: true };
  }
  return { ok: false, reason: 'command does not match the step\'s allowed tools' };
}

/** The workflow fields a run session carries. */
export interface WorkflowSessionPolicy {
  unattended?: boolean;
  workflowRunId?: string;
  toolAccess?: WorkflowToolAccess;
  allowedTools?: string[];
}

/**
 * How a tool call in a run session is to be handled, before it runs:
 * `allow` (the normal path: guardrails and approvals apply, and an approval
 * an unattended run would need is denied), `auto` (the allowlist names it: run
 * without asking), or `deny` with the reason the tool result gives.
 */
export type WorkflowToolDecision = { kind: 'allow' } | { kind: 'auto' } | { kind: 'deny'; reason: string };

export function workflowToolDecision(session: WorkflowSessionPolicy, call: { name: string; input?: unknown }): WorkflowToolDecision {
  const access = session.toolAccess;
  if (!access || access === 'workspace') return { kind: 'allow' };
  if (WORKFLOW_ALWAYS_TOOLS.includes(call.name)) return { kind: 'allow' };
  if (!workflowToolAllowed(access, call.name, session.allowedTools)) {
    const label = access === 'allowlist' ? 'not in the step\'s allowed tools' : `not available with ${access === 'none' ? 'no' : 'read-only'} tool access`;
    return { kind: 'deny', reason: unattendedDenial(call.name, label) };
  }
  if (access === 'read') return { kind: 'allow' };
  if (call.name === 'bash' || call.name === 'start_process') {
    const command = (call.input as { command?: unknown } | undefined)?.command;
    const verdict = commandAllowed(typeof command === 'string' ? command : '', session.allowedTools);
    return verdict.ok ? { kind: 'auto' } : { kind: 'deny', reason: unattendedDenial(call.name, verdict.reason) };
  }
  return { kind: 'auto' };
}
