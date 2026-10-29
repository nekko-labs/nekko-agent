import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBridgeHost } from './bridge';

const channels: MessageChannel[] = [];
afterEach(() => { for (const c of channels.splice(0)) { c.port1.close(); c.port2.close(); } });

function setup(granted: Parameters<typeof createBridgeHost>[1]['granted'], handlers: Parameters<typeof createBridgeHost>[1]['handlers']) {
  const ch = new MessageChannel();
  channels.push(ch);
  createBridgeHost(ch.port1, { granted, handlers });
  const call = (msg: unknown) => new Promise<unknown>((resolve) => {
    ch.port2.onmessage = (e) => resolve(e.data);
    ch.port2.postMessage(msg);
  });
  return { call, port: ch.port2 };
}

describe('mod bridge', () => {
  it('answers a method that needs no permission', async () => {
    const { call } = setup([], { 'ui.toast': (p) => `shown ${(p as { text: string }).text}` });
    expect(await call({ id: 1, method: 'ui.toast', params: { text: 'hi' } })).toEqual({ id: 1, result: 'shown hi' });
  });

  it('denies tools.run without tools:run and never calls the handler', async () => {
    const run = vi.fn();
    const { call } = setup(['chats:read'], { 'tools.run': run });
    expect(await call({ id: 2, method: 'tools.run', params: {} })).toMatchObject({ id: 2, error: { code: 'denied' } });
    expect(run).not.toHaveBeenCalled();
  });

  it('calls a granted method', async () => {
    const { call } = setup(['tools:run'], { 'tools.run': async () => 'ran' });
    expect(await call({ id: 3, method: 'tools.run' })).toEqual({ id: 3, result: 'ran' });
  });

  it('reports unknown methods, including prototype names and methods with no handler', async () => {
    const { call } = setup(['chats:read'], {});
    for (const method of ['nope', 'constructor', '__proto__', 'chats.list']) {
      expect(await call({ id: method, method })).toMatchObject({ error: { code: 'unknown' } });
    }
  });

  it('turns a throwing handler into failed, without its stack', async () => {
    const { call } = setup([], { 'storage.get': () => { throw new Error('disk on fire at /Users/x/secret'); } });
    const reply = await call({ id: 4, method: 'storage.get' }) as { error: { code: string; message: string } };
    expect(reply.error.code).toBe('failed');
    expect(reply.error.message).not.toContain('/Users');
  });

  it('ignores malformed messages', async () => {
    const { call, port } = setup([], { 'ui.toast': () => 'ok' });
    for (const junk of [null, 'x', { method: 'ui.toast' }, { id: {}, method: 'ui.toast' }, { id: 5, method: 7 }]) port.postMessage(junk);
    expect(await call({ id: 6, method: 'ui.toast' })).toEqual({ id: 6, result: 'ok' });
  });
});
