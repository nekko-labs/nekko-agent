import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentEvent, AppSettings, MessagingSettings, ModelInfo, SendOptions, Session } from '@nekko-agent/shared';
import { pickAutoModel } from '@nekko-agent/shared';
import { setDataDir } from './paths.js';
import { createMessagingService, loadState, type MessagingHost, type MessagingService } from './messaging/service.js';
import { TelegramApi } from './messaging/telegram.js';

/**
 * What the Telegram bridge does, which the engine daemon's port
 * (crates/nekko-messaging `Bridge`, driven by crates/nekkod/src/messaging.rs)
 * must reproduce exactly. The real service and the real `TelegramApi` run
 * over a scripted Bot API (`fetch`) and a fake host under fake timers,
 * through a script of operations; after each one the Telegram requests sent
 * (URL and body as sent), the long polls started, the host calls, the state
 * file and the status are recorded. The script itself is written into the
 * golden file, so the Rust test replays the same operations.
 * Fails if the file is stale; rewrite it with UPDATE_GOLDEN=1.
 */
const golden = join(__dirname, '..', '..', '..', 'crates', 'nekko-messaging', 'tests', 'golden', 'bridge.json');

afterEach(() => {
  vi.useRealTimers();
});

type Op =
  | { settings: MessagingSettings }
  | { updates: unknown[]; models?: unknown[]; failChat?: string }
  | { pollError: string }
  | { event: Record<string, unknown> }
  | { tick: number }
  | { failSend: string }
  | { failGetMe: string }
  | { stop: true }
  | { restart: MessagingSettings };

const msg = (updateId: number, chatId: number, text?: string) => ({
  update_id: updateId,
  message: { message_id: 1, chat: { id: chatId, type: 'private' }, ...(text === undefined ? {} : { text }) },
});
const press = (updateId: number, id: string, chatId: number, data: string, text?: string, messageId = 55) => ({
  update_id: updateId,
  callback_query: {
    id,
    from: { id: 5 },
    message: { message_id: messageId, chat: { id: chatId, type: 'private' }, ...(text === undefined ? {} : { text }) },
    data,
  },
});

const ON: MessagingSettings = { telegram: { enabled: true, botToken: '123:TEST', allowedChatIds: ['42', '7', '-1001'] } };
const TOKEN2: MessagingSettings = { telegram: { enabled: true, botToken: '456:TEST2', allowedChatIds: ['42', '7'] } };
const OFF: MessagingSettings = { telegram: { enabled: false, botToken: '456:TEST2', allowedChatIds: ['42', '7'] } };
const long = `${'a'.repeat(4095)}\u{1F600} and the rest`;

