import { describe, expect, it, vi } from 'vitest';
import { APPROVE_TOOL, WATCH_TOOL, TITLE_TOOL, askNekkod, callNekkod, handleBridgeMessage, offeredTools } from './bridge.js';

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

describe('the Nekko watch tool on the bridge', () => {
  const allow = vi.fn(async () => ({ behavior: 'allow' as const, updatedInput: {} }));

  it('is offered only when nekkod asks for it, and never an unknown name', () => {
    expect(offeredTools(undefined)).toEqual([]);
    expect(offeredTools('')).toEqual([]);
    expect(offeredTools('agent_watch')).toEqual([WATCH_TOOL]);
    expect(offeredTools('agent_watch, agent_watch,run_shell')).toEqual([WATCH_TOOL]);
  });

  it('lists approve alone without it, and both with it', async () => {
    const without = (await handleBridgeMessage({ id: 1, method: 'tools/list' }, allow)) as any;
    expect(without.result.tools.map((t: any) => t.name)).toEqual(['approve']);
    const withWatch = (await handleBridgeMessage({ id: 1, method: 'tools/list' }, allow, [WATCH_TOOL])) as any;
    expect(withWatch.result.tools.map((t: any) => t.name)).toEqual(['approve', 'agent_watch']);
  });

  it('runs an offered call through nekkod and marks a refusal as an error', async () => {
    const run = vi.fn(async () => ({ ok: true as const, text: 'Watch armed: w1.' }));
    const msg = { id: 2, method: 'tools/call', params: { name: 'agent_watch', arguments: { action: 'list' } } };
    const r = (await handleBridgeMessage(msg, allow, [WATCH_TOOL], run)) as any;
    expect(run).toHaveBeenCalledWith({ name: 'agent_watch', input: { action: 'list' } });
    expect(r.result).toEqual({ content: [{ type: 'text', text: 'Watch armed: w1.' }] });
    const refused = (await handleBridgeMessage(msg, allow, [WATCH_TOOL], async () => ({ ok: false, error: 'Not on a Claude plan.' }))) as any;
    expect(refused.result.isError).toBe(true);
    expect(refused.result.content[0].text).toBe('Not on a Claude plan.');
  });

  it('does not run the watch when it was not offered', async () => {
    const run = vi.fn(async () => ({ ok: true as const, text: 'should not run' }));
    const r = (await handleBridgeMessage({ id: 3, method: 'tools/call', params: { name: 'agent_watch', arguments: {} } }, allow, [], run)) as any;
    expect(run).not.toHaveBeenCalled();
    expect(r.result.content[0].text).toContain('Unknown tool');
  });

  it('posts to /harness/tool with the bridge token and fails closed', async () => {
    const fetchImpl = reply(200, { ok: true, text: 'Cancelled watch w1' });
    await expect(callNekkod('http://127.0.0.1:9', 'tok', { name: 'agent_watch', input: { action: 'cancel', id: 'w1' } }, fetchImpl)).resolves.toEqual({ ok: true, text: 'Cancelled watch w1' });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('http://127.0.0.1:9/harness/tool');
    expect(init.headers.Authorization).toBe('Bearer tok');
    for (const bad of [reply(401, {}), reply(200, { ok: true }), vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch]) {
      expect((await callNekkod('http://x', 't', { name: 'agent_watch', input: {} }, bad)).ok).toBe(false);
    }
  });
});


describe('the in-turn title tool on the bridge', () => {
  const allow = vi.fn(async () => ({ behavior: 'allow' as const, updatedInput: {} }));

  it('registers naming only when requested, independently of watches', async () => {
    expect(offeredTools('set_chat_title,set_chat_title,unknown')).toEqual([TITLE_TOOL]);
    const tools = offeredTools('agent_watch,set_chat_title');
    expect(tools).toEqual([WATCH_TOOL, TITLE_TOOL]);
    const listed = await handleBridgeMessage({ id: 1, method: 'tools/list' }, allow, tools) as any;
    expect(listed.result.tools).toEqual([APPROVE_TOOL, WATCH_TOOL, TITLE_TOOL]);
    expect(TITLE_TOOL.inputSchema.required).toEqual(['title']);
  });

  it('runs only offered naming calls and surfaces daemon refusals', async () => {
    const msg = { id: 2, method: 'tools/call', params: { name: 'set_chat_title', arguments: { title: 'Fix chat naming' } } };
    const run = vi.fn(async () => ({ ok: true as const, text: 'Chat title updated.' }));
    await handleBridgeMessage(msg, allow, [], run);
    expect(run).not.toHaveBeenCalled();
    const answer = await handleBridgeMessage(msg, allow, [TITLE_TOOL], run) as any;
    expect(run).toHaveBeenCalledWith({ name: 'set_chat_title', input: { title: 'Fix chat naming' } });
    expect(answer.result.content[0].text).toBe('Chat title updated.');
    const refused = await handleBridgeMessage(msg, allow, [TITLE_TOOL], async () => ({ ok: false, error: 'Title already chosen.' })) as any;
    expect(refused.result.isError).toBe(true);
  });

  it('sends naming only through the authenticated tool endpoint', async () => {
    const fetchImpl = reply(200, { ok: true, text: 'Chat title updated.' });
    const call = { name: 'set_chat_title', input: { title: 'Fix chat naming' } };
    await callNekkod('http://127.0.0.1:9', 'title-token', call, fetchImpl);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('http://127.0.0.1:9/harness/tool');
    expect(init.headers.Authorization).toBe('Bearer title-token');
    expect(JSON.parse(init.body)).toEqual(call);
  });
});
