import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { expect, it } from 'vitest';
import type { ChatMessage, Session } from '@nekko-agent/shared';
import { assembleContext, renderContextBlock } from '@nekko-agent/core';
import { turnSystemPrompt, turnTools } from './turn-plan.js';
import {
  SANDBOX_TOOLS,
  sandboxAdmissionRefusal,
  sandboxToolCheck,
  sandboxWorkspaces,
  SUMMARY_SYSTEM,
  clip,
  compactedTranscript,
  compactionPlan,
  compactionRefusal,
  compactionSizes,
  compactionUsageRecord,
  continuedChat,
  imageFailure,
  imageReply,
  imageSize,
  imageStageLabel,
  interruptQueuedPlan,
  queuedIndexValid,
  splitTranscript,
  startImageTurn,
  summarizeWith,
  summaryMessage,
  summaryPrompt,
  transcriptText,
} from './turn-variants.js';

/**
 * The turns that are not ordinary replies, as the TS functions run them:
 * compaction (what is summarized, the transcript the summary calls read,
 * the chunking, the summary passes and their progress, the edit, the new
 * chat), image turns (the transcript edits, the request, the labels and
 * replies) and starting a queued prompt at once. The engine daemon's port
 * (crates/nekko-turn/src/variants.rs) must give the same text for the same
 * input. Writes crates/nekko-turn/tests/golden/variants.json; fails if it is
 * stale (rewrite with UPDATE_GOLDEN=1).
 */
const golden = join(__dirname, '..', '..', '..', 'crates', 'nekko-turn', 'tests', 'golden', 'variants.json');

let n = 0;
const msg = (role: string, content: string, extra: Record<string, unknown> = {}): ChatMessage =>
  ({ id: `m${n++}`, role, content, createdAt: 1000 + n, ...extra }) as unknown as ChatMessage;

const emoji = '\u{1F63A}';
const big = (label: string, units: number) => `${label}${'x'.repeat(units)}${label}`;

const TRANSCRIPTS: ChatMessage[][] = [
  [],
  [msg('user', 'hello'), msg('assistant', 'hi there')],
  [
    msg('user', 'run it', { images: ['a', 'b'], videos: ['v'] }),
    msg('assistant', '', { toolCalls: [{ id: 'c1', name: 'bash', input: { command: 'cat big.log', nested: { k: [1, 2.5, null] } } }, { id: 'c2', name: 'read_file' }] }),
    msg('tool', '', { toolResult: { toolCallId: 'c1', output: `START${'y'.repeat(4000)}END` } }),
    msg('tool', '', { toolResult: { toolCallId: 'c2', output: 'nope', isError: true } }),
  ],
  [
    msg('assistant', 'earlier summary text', { compaction: { summarized: 3 } }),
    msg('user', `${emoji.repeat(10)} unicode ${emoji}`),
    msg('assistant', '', { toolCalls: [{ id: 'c3', name: 'write_file', input: { path: 'a.txt', content: `${emoji.repeat(5)}${'z'.repeat(900)}` } }] }),
    msg('tool', '', { toolResult: { toolCallId: 'c3', output: `${emoji.repeat(4)}${'q'.repeat(2000)}` } }),
  ],
  [msg('system', 'sys'), msg('user', '', { images: [] }), msg('assistant', '', { toolCalls: [{ id: 'c4', name: 'x', input: null }] })],
];

const CLIPS: Array<[string, number]> = [
  ['short', 400],
  ['a'.repeat(400), 400],
  ['a'.repeat(401), 400],
  [`${emoji.repeat(10)}${'b'.repeat(2000)}`, 1500],
  ['abc', 1],
  ['abcdefghijklmnop', 10],
];

const SPLITS: Array<[string, number]> = [
  ['', 10],
  ['short', 10],
  ['line one\nline two\nline three\nline four', 12],
  ['nolinebreaksatallinthistext', 8],
  ['a\nbcdefghijklmnopqrstuvwxyz', 10],
  [`${emoji.repeat(3)}\n${'w'.repeat(30)}\nend`, 20],
  [Array.from({ length: 40 }, (_, i) => `row ${i} ${'r'.repeat(i)}`).join('\n'), 64],
];

const WINDOWS = [0, 1000, 4096, 8192, 32_768, 128_000, 200_000, 1_000_000, 6_000.5];

const longTurns = (count: number, size: number): ChatMessage[] =>
  Array.from({ length: count }, (_, i) => [msg('user', `ask ${i} ${'u'.repeat(size)}`), msg('assistant', `answer ${i} ${'a'.repeat(size)}`)]).flat();

