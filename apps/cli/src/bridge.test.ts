import { describe, expect, it, vi } from 'vitest';
import { APPROVE_TOOL, askNekkod, handleBridgeMessage } from './bridge.js';

const prompt = { tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'toolu_1' };

function reply(status: number, body: unknown): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe('askNekkod', () => {
  it('posts the prompt with the bridge token and relays an allow', async () => {
    const fetchImpl = reply(200, { behavior: 'allow', updatedInput: { command: 'ls' } });
    await expect(askNekkod('http://127.0.0.1:9/', 'tok', prompt, fetchImpl)).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { command: 'ls' },
    });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('http://127.0.0.1:9/harness/approve');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body)).toEqual(prompt);
  });

  it('relays a deny with its message', async () => {
    await expect(askNekkod('http://x', 't', prompt, reply(200, { behavior: 'deny', message: 'No.' }))).resolves.toEqual({
      behavior: 'deny',
      message: 'No.',
    });
  });

  it('denies when nekkod refuses, is unreachable or answers nonsense', async () => {
    for (const fetchImpl of [
      reply(401, { error: 'unauthorized' }),
      reply(200, { behavior: 'allow' }),
      reply(200, { whatever: true }),
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    ]) {
      const d = await askNekkod('http://x', 't', prompt, fetchImpl);
      expect(d.behavior).toBe('deny');
    }
  });
});

describe('handleBridgeMessage', () => {
  const allow = vi.fn(async () => ({ behavior: 'allow' as const, updatedInput: {} }));

  it('lists only the approve tool', async () => {
    const r = (await handleBridgeMessage({ id: 1, method: 'tools/list' }, allow)) as any;
    expect(r.result.tools).toEqual([APPROVE_TOOL]);
  });

  it('answers approve with the decision as JSON text, the permission-prompt contract', async () => {
    const r = (await handleBridgeMessage({ id: 2, method: 'tools/call', params: { name: 'approve', arguments: prompt } }, allow)) as any;
    expect(allow).toHaveBeenCalledWith(prompt);
    expect(JSON.parse(r.result.content[0].text)).toEqual({ behavior: 'allow', updatedInput: {} });
  });

  it('denies an unknown tool and ignores notifications', async () => {
    const r = (await handleBridgeMessage({ id: 3, method: 'tools/call', params: { name: 'other' } }, allow)) as any;
    expect(JSON.parse(r.result.content[0].text).behavior).toBe('deny');
    await expect(handleBridgeMessage({ method: 'notifications/initialized' }, allow)).resolves.toBeUndefined();
  });
});
