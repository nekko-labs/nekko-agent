import { spawn } from 'child_process';
import type { AppSettings, HookEvent, HookRule, ToolCall, ToolResult } from '@nekko-agent/shared';

/**
 * Lifecycle hooks: your own commands around the agent's actions.
 *
 * Claude Code has PreToolUse/PostToolUse/Stop hooks, Codex a `notify`
 * command, OpenClaw plugins; Nekko Agent had guardrails (pattern rules on
 * shell commands) and nothing programmable. A hook is a shell command run
 * with the event as JSON on stdin:
 *
 * - `PreToolUse` runs before a tool. Exit code 2, or stdout JSON
 *   `{"decision":"block","reason":"..."}`, blocks the call; the reason goes
 *   back to the model as the tool's error, so it can do something else.
 * - `PostToolUse` runs after a tool. Whatever it prints is appended to the
 *   tool's output for the model (a linter's verdict, a reminder).
 * - `TurnEnd` runs when a reply ends (finished, failed or stopped); nothing
 *   waits on it. Notifications, logging, "git status" into a file.
 *
 * `matcher` is a regular expression on the tool name (`bash|write_file`),
 * empty for every tool. Hooks run in the chat's workspace with
 * `NEKKO_HOOK_EVENT` set, one after another, each with a time limit.
 */

export const HOOK_TIMEOUT_MS = 60_000;
/**
 * A daemon that lists this in `daemon:info` runs a turn's PreToolUse and
 * PostToolUse hooks itself from the rules in its spec (`facts.hookRules`).
 */
export const DAEMON_HOOKS = 'turn:hooks';
/** Most output a hook may hand to the model. */
export const HOOK_OUTPUT_MAX = 2_000;

export interface HookPayload {
  event: HookEvent;
  sessionId: string;
  cwd: string;
  tool?: { id: string; name: string; input: Record<string, unknown> };
  result?: { output: string; isError?: boolean };
  /** TurnEnd: how the reply ended. */
  stop?: 'complete' | 'loop' | 'runaway' | 'error' | 'stopped';
  error?: string;
}

export interface HookOutcome {
  rule: HookRule;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** The rules that apply to an event and, for tool events, a tool name. */
export function matchingHooks(settings: Pick<AppSettings, 'hooks'>, event: HookEvent, toolName?: string): HookRule[] {
  return (settings.hooks ?? []).filter((h) => {
    if (h.enabled === false || h.event !== event || !h.command.trim()) return false;
    if (!toolName || !h.matcher?.trim()) return true;
    try {
      return new RegExp(h.matcher, 'i').test(toolName);
    } catch {
      return h.matcher.split(/[|,\s]+/).filter(Boolean).includes(toolName);
    }
  });
}

/** Whether any hook wants to see tool calls (then every tool runs in the host). */
export function hasToolHooks(settings: Pick<AppSettings, 'hooks'>): boolean {
  return (settings.hooks ?? []).some((h) => h.enabled !== false && h.command.trim() && (h.event === 'PreToolUse' || h.event === 'PostToolUse'));
}

function shell(command: string): { file: string; args: string[] } {
  return process.platform === 'win32'
    ? { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] }
    : { file: '/bin/sh', args: ['-c', command] };
}

/** Run one hook with the payload on stdin. Never throws. */
export function runHook(rule: HookRule, payload: HookPayload): Promise<HookOutcome> {
  return new Promise((resolve) => {
    const { file, args } = shell(rule.command);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(file, args, {
        cwd: payload.cwd,
        windowsHide: true,
        windowsVerbatimArguments: process.platform === 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, NEKKO_HOOK_EVENT: payload.event, NEKKO_SESSION_ID: payload.sessionId, ...(payload.tool ? { NEKKO_TOOL_NAME: payload.tool.name } : {}) },
      });
    } catch (e) {
      resolve({ rule, code: null, stdout: '', stderr: (e as Error).message, timedOut: false });
      return;
    }
    const limit = Math.min(Math.max(1_000, rule.timeoutMs ?? HOOK_TIMEOUT_MS), 10 * 60_000);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, limit);
    child.stdout?.on('data', (c: Buffer) => { stdout += c.toString(); });
    child.stderr?.on('data', (c: Buffer) => { stderr += c.toString(); });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ rule, code: null, stdout, stderr: stderr || e.message, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ rule, code, stdout, stderr, timedOut });
    });
    // A hook may exit without reading stdin. Pipe writes can then emit EPIPE
    // asynchronously; the process error/close handlers still own its outcome.
    child.stdin?.on('error', () => {});
    try {
      child.stdin?.end(JSON.stringify(payload));
    } catch {
      /* the hook closed stdin early; fine */
    }
  });
}

