import { afterEach, expect, it, vi } from 'vitest';
import { Jimp } from 'jimp';
import { AnthropicProvider } from './anthropic.js';
import { normalizeAnthropicImages } from './anthropic-images.js';
import type { ChatMessage } from '@nekko-agent/shared';

afterEach(() => vi.restoreAllMocks());

it('bounds historical attachments and tool evidence on retry and new turns without changing originals', async () => {
  const image = new Jimp({ width: 2100, height: 10, color: 0xff0000ff });
  const data = await image.getBase64('image/png');
  const messages: ChatMessage[] = [
    { id: 'u', role: 'user', content: 'inspect', createdAt: 0, images: Array(20).fill(data) },
    { id: 'a', role: 'assistant', content: '', createdAt: 1, toolCalls: [{ id: 'c', name: 'capture', input: {} }] },
    { id: 't', role: 'tool', content: '', createdAt: 2, toolResult: { toolCallId: 'c', output: 'captured', images: [data] } },
  ];
  const original = JSON.stringify(messages);
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('data: {"type":"message_stop"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }));
  const provider = new AnthropicProvider({ id: 'p', kind: 'anthropic', label: 'Test', baseUrl: 'https://example.invalid', enabled: true });
  for (let turn = 0; turn < 3; turn++) {
    const history = turn === 2 ? [...messages, { id: 'next', role: 'user' as const, content: 'continue', createdAt: 3 }] : messages;
    for await (const _ of provider.chat({ model: 'claude-sonnet-4-6', messages: history })) { /* drain */ }
    const wire = JSON.parse(fetch.mock.calls.at(-1)![1]!.body as string);
    const images = wire.messages.flatMap((m: any) => Array.isArray(m.content) ? m.content.filter((b: any) => b.type === 'image') : []);
    expect(images).toHaveLength(21);
    const decoded = await Jimp.read(Buffer.from(images[0].source.data, 'base64'));
    expect(decoded.width).toBe(1568);
    expect(decoded.height).toBe(7);
    expect(wire.messages.some((m: any) => m.content?.some?.((b: any) => b.type === 'tool_result' && b.tool_use_id === 'c'))).toBe(true);
    expect(JSON.stringify(messages)).toBe(original);
  }
});

it('bounds portrait images but leaves small and unreadable bytes unchanged', async () => {
  const large = new Jimp({ width: 5, height: 2100 });
  const small = new Jimp({ width: 5, height: 10 });
  const block = (data: string) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } });
  const blocks = [block((await large.getBuffer('image/png')).toString('base64')), block((await small.getBuffer('image/png')).toString('base64')), block('invalid')];
  const result = await normalizeAnthropicImages([{ role: 'user', content: blocks }]);
  const decoded = await Jimp.read(Buffer.from(result[0].content[0].source.data, 'base64'));
  expect(decoded.height).toBe(1568);
  expect(decoded.width).toBe(4);
  expect(result[0].content.slice(1)).toEqual(blocks.slice(1));
});
