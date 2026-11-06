import type { ModPermission } from '@nekko-agent/shared';

/*
 * The only way a mod frame talks to the app (spec desktop/customizable-ui).
 * Each method names the permission it needs; the host refuses a call the
 * person did not grant before any handler sees it.
 */

/** Method to the permission it needs; null needs none. */
export const METHOD_PERMISSIONS: Readonly<Record<string, ModPermission | null>> = {
  'ui.toast': null,
  'view.open': null,
  'storage.get': null,
  'storage.set': null,
  'chats.list': 'chats:read',
  'chats.messages': 'chats:content',
  'chats.start': 'chats:write',
  'chats.send': 'chats:write',
  'chats.stop': 'chats:write',
  'hardware.read': 'hardware:read',
  'usage.read': 'usage:read',
  'files.pick': 'files:read',
  'files.save': 'files:write',
  'tools.run': 'tools:run',
};

export type BridgeHandler = (params: unknown) => unknown | Promise<unknown>;
export type BridgeError = { code: 'denied' | 'unknown' | 'failed'; message: string };

/** Serves a mod's calls on `port`. Returns a function that stops serving. */
export function createBridgeHost(
  port: MessagePort,
  opts: { granted: readonly ModPermission[]; handlers: Partial<Record<string, BridgeHandler>> },
): () => void {
  const reply = (id: string | number, body: { result: unknown } | { error: BridgeError }) => port.postMessage({ id, ...body });
  port.onmessage = async (e: MessageEvent) => {
    const msg = e.data as { id?: unknown; method?: unknown; params?: unknown } | null;
    if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string' || (typeof msg.id !== 'string' && typeof msg.id !== 'number')) return;
    const { id, method } = msg as { id: string | number; method: string };
    const handler = Object.hasOwn(METHOD_PERMISSIONS, method) && Object.hasOwn(opts.handlers, method) ? opts.handlers[method] : undefined;
    if (!handler) return reply(id, { error: { code: 'unknown', message: `${method} is not available` } });
    const needs = METHOD_PERMISSIONS[method];
    if (needs && !opts.granted.includes(needs)) return reply(id, { error: { code: 'denied', message: `${method} needs the ${needs} permission` } });
    try {
      reply(id, { result: await handler(msg.params) });
    } catch {
      // The mod learns only that it failed: an error's text can carry paths or other private detail.
      reply(id, { error: { code: 'failed', message: `${method} failed` } });
    }
  };
  port.start();
  return () => { port.onmessage = null; port.close(); };
}