function clip(s: string): string {
  const t = s.trim();
  return t.length <= HOOK_OUTPUT_MAX ? t : `${t.slice(0, HOOK_OUTPUT_MAX)}…`;
}

export function label(rule: HookRule): string {
  return rule.name?.trim() || rule.command.trim().split(/\s+/)[0] || 'hook';
}

/** A hook's decision, from exit code 2 or a JSON verdict on stdout. */
export function decisionOf(outcome: HookOutcome): { block: boolean; reason: string } {
  const out = outcome.stdout.trim();
  if (out.startsWith('{')) {
    try {
      const v = JSON.parse(out) as { decision?: string; reason?: string };
      if (v.decision === 'block' || v.decision === 'deny') return { block: true, reason: v.reason?.trim() || 'Blocked by a hook.' };
    } catch {
      /* not a verdict */
    }
  }
  if (outcome.code === 2) return { block: true, reason: clip(outcome.stderr || out) || 'Blocked by a hook.' };
  return { block: false, reason: '' };
}

/**
 * Run the PreToolUse hooks for a call. The first that blocks wins; a hook
 * that fails to run or times out never blocks (a broken hook must not stop
 * every tool), but says so in the returned notes.
 */
export async function preToolHooks(settings: Pick<AppSettings, 'hooks'>, call: ToolCall, ctx: { sessionId: string; cwd: string }): Promise<{ block?: string; notes: string[] }> {
  const notes: string[] = [];
  for (const rule of matchingHooks(settings, 'PreToolUse', call.name)) {
    const outcome = await runHook(rule, { event: 'PreToolUse', sessionId: ctx.sessionId, cwd: ctx.cwd, tool: { id: call.id, name: call.name, input: call.input } });
    if (outcome.timedOut) {
      notes.push(`[hook ${label(rule)} timed out and was ignored]`);
      continue;
    }
    const d = decisionOf(outcome);
    if (d.block) return { block: `Blocked by hook ${label(rule)}: ${d.reason}`, notes };
  }
  return { notes };
}

/** Run the PostToolUse hooks; what they print is appended to the result for the model. */
export async function postToolHooks(settings: Pick<AppSettings, 'hooks'>, call: ToolCall, result: ToolResult, ctx: { sessionId: string; cwd: string }): Promise<ToolResult> {
  const rules = matchingHooks(settings, 'PostToolUse', call.name);
  if (!rules.length) return result;
  const notes: string[] = [];
  for (const rule of rules) {
    const outcome = await runHook(rule, {
      event: 'PostToolUse',
      sessionId: ctx.sessionId,
      cwd: ctx.cwd,
      tool: { id: call.id, name: call.name, input: call.input },
      result: { output: result.output, ...(result.isError ? { isError: true } : {}) },
    });
    if (outcome.timedOut) {
      notes.push(`[hook ${label(rule)} timed out]`);
      continue;
    }
    const text = clip(outcome.stdout);
    if (text) notes.push(`[hook ${label(rule)}]: ${text}`);
  }
  return notes.length ? { ...result, output: `${result.output}\n\n${notes.join('\n')}` } : result;
}

/** Run the TurnEnd hooks; nothing waits on them. */
export function turnEndHooks(settings: Pick<AppSettings, 'hooks'>, payload: Omit<HookPayload, 'event'>): void {
  for (const rule of matchingHooks(settings, 'TurnEnd')) {
    void runHook(rule, { ...payload, event: 'TurnEnd' });
  }
}