const SCRIPT: Op[] = [
  { settings: ON },
  // Two refusals in one batch, a message with no text and a group chat refused.
  { updates: [msg(10, 99, 'hello'), msg(11, 42), msg(12, -100, 'group')] },
  { updates: [msg(13, 42, '  fix the tests  ')] },
  { tick: 1500 },
  { event: { type: 'text', sessionId: 's1', delta: 'Hello ' } },
  { event: { type: 'tool_call', sessionId: 's1', call: { id: 'c1', name: 'read_file', arguments: {} } } },
  { tick: 1500 },
  { event: { type: 'tool_result', sessionId: 's1', result: { toolCallId: 'c1', output: 'ok' } } },
  { event: { type: 'text', sessionId: 's1', delta: 'there' } },
  // Events nobody is bound to, and one with no session.
  { event: { type: 'text', sessionId: 's_other', delta: 'ignored' } },
  { event: { type: 'text', delta: 'no session' } },
  { event: { type: 'done', sessionId: 's1', messageId: 'm1' } },
  { tick: 1500 },
  { event: { type: 'tool_approval_required', sessionId: 's1', call: { id: 'call-9', name: 'write_file' }, reason: 'writes src/x.ts', severity: 'medium' } },
  { updates: [press(14, 'q1', 42, 'm:1', 'Approval needed: write_file: writes src/x.ts (severity: medium)')] },
  // Used already: expired. So is anything not shaped m:<n>.
  { updates: [press(15, 'q2', 42, 'm:1')] },
  { updates: [press(16, 'q3', 42, 'approve')] },
  { event: { type: 'tool_approval_required', sessionId: 's1', call: { id: 'call-10', name: 'bash' }, reason: 'runs rm', severity: 'high' } },
  // An unlisted chat pressing a live button is ignored without an answer.
  { updates: [press(17, 'q4', 99, 'm:3')] },
  { updates: [press(18, 'q5', 42, 'm:4')] },
  {
    event: {
      type: 'question', sessionId: 's1',
      request: { callId: 'ask-1', askedAt: 1, questions: [{ id: 'q1', header: 'Pick', question: 'Which auth?', options: [{ label: 'JWT' }, { label: 'OAuth' }] }] },
    },
  },
  { updates: [msg(19, 42, 'use JWT please')] },
  {
    event: {
      type: 'question', sessionId: 's1',
      request: { callId: 'ask-2', askedAt: 2, questions: [{ id: 'q2', header: 'Pick', question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }] },
    },
  },
  { updates: [press(20, 'q6', 42, 'm:008', 'Agent asks: Which database?', 60)] },
  { updates: [msg(21, 42, 'next task')] },
  { event: { type: 'error', sessionId: 's1', message: 'boom' } },
  { updates: [msg(22, 42, 'again')], failChat: 'provider exploded' },
  { tick: 1500 },
  {
    event: {
      type: 'question', sessionId: 's1',
      request: {
        callId: 'ask-3', askedAt: 3,
        questions: [
          { id: 'a', header: 'A', question: 'First?', options: [{ label: 'yes' }, { label: 'no' }] },
          { id: 'b', header: 'B', question: 'Second?', options: [{ label: 'left' }] },
        ],
      },
    },
  },
  {
    event: {
      type: 'question', sessionId: 's1',
      request: { callId: 'ask-4', askedAt: 4, questions: [{ id: 'c', header: 'C', question: 'Colour?', options: ['red', 'green', 'blue', 'cyan', 'pink'].map((label) => ({ label })) }] },
    },
  },
  { event: { type: 'question_resolved', sessionId: 's1', callId: 'ask-4' } },
  // The chat bound in the state file: an Auto chat on another provider.
  {
    updates: [msg(23, 7, 'implement the parser and refactor the lexer')],
    models: [
      { id: 'tiny-3b', name: 'Tiny 3B', providerId: 'p2' },
      { id: 'big-70b', name: 'Big 70B', providerId: 'p2' },
      { id: 'whisper-large', name: 'Whisper', providerId: 'p2' },
    ],
  },
  { updates: [msg(24, 7, 'hi')], models: [] },
  { tick: 1500 },
  { event: { type: 'text', sessionId: 's_auto', delta: 'short' } },
  { event: { type: 'done', sessionId: 's_auto', messageId: 'm2' } },
  // An app-started turn mirrored into its chat, cut at 4096 units mid-emoji.
  { event: { type: 'text', sessionId: 's1', delta: long } },
  { tick: 1500 },
  { event: { type: 'done', sessionId: 's1', messageId: 'm3' } },
  // A send that fails is sent again on the next flush.
  { event: { type: 'text', sessionId: 's1', delta: 'lost' } },
  { failSend: 'Bad Request: chat not found' },
  { tick: 1500 },
  { event: { type: 'text', sessionId: 's1', delta: ' found' } },
  { tick: 1500 },
  { event: { type: 'done', sessionId: 's1', messageId: 'm4' } },
  { pollError: 'Conflict: terminated by other getUpdates request' },
  { tick: 5000 },
  { updates: [] },
  { failGetMe: 'Unauthorized' },
  { settings: TOKEN2 },
  { updates: [msg(25, 42, 'after the token change'), msg(26, -1001, 'not listed any more')] },
  { tick: 1500 },
  // The same config again changes nothing.
  { settings: TOKEN2 },
  { settings: OFF },
  { updates: [msg(27, 42, 'while off')] },
  { settings: TOKEN2 },
  // A button from before the restart of the bridge still answers.
  { updates: [press(28, 'q7', 42, 'm:6', 'Agent asks: Which auth?', 61)] },
  { stop: true },
  { restart: TOKEN2 },
];

/** State files as the bridge finds them. */
const LOADS: Array<string | null> = [
  null,
  '',
  'not json',
  '\uFEFF{"offset":5,"bindings":{}}',
  'null',
  '[1,2]',
  '"ab"',
  '{"bindings":{"9":"s9","-5":"s5","1":"s1"},"offset":3}',
  '{"offset":"12","extra":true,"bindings":{"x":"y"},"0":"zero"}',
  '{"offset":1,"offset":2}',
];

