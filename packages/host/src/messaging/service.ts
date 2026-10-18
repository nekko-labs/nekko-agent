import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import type { AgentEvent, AppSettings, AskRequest, MessagingSettings, MessagingStatus, ModelInfo, SendOptions, Session } from '@nekko-agent/shared';
import { pickAutoModel } from '@nekko-agent/shared';
import { dataDir } from '../store.js';
import { writeJsonAtomic } from '../secure-file.js';
import { TelegramApi, type TelegramUpdate, type InlineButton } from './telegram.js';

/**
 * The messaging bridge: an inbound channel adapter on one side, the host's
 * session/chat surface on the other. An inbound message resolves to one
 * session (a persisted chat -> session binding, so a thread continues the same
 * agent); the session's streamed reply is edited into a single channel message
 * rather than spamming one message per delta; approvals and the agent's
 * ask_user questions become inline buttons; and nothing answers a chat id the
 * operator did not list.
 *
 * Telegram ships first because a bot token + long-poll is the whole setup:
 * no webhook, no public URL, no phone number. New channels plug in beside it;
 * the bridge logic is channel-agnostic except where a `tg` call is made.
 */

/** Narrow host surface, injected so tests can drive the bridge with fakes. */
export interface MessagingHost {
  getSettings(): AppSettings;
  getSession(id: string): Session | null;
  createSession(): Session;
  listModels(providerId: string): Promise<ModelInfo[]>;
  sendChat(opts: SendOptions): Promise<void>;
  approveTool(sessionId: string, toolCallId: string, approved: boolean): void;
  answerQuestion(sessionId: string, callId: string, answers: { questionId: string; labels: string[]; note?: string }[]): void;
  events: { on(ev: 'agentEvent', fn: (e: AgentEvent) => void): void; off(ev: 'agentEvent', fn: (e: AgentEvent) => void): void };
}

interface MessagingState {
  /** Telegram getUpdates cursor, persisted so a restart skips served updates. */
  offset: number;
  /** chatId -> sessionId, the durable binding. */
  bindings: Record<string, string>;
}

