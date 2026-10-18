import type { Host } from '@nekko-agent/host';
import { IpcChannels } from '@nekko-agent/shared';
import type { ChannelHandler, ChannelOverrides } from 'nekko-agent/backend';

/**
 * The channels the Local Web UI's backend answers differently from the shared
 * dispatcher (on top of the base set every backend has, backend.ts).
 */

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
