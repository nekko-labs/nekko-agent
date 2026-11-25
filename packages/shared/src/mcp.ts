/** Model Context Protocol (MCP) client contracts. */

/** A configured MCP server (stdio spawn, or streamable HTTP when `url` is set). */
export interface McpServerConfig {
  id: string;
  name: string;
  /** Executable to spawn, e.g. "npx". Ignored when `url` is set. */
  command: string;
  /** Arguments, e.g. ["-y", "@modelcontextprotocol/server-filesystem", "/path"]. */
  args: string[];
  /** Streamable-HTTP MCP endpoint (e.g. a Hypergate gateway). When set, we connect over HTTP instead of spawning. */
  url?: string;
  /** Bearer token sent as `Authorization: Bearer <token>` on HTTP requests. */
  token?: string;
  enabled: boolean;
}

/** A tool exposed by an MCP server. */
export interface McpToolInfo {
  name: string;
  description?: string;
}

/**
 * A running Hypergate daemon (`hypergated`, github.com/nekko-labs/hypergate)
 * found on this machine: the companion that runs and supervises local MCP
 * servers and puts them all behind one gateway endpoint.
 */
export interface HypergateInfo {
  /** Streamable-HTTP gateway endpoint (one URL for every managed server). */
  url: string;
  /** Bearer token for the gateway. Only filled in once we've connected. */
  token?: string;
  /** The daemon's management web UI, which is what the Hypergate tab shows. */
  uiUrl?: string;
  /** Managed server count. */
  servers: number;
  version: string;
  /** The loopback port the daemon answered on. */
  port: number;
  /**
   * The name Hypergate knows this Nekko Agent install by, once connected.
   *
   * Connecting mints (or reuses) a *scoped* agent there rather than borrowing
   * the master gateway token, which is what makes the pairing visible from
   * Hypergate's side too: its Agents list shows Nekko Agent online, with its own
   * per-server permissions and its own usage history.
   */
  agent?: string;
}

/** The Connectors page's Hypergate check: on this computer, and up? */
export interface HypergateCheck {
  /** A `hypergate` CLI was found, or a daemon answered. */
  installed: boolean;
  /** The running daemon, or null when nothing answered. */
  info: HypergateInfo | null;
}

/** Live connection status for an MCP server. */
export interface McpServerStatus {
  id: string;
  name: string;
  connected: boolean;
  tools: McpToolInfo[];
  error?: string;
}