interface Outbound {
  chatId: string;
  /** Channel message being edited as the reply streams; created on first flush. */
  messageId?: number;
  text: string;
  /** Transient tool-status tail, replaced as tools run ("running read_file…"). */
  status: string;
  dirty: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

interface PendingCallback {
  kind: 'approve' | 'ask';
  sessionId: string;
  callId: string;
  /** For ask callbacks: the question and chosen option. */
  questionId?: string;
  label?: string;
}

/**
 * What the engine daemon puts in `NEKKOD_OWNS` when it runs the messaging
 * bridges itself (crates/nekkod/src/messaging.rs): this host then never
 * starts its own, since Telegram allows one long poll per bot token.
 */
export const DAEMON_MESSAGING = 'messaging';

const STATE_FILE = 'messaging-state.json';
/** Telegram caps edit throughput near one write per second per chat. */
const EDIT_INTERVAL_MS = 1_500;
const POLL_TIMEOUT_SEC = 25;
const ERROR_BACKOFF_MS = 5_000;

export interface MessagingService {
  update(settings: MessagingSettings | undefined): void;
  status(): MessagingStatus;
  stop(): void;
}

/** Exported for the parity golden (crates/nekko-messaging). */
export function loadState(): MessagingState {
  try {
    const p = join(dataDir(), STATE_FILE);
    if (existsSync(p)) return { offset: 0, bindings: {}, ...JSON.parse(readFileSync(p, 'utf8')) };
  } catch {
    /* corrupt state starts clean */
  }
  return { offset: 0, bindings: {} };
}

export function createMessagingService(
  host: MessagingHost,
  apiFactory: (token: string) => TelegramApi = (t) => new TelegramApi(t),
): MessagingService {
  const state = loadState();
  const persist = () => writeJsonAtomic(join(dataDir(), STATE_FILE), state);

  let tg: TelegramApi | null = null;
  let activeToken: string | undefined;
  let polling = false;
  let stopped = true;
  let botUsername: string | undefined;
  let lastError: string | undefined;
  let subscribed = false;
  const outbound = new Map<string, Outbound>();
  const callbacks = new Map<number, PendingCallback>();
  const pendingQuestions = new Map<string, AskRequest>();
  let callbackSeq = 0;

  const saveCallback = (cb: PendingCallback): string => {
    const seq = ++callbackSeq;
    callbacks.set(seq, cb);
    return `m:${seq}`;
  };

  const chatIdForSession = (sessionId: string): string | undefined =>
    Object.entries(state.bindings).find(([, s]) => s === sessionId)?.[0];

  const sessionForChat = (chatId: string): Session => {
    const bound = state.bindings[chatId];
    const existing = bound ? host.getSession(bound) : null;
    if (existing) return existing;
    const s = host.createSession();
    state.bindings[chatId] = s.id;
    persist();
    return s;
  };

  const flushOutbound = async (sessionId: string, final = false) => {
    const out = outbound.get(sessionId);
    if (!out || !tg) return;
    const body = (out.text + (out.status && !final ? `\n\n_${out.status}_` : '')).trim() || '…';
    try {
      if (!out.messageId) {
        const m = await tg.sendMessage(out.chatId, body);
        out.messageId = m.message_id;
      } else {
        await tg.editMessageText(out.chatId, out.messageId, body);
      }
      out.dirty = false;
    } catch {
      /* a dropped edit is cosmetic; the final flush retries */
    }
    if (final) {
      if (out.timer) clearTimeout(out.timer);
      outbound.delete(sessionId);
    }
  };

  const scheduleFlush = (sessionId: string) => {
    const out = outbound.get(sessionId);
    if (!out || out.timer) return;
    out.timer = setTimeout(() => {
      out.timer = undefined;
      void flushOutbound(sessionId);
    }, EDIT_INTERVAL_MS);
  };

  /** The bound channel message for this session, creating it on the first
   *  streamed delta so app-originated turns mirror to the channel too. */
  const outboundFor = (sessionId: string): Outbound | undefined => {
    let out = outbound.get(sessionId);
    if (out) return out;
    const chatId = chatIdForSession(sessionId);
    if (!chatId) return undefined;
    out = { chatId, text: '', status: '', dirty: true };
    outbound.set(sessionId, out);
    return out;
  };

  const onEvent = (e: AgentEvent) => {
    const sessionId = (e as { sessionId?: string }).sessionId;
    if (!sessionId || !tg) return;
    const out = outbound.get(sessionId);

    if (e.type === 'text') {
      const o = outboundFor(sessionId);
      if (!o) return;
      o.text += e.delta;
      scheduleFlush(sessionId);
      return;
    }
    if (e.type === 'tool_call' || e.type === 'tool_result') {
      const o = outboundFor(sessionId);
      if (!o) return;
      o.status = e.type === 'tool_call' ? `running ${e.call.name}…` : '';
      scheduleFlush(sessionId);
      return;
    }
    if (e.type === 'tool_approval_required') {
      // The approval goes out as its own message with real buttons; '!' marks
      // the deny callback inside the 64-byte callback_data budget.
      const chatId = out?.chatId ?? chatIdForSession(sessionId);
      if (!chatId) return;
      const ok = saveCallback({ kind: 'approve', sessionId, callId: e.call.id });
      const no = saveCallback({ kind: 'approve', sessionId, callId: `!${e.call.id}` });
      void tg.sendMessage(
        chatId,
        `Approval needed: ${e.call.name}: ${e.reason} (severity: ${e.severity})`,
        [[{ text: 'Approve', callback_data: ok }, { text: 'Deny', callback_data: no }]],
      ).catch(() => {});
      return;
    }
    if (e.type === 'question') {
      pendingQuestions.set(sessionId, e.request);
      const chatId = out?.chatId ?? chatIdForSession(sessionId);
      if (!chatId) return;
      const [q] = e.request.questions;
      if (e.request.questions.length === 1 && q.options.length <= 4) {
        const rows: InlineButton[][] = q.options.map((opt) => [
          { text: opt.label, callback_data: saveCallback({ kind: 'ask', sessionId, callId: e.request.callId, questionId: q.id, label: opt.label }) },
        ]);
        void tg.sendMessage(chatId, `Agent asks: ${q.question}\n(reply with text for something else)`, rows).catch(() => {});
      } else {
        const text = e.request.questions
          .map((x) => `${x.question}\n${x.options.map((o) => `• ${o.label}`).join('\n')}`)
          .join('\n\n');
        void tg.sendMessage(chatId, `Agent asks:\n\n${text}\n\n(reply with your answer)`).catch(() => {});
      }
      return;
    }
    if (e.type === 'question_resolved') {
      pendingQuestions.delete(sessionId);
      return;
    }
    if (e.type === 'done') void flushOutbound(sessionId, true);
    if (e.type === 'error') {
      const chatId = out?.chatId ?? chatIdForSession(sessionId);
      if (chatId) void tg.sendMessage(chatId, `Nekko Agent error: ${e.message}`).catch(() => {});
      void flushOutbound(sessionId, true);
    }
  };

  const resolveChatTarget = async (session: Session, text: string): Promise<{ providerId: string; modelId: string } | null> => {
    const settings = host.getSettings();
    const providerId = session.providerId ?? settings.defaultProviderId ?? settings.providers.find((p) => p.enabled)?.id;
    if (!providerId) return null;
    if (session.autoModel) {
      const models = await host.listModels(providerId).catch(() => [] as ModelInfo[]);
      const pick = pickAutoModel(models, text);
      return pick ? { providerId, modelId: pick.modelId } : null;
    }
    const modelId = session.modelId ?? settings.defaultModelId;
    return modelId ? { providerId, modelId } : null;
  };

  const onInboundText = async (chatId: string, text: string) => {
    if (!tg || !text) return;
    const allowed = host.getSettings().messaging?.telegram?.allowedChatIds ?? [];
    if (!allowed.includes(chatId)) {
      // The allowlist is the whole authorization boundary: refuse loudly rather
      // than silently, so a misrouted room knows it is not being read.
      await tg.sendMessage(chatId, 'Nekko Agent: this chat is not on the allowlist.').catch(() => {});
      return;
    }
    const session = sessionForChat(chatId);

    // A pending ask_user question takes the next text as its free-text answer.
    const pending = pendingQuestions.get(session.id);
    if (pending) {
      pendingQuestions.delete(session.id);
      host.answerQuestion(session.id, pending.callId, [{ questionId: pending.questions[0].id, labels: [], note: text }]);
      return;
    }

    const target = await resolveChatTarget(session, text);
    if (!target) {
      await tg.sendMessage(chatId, 'Nekko Agent: no provider/model is configured for this chat.').catch(() => {});
      return;
    }
    outbound.set(session.id, { chatId, text: '', status: 'queued…', dirty: true });
    scheduleFlush(session.id);
    try {
      await host.sendChat({ sessionId: session.id, providerId: target.providerId, modelId: target.modelId, text });
    } catch (err) {
      outbound.delete(session.id);
      await tg.sendMessage(chatId, `Nekko Agent error: ${(err as Error).message}`).catch(() => {});
    }
  };

  const onUpdate = (u: TelegramUpdate) => {
    state.offset = Math.max(state.offset, u.update_id + 1);
    if (u.message?.text && u.message.chat) {
      void onInboundText(String(u.message.chat.id), u.message.text.trim());
      return;
    }
    const cb = u.callback_query;
    if (!cb || !tg) return;
    const chatId = cb.message?.chat.id != null ? String(cb.message.chat.id) : undefined;
    const allowed = host.getSettings().messaging?.telegram?.allowedChatIds ?? [];
    if (!chatId || !allowed.includes(chatId)) return;
    const m = /^m:(\d+)$/.exec(cb.data ?? '');
    const entry = m ? callbacks.get(Number(m[1])) : undefined;
    if (!entry) {
      void tg.answerCallbackQuery(cb.id, 'That action expired.').catch(() => {});
      return;
    }
    callbacks.delete(Number(m![1]));
    if (entry.kind === 'approve') {
      const approved = !entry.callId.startsWith('!');
      host.approveTool(entry.sessionId, entry.callId.replace(/^!/, ''), approved);
      void tg.answerCallbackQuery(cb.id, approved ? 'Approved' : 'Denied').catch(() => {});
      if (cb.message?.message_id) {
        void tg.editMessageText(chatId, cb.message.message_id, `${cb.message.text ?? 'Approval'}: ${approved ? 'approved' : 'denied'} from Telegram.`).catch(() => {});
      }
    } else {
      host.answerQuestion(entry.sessionId, entry.callId, [{ questionId: entry.questionId ?? '', labels: entry.label ? [entry.label] : [] }]);
      pendingQuestions.delete(entry.sessionId);
      void tg.answerCallbackQuery(cb.id, entry.label).catch(() => {});
    }
  };

  const poll = async () => {
    while (!stopped && tg) {
      try {
        const updates = await tg.getUpdates(state.offset, POLL_TIMEOUT_SEC);
        for (const u of updates) onUpdate(u);
        if (updates.length) persist();
        lastError = undefined;
      } catch (err) {
        lastError = (err as Error).message;
        await new Promise((r) => setTimeout(r, ERROR_BACKOFF_MS));
      }
    }
    polling = false;
  };

  const teardown = () => {
    stopped = true;
    tg = null;
    activeToken = undefined;
    botUsername = undefined;
    if (subscribed) {
      host.events.off('agentEvent', onEvent);
      subscribed = false;
    }
    for (const out of outbound.values()) if (out.timer) clearTimeout(out.timer);
    outbound.clear();
    pendingQuestions.clear();
  };

  return {
    update(settings) {
      const cfg = settings?.telegram;
      if (!cfg?.enabled || !cfg.botToken) {
        teardown();
        return;
      }
      if (tg && activeToken === cfg.botToken) return;
      if (!tg) {
        stopped = false;
        if (!subscribed) {
          host.events.on('agentEvent', onEvent);
          subscribed = true;
        }
      }
      activeToken = cfg.botToken;
      tg = apiFactory(cfg.botToken);
      botUsername = undefined;
      const client = tg;
      void client
        .getMe()
        .then((me) => {
          if (tg === client) {
            botUsername = me.username;
            lastError = undefined;
          }
        })
        .catch((e) => {
          if (tg === client) lastError = (e as Error).message;
        });
      if (!polling) {
        polling = true;
        void poll();
      }
    },
    status() {
      return {
        telegram: tg
          ? { running: !stopped, botUsername, lastError, boundChats: Object.keys(state.bindings).length }
          : undefined,
      };
    },
    stop: teardown,
  };
}
