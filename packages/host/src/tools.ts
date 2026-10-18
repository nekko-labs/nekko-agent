import { getExecutionMode, isDedicatedOnlyBrowserAction, validateBrowserInput } from '@nekko-agent/shared';
import { getSession } from './sessions.js';
import { executeSandboxTool } from './execution-router.js';
import { execFile, spawn, type ChildProcess, type ExecFileOptions } from 'child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path';
import type { ToolCall, ToolResult, AppSettings, ChatMode } from '@nekko-agent/shared';
import { classifyCommand } from '@nekko-agent/core';
import { recordOriginal } from './changes.js';
import { appendAgentTerminal } from './terminal.js';
import { describeProcess, killProcess, listProcesses, readProcess, startProcess } from './processes.js';
import { describeFetched, fetchUrl } from './web-fetch.js';

const dedicatedBrowsers = new Set<string>();
const browsers = new Map<string, { client: import('@browserbasehq/stagehand').Stagehand; mode: string; port?: number }>();

/** Kill the command's shell and descendants, not just the shell holding its pipes. */
function stopCommandTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => child.kill());
    killer.on('exit', (code) => { if (code !== 0 && child.exitCode === null) child.kill(); });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch { child.kill(); }
  }
}

/** execFile does not forward detached; spawn is needed for Unix group cancellation. */
function runShell(file: string, args: string[], options: ExecFileOptions & { detached: boolean; encoding: 'utf8' }, callback: (error: Error | null, stdout: string, stderr: string) => void): ChildProcess {
  if (process.platform === 'win32') return execFile(file, args, options, callback);
  const child = spawn(file, args, { cwd: options.cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  let failure: Error | null = null;
  const collect = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
    if (failure) return;
    if (stream === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
    if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > (options.maxBuffer ?? 1024 * 1024)) {
      failure = new Error('Command output exceeded maxBuffer');
      stopCommandTree(child);
    }
  };
  child.stdout!.on('data', chunk => collect(chunk, 'stdout'));
  child.stderr!.on('data', chunk => collect(chunk, 'stderr'));
  child.on('error', error => { failure = error; });
  child.on('close', (code, signal) => callback(failure ?? (code === 0 ? null : new Error(`Command failed: ${file}\n${stderr}`)), stdout, stderr));
  return child;
}

export interface ToolHostOptions {
  settings: AppSettings;
  /** Resolve relative paths against the first workspace root. */
  defaultCwd?: string;
  /**
   * Called when a command needs approval. Resolves true to proceed. The host
   * wires this to the renderer's approval prompt.
   */
  requestApproval: (call: ToolCall, reason: string, severity: 'low' | 'medium' | 'high') => Promise<boolean>;
  /** Per-chat tool-execution policy (defaults to guardrails). */
  mode?: ChatMode;
  /** Chat this tool runs for, used to track file changes for diff/approve. */
  sessionId?: string;
  allowBrowserControl?: boolean;
  /** Stop this turn's shell command and its descendants when the user stops the agent. */
  signal?: AbortSignal;
}

/** Whether a mutating tool needs an up-front confirm in this mode. */
function asksEverything(opts: ToolHostOptions): boolean {
  return opts.mode === 'ask' || opts.settings.sandboxMode === 'ask-everything';
}

/** Roots the workspace-jail sandbox confines file access to. */
function jailRoots(settings: AppSettings): string[] {
  return settings.workspaces.map((w) => resolve(w.path));
}

function resolvePath(p: string, opts: ToolHostOptions): string {
  const base = opts.defaultCwd ?? opts.settings.workspaces[0]?.path ?? process.cwd();
  return isAbsolute(p) ? resolve(p) : resolve(base, p);
}

/** The string rule: relative(root, target) is empty, or neither starts with `..` nor is absolute. */
function within(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Where a path really is: its deepest existing ancestor with links followed,
 * plus the part that does not exist yet as given. A path with no existing
 * ancestor at all comes back as is.
 */
function realLocation(p: string): string {
  let existing = p;
  const rest: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync.native(existing), ...[...rest].reverse());
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return resolve(p);
      rest.push(basename(existing));
      existing = parent;
    }
  }
}

