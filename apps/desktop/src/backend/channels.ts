import { IpcChannels, withApiServerDefaults, type AgentToolId, type ApiServerSettings, type SubagentTarget } from '@nekko-agent/shared';
import { listAgentTerminals, onDaemonOr, type Host } from '@nekko-agent/host';
import { apiServerStatus, newApiToken, syncApiServer } from '../main/api-server.js';
import { cliInstallStatus, installCli } from '../main/cli-install.js';
import { refreshLocalAccess, subagentTarget, type AppLike } from '../main/local-access.js';
import type { LocalRelay } from './local-relay.js';
import type { NetworkVisibility } from './network-visibility.js';
import type { ChannelOverrides } from './wire.js';

/**
 * The channels only the desktop edition answers, and answers differently from
 * the shared dispatcher. They used to be `ipcMain` handlers in the Electron
 * main process; none of them needs Electron (the app paths arrive as plain
 * values, see `index.ts`), so they run here beside the host they drive.
 */
export function desktopChannels(app: AppLike, host: Host, localRelay?: LocalRelay, visibility?: NetworkVisibility): ChannelOverrides {
  const C = IpcChannels;
  return {
    // The local API server. Transport-local by nature: the web and self-hosted
    // editions already are this server, so there is nothing for them to switch on.
    [C.apiServerStatus]: () => apiServerStatus(host),
    [C.apiServerSave]: ([patch]) => {
      const current = withApiServerDefaults(host.getSettings().apiServer);
      const next = { ...current, ...(patch as Partial<ApiServerSettings>) };
      // Switching it on without a token would be switching on an unauthenticated
      // agent endpoint, so the first "on" mints one rather than refusing.
      if (next.enabled && !next.token) next.token = newApiToken();
      host.updateSettings({ apiServer: next });
      syncApiServer(host);
      // A new port, address or token has to reach the CLI's link file and the
      // MCP entries this app wrote, or they keep dialling the old one.
      refreshLocalAccess(app, host);
      return apiServerStatus(host);
    },
    [C.apiServerNewToken]: () => {
      const current = withApiServerDefaults(host.getSettings().apiServer);
      host.updateSettings({ apiServer: { ...current, token: newApiToken() } });
      syncApiServer(host);
      refreshLocalAccess(app, host);
      return apiServerStatus(host);
    },

    // The bundled CLI's launcher and PATH entry.
    [C.cliInstallStatus]: () => cliInstallStatus(app),
    [C.cliInstall]: () => {
      const status = installCli(app);
      // Entries written before the launcher existed used npx; now they can
      // name the launcher instead.
      refreshLocalAccess(app, host);
      return status;
    },

    // MCP entries written from this window point at this app's server: the
    // renderer asks for "install into Claude Code" and the backend fills in
    // the address, token and launcher, which the renderer never has to hold.
    // nekkod writes the entries; it asks `integrations:target` for that
    // target when a call reaches it without one.
    'integrations:target': () => subagentTarget(app, host),
    [C.integrationsInstall]: ([tool, target]) => {
      const t = (target as SubagentTarget | null | undefined) ?? subagentTarget(app, host);
      return onDaemonOr(C.integrationsInstall, [tool, t], () => host.installSubagent(tool as AgentToolId, t));
    },
    [C.integrationsSnippet]: ([tool, target]) => {
      const t = (target as SubagentTarget | null | undefined) ?? subagentTarget(app, host);
      return onDaemonOr(C.integrationsSnippet, [tool, t], () => host.subagentSnippet(tool as AgentToolId, t));
    },

    // The relay this computer runs on its Tailscale address (Remote access card).
    // Not `remote:*`: those are nekkod's, and phones never reach these.
    ...(localRelay
      ? {
          [C.localRelayStatus]: () => localRelay.status(),
          [C.localRelayStart]: () => localRelay.start(),
          [C.localRelayStop]: () => localRelay.stop(),
          [C.localRelaySetLan]: (on: unknown) => localRelay.setLan(on !== false),
        }
      : {}),
    // "Visible on this network" (mDNS). Desktop only, and phones never reach it.
    ...(visibility
      ? {
          [C.networkVisibilityStatus]: () => visibility.status(),
          [C.networkVisibilityStart]: () => visibility.start(),
          [C.networkVisibilityStop]: () => visibility.stop(),
        }
      : {}),

    // For nekkod: the terminals it does not own (the agent command logs).
    'terminals:list:agent': () => listAgentTerminals(),
  };
}
