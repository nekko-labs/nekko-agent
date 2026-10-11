import { cacheUsage } from './prompt-caching.js';
import { withToolImages } from './tool-images.js';
import type { ModelInfo, ProviderConfig, ToolCall } from '@nekko-agent/shared';
import { effectiveEffort } from '@nekko-agent/shared';
import type { Provider, ChatRequest, ProviderChunk } from './types.js';
import { randomUUID } from 'node:crypto';
import { parseSSE } from './sse.js';
import { httpError } from './errors.js';
import { DecodeClock } from './decode-clock.js';

/**
 * Last-known subscription model set, used only when the live catalog cannot be
 * fetched (offline, unsigned, backend down). The Codex backend retired the
 * gpt-5/codex ids in 2026, so this mirrors the current picker generation.
 */
const CHATGPT_MODELS: Array<{ id: string; name: string; ctx?: number }> = [
  { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' },
  { id: 'gpt-6-sol', name: 'GPT-6 Sol' },
  { id: 'gpt-6-luna', name: 'GPT-6 Luna' },
  { id: 'gpt-6-astra', name: 'GPT-6 Astra' },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', ctx: 272000 },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', ctx: 272000 },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', ctx: 272000 },
];

/**
 * The Codex backend filters its model catalog by the Codex CLI version a client
 * reports — unversioned and stale versions get a truncated or empty list. This
 * pins a recent CLI release; raise it when the backend starts gating newer
 * entries behind a higher line.
 */
const CODEX_CLIENT_VERSION = '0.160.0';

/**
 * The Codex backend requires this beta header for Responses-API streaming and
 * a `chatgpt-account-id` header identifying the signed-in ChatGPT account.
 * `originator` matches what the first-party Codex CLI sends; `session_id`
 * scopes a conversation for the backend's caching/telemetry.
 */
const RESPONSES_BETA = 'responses=experimental';
const ORIGINATOR = 'codex_cli_rs';

const MISSING_ACCOUNT_ID =
  'This ChatGPT sign-in is missing an account id. Sign out and sign in again so it can be captured (sessions signed in before this version may lack one).';

/**
 * Client for the ChatGPT/Codex subscription endpoint: the Responses API over
 * SSE at `{baseUrl}/codex/responses`. Only usable with a subscription token —
 * the host injects the fresh OAuth access token into config.apiKey and the
 * ChatGPT account id into config.accountId.
 */
export class ChatGptProvider implements Provider {
  /** One session id per provider instance (≈ one agent run). */
  private readonly sessionId = randomUUID();

  constructor(public readonly config: ProviderConfig) {}

  private base(): string {
    return this.config.baseUrl.trim().replace(/\/+$/, '');
  }