const PLANS: Array<{ messages: ChatMessage[]; window: number }> = [
  { messages: [], window: 8192 },
  { messages: [msg('user', 'only one')], window: 8192 },
  { messages: longTurns(3, 600), window: 128_000 },
  { messages: longTurns(3, 600), window: 1000 },
  { messages: longTurns(4, 20), window: 8192 },
  { messages: [msg('assistant', 'summary', { compaction: { summarized: 2 } })], window: 8192 },
  { messages: [msg('user', 'a'), msg('assistant', 'b'), msg('assistant', 'prior', { compaction: { summarized: 2 } }), ...longTurns(3, 100)], window: 128_000 },
  { messages: [msg('user', 'a'), msg('assistant', 'prior', { compaction: { summarized: 1 } }), msg('user', 'next')], window: 128_000 },
  { messages: [msg('assistant', 'no user at all'), msg('tool', '', { toolResult: { toolCallId: 'x', output: 'out' } })], window: 128_000 },
  { messages: [msg('user', 'first'), msg('assistant', 'reply', { toolCalls: [{ id: 't', name: 'grep', input: { pattern: 'p' } }] }), msg('tool', '', { toolResult: { toolCallId: 't', output: 'hits' } }), msg('user', 'second'), msg('assistant', 'done')], window: 8192 },
];

const provider = { id: 'p', kind: 'openai-compat', label: 'P', baseUrl: 'http://127.0.0.1:1/v1', enabled: true } as const;
const chat = (over: Record<string, unknown> = {}) =>
  ({ id: 's', title: 'Chat', messages: [msg('user', 'hi')], providerId: 'p', modelId: 'm', createdAt: 1, updatedAt: 1, ...over }) as unknown as Session;

const REFUSALS: Array<{ session: Session | null; provider?: unknown; offlineAllowed: boolean }> = [
  { session: null, provider, offlineAllowed: true },
  { session: chat({ incognito: true }), provider, offlineAllowed: true },
  { session: chat({ queue: ['next'] }), provider, offlineAllowed: true },
  { session: chat({ messages: [] }), provider, offlineAllowed: true },
  { session: chat({ modelId: undefined }), provider, offlineAllowed: true },
  { session: chat({ providerId: '' }), provider, offlineAllowed: true },
  { session: chat(), provider: undefined, offlineAllowed: true },
  { session: chat(), provider: { ...provider, enabled: false }, offlineAllowed: true },
  { session: chat({ offline: true }), provider, offlineAllowed: false },
  { session: chat({ offline: true }), provider, offlineAllowed: true },
  { session: chat({ queue: [] }), provider, offlineAllowed: false },
];

/** A scripted model: each summary is a shorter digest of its chunk, so passes converge. */
const digest = (chunk: string) => `  S${chunk.length}:${'z'.repeat(Math.floor(chunk.length / 3))}  `;
const SUMMARIES: Array<{ text: string; window: number; reply: 'digest' | 'empty' | 'throw' | 'blank-second' }> = [
  { text: '', window: 8192, reply: 'digest' },
  { text: '   \n  ', window: 8192, reply: 'digest' },
  { text: 'USER: hello\n\nASSISTANT: hi', window: 8192, reply: 'digest' },
  { text: Array.from({ length: 60 }, (_, i) => `line ${i} ${'l'.repeat(100)}`).join('\n'), window: 2000, reply: 'digest' },
  { text: Array.from({ length: 300 }, (_, i) => `row ${i} ${'r'.repeat(80)}`).join('\n'), window: 4096, reply: 'digest' },
  { text: 'x'.repeat(20_000), window: 1000, reply: 'digest' },
  { text: 'USER: hi', window: 8192, reply: 'empty' },
  { text: 'USER: hi', window: 8192, reply: 'throw' },
  { text: Array.from({ length: 30 }, (_, i) => `line ${i} ${'l'.repeat(100)}`).join('\n'), window: 2000, reply: 'blank-second' },
];

const USAGE: Array<[Record<string, unknown>, string, string, Record<string, number>, number]> = [
  [{ id: 'p', auth: 'apiKey' }, 'm', 's', { inputTokens: 200, outputTokens: 20 }, 1_700_000_000_000],
  [{ id: 'c', auth: 'subscription' }, 'claude', 's2', { inputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 1, outputTokens: 0 }, 2],
  [{ id: 'q' }, 'local', 's3', { inputTokens: 0, cacheReadTokens: 0, outputTokens: 7 }, 3],
];

const imageParams = { modelId: 'image/sd/model', width: 512, height: 768, steps: 20, cfgScale: 4.5, seed: 42 };
const IMAGE_STARTS: Array<{ session: Session; prompt: string; params: Record<string, unknown>; seed: number }> = [
  { session: chat({ title: 'New chat', messages: [] }), prompt: '  a calico cat  ', params: imageParams, seed: 7 },
  { session: chat({ title: 'Named', titleAuto: false, chatType: 'multimodal' }), prompt: 'again', params: { ...imageParams, seed: -1 }, seed: 123456 },
  { session: chat({ title: 'New chat', messages: [] }), prompt: `${'p'.repeat(60)} long prompt`, params: { ...imageParams, cfgScale: 7 }, seed: 1 },
  { session: chat({ title: 'New chat' }), prompt: '   ', params: imageParams, seed: 1 },
  { session: chat({ title: 'New chat', messages: [], modelId: 'old' }), prompt: `${emoji} cat`, params: { width: 256, height: 256, steps: 1, cfgScale: 0, seed: 0 }, seed: 9 },
];

