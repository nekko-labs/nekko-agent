import { execFile } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { getExecutionMode, getSessionWorkspaceIds, type Session, type SandboxStatus, type SandboxDiff, type ToolCall, type ToolResult } from '@nekko-agent/shared';
import { ContainerSandbox } from './container-sandbox.js';
import { dataDir, getSettings } from './store.js';
import { getSession, saveSession } from './sessions.js';
import { daemonCall, daemonOwns } from './engine/daemon.js';

/** The engine daemon owns the containers (crates/nekkod/src/sandbox.rs). */
export const DAEMON_SANDBOX = 'sandbox';

export const SANDBOX_TOOLS = new Set(['read_file', 'write_file', 'edit_file', 'list_dir', 'glob', 'grep', 'bash']);
const runtimes = new Map<string, { sandbox: ContainerSandbox; identity: string; signal?: AbortSignal; error?: string; ready: boolean }>();
const activeTools = new WeakSet<object>();
function sessionFor(id: string): Session {
  const s = getSession(id);
  if (!s || getExecutionMode(s) !== 'sandbox') throw new Error('Sandbox session required');
  return s;
}
function runtime(s: Session) {
  if (!s.sandbox) throw new Error('Configure a sandbox explicitly before sending. No host fallback is available.');
  const key = join(dataDir(), s.id);
  const prior = runtimes.get(key);
  if (prior?.identity === s.sandbox.identity) return prior;
  const settings = getSettings();
  if (JSON.stringify(getSessionWorkspaceIds(s)) !== JSON.stringify(s.sandbox.sourceWorkspaceIds)) throw new Error('Sandbox folder selection changed. Create a new sandbox chat.');
  const folders = s.sandbox.sourceWorkspaceIds.map(id => {
    const w = settings.workspaces.find(w => w.id === id);
    if (!w) throw new Error('Sandbox source folder unavailable');
    return w.path;
  });
  const entry = { ready: false, identity: s.sandbox.identity, signal: undefined as AbortSignal | undefined, error: undefined as string | undefined, sandbox: undefined as unknown as ContainerSandbox };
  entry.sandbox = new ContainerSandbox({ sessionId: s.id, stateDirectory: join(dataDir(), 'sandboxes', entry.identity), sourceFolders: folders, image: s.sandbox.image }, async (executable, args, options) => {
    if (entry.signal?.aborted) throw new Error('Sandbox execution cancelled');
    const container = args[0] === 'exec' ? args.find(a => /^nekko-[a-f0-9-]{36}$/.test(a)) : undefined;
    let cancelled = false;
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      entry.error = 'Sandbox stopped by cancellation. Create a new sandbox chat to resume.';
      // Stop the container, not just the CLI: docker exec cancellation alone leaves its shell running.
      if (container) execFile(executable, ['kill', container], { windowsHide: true, timeout: 10000 }, () => {});
    };
    entry.signal?.addEventListener('abort', cancel, { once: true });
    try {
      const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        execFile(executable, args, { ...options, signal: entry.signal }, (error, stdout, stderr) => {
          if (error) reject(error); else resolve({ stdout, stderr });
        });
      });
      if (entry.signal?.aborted) throw new Error('Sandbox execution cancelled');
      return result;
    } catch (error) {
      if (container) cancel();
      throw error;
    } finally { entry.signal?.removeEventListener('abort', cancel); }
  });
  runtimes.set(key, entry);
  return entry;
}
/**
 * The chat's side of sandbox setup: only an empty, idle, unconfigured chat
 * becomes a sandbox chat (the engine daemon's port is nekko-store's
 * `configure_sandbox`, held to this by the session-writes golden set).
 */