/**
 * The jail checks the resolved strings first, then the filesystem: a symlink
 * or junction inside a workspace that points outside it is refused (#550).
 */
function assertInJail(target: string, opts: ToolHostOptions): void {
  if (opts.settings.sandboxMode !== 'workspace-jail') return;
  const roots = jailRoots(opts.settings);
  if (roots.length === 0) return; // nothing to jail against yet
  const outside = () => new Error(
    `Sandbox: ${target} is outside the workspace folders. Add the folder or switch sandbox mode in Settings.`,
  );
  if (!roots.some((root) => within(root, target))) throw outside();
  const realTarget = realLocation(target);
  if (!roots.some((root) => within(realLocation(root), realTarget))) throw outside();
}

const ok = (call: ToolCall, output: string): ToolResult => ({ toolCallId: call.id, output });
const err = (call: ToolCall, output: string): ToolResult => ({ toolCallId: call.id, output, isError: true });

async function controlBrowser(call: ToolCall, opts: ToolHostOptions): Promise<ToolResult> {
  if (!opts.allowBrowserControl || !opts.sessionId) return err(call, 'Browser control is available only in a local desktop chat.');
  const input = call.input as Record<string, unknown>;
  const mode = input.mode;
  const action = input.action;
  if (input.visible !== undefined && (typeof input.visible !== 'boolean' || mode !== 'dedicated')) return err(call, 'visible is a boolean for dedicated mode only.');
  if (mode !== 'dedicated' && mode !== 'existing') return err(call, 'Choose dedicated or existing browser mode.');
  try { validateBrowserInput(input); }
  catch (e) { return err(call, (e as Error).message); }
  if (mode === 'existing' && isDedicatedOnlyBrowserAction(action)) return err(call, `The ${String(action)} action needs dedicated mode (the in-app browser). Existing mode supports navigate, inspect, click, fill and close.`);
  const port = mode === 'existing' ? Number(input.port ?? 9222) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) return err(call, 'CDP port must be a local TCP port.');
  const url = action === 'navigate' || action === 'tab_new' ? String(input.url ?? '') : '';
  const selector = String(input.selector ?? '');
  const existing = browsers.get(opts.sessionId);
  if ((mode === 'existing' && dedicatedBrowsers.has(opts.sessionId)) || (existing && (existing.mode !== mode || existing.port !== port))) return err(call, 'Close the current browser session before switching modes or ports.');
  const detail = action === 'evaluate' ? ` ${String(input.expression).slice(0, 300)}`
    : action === 'type' ? ` ${JSON.stringify(String(input.text).slice(0, 120))}`
    : action === 'press' ? ` ${String(input.key)}`
    : action === 'wait' && !selector ? ` text ${JSON.stringify(String(input.text ?? ''))}`
    : action === 'tab_switch' || action === 'tab_close' ? ` ${input.tab ?? 'current'}` : '';
  const disclosure = action === 'screenshot' ? ' Page pixels will be sent to the selected chat model for inspection.'
    : action === 'evaluate' ? ' The expression runs as script inside the page.' : '';
  const approved = await opts.requestApproval(call, `Browser ${mode}: ${action}${url ? ` ${url}` : ''}${selector ? ` ${selector}` : ''}${detail}.${disclosure}`, 'high');
  if (!approved) return err(call, 'Browser action not approved.');
  if (mode === 'dedicated') {
    const bridgeUrl = process.env.NEKKO_BROWSER_URL;
    const token = process.env.NEKKO_BROWSER_TOKEN;
    if (!bridgeUrl || !token) return err(call, 'In-app browser is unavailable. Restart the desktop app to enable it.');
    const response = await fetch(bridgeUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...input, sessionId: opts.sessionId }),
      signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
    const result = await response.json() as { output?: string; error?: string; image?: { data?: unknown; mime?: unknown } };
    if (response.ok) {
      if (action === 'close') dedicatedBrowsers.delete(opts.sessionId);
      else dedicatedBrowsers.add(opts.sessionId);
    }
    if (!response.ok) return err(call, result.error ?? 'In-app browser action failed.');
    // Pixels travel as an image attachment, never as base64 in the text output.
    const image = result.image;
    if (action === 'screenshot') {
      if (!image || typeof image.data !== 'string' || image.mime !== 'image/png' || !image.data || image.data.length > 7 * 1024 * 1024) return err(call, 'In-app browser returned an invalid screenshot.');
      return { ...ok(call, `${result.output ?? 'Screenshot taken.'}\nPixels attached to the selected model; vision support is required.`), images: [`data:image/png;base64,${image.data}`] };
    }
    return ok(call, result.output ?? '');
  }
  if (action === 'close') {
    if (existing) {
      browsers.delete(opts.sessionId);
      await existing.client.close();
    }
    return ok(call, 'Browser session disconnected.');
  }
  let current = existing;
  if (!current) {
    const { localBrowser, Stagehand } = await import('@browserbasehq/stagehand');
    const browser = await localBrowser.connect({ cdpUrl: `http://127.0.0.1:${port}` });
    try {
      current = { client: await Stagehand.create({ browser }), mode, port };
      browsers.set(opts.sessionId, current);
    } catch (error) {
      await browser.close();
      throw error;
    }
  }
  const page = await current.client.browser.context.activePage();
  if (!page) return err(call, 'No active browser tab. Open a page and try again.');
  if (action === 'navigate') await page.goto(url);
  if (action === 'click') await page.locator(selector).click();
  if (action === 'fill') await page.locator(selector).fill(String(input.value ?? ''));
  return ok(call, action === 'fill' ? 'Field filled.' : `${await page.title()}\n${(await page.locator('body').innerText()).slice(0, 6000)}`);
}