const QUEUED_CHATS: Session[] = [
  chat({ queue: ['plain text', { text: 'with media', images: ['data:image/png;base64,abc'], videos: ['data:video/mp4;base64,v'], skill: { name: 'review', input: 'with media' } }, { text: 'empty media', images: [], videos: [] }] }),
  chat({ providerId: undefined, modelId: undefined, queue: ['one'] }),
  chat({ queue: [] }),
];
const INDICES: unknown[] = [0, 1, 2, 3, -1, 1.5, '0', null, Number.MAX_SAFE_INTEGER, 2 ** 53];
const INTERRUPTS: Array<{ chat: number; index: number; brain: unknown; defaults: Record<string, string> }> = [
  { chat: 0, index: 0, brain: undefined, defaults: {} },
  { chat: 0, index: 1, brain: { providerId: 'p2', modelId: 'm2' }, defaults: {} },
  { chat: 0, index: 2, brain: null, defaults: {} },
  { chat: 0, index: 1, brain: { modelId: '__auto__' }, defaults: {} },
  { chat: 1, index: 0, brain: undefined, defaults: { defaultProviderId: 'dp', defaultModelId: 'dm' } },
  { chat: 1, index: 0, brain: undefined, defaults: { defaultProviderId: 'dp' } },
  { chat: 1, index: 0, brain: { providerId: 'bp' }, defaults: { defaultModelId: 'dm' } },
];

/** A sandbox chat's turn, composed as chat.ts composes it (`admitTurn` and `turnSystemPrompt`). */
const SANDBOX_CHATS: Array<Record<string, unknown>> = [
  { id: 'b1', title: 'Box', workspaceId: 'w1', executionMode: 'sandbox', mode: 'ask', sandbox: { image: 'node:22@sha256:abc', identity: 'i1', configuredAt: 1, sourceWorkspaceIds: ['w1', 'w2'] }, supportingWorkspaceIds: ['w2'], messages: [] },
  { id: 'b2', title: 'Box', workspaceId: 'w1', executionMode: 'sandbox', messages: [], disabledTools: ['grep', 'bash'] },
  { id: 'b3', title: 'Box', executionMode: 'sandbox', sandbox: { image: 'x@sha256:1', identity: 'i3', configuredAt: 1, sourceWorkspaceIds: [] }, chatType: 'image', messages: [] },
  { id: 'b4', title: 'Box', executionMode: 'sandbox', offline: true, workspaceId: 'w9', sandbox: { image: 'x@sha256:1', identity: 'i4', configuredAt: 1, sourceWorkspaceIds: ['w9'] }, messages: [] },
];
const SANDBOX_SETTINGS = [
  { providers: [{ id: 'p1', label: 'Local', enabled: true }], systemInstructions: 'Host-only instructions.', aboutUser: 'Philip', turnWrapper: 'Custom', orchestration: { strategy: 'swarm', maxDepth: 1, maxParallel: 2 } },
  { providers: [] },
];
const SANDBOX_TOOL_NAMES = ['read_file', 'write_file', 'edit_file', 'list_dir', 'glob', 'grep', 'bash', 'fetch_url', 'browser', 'spawn_agent', 'mcp__x__y', 'update_plan', 'ask_user', 'start_process', ''];

function sandboxCases() {
  return SANDBOX_CHATS.flatMap((session) => SANDBOX_SETTINGS.map((settings) => {
    const tools = turnTools({ session: session as never, offline: !!session.offline, orchestration: settings.orchestration as never, allowBrowserControl: true, mcpTools: [], decide: false }).filter((t) => SANDBOX_TOOLS.has(t.name));
    const workspaces = sandboxWorkspaces(session as never);
    const system = turnSystemPrompt({ workspaces, tools, settings: settings as never, sandbox: true, executionMode: 'sandbox', worktreeNotices: [], contextBlock: renderContextBlock(assembleContext({ attached: [], guidelines: [], memory: [], connectorSnippets: [], indexSnippets: [] }), new Map()), platform: 'linux' });
    return { input: { session, settings }, output: { tools: tools.map((t) => t.name), workspaces, system } };
  }));
}

