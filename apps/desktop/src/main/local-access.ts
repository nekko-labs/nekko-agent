import { homedir } from 'node:os';
import { join } from 'node:path';
import type { App } from 'electron';
import { defaultUserDataDir, onDaemonOr, type Host } from '@nekko-agent/host';
import { brandEnv, withApiServerDefaults, type SubagentTarget } from '@nekko-agent/shared';
import { apiServerStatus, ensureApiServerToken, syncApiServer } from './api-server.js';
import { cliInstallStatus, installCli, writeCliLink } from './cli-install.js';

/**
 * Everything that makes "installed the app" mean "the CLI and the MCP entries
 * already work": the local API server, the `nekko-agent` launcher on PATH, the
 * link file the CLI reads, and the MCP entries other agent tools hold.
 *
 * Kept in one place because the four go stale together. Rolling the token or
 * moving the port breaks a terminal that read the old link file and a Claude
 * Code whose entry still carries the old token, so every settings change runs
 * the same refresh.
 */

export type AppLike = Pick<App, 'isPackaged' | 'getAppPath' | 'getPath'>;

/**
 * Where the CLI looks for the link file: its own data directory, which is
 * `NEKKO_DATA_DIR` when set and `~/.nekko` otherwise (see apps/cli/src/lib.ts).
 * Not the desktop app's userData: the CLI has no way to know where that is.
 */
export function cliLinkDir(): string {
  return defaultUserDataDir();
}

/**
 * How an MCP entry written now should reach this app: the address clients are
 * told to use, the token, and the launcher the app installed. Empty when the
 * server is off, so an entry falls back to the portable `npx` form rather than
 * pointing at a port nothing listens on.
 */
export function subagentTarget(app: AppLike, host: Host): SubagentTarget {
  const status = apiServerStatus(host);
  if (!status.settings.enabled) return {};
  const cli = cliInstallStatus(app);
  return {
    url: status.clientUrl,
    token: status.settings.token,
    command: cli.installed ? cli.binPath : undefined,
  };
}

/**
 * Bring the link file and the already-installed MCP entries in line with the
 * current server settings. Only tools that already carry a nekko-agent entry
 * are touched, and of those only the ones this app wrote: installing into a
 * new tool is the user's call (onboarding or the Add button), and an entry
 * someone wrote by hand is theirs; keeping our own working is ours.
 */
export function refreshLocalAccess(app: AppLike, host: Host): void {
  const status = apiServerStatus(host);
  writeCliLink(cliLinkDir(), {
    url: status.clientUrl,
    token: status.settings.token,
    enabled: status.settings.enabled,
    updatedAt: Date.now(),
    pid: process.pid,
  });
  const target = subagentTarget(app, host);
  // nekkod writes the entries when it serves them (the same loop, in Rust).
  void onDaemonOr('integrations:refresh', [target], () => {
    for (const tool of host.detectAgentTools()) {
      if (!tool.installed) continue;
      try {
        // Only entries this app wrote; a hand-written one is its author's.
        host.refreshSubagent(tool.id, target);
      } catch {
        /* someone else's config file; the Server tab still offers the snippet */
      }
    }
  }).catch(() => {
    /* the daemon went away mid-call; the next settings change refreshes again */
  });
}

/**
 * Honour "Start Server on Nekko Launch" being off: the server stays down for
 * this launch.
 *
 * Done by writing `enabled: false` rather than by skipping the sync, so every
 * reader agrees it is stopped: the Agent server panel shows the power pill off,
 * the CLI link says nothing is serving (a terminal falls back to the data
 * directory instead of dialling a closed port), and the MCP entries fall back
 * to their portable form. Switching it on from the pill is then an ordinary
 * save, for this session only.
 */
export function applyStartOnLaunch(host: Host): void {
  const settings = withApiServerDefaults(host.getSettings().apiServer);
  if (settings.startOnLaunch === false && settings.enabled) {
    host.updateSettings({ apiServer: { ...settings, enabled: false } });
  }
}

/**
 * Startup: a token if there is none, the server up, the launcher linked, and
 * everything that points at the server refreshed.
 *
 * The launcher is only linked automatically in a packaged build. A development
 * run would otherwise put a checkout's CLI on the developer's real PATH every
 * time the app started; there the Server tab's Install button does it on ask.
 */
export function startLocalAccess(app: AppLike, host: Host): void {
  applyStartOnLaunch(host);
  ensureApiServerToken(host);
  syncApiServer(host);
  if (app.isPackaged) installCli(app);
  refreshLocalAccess(app, host);
}

/**
 * Quit: tell the CLI the app is no longer serving, so a terminal falls back to
 * the local data directory instead of dialling a port that just closed. (A
 * crash skips this; the pid in the link covers that case.)
 */
export function stopLocalAccess(host: Host): void {
  const status = apiServerStatus(host);
  writeCliLink(cliLinkDir(), {
    url: status.clientUrl,
    token: status.settings.token,
    enabled: false,
    updatedAt: Date.now(),
  });
}