export function applySandboxSetup(s: Session, image: string, identity: string, now: number): void {
  if (s.activeRun || s.sandbox || s.messages.length) throw new Error('Sandbox setup is immutable and requires an empty, idle, unconfigured session');
  // Setup is the explicit transition, not a later renderer option patch.
  s.executionMode = 'sandbox';
  s.gitIsolation = false;
  if (!/^\S+@sha256:[a-f0-9]{64}$/.test(image)) throw new Error('A digest-pinned, already installed Linux image is required');
  s.sandbox = { image, identity, configuredAt: now, sourceWorkspaceIds: getSessionWorkspaceIds(s) };
  s.mode = 'ask'; s.gitWorktrees = undefined;
}
/** Calling this user-facing API is explicit consent to copy selected folders using a local image. */
export async function configureSandbox(sessionId: string, image: string): Promise<SandboxStatus> {
  const s = getSession(sessionId);
  if (!s) throw new Error('Session not found');
  applySandboxSetup(s, image, randomUUID(), Date.now());
  saveSession(s);
  const r = runtime(s);
  try { await r.sandbox.initialize(); r.ready = true; } catch (error) { r.error = (error as Error).message; throw error; }
  return sandboxStatus(sessionId);
}
export async function cleanupSandbox(sessionId: string, identity: string): Promise<void> {
  const s = sessionFor(sessionId);
  if (s.activeRun || s.sandbox?.identity !== identity) throw new Error('Sandbox is busy or identity is stale');
  const r = runtime(s);
  if (activeTools.has(r)) throw new Error('Sandbox operation already in progress');
  await r.sandbox.destroy();
  r.ready = false;
  r.error = 'Sandbox resources deleted. Create a new sandbox chat to resume.';
}
export function sandboxStatus(sessionId: string): SandboxStatus {
  const s = getSession(sessionId);
  if (!s) throw new Error('Session not found');
  const r = runtimes.get(join(dataDir(), s.id));
  return { mode: getExecutionMode(s), phase: r?.error ? 'error' : r?.ready ? 'ready' : s.sandbox ? 'configured' : 'unconfigured', identity: s.sandbox?.identity, image: s.sandbox?.image, error: r?.error, applySupported: false };
}
async function ready(s: Session) {
  const r = runtime(s);
  if (r.error) throw new Error(r.error);
  try { await r.sandbox.initialize(); } catch (error) { r.error = (error as Error).message; throw error; }
  r.ready = true;
  return r;
}
export async function sandboxDiff(sessionId: string): Promise<SandboxDiff> {
  const r = await ready(sessionFor(sessionId));
  const changes = await r.sandbox.diff();
  return { identity: r.identity, diffId: createHash('sha256').update(r.identity + JSON.stringify(changes)).digest('hex'), changes };
}
export async function applySandboxDiff(sessionId: string, identity: string, diffId: string, paths: string[]): Promise<never> {
  const diff = await sandboxDiff(sessionId);
  if (diff.identity !== identity || diff.diffId !== diffId || !paths.length || paths.some(p => !diff.changes.some(c => c.path === p))) throw new Error('Invalid or stale sandbox diff selection');
  throw new Error('Apply-back is disabled: exclusive host filesystem ownership cannot be guaranteed against concurrent external writes. Export/review the diff manually.');
}
export async function executeSandboxTool(sessionId: string, call: ToolCall, approve: (call: ToolCall, reason: string, severity: 'low' | 'medium' | 'high') => Promise<boolean>, signal?: AbortSignal): Promise<ToolResult> {
  const failure = (output: string): ToolResult => ({ toolCallId: call.id, output, isError: true });
  if (!SANDBOX_TOOLS.has(call.name)) return failure(`Unsupported sandbox tool: ${call.name}. Host controls, network, connectors, MCP and delegation are denied. No host fallback.`);
  try {
    if (signal?.aborted) return failure('Sandbox execution cancelled');
    if (!await approve(call, `Sandbox ${call.name}: access only the copied workspace`, call.name === 'bash' ? 'high' : call.name === 'write_file' || call.name === 'edit_file' ? 'medium' : 'low')) return failure('Sandbox action not approved');
    if (signal?.aborted) return failure('Sandbox execution cancelled');
    // Under a daemon that owns the containers, the call runs there; a Stop stops it there.
    const call_ = daemonOwns(DAEMON_SANDBOX) ? daemonCall() : undefined;
    if (call_) {
      const abort = () => { void call_('sandbox:abort', sessionId).catch(() => {}); };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        return await call_<ToolResult>('sandbox:tool', sessionId, call);
      } finally { signal?.removeEventListener('abort', abort); }
    }
    const s = sessionFor(sessionId);
    const r = runtime(s);
    // Own the signal before readiness checks. Reject overlapping calls rather than
    // letting a second caller replace the signal of an operation already in flight.
    if (activeTools.has(r)) return failure('Sandbox operation already in progress');
    activeTools.add(r);
    r.signal = signal;
    try {
      await ready(s);
      if (signal?.aborted) return failure('Sandbox execution cancelled');
      const result = await r.sandbox.execute(call.name, call.input);
      return { toolCallId: call.id, output: typeof result === 'string' ? result : JSON.stringify(result) };
    } finally { r.signal = undefined; activeTools.delete(r); }
  } catch (error) { return failure((error as Error).message); }
}
/** Context is not silently read from host attachments, guidelines, memory or indices. */
export function sandboxWorkspaces(s: Session) {
  return (s.sandbox?.sourceWorkspaceIds ?? getSessionWorkspaceIds(s)).map((_, i) => ({ id: `sandbox-${i}`, name: `folder-${i}`, path: `folder-${i}`, addedAt: 0 }));
}