it('turn variants match the daemon golden set', async () => {
  const summaries = [];
  for (const c of SUMMARIES) {
    const prompts: string[] = [];
    const progress: number[][] = [];
    let calls = 0;
    const call = async (chunk: string) => {
      prompts.push(summaryPrompt(chunk));
      calls++;
      if (c.reply === 'empty') return ' \n ';
      if (c.reply === 'throw') throw new Error('Model request failed (HTTP 500): boom');
      if (c.reply === 'blank-second' && calls === 2) return '';
      return digest(chunk);
    };
    try {
      const out = await summarizeWith(c.text, c.window, call, (done, total) => progress.push([done, total]));
      summaries.push({ input: c, output: { summary: out, prompts, progress } });
    } catch (e) {
      summaries.push({ input: c, output: { error: (e as Error).message } });
    }
  }
  const plans = PLANS.map((c) => ({ input: c, output: compactionPlan(c.messages, c.window) }));
  const edits = PLANS.flatMap((c, i) => {
    const plan = compactionPlan(c.messages, c.window);
    if ('error' in plan) return [];
    const marker = summaryMessage(`compact_${i}`, `Summary ${i}`, plan.summarized, plan.createdAt ?? 99);
    const title = `Chat ${i}`;
    return [{ input: { messages: c.messages, plan, marker, title }, output: { here: compactedTranscript(c.messages, plan, marker), next: continuedChat(title, marker, plan.recent) } }];
  });
  const images = IMAGE_STARTS.map((c, i) => {
    const session = structuredClone(c.session);
    const now = 1_700_000_000_000 + i;
    const started = startImageTurn(session, { sessionId: session.id, prompt: c.prompt, params: c.params as never }, now, c.seed);
    return { input: { ...c, now }, output: { started, session } };
  });
  const replies = [
    { result: { created: 1, data: [{ b64_json: 'eA==' }, { b64_json: 'eQ==' }] }, params: imageParams, seed: 42, ms: 1234, now: 1_700_000_000_500 },
    { result: { created: 1, data: [] }, params: { width: 256, height: 256, steps: 1, cfgScale: 0, seed: -1 }, seed: 5, ms: 0, now: 35 },
  ].map((c) => ({ input: c, output: imageReply(c.result, c.params as never, c.seed, c.ms, c.now) }));
  const failures = [
    { stopped: true, message: 'Stopped.', now: 10 },
    { stopped: false, message: 'Choose an image-generation model.', now: 1_700_000_000_000 },
  ].map((c) => ({ input: c, output: imageFailure(c.stopped, c.message, c.now) }));
  const out = {
    system: SUMMARY_SYSTEM,
    transcripts: TRANSCRIPTS.map((input) => ({ input, output: transcriptText(input) })),
    clips: CLIPS.map(([text, max]) => ({ input: { text, max }, output: clip(text, max) })),
    splits: SPLITS.map(([text, max]) => ({ input: { text, max }, output: splitTranscript(text, max) })),
    sizes: WINDOWS.map((input) => ({ input, output: compactionSizes(input) })),
    plans,
    refusals: REFUSALS.map((c) => ({ input: c, output: compactionRefusal(c.session, c.provider as never, c.offlineAllowed) })),
    summaries,
    edits,
    usage: USAGE.map(([config, model, sessionId, item, ts]) => ({ input: { config, model, sessionId, item, ts }, output: compactionUsageRecord(config as never, model, sessionId, item as never, ts) })),
    imageSizes: [{ width: 1024, height: 1024 }, { width: 512, height: 768 }].map((input) => ({ input, output: imageSize(input) })),
    imageLabels: (['loading', 'generating'] as const).map((stage) => ({ input: { stage, size: '512×768' }, output: imageStageLabel(stage, '512×768') })),
    images,
    replies,
    failures,
    indices: QUEUED_CHATS.flatMap((session, c) => INDICES.map((index) => ({ input: { chat: c, index }, output: queuedIndexValid(session, index as number) }))),
    queuedChats: QUEUED_CHATS,
    interrupts: INTERRUPTS.map((c) => ({ input: c, output: interruptQueuedPlan(QUEUED_CHATS[c.chat], c.index, c.brain as never, c.defaults) })),
    sandboxTurns: sandboxCases(),
    sandboxRefusals: SANDBOX_CHATS.flatMap((session) => [{}, { skill: { name: 'review', input: 'x' } }].map((opts) => ({ input: { session, opts }, output: sandboxAdmissionRefusal(session as never, opts as never) }))),
    sandboxTools: SANDBOX_TOOL_NAMES.map((name) => ({ input: name, output: sandboxToolCheck(name) })),
  };
  const actual = JSON.parse(JSON.stringify(out));
  if (process.env.UPDATE_GOLDEN) writeFileSync(golden, `${JSON.stringify(actual, null, 2)}\n`);
  expect(JSON.parse(readFileSync(golden, 'utf8'))).toEqual(actual);
});