async function captureApp(call: ToolCall, opts: ToolHostOptions): Promise<ToolResult> {
  if (!opts.allowBrowserControl || !opts.sessionId) return err(call, 'Window capture is available only in a local desktop chat.');
  const input = call.input as Record<string, unknown>;
  if (!['list', 'screenshot', 'record'].includes(String(input.action))) return err(call, 'Choose list, screenshot, or record.');
  if (input.inspect !== undefined && typeof input.inspect !== 'boolean') return err(call, 'inspect must be a boolean.');
  const root = realpathSync(opts.defaultCwd ?? opts.settings.workspaces[0]?.path ?? process.cwd());
  let outputPath: string | undefined;
  if (input.action !== 'list') {
    if (typeof input.window_id !== 'string' || !input.window_id) return err(call, 'List windows and choose a window_id first.');
    if (typeof input.path !== 'string' || !input.path) return err(call, 'An output path is required.');
    outputPath = resolvePath(input.path, opts);
    assertInJail(outputPath, opts);
    let parent = dirname(outputPath);
    while (!existsSync(parent)) parent = dirname(parent);
    const actual = resolve(realpathSync(parent), relative(parent, outputPath));
    const rel = relative(root, actual);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return err(call, 'Capture output must be inside the chat project, without escaping through links.');
    if (!outputPath.toLowerCase().endsWith(input.action === 'record' ? '.webm' : '.png')) return err(call, 'Use .png for screenshots or .webm for recordings.');
    if (existsSync(outputPath)) return err(call, 'Capture output already exists; choose a new path.');
    if (input.action === 'record' && (!Number.isFinite(Number(input.seconds ?? 5)) || Number(input.seconds ?? 5) < 1 || Number(input.seconds ?? 5) > 15)) return err(call, 'Recording duration must be 1–15 seconds.');
  }
  const inspect = input.action === 'screenshot' && input.inspect !== false;
  const approved = await opts.requestApproval(call, `Window capture: ${input.action}${input.window_id ? ` ${input.window_id}` : ''}${outputPath ? ` → ${outputPath}` : ''}. Window content may contain private information.${inspect ? ' Screenshot pixels will also be sent to the selected chat model for inspection.' : ''}`, 'high');
  if (!approved) return err(call, 'Window capture not approved.');
  if (opts.signal?.aborted) return err(call, 'Capture cancelled.');
  const url = process.env.NEKKO_BROWSER_URL;
  const token = process.env.NEKKO_BROWSER_TOKEN;
  if (!url || !token) return err(call, 'Desktop capture bridge is unavailable. Restart the desktop app; no browser fallback was used.');
  const response = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ tool: 'capture', sessionId: opts.sessionId, action: input.action, window_id: input.window_id, seconds: input.seconds }),
    signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
  });
  const result = await response.json() as { error?: string; data?: string; mime?: string; [key: string]: unknown };
  if (!response.ok || result.error) return err(call, result.error ?? 'Window capture failed.');
  if (!outputPath) return ok(call, JSON.stringify(result, null, 2));
  if (typeof result.data !== 'string' || result.data.length > 30 * 1024 * 1024 || result.mime !== (input.action === 'record' ? 'video/webm' : 'image/png')) return err(call, 'Desktop bridge returned invalid capture media.');
  const media = Buffer.from(result.data, 'base64');
  if (!media.length) return err(call, 'Desktop bridge returned empty capture media.');
  if (opts.signal?.aborted) return err(call, 'Capture cancelled.');
  mkdirSync(dirname(outputPath), { recursive: true });
  // Revalidate after approval/capture: a link may have changed while waiting.
  const finalRelative = relative(root, realpathSync(dirname(outputPath)));
  if (finalRelative.startsWith('..') || isAbsolute(finalRelative)) return err(call, 'Capture output directory escaped the chat project.');
  writeFileSync(outputPath, media, { flag: 'wx' });
  const { data: _data, ...metadata } = result;
  const attached = inspect && media.length <= 5 * 1024 * 1024;
  return {
    ...ok(call, JSON.stringify({ ...metadata, path: outputPath, bytes: media.length,
      inspection: attached ? 'Pixels attached to the selected model; vision support is required. Capture alone does not prove verification.'
        : inspect ? 'Saved, but too large for model inspection (5 MB limit). No pixels attached.' : 'Saved without model inspection.',
    }, null, 2)),
    ...(attached ? { images: [`data:image/png;base64,${media.toString('base64')}`] } : {}),
  };
}

