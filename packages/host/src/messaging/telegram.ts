/**
 * Minimal Telegram Bot API client: only the methods a chat bridge needs.
 * Long-polling rather than webhooks, so a desktop or self-hosted install needs
 * no public URL and no inbound ports: the bot dials out, like the relay agent.
 */

export interface TelegramUser {
  id: number;
  username?: string;
}

export interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: TelegramUser;
  text?: string;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

interface ApiReply<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

/** Max body Telegram will accept in one message. */
export const TELEGRAM_MESSAGE_LIMIT = 4096;

/**
 * The first 4096 UTF-16 units, stopping before a character the cut would
 * split: half a surrogate pair is no character at all (`JSON.stringify` sends
 * it as a lone `\ud83d` escape). The daemon's port cuts the same way
 * (`nekko_js::slice16`), since a Rust string cannot hold half a character.
 */
export function cutForTelegram(text: string): string {
  const cut = text.slice(0, TELEGRAM_MESSAGE_LIMIT);
  const last = cut.charCodeAt(cut.length - 1);
  return cut.length === TELEGRAM_MESSAGE_LIMIT && last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

export class TelegramApi {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly apiRoot = 'https://api.telegram.org',
  ) {}

  private async call<T>(method: string, body?: Record<string, unknown>): Promise<T> {
    const res = await this.fetchImpl(`${this.apiRoot}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : '{}',
    });
    const data = (await res.json()) as ApiReply<T>;
    if (!data.ok) throw new Error(`telegram ${method}: ${data.description ?? res.status}`);
    return data.result as T;
  }

  getMe(): Promise<TelegramUser> {
    return this.call('getMe');
  }

  /** Long-poll: resolves with up to `limit` updates after `timeoutSec` seconds. */
  getUpdates(offset: number, timeoutSec = 25, limit = 50): Promise<TelegramUpdate[]> {
    return this.call('getUpdates', { offset, timeout: timeoutSec, limit });
  }

  sendMessage(chatId: number | string, text: string, keyboard?: InlineButton[][]): Promise<TelegramMessage> {
    return this.call('sendMessage', {
      chat_id: chatId,
      text: cutForTelegram(text),
      ...(keyboard?.length ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    });
  }

  /** Edits are best-effort: a stale or unchanged body is a 400 we can ignore. */
  async editMessageText(chatId: number | string, messageId: number, text: string): Promise<void> {
    try {
      await this.call('editMessageText', { chat_id: chatId, message_id: messageId, text: cutForTelegram(text) });
    } catch {
      /* message deleted or identical content */
    }
  }

  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    return this.call('answerCallbackQuery', { callback_query_id: callbackQueryId, ...(text ? { text } : {}) });
  }
}
