import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { expect, it, vi } from 'vitest';
import type { McpServerConfig } from '@nekko-agent/shared';

/**
 * `mcpStatus` as the TS host reports it once the engine daemon runs the MCP
 * servers: `syncMcp` hands the configs to the daemon and keeps the snapshot it
 * answers, and the status is read from that. The daemon's own `mcp:status`
 * (crates/nekkod/src/mcp.rs `status`) must give the same rows for the same
 * configs and snapshot. Writes crates/nekkod/tests/golden/mcp-status.json;
 * fails if it is stale (rewrite with UPDATE_GOLDEN=1).
 */
const golden = join(__dirname, '..', '..', '..', 'crates', 'nekkod', 'tests', 'golden', 'mcp-status.json');

let snapshot: unknown = null;
vi.mock('./engine/daemon.js', () => ({ daemonCall: () => async () => snapshot }));
vi.mock('./daemon-caps.js', () => ({ daemonOwns: async () => true }));

const { syncMcp, mcpStatus } = await import('./mcp.js');

const tool = (name: string, description?: string | null) => (description === undefined ? { name } : { name, description });
const CASES: Array<{ name: string; configs: unknown[]; snapshot: unknown }> = [
  {
    name: 'connected, failed and disabled servers in settings order',
    configs: [
      { id: 'b', name: 'Beta', command: 'npx', args: [], enabled: true },
      { id: 'a', name: 'Alpha', command: '', args: [], enabled: true, url: 'http://127.0.0.1:9/mcp' },
      { id: 'off', name: 'Off', command: 'x', args: [], enabled: false },
    ],
    snapshot: {
      specs: [],
      servers: {
        a: { connected: true, tools: [tool('echo', 'Echo it back'), tool('plain')] },
        b: { connected: false, tools: [], error: 'spawn npx ENOENT' },
      },
    },
  },
  { name: 'no servers', configs: [], snapshot: { specs: [], servers: {} } },
  {
    name: 'a nameless config and null fields',
    configs: [{ id: 'n', command: 'c', args: [], enabled: true }],
    snapshot: { specs: [], servers: { n: { connected: true, tools: [tool('t', null), { name: null }], error: null } } },
  },
  {
    name: 'a server the daemon does not know',
    configs: [{ id: 'ghost', name: 'Ghost', command: 'c', args: [], enabled: true }],
    snapshot: { specs: [], servers: { other: { connected: true, tools: [tool('x')] } } },
  },
];

it('mcp status matches the daemon golden set', async () => {
  const out = [];
  for (const c of CASES) {
    snapshot = c.snapshot;
    await syncMcp(c.configs as McpServerConfig[]);
    out.push({ ...c, status: JSON.parse(JSON.stringify(mcpStatus(c.configs as McpServerConfig[]))) });
  }
  if (process.env.UPDATE_GOLDEN) writeFileSync(golden, `${JSON.stringify(out, null, 2)}\n`);
  expect(JSON.parse(readFileSync(golden, 'utf8'))).toEqual(out);
});
