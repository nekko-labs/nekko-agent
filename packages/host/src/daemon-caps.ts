import { getExecutionMode } from '@nekko-agent/shared';
import { appendAgentTerminal } from './terminal.js';
import { getSession } from './sessions.js';

/**
 * What the engine daemon serves itself (its `daemon:info` `owned` list), asked
 * once, and the agent-terminal callback its turns use (`loop:log`).
 */

export type Call = <T>(channel: string, ...args: unknown[]) => Promise<T>;

let owned: Promise<string[]> | undefined;
/** Whether the engine daemon serves `channel` itself (`daemon:info`, asked once). */
export async function daemonOwns(call: Call, channel: string): Promise<boolean> {
  owned ??= call<{ owned?: string[] }>('daemon:info')
    .then((info) => info?.owned ?? [])
    .catch(() => {
      owned = undefined;
      return [];
    });
  return (await owned).includes(channel);
}

/**
 * Whether the engine daemon already has this host event: a copy made for this
 * host's own listeners (`relayOnly`), or output of a terminal the daemon owns
 * (mirrored from it; only the agent command logs are this host's). The
 * daemon's `/api/events` subscription (`?forDaemon=1`) is sent neither, so
 * it never reads its own events back.
 */
export function isDaemonCopy(name: string, payload: unknown): boolean {
  const p = payload as { relayOnly?: unknown; terminalId?: unknown } | null;
  if (p?.relayOnly === true) return true;
  return name === 'terminalEvent' && typeof p?.terminalId === 'string' && !p.terminalId.startsWith('agent_');
}

/** How long a daemon turn may stay silent before this side checks the daemon still has it. */
export const LIVENESS_INTERVAL_MS = 30_000;
/** Consecutive failed liveness probes before the daemon counts as gone. */
export const LIVENESS_STRIKES = 2;

/** `loop:log`: a daemon-driven turn's command output, for the chat's agent terminal. */
export function loopLog(sessionId: string, workspaceId: string | undefined, data: string): void {
  if (getExecutionMode(getSession(sessionId) ?? undefined) === 'sandbox') throw new Error('Sandbox daemon mutation denied');
  appendAgentTerminal(sessionId, workspaceId, data);
}