/** Execute one tool call, enforcing sandbox + guardrails. */
export async function executeTool(call: ToolCall, opts: ToolHostOptions): Promise<ToolResult> {
  if (opts.sessionId && getExecutionMode(getSession(opts.sessionId) ?? undefined) === 'sandbox') return executeSandboxTool(opts.sessionId, call, opts.requestApproval, opts.signal);
  const a = call.input as Record<string, any>;
  try {
    switch (call.name) {
      case 'browser': return await controlBrowser(call, opts);
      case 'capture': return await captureApp(call, opts);
      case 'read_file': {
        const p = resolvePath(a.path, opts);
        assertInJail(p, opts);
        if (!existsSync(p)) return err(call, `File not found: ${p}`);
        const content = readFileSync(p, 'utf8');
        if (a.start_line != null || a.end_line != null) {
          const start = a.start_line ?? 1;
          const end = a.end_line ?? start + 199;
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
            return err(call, 'start_line and end_line must be positive integers, with end_line >= start_line.');
          }
          const lines = content.split('\n');
          const selected = lines.slice(start - 1, end).map((line, i) => `${start + i}: ${line}`).join('\n');
          return ok(call, selected.length > 60000 ? selected.slice(0, 60000) + '\n…(truncated; request a smaller line range)' : selected || `(no lines at or after ${start}; ${lines.length} total lines)`);
        }
        return ok(call, content.length > 60000 ? content.slice(0, 60000) + '\n…(truncated; use start_line and end_line to read later lines)' : content);
      }
      case 'write_file': {
        const p = resolvePath(a.path, opts);
        assertInJail(p, opts);
        if (asksEverything(opts)) {
          if (!(await opts.requestApproval(call, `Write ${p}`, 'medium'))) return err(call, 'Write not approved by user.');
        }
        await recordOriginal(opts.sessionId, p);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, String(a.content ?? ''), 'utf8');
        return ok(call, `Wrote ${p} (${String(a.content ?? '').length} bytes)`);
      }
      case 'edit_file': {
        const p = resolvePath(a.path, opts);
        assertInJail(p, opts);
        if (!existsSync(p)) return err(call, `File not found: ${p}`);
        if (asksEverything(opts)) {
          if (!(await opts.requestApproval(call, `Edit ${p}`, 'medium'))) return err(call, 'Edit not approved by user.');
        }
        const cur = readFileSync(p, 'utf8');
        const count = cur.split(a.old_string).length - 1;
        if (count === 0) return err(call, 'old_string not found in file.');
        if (count > 1) return err(call, `old_string matched ${count} times; make it unique.`);
        await recordOriginal(opts.sessionId, p);
        writeFileSync(p, cur.replace(a.old_string, a.new_string), 'utf8');
        return ok(call, `Edited ${p}`);
      }
      case 'list_dir': {
        const p = resolvePath(a.path, opts);
        assertInJail(p, opts);
        if (!existsSync(p)) return err(call, `Directory not found: ${p}`);
        const entries = readdirSync(p, { withFileTypes: true }).map(
          (e) => (e.isDirectory() ? `${e.name}/` : e.name),
        );
        return ok(call, entries.join('\n') || '(empty)');
      }
      case 'glob': {
        const root = a.path ? resolvePath(a.path, opts) : opts.defaultCwd ?? opts.settings.workspaces[0]?.path ?? process.cwd();
        assertInJail(root, opts);
        if (!existsSync(root)) return err(call, `Directory not found: ${root}`);
        const matches = globFiles(root, a.pattern);
        return ok(call, matches.slice(0, 200).join('\n') || '(no matches)');
      }
      case 'grep': {
        const root = a.path ? resolvePath(a.path, opts) : opts.defaultCwd ?? opts.settings.workspaces[0]?.path ?? process.cwd();
        assertInJail(root, opts);
        if (!existsSync(root)) return err(call, `Path not found: ${root}`);
        return ok(call, grepFiles(root, a.pattern).slice(0, 100).join('\n') || '(no matches)');
      }
      case 'fetch_url': {
        if (typeof a.url !== 'string' || !a.url.trim()) return err(call, 'A URL is required.');
        // Reading a page is as safe as reading a file; only ask-everything asks.
        if (asksEverything(opts) && !(await opts.requestApproval(call, `Fetch ${a.url}`, 'low'))) return err(call, 'Fetch not approved by user.');
        try {
          const page = await fetchUrl(a.url, { maxChars: typeof a.max_chars === 'number' ? a.max_chars : undefined, signal: opts.signal });
          return ok(call, describeFetched(page));
        } catch (e) {
          return err(call, (e as Error).message);
        }
      }
      case 'start_process': {
        if (typeof a.command !== 'string' || !a.command.trim()) return err(call, 'A command is required.');
        const decision = classifyCommand(a.command, opts.settings.guardrails);
        if (decision.action === 'deny') {
          return err(call, `Blocked by guardrail (${decision.matches.map((m) => m.label).join(', ')}).`);
        }
        const needsApproval = opts.mode === 'yolo' ? false : asksEverything(opts) || decision.action === 'ask';
        if (needsApproval) {
          const approved = await opts.requestApproval(call, decision.matches.map((m) => m.label).join(', ') || 'Start a background process', decision.severity);
          if (!approved) return err(call, 'Command not approved by user.');
        }
        if (!opts.sessionId) return err(call, 'Background processes need a chat to belong to.');
        const cwd = a.cwd ? resolvePath(a.cwd, opts) : opts.defaultCwd ?? opts.settings.workspaces[0]?.path ?? process.cwd();
        try {
          const info = startProcess({
            sessionId: opts.sessionId,
            workspaceId: opts.settings.workspaces.find((w) => w.path === cwd)?.id,
            command: a.command,
            cwd,
            name: typeof a.name === 'string' && a.name.trim() ? a.name.trim().slice(0, 40) : undefined,
          });
          return ok(call, `Started ${info.name ? `${info.id} (${info.name})` : info.id}${info.pid ? `, pid ${info.pid}` : ''}, in ${cwd}. Call read_process with this id to see its output (wait_ms waits for more), kill_process to stop it. It stops when this chat stops.`);
        } catch (e) {
          return err(call, (e as Error).message);
        }
      }
      case 'read_process': {
        if (!opts.sessionId) return err(call, 'Background processes need a chat to belong to.');
        if (typeof a.id !== 'string' || !a.id) {
          const list = listProcesses(opts.sessionId);
          return ok(call, list.length ? list.map(describeProcess).join('\n') : 'No background processes in this chat.');
        }
        const read = await readProcess(a.id, { waitMs: typeof a.wait_ms === 'number' ? a.wait_ms : undefined, all: a.all === true });
        if (!read || read.info.sessionId !== opts.sessionId) return err(call, `No process ${a.id} in this chat. It may have exited and been read already; start it again if you need it.`);
        const head = describeProcess(read.info);
        const body = read.output ? `${read.truncated ? '…(older output dropped)\n' : ''}${read.output}` : '(no new output)';
        return ok(call, `${head}\n\n${body}`);
      }
      case 'kill_process': {
        if (!opts.sessionId) return err(call, 'Background processes need a chat to belong to.');
        if (typeof a.id !== 'string' || !a.id) return err(call, 'A process id is required.');
        const info = listProcesses(opts.sessionId).find((p) => p.id === a.id);
        if (!info) return err(call, `No process ${a.id} in this chat.`);
        if (info.exitCode !== undefined) return ok(call, `${describeProcess(info)} (already exited)`);
        killProcess(a.id);
        return ok(call, `Stopping ${info.name ? `${info.id} (${info.name})` : info.id}.`);
      }
      case 'bash': {
        const decision = classifyCommand(a.command, opts.settings.guardrails);
        // A deny guardrail is a hard floor in every mode (even YOLO).
        if (decision.action === 'deny') {
          return err(call, `Blocked by guardrail (${decision.matches.map((m) => m.label).join(', ')}).`);
        }
        // YOLO never prompts; Ask always prompts; Guardrails prompts on ask-rules.
        const needsApproval =
          opts.mode === 'yolo'
            ? false
            : asksEverything(opts) || decision.action === 'ask';
        if (needsApproval) {
          const approved = await opts.requestApproval(
            call,
            decision.matches.map((m) => m.label).join(', ') || 'Run command',
            decision.severity,
          );
          if (!approved) return err(call, 'Command not approved by user.');
        }
        const cwd = a.cwd ? resolvePath(a.cwd, opts) : opts.defaultCwd ?? opts.settings.workspaces[0]?.path ?? process.cwd();
        const mirror = (text: string) => {
          if (opts.sessionId) appendAgentTerminal(opts.sessionId, opts.settings.workspaces.find((w) => w.path === cwd)?.id, text.replace(/[^\x09\x0a\x20-\x7e\u0080-\uffff]/g, '').replace(/\n/g, '\r\n'));
        };
        if (opts.signal?.aborted) return err(call, 'Command cancelled.');
        mirror(`$ ${a.command}\n`);
        try {
          const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolveP, reject) => {
            let stopped: 'cancelled' | 'timed out' | null = null;
            let timer: ReturnType<typeof setTimeout>;
            let grace: ReturnType<typeof setTimeout> | undefined;
            let settled = false;
            let capturedOut = '', capturedErr = '';
            const finish = (error: Error | null, stdout: string, stderr: string) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              clearTimeout(grace);
              opts.signal?.removeEventListener('abort', onAbort);
              if (stopped) reject(Object.assign(new Error(`Command ${stopped}.`), { stdout, stderr }));
              else if (error) reject(Object.assign(error, { stdout, stderr }));
              else resolveP({ stdout, stderr });
            };
            const stop = (reason: 'cancelled' | 'timed out') => {
              if (settled || stopped) return;
              stopped = reason;
              // Killing a process is not proof that its inherited pipes close.
              // Bound cleanup too, matching the daemon's five-second kill grace.
              grace = setTimeout(() => {
                finish(null, capturedOut, capturedErr);
                child.stdin?.destroy();
                child.stdout?.destroy();
                child.stderr?.destroy();
              }, 5_000);
              stopCommandTree(child);
            };
            const onAbort = () => stop('cancelled');
            // A separate process group on Unix lets Stop and timeout kill all
            // descendants. On Windows taskkill /T does the same for cmd.exe.
            const options: ExecFileOptions & { detached: boolean; encoding: 'utf8' } = { cwd, maxBuffer: 10 * 1024 * 1024, detached: process.platform !== 'win32', windowsHide: true, windowsVerbatimArguments: process.platform === 'win32', encoding: 'utf8' };
            if (typeof a.command !== 'string') throw new TypeError(`The "command" argument must be of type string. Received ${typeof a.command === 'number' ? `type number (${a.command})` : String(a.command)}`);
            const child = runShell(process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/sh', process.platform === 'win32' ? ['/d', '/s', '/c', a.command] : ['-c', a.command], options, (error: Error | null, stdout: string, stderr: string) => {
              // Keep the previous exec error format (without the explicit shell).
              if (error) error.message = error.message.replace(/^Command failed: .*?\r?\n/, `Command failed: ${a.command}\n`);
              finish(error, stdout, stderr);
            });
            // A noninteractive tool has nobody to answer stdin prompts.
            child.stdin?.end();
            timer = setTimeout(() => stop('timed out'), 120_000);
            opts.signal?.addEventListener('abort', onAbort, { once: true });
            if (opts.signal?.aborted) onAbort();
            child.stdout?.on('data', (chunk: Buffer | string) => {
              capturedOut = (capturedOut + String(chunk)).slice(0, 60000);
              if (!settled) mirror(String(chunk));
            });
            child.stderr?.on('data', (chunk: Buffer | string) => {
              capturedErr = (capturedErr + String(chunk)).slice(0, 60000);
              if (!settled) mirror(String(chunk));
            });
          });
          const output = (stdout + (stderr ? `\n[stderr]\n${stderr}` : '')).slice(0, 60000) || '(no output)';
          if (!stdout && !stderr) mirror('(no output)\n');
          return ok(call, output);
        } catch (e: any) {
          const output = `Command failed: ${e.message}\n${e.stdout ?? ''}${e.stderr ?? ''}`.slice(0, 60000);
          mirror(`[command failed]\n`);
          return err(call, output);
        }
      }
      default:
        return err(call, `Unknown tool: ${call.name}`);
    }
  } catch (e) {
    return err(call, (e as Error).message);
  }
}