const INITIAL_STATE = '{"bindings":{"7":"s_auto"},"offset":10,"note":"kept"}';

const SETTINGS = {
  theme: 'dark',
  providers: [
    { id: 'p1', kind: 'openai-compat', label: 'One', baseUrl: 'http://x', enabled: true },
    { id: 'p2', kind: 'openai-compat', label: 'Two', baseUrl: 'http://y', enabled: true },
  ],
  defaultProviderId: 'p1',
  defaultModelId: 'm1',
  messaging: {},
};

const m = (id: string, name?: string) => (name === undefined ? { id, providerId: 'p' } : { id, name, providerId: 'p' });
const LOCAL = [m('gemma-3-12b', 'Gemma 3 12B'), m('qwen2.5-32b-instruct', 'Qwen 32B'), m('llama-3.3-70b', 'Llama 70B'), m('whisper-large-v3', 'Whisper')];
const AUTO_CASES: Array<[unknown[], string]> = [
  [[], 'hi'],
  [LOCAL, 'hi'],
  [LOCAL, 'please refactor the module'],
  [LOCAL, 'Why does this crash?'],
  [LOCAL, `${'x'.repeat(601)}`],
  [LOCAL, 'look:\n```\ncode\n```'],
  [[m('whisper-1'), m('text-embedding-3-small')], 'hi'],
  [[m('toy-model'), m('another-toy')], 'hi'],
  [[m('gpt-4o-mini'), m('gpt-4o'), m('o3-mini'), m('o3'), m('claude-3-5-haiku'), m('claude-sonnet-4'), m('claude-opus-4')], 'hello there'],
  [[m('gpt-4o-mini'), m('gpt-4o'), m('o3-mini'), m('o3'), m('claude-3-5-haiku'), m('claude-sonnet-4'), m('claude-opus-4')], 'debug the race'],
  [[m('phi-4'), m('mixtral-8x7b'), m('stable-diffusion-xl'), m('bge-reranker')], 'quick one'],
  [[m('phi-4'), m('mixtral-8x7b')], 'IMPLEMENT it'],
  [[m('model_sd_v1'), m('my-ocr'), m('gemma2-9b')], 'hi'],
  [[{ id: 'odd', providerId: 'p' }, { id: 'undefined-name-flash', providerId: 'p' }], 'test this'],
  [[m('a-7b'), m('b-7b'), m('c-70b')], 'hi'],
];

const SESSIONS = [{ id: 's_auto', title: 'Auto chat', providerId: 'p2', autoModel: true, messages: [], createdAt: 1, updatedAt: 1 }];

