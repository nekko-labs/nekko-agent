/**
 * The desktop app's TS backend: the host, run as its own process.
 *
 * `nekkod` starts this with the app's Electron binary under
 * `ELECTRON_RUN_AS_NODE=1` (plain Node, so no second runtime ships) and reads
 * the `NEKKO_BACKEND_READY {"port":N}` line it prints once it is listening.
 * Everything the daemon has not taken over yet runs here: providers, the agent
 * loop, sessions, tools, the model server, the local API server for the CLI
 * and MCP clients. The Electron main process keeps only the window.
 *
 * Nothing here may import `electron`: under RUN_AS_NODE there is no Electron
 * API to import, which is also what keeps the boundary honest.
 *
 * Environment:
 * - `NEKKO_BACKEND_TOKEN`: bearer token for the wire (from whoever started us).
 * - `NEKKO_BACKEND_DATA_DIR`: the user data directory.
 * - `NEKKO_BACKEND_APP`: `{ isPackaged, appPath, userData, version, resourcesPath }`.
 * - `NEKKO_BACKEND_ORIGINS`: JSON list of page origins allowed on the sockets.
 * - `NEKKOD_URL` / `NEKKOD_TOKEN`: set when the daemon started us; the ptys are
 *   then the daemon's, and this host forwards terminal calls to it.
 */
import { join } from 'node:path';
import { createHost, flushAgentLogs, useEngineDaemon, useTerminalDaemon } from '@nekko-agent/host';
import { closeApiServer } from '../main/api-server.js';
import { startLocalAccess, stopLocalAccess, type AppLike } from '../main/local-access.js';
import { closeWorkflowLoopbackListener, manageWorkflowLoopbackListener } from '../main/workflow-listener.js';
import { desktopChannels } from './channels.js';
import { bundledRelayEntry, LocalRelay } from './local-relay.js';
import { startWire } from './wire.js';

interface AppFacts {
  isPackaged?: boolean;
  appPath?: string;
  userData?: string;
  version?: string;
  resourcesPath?: string;
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set; the backend is started by the desktop app, not by hand`);
  return v;
}

async function main(): Promise<void> {
  const token = env('NEKKO_BACKEND_TOKEN');
  const dataDir = env('NEKKO_BACKEND_DATA_DIR');
  const facts: AppFacts = JSON.parse(process.env.NEKKO_BACKEND_APP ?? '{}');
  const origins: string[] = JSON.parse(process.env.NEKKO_BACKEND_ORIGINS ?? '["null"]');
  // Secrets stay out of the environment every child process inherits.
  delete process.env.NEKKO_BACKEND_TOKEN;

  // The host reports this as the app's version.
  if (facts.version) process.env.NEKKO_VERSION = facts.version;
  // The CLI installer finds the bundled CLI under the app's resources.
  if (facts.resourcesPath && !(process as { resourcesPath?: string }).resourcesPath) {
    (process as { resourcesPath?: string }).resourcesPath = facts.resourcesPath;
  }

  const daemonUrl = process.env.NEKKOD_URL;
  const daemonToken = process.env.NEKKOD_TOKEN;
  delete process.env.NEKKOD_TOKEN;
  if (daemonUrl && daemonToken) {
    // The daemon owns the ptys and the model-server processes; this host keeps
    // the policy for both and reaches them through it.
    useTerminalDaemon({ url: daemonUrl, token: daemonToken });
    useEngineDaemon({ url: daemonUrl, token: daemonToken });
  }

  const host = createHost({ dataDir, allowBrowserControl: true });
  const userData = facts.userData ?? dataDir;
  const app: AppLike = {
    isPackaged: Boolean(facts.isPackaged),
    getAppPath: () => facts.appPath ?? process.cwd(),
    getPath: (() => userData) as AppLike['getPath'],
  };

  manageWorkflowLoopbackListener(host);
  // The local API server comes up with the app (on by default), with the CLI
  // linked and everything pointed at it refreshed: a CLI or MCP client should
  // not need the window touched first.
  startLocalAccess(app, host);

  // Relay on this computer: back on at launch if it was switched on.
  const localRelay = new LocalRelay({ stateFile: join(dataDir, 'local-relay.json'), entry: bundledRelayEntry() });
  localRelay.resume();

  const wire = await startWire({ host, token, overrides: desktopChannels(app, host, localRelay), origins });

  let stopping = false;
  const shutdown = async (code: number) => {
    if (stopping) return;
    stopping = true;
    try {
      closeWorkflowLoopbackListener();
      closeApiServer();
      stopLocalAccess(host);
      localRelay.close();
      wire.close();
    } finally {
      try { await flushAgentLogs(); }
      catch (error) { console.error('Command log shutdown drain failed:', error); code = 1; }
      // 'exit' handlers (runtime supervisors, model server children) run here.
      process.exit(code);
    }
  };
  // Whoever started us holds our stdin open for as long as it wants us; EOF
  // is the shutdown signal on every platform, Windows included.
  process.stdin.on('end', () => shutdown(0));
  process.stdin.on('close', () => shutdown(0));
  process.stdin.resume();
  process.on('SIGTERM', () => shutdown(0));

  process.stdout.write(`NEKKO_BACKEND_READY ${JSON.stringify({ port: wire.port, pid: process.pid })}\n`);
}

main().catch((e) => {
  console.error(`nekko-agent backend: ${(e as Error)?.stack ?? e}`);
  process.exit(1);
});