const SKIP = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', 'target', '.venv', 'coverage']);

/** Minimal glob supporting **, *, and ?, no external dependency. */
function globFiles(root: string, pattern: string): string[] {
  const re = globToRegExp(pattern);
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else {
        const rel = relative(root, full).replace(/\\/g, '/');
        if (re.test(rel)) out.push(rel);
      }
    }
  };
  walk(root);
  return out;
}

function globToRegExp(glob: string): RegExp {
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('.+^${}()|[]\\'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp(re + '$');
}

function grepFiles(root: string, pattern: string): string[] {
  let re: RegExp;
  try {
    re = new RegExp(pattern, 'i');
  } catch {
    return [`Invalid regex: ${pattern}`];
  }
  const out: string[] = [];
  const fileRoot = statSync(root).isFile();
  const scan = (full: string) => {
    try {
      if (statSync(full).size > 1_000_000) return;
      const lines = readFileSync(full, 'utf8').split('\n');
      lines.forEach((line, idx) => {
        if (re.test(line)) {
          out.push(`${(fileRoot ? basename(full) : relative(root, full)).replace(/\\/g, '/')}:${idx + 1}: ${line.trim().slice(0, 200)}`);
        }
      });
    } catch {
      /* binary or unreadable */
    }
  };
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP.has(e.name) || out.length > 100) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else {
        scan(full);
      }
    }
  };
  if (fileRoot) scan(root);
  else walk(root);
  return out;
}