it('runs the Telegram bridge as the daemon must', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const dir = mkdtempSync(join(tmpdir(), 'nekko-messaging-golden-'));
  try {
    setDataDir(dir);
    const file = join(dir, 'messaging-state.json');

    const loads = LOADS.map((text) => {
      rmSync(file, { force: true });
      if (text !== null) writeFileSync(file, text);
      return { file: text, state: JSON.stringify(loadState(), null, 2) };
    });
    rmSync(file, { force: true });
    writeFileSync(file, INITIAL_STATE);

    // The fake host.
    const settings = JSON.parse(JSON.stringify(SETTINGS)) as AppSettings;
    const sessions = new Map<string, Session>(SESSIONS.map((s) => [s.id, JSON.parse(JSON.stringify(s))]));
    let sessionN = 0;
    let models: unknown[] = [];
    let failChat: string | undefined;
    const emitter = new EventEmitter();
    let hostCalls: unknown[] = [];
    const host: MessagingHost = {
      getSettings: () => settings,
      getSession: (id) => sessions.get(id) ?? null,
      createSession: () => {
        const s = { id: `s${++sessionN}`, title: 'New chat', messages: [], createdAt: 1, updatedAt: 1 } as Session;
        sessions.set(s.id, s);
        hostCalls.push({ create: s.id });
        return s;
      },
      listModels: async (providerId) => {
        hostCalls.push({ listModels: providerId });
        return models as ModelInfo[];
      },
      sendChat: async (opts: SendOptions) => {
        hostCalls.push({ send: opts });
        if (failChat) {
          const m = failChat;
          failChat = undefined;
          throw new Error(m);
        }
      },
      approveTool: (sessionId, callId, approved) => {
        hostCalls.push({ approve: [sessionId, callId, approved] });
      },
      answerQuestion: (sessionId, callId, answers) => {
        hostCalls.push({ answer: [sessionId, callId, answers] });
      },
      events: emitter as unknown as MessagingHost['events'],
    };

    // The scripted Bot API.
    let calls: Array<{ url: string; body: string }> = [];
    let polls: Array<{ url: string; body: string }> = [];
    const pending: Array<(reply: unknown) => void> = [];
    let messageId = 100;
    let failSend: string | undefined;
    let failGetMe: string | undefined;
    const reply = (data: unknown) => ({ status: 200, json: async () => data });
    const fetchImpl = (async (url: string, init: { body: string }) => {
      const method = url.slice(url.lastIndexOf('/') + 1);
      if (method === 'getUpdates') {
        polls.push({ url, body: init.body });
        return new Promise((resolve) => pending.push((data) => resolve(reply(data))));
      }
      calls.push({ url, body: init.body });
      if (method === 'getMe') {
        if (failGetMe) {
          const d = failGetMe;
          failGetMe = undefined;
          return reply({ ok: false, error_code: 401, description: d });
        }
        return reply({ ok: true, result: { id: 7, is_bot: true, username: 'nekko_bot' } });
      }
      if (method === 'sendMessage') {
        if (failSend) {
          const d = failSend;
          failSend = undefined;
          return reply({ ok: false, error_code: 400, description: d });
        }
        const chat = JSON.parse(init.body).chat_id;
        return reply({ ok: true, result: { message_id: messageId++, chat: { id: Number(chat), type: 'private' } } });
      }
      return reply({ ok: true, result: true });
    }) as unknown as typeof fetch;
    const apiFactory = (token: string) => new TelegramApi(token, fetchImpl);

    const settle = async () => {
      for (let round = 0; round < 3; round++) {
        for (let i = 0; i < 20; i++) await Promise.resolve();
        await new Promise((r) => setImmediate(r));
      }
    };

    let service: MessagingService = createMessagingService(host, apiFactory);
    const steps = [];
    for (const op of SCRIPT) {
      calls = [];
      polls = [];
      hostCalls = [];
      if ('settings' in op) {
        settings.messaging = op.settings;
        service.update(op.settings);
      } else if ('updates' in op) {
        if (op.models) models = op.models;
        if (op.failChat) failChat = op.failChat;
        const resolve = pending.shift();
        if (!resolve) throw new Error('no poll waiting');
        resolve({ ok: true, result: op.updates });
      } else if ('pollError' in op) {
        const resolve = pending.shift();
        if (!resolve) throw new Error('no poll waiting');
        resolve({ ok: false, error_code: 409, description: op.pollError });
      } else if ('event' in op) {
        emitter.emit('agentEvent', op.event as unknown as AgentEvent);
      } else if ('tick' in op) {
        await vi.advanceTimersByTimeAsync(op.tick);
      } else if ('failSend' in op) {
        failSend = op.failSend;
      } else if ('failGetMe' in op) {
        failGetMe = op.failGetMe;
      } else if ('stop' in op) {
        service.stop();
      } else if ('restart' in op) {
        service = createMessagingService(host, apiFactory);
        settings.messaging = op.restart;
        service.update(op.restart);
      }
      await settle();
      steps.push({
        op,
        telegram: calls,
        polls,
        host: JSON.parse(JSON.stringify(hostCalls)),
        state: existsSync(file) ? readFileSync(file, 'utf8') : null,
        status: JSON.parse(JSON.stringify(service.status())),
      });
    }
    service.stop();

    // Auto chats pick their model as the composer does (the bridge's only use of it).
    const autoPicks = AUTO_CASES.map(([models, prompt]) => ({ models, prompt, pick: pickAutoModel(models as ModelInfo[], prompt)?.modelId ?? null }));

    const out = { loads, initialState: INITIAL_STATE, settings: SETTINGS, sessions: SESSIONS, autoPicks, steps };
    if (process.env.UPDATE_GOLDEN) {
      mkdirSync(join(golden, '..'), { recursive: true });
      writeFileSync(golden, `${JSON.stringify(out, null, 1)}\n`);
    }
    expect(JSON.parse(readFileSync(golden, 'utf8'))).toEqual(JSON.parse(JSON.stringify(out)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
