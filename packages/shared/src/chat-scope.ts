/**
 * Per-chat scoping of settings that are configured app-wide: how hard the
 * model works, which MCP servers' tools a chat sees, and which connectors it
 * reads context from. The engine daemon's port is crates/nekko-turn/src/scope.rs;
 * the turn-plan golden test holds the two to the same answers.
 */
import type { Session } from './chat.js';
import type { EffortLevel } from './settings.js';

type Scoped = Pick<Session, 'effort' | 'disabledMcpServers' | 'disabledConnectors'>;

/** The effort a chat's turns run at: its own when set, else the app-wide one. */
export function chatEffort(session: Scoped | null | undefined, appEffort: EffortLevel | undefined): EffortLevel | undefined {
  return session?.effort ?? appEffort;
}

/** MCP tool specs (`mcp__<server>__<tool>`) less those whose server the chat switched off. */
export function chatMcpTools<T extends { name: string }>(tools: T[], session: Scoped | null | undefined): T[] {
  const off = (session?.disabledMcpServers ?? []).map((id) => `mcp__${id}__`);
  return off.length ? tools.filter((t) => !off.some((prefix) => t.name.startsWith(prefix))) : tools;
}

/** Connector configs less those the chat switched off. */
export function chatConnectors<T extends { kind: string }>(connectors: T[], session: Scoped | null | undefined): T[] {
  const off = new Set(session?.disabledConnectors ?? []);
  return off.size ? connectors.filter((c) => !off.has(c.kind)) : connectors;
}
