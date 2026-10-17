import { isDaemonCopy, listAgentTerminals, type Host } from '@nekko-agent/host';
import { IpcChannels, IpcEvents } from '@nekko-agent/shared';

/**
 * The channels the web edition answers differently from the shared
 * dispatcher, whether the host runs in this process or as nekkod's backend.
 */
export type ChannelHandler = (args: unknown[]) => unknown;
/** A Map, so a channel named `constructor` or `__proto__` can never reach Object.prototype. */
export type ChannelOverrides = Map<string, ChannelHandler>;

export const OAUTH_UNSUPPORTED_MESSAGE = 'OAuth sign-in is only available in the desktop app.';

const OAUTH_UNSUPPORTED = new Set<string>([
  IpcChannels.oauthBegin,
  IpcChannels.oauthFinish,
  IpcChannels.oauthCancel,
  IpcChannels.oauthSignOut,
  IpcChannels.providersImportCliAuth,
]);

/** Backend-only: the public server's inbound webhook route, relayed through nekkod. */
export const WEBHOOK_DISPATCH = 'web:dispatchWebhook';

export type WebhookDispatchResult = { started: number } | { unauthorized: true };

export function webChannelOverrides(host: Host): ChannelOverrides {
  const out: Record<string, ChannelHandler> = {
    [IpcChannels.oauthStatus]: ([providerConfigId]) => ({
      tokenKey: (providerConfigId as string) ?? '',
      connected: false,
      state: 'missing',
      message: OAUTH_UNSUPPORTED_MESSAGE,
    }),
    // nekkod merges the terminals it owns with the ones it does not (the agent command logs).
    'terminals:list:agent': () => listAgentTerminals(),
    [WEBHOOK_DISPATCH]: async ([slug, secret, payload]): Promise<WebhookDispatchResult> => {
      try {
        const runs = await host.dispatchWebhook(String(slug), String(secret), (payload ?? {}) as Record<string, unknown>);
        return { started: runs.length };
      } catch (e) {
        if ((e as Error & { code?: string }).code === 'WEBHOOK_UNAUTHORIZED') return { unauthorized: true };
        throw e;
      }
    },
  };
  for (const channel of OAUTH_UNSUPPORTED) {
    out[channel] = () => {
      throw new Error(OAUTH_UNSUPPORTED_MESSAGE);
    };
  }
  return new Map(Object.entries(out));
}

export function overrideFor(overrides: ChannelOverrides, channel: string): ChannelHandler | undefined {
  return overrides.get(channel);
}

/** Every host event, keyed by the host's event name, with the channel clients know it by. */
export const HOST_EVENTS = Object.entries(IpcEvents) as [string, string][];

/**
 * Subscribe `send` to every host event (or `only` that channel); returns the
 * unsubscribe. `forDaemon` leaves out what the daemon already has (`isDaemonCopy`).
 */
export function subscribeHostEvents(host: Host, send: (frame: string) => void, only?: string | null, forDaemon = false): () => void {
  const offs = HOST_EVENTS.filter(([, channel]) => !only || channel === only).map(([name, channel]) => {
    const listener = (payload: unknown) => {
      if (forDaemon && isDaemonCopy(name, payload)) return;
      send(JSON.stringify({ channel, payload }));
    };
    host.events.on(name, listener);
    return () => host.events.off(name, listener);
  });
  return () => offs.forEach((off) => off());
}