  /**
   * Throws when the account id is absent: the backend 401s without it, and a
   * clear sign-in-again error beats a cryptic upstream rejection.
   */
  private headers(): Record<string, string> {
    if (!this.config.accountId) throw new Error(MISSING_ACCOUNT_ID);
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.config.apiKey ?? ''}`,
      'chatgpt-account-id': this.config.accountId,
      'OpenAI-Beta': RESPONSES_BETA,
      originator: ORIGINATOR,
      session_id: this.sessionId,
    };
  }

  /**
   * Headers for the catalog GET: same subscription auth as chat, but no
   * `OpenAI-Beta`/`session_id`, which are Responses-API concerns.
   */
  private catalogHeaders(): Record<string, string> {
    if (!this.config.accountId) throw new Error(MISSING_ACCOUNT_ID);
    return {
      Accept: 'application/json',
      Authorization: `Bearer ${this.config.apiKey ?? ''}`,
      'chatgpt-account-id': this.config.accountId,
      originator: ORIGINATOR,
    };
  }

  /**
   * The live subscription catalog: `GET {base}/codex/models`, the same route
   * the Codex CLI's models manager reads. The backend filters it by the
   * `client_version` we report, the account's plan, and active rollouts, so
   * the answer is exactly the set this sign-in can run — including models that
   * did not exist when this build shipped. Returns null on any failure so the
   * caller can fall back to the curated list.
   */
  private async fetchCatalog(): Promise<ModelInfo[] | null> {
    if (!this.config.apiKey || !this.config.accountId) return null;
    const url = `${this.base()}/codex/models?client_version=${CODEX_CLIENT_VERSION}`;
    let res: Response;
    try {
      // Falls back to the curated list, so a slow catalog costs seconds, not the picker.
      res = await fetch(url, { headers: this.catalogHeaders(), signal: AbortSignal.timeout(8000) });
    } catch {
      return null;
    }
    if (!res.ok) return null;
    const json: any = await res.json().catch(() => null);
    const rows: any[] = Array.isArray(json?.models) ? json.models : [];
    const models = rows.flatMap((m, order): { model: ModelInfo; priority: number; order: number }[] => {
      const id = typeof m?.slug === 'string' && m.slug ? m.slug : typeof m?.id === 'string' ? m.id : '';
      if (!id) return [];
      // The picker list is authoritative for what this account may run;
      // hidden or unpicked entries stay out of ours.
      if (typeof m.visibility === 'string' && m.visibility !== 'list') return [];
      if (m.show_in_picker === false) return [];
      const ctx = m.context_window ?? m.max_context_window;
      const name =
        typeof m.display_name === 'string' && m.display_name
          ? m.display_name
          : typeof m.name === 'string' && m.name
            ? m.name
            : id;
      return [
        {
          model: { id, providerId: this.config.id, name, contextLength: typeof ctx === 'number' && ctx > 0 ? ctx : undefined },
          priority: typeof m.priority === 'number' ? m.priority : Number.MAX_SAFE_INTEGER,
          order,
        },
      ];
    });
    models.sort((a, b) => a.priority - b.priority || a.order - b.order);
    return models.length ? models.map((m) => m.model) : null;
  }

  async listModels(): Promise<ModelInfo[]> {
    const all: ModelInfo[] =
      (await this.fetchCatalog()) ??
      CHATGPT_MODELS.map((m) => ({
        id: m.id,
        providerId: this.config.id,
        name: m.name,
        contextLength: m.ctx,
      }));
    const custom = this.config.customModelId?.trim();
    if (custom && !all.some((m) => m.id === custom)) {
      all.push({
        id: custom,
        providerId: this.config.id,
        name: `${custom} (custom)`,
        // An arbitrary custom id has no known window; do not invent 128k.
      });
    }
    return all;
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    if (!this.config.apiKey) {
      return { ok: false, message: 'Not signed in. Sign in with ChatGPT in the provider settings.' };
    }
    if (!this.config.accountId) {
      return { ok: false, message: MISSING_ACCOUNT_ID };
    }
    // A real check, not just "a token exists": the catalog route is the same
    // auth + account the Responses calls need, and its failure is the message
    // worth showing.
    const url = `${this.base()}/codex/models?client_version=${CODEX_CLIENT_VERSION}`;
    let res: Response;
    try {
      res = await fetch(url, { headers: this.catalogHeaders() });
    } catch (e) {
      return { ok: false, message: friendlyError(e, this.base()) };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, message: `chatgpt ${res.status}: ${text.slice(0, 200)}` };
    }
    return { ok: true, message: 'Signed in with a ChatGPT subscription' };
  }

  async *chat(req: ChatRequest): AsyncIterable<ProviderChunk> {
    const body: Record<string, unknown> = {
      model: req.model,
      instructions: req.system,
      input: toResponseItems(req),
      tools: req.tools?.map((t) => ({
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
      stream: true,
      store: false,
    };
    // The Codex backend accepts only the Codex CLI's request shape: `temperature`
    // and `max_output_tokens` are not in it and fail the whole request with a
    // 400 ("Unsupported parameter"), so the effort setting goes out as
    // `reasoning.effort` instead and this provider sends no output cap.
    // `normal` means the model's own default, so no rung is sent for it.
    const reasoning: Record<string, unknown> = {};
    const effort = effectiveEffort(req.effort, req.model);
    if (effort === 'low' || effort === 'medium') reasoning.effort = effort;
    else if (effort !== 'normal') reasoning.effort = 'high';
    if (req.think === true) reasoning.summary = 'auto';
    if (Object.keys(reasoning).length) body.reasoning = reasoning;

    let res: Response;
    try {
      res = await fetch(`${this.base()}/codex/responses`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (e) {
      // The account-id guard above throws the friendly error; only real fetch
      // failures land here.
      throw new Error(friendlyError(e, this.base()));
    }
    req.onHeaders?.(res.headers);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw httpError(`chatgpt ${res.status}: ${text.slice(0, 200)}`, res);
    }

    // Times the decode phase for the tok/s figure: from the first generated
    // delta to the `response.completed` event that reports usage.
    const decode = new DecodeClock();

    for await (const data of parseSSE(res)) {
      let ev: any;
      try {
        ev = JSON.parse(data);
      } catch {
        continue;
      }
      switch (ev.type) {
        case 'response.output_text.delta':
          if (ev.delta) {
            decode.mark();
            yield { type: 'text', delta: ev.delta as string };
          }
          break;
        case 'response.reasoning_summary_text.delta':
          if (ev.delta) {
            decode.mark();
            yield { type: 'reasoning', delta: ev.delta as string };
          }
          break;
        case 'response.output_item.done': {
          const item = ev.item;
          if (item?.type === 'message' && (item.phase === 'commentary' || item.phase === 'final_answer')) {
            yield { type: 'phase', phase: item.phase };
          }
          if (item?.type === 'function_call') {
            decode.mark();
            const call: ToolCall = {
              id: item.call_id ?? item.id,
              name: item.name,
              input: safeParse(item.arguments),
            };
            yield { type: 'tool_call', call };
          }
          break;
        }
        case 'response.completed': {
          decode.stop();
          const usage = ev.response?.usage;
          if (usage) {
            yield {
              type: 'usage',
              ...cacheUsage(usage, 'input_tokens'),
              outputTokens: usage.output_tokens ?? 0,
              outputMs: decode.elapsed(),
            };
          }
          yield { type: 'done' };
          return;
        }
        case 'response.incomplete': {
          // Hit the output cap (or another length stop): keep what streamed.
          decode.stop();
          const usage = ev.response?.usage;
          if (usage) {
            yield {
              type: 'usage',
              ...cacheUsage(usage, 'input_tokens'),
              outputTokens: usage.output_tokens ?? 0,
              outputMs: decode.elapsed(),
            };
          }
          yield { type: 'done' };
          return;
        }
        case 'response.failed':
        case 'error':
          throw new Error(
            `chatgpt response failed: ${
              ev.response?.error?.message ?? ev.error?.message ?? ev.message ?? 'unknown error'
            }`,
          );
        default:
          break;
      }
    }
    yield { type: 'done' };
  }
}

/** Map normalized chat history onto Responses API input items. */
function toResponseItems(req: ChatRequest) {
  const out: any[] = [];
  for (const m of withToolImages(req.messages)) {
    if (m.role === 'tool' && m.toolResult) {
      out.push({
        type: 'function_call_output',
        call_id: m.toolResult.toolCallId,
        output: m.toolResult.output,
      });
    } else if (m.role === 'assistant') {
      if (m.content) {
        out.push({
          type: 'message',
          role: 'assistant',
          phase: m.phase ?? (m.toolCalls?.length ? 'commentary' : 'final_answer'),
          content: [{ type: 'output_text', text: m.content }],
        });
      }
      for (const c of m.toolCalls ?? []) {
        out.push({
          type: 'function_call',
          call_id: c.id,
          name: c.name,
          arguments: JSON.stringify(c.input),
        });
      }
    } else if (m.role === 'user') {
      const content: any[] = [{ type: 'input_text', text: m.content }];
      for (const url of m.images ?? []) {
        content.push({ type: 'input_image', image_url: url });
      }
      out.push({ type: 'message', role: 'user', content });
    }
    // role 'system' in history is covered by req.system -> instructions.
  }
  return out;
}

function safeParse(s: string | undefined): Record<string, unknown> {
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    return {};
  }
}

/** Turn low-level fetch failures into actionable guidance. */
function friendlyError(e: unknown, url: string): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/abort/i.test(msg)) return 'Request cancelled.';
  if (/ECONNREFUSED|fetch failed|Failed to fetch|ENOTFOUND|ETIMEDOUT|network/i.test(msg)) {
    return `Can't reach ChatGPT at ${url}. Check the network connection.`;
  }
  return msg;
}
