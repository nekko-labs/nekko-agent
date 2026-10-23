import { VERSION } from './version.js';

/**
 * The Claude Agent approval bridge: `nekko-agent mcp --bridge --url <nekkod>`, with
 * the chat's bridge token in `NEKKO_BRIDGE_TOKEN` (never in argv, which any local
 * user can list).
 *
 * nekkod starts the user's own Claude Code with `--permission-prompt-tool
 * mcp__nekko_bridge__approve` and a per-chat `--mcp-config` that runs this
 * server. Each permission prompt Claude Code raises becomes one `approve` call,
 * which this server forwards to nekkod (`POST /harness/approve`, authenticated
 * by the chat's bridge token only) and answers with nekkod's decision: the
 * chat's mode, or the user in Nekko's approval UI, on the wall or the phone.
 *
 * Anything that goes wrong (nekkod unreachable, a refused token, a malformed
 * answer) is a deny. Permissions fail closed.
 */

const PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18'];

export const APPROVE_TOOL = {
  name: 'approve',
  description:
    "Nekko Agent's permission prompt for Claude Code: decides whether a tool call may run, asking the user in Nekko Agent when the chat's mode says so.",
  inputSchema: {
    type: 'object',
    properties: {
      tool_name: { type: 'string' },
      toolName: { type: 'string' },
      input: { type: 'object' },
      tool_use_id: { type: 'string' },
      toolUseID: { type: 'string' },
    },
  },
};

export type BridgeDecision =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

const deny = (message: string): BridgeDecision => ({ behavior: 'deny', message });

/** Ask nekkod about one permission prompt. Never throws: a failure is a deny. */
export async function askNekkod(
  url: string,
  token: string,
  prompt: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<BridgeDecision> {
  try {
    const res = await fetchImpl(`${url.replace(/\/$/, '')}/harness/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(prompt),
    });
    if (!res.ok) return deny(`Nekko Agent refused the approval request (HTTP ${res.status}).`);
    const answer = (await res.json()) as Partial<BridgeDecision> & { updatedInput?: unknown; message?: unknown };
    if (answer.behavior === 'allow' && answer.updatedInput && typeof answer.updatedInput === 'object') {
      return { behavior: 'allow', updatedInput: answer.updatedInput as Record<string, unknown> };
    }
    if (answer.behavior === 'deny') return deny(typeof answer.message === 'string' ? answer.message : 'Denied.');
    return deny('Nekko Agent gave no usable answer, so this was denied.');
  } catch (e) {
    return deny(`Could not reach Nekko Agent to approve this (${(e as Error).message}), so it was denied.`);
  }
}

/** One JSON-RPC message in, its reply (or nothing, for a notification). */
export async function handleBridgeMessage(
  msg: { id?: unknown; method?: string; params?: any },
  ask: (prompt: Record<string, unknown>) => Promise<BridgeDecision>,
): Promise<unknown | undefined> {
  const { id, method, params } = msg;
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result });
  if (method === 'initialize') {
    const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : '';
    const protocolVersion = PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[PROTOCOL_VERSIONS.length - 1];
    return ok({ protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'nekko_bridge', title: 'Nekko Agent approvals', version: VERSION } });
  }
  if (typeof method === 'string' && method.startsWith('notifications/')) return undefined;
  if (method === 'ping') return ok({});
  if (method === 'tools/list') return ok({ tools: [APPROVE_TOOL] });
  if (method === 'tools/call') {
    const decision =
      params?.name === APPROVE_TOOL.name
        ? await ask((params?.arguments ?? {}) as Record<string, unknown>)
        : deny(`Unknown tool: ${String(params?.name)}`);
    return ok({ content: [{ type: 'text', text: JSON.stringify(decision) }] });
  }
  if (id === undefined) return undefined;
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } };
}

export function runBridgeServer(opts: { token?: string; url?: string }): void {
  console.log = (...a: unknown[]) => console.error(...a);
  const { token, url } = opts;
  const ask = (prompt: Record<string, unknown>) =>
    token && url ? askNekkod(url, token, prompt) : Promise.resolve(deny('The approval bridge was started without its token or address.'));
  const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + '\n');
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      void handleBridgeMessage(msg, ask).then((reply) => reply !== undefined && send(reply));
    }
  });
  process.stdin.on('end', () => process.exit(0));
}
