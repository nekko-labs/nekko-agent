import { cacheUsage, geminiCachePrefix, geminiExplicitCacheModel, type CacheCapableProviderConfig } from './prompt-caching.js';
import { withToolImages } from './tool-images.js';
import type { ModelInfo, ProviderConfig, ToolCall } from '@nekko-agent/shared';
import { effectiveEffort } from '@nekko-agent/shared';
import type { Provider, ChatRequest, ProviderChunk, ToolSpec } from './types.js';
import { parseSSE } from './sse.js';
import { httpError } from './errors.js';
import { DecodeClock } from './decode-clock.js';

/** A model list that has not answered in this long is from a server that is not there. */
export const LIST_TIMEOUT_MS = 5000;

/**
 * Client for any OpenAI-compatible /chat/completions endpoint. Covers OpenAI,
 * OpenRouter, LM Studio, vLLM, and generic openai-compat servers, they only
 * differ in base URL and auth header, which come from the ProviderConfig.
 */
export class OpenAICompatProvider implements Provider {
  constructor(public readonly config: CacheCapableProviderConfig) {}

  /**
   * Normalized API base. LM Studio / vLLM / generic servers expose the OpenAI
   * routes under `/v1`, but users often paste just `http://host:port`. If the
   * configured URL has no path (or a bare `/`), append `/v1` so `/models` and
   * `/chat/completions` resolve. URLs that already include a path are left alone.
   */
  private base(): string {
    let url = this.config.baseUrl.trim().replace(/\/+$/, '');
    try {
      const u = new URL(url);
      if (u.pathname === '' || u.pathname === '/') url = `${url}/v1`;
    } catch {
      /* leave as-is if it isn't a parseable URL */
    }
    return url;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) h['Authorization'] = `Bearer ${this.config.apiKey}`;
    if (this.config.kind === 'openrouter') {
      h['HTTP-Referer'] = 'https://github.com/nekko-labs/nekko-agent';
      h['X-Title'] = 'Nekko Agent';
    }
    return h;
  }

  async listModels(): Promise<ModelInfo[]> {
    // A model list is metadata: a machine that is off (a LAN box, a VPN peer)
    // should read as unreachable in seconds, not hold the picker for the OS
    // connect timeout.
    // LM Studio's native REST API (/api/v0/models) reports per-model load state,
    // which the OpenAI-compatible /v1/models route does not. Prefer it for LM
    // Studio so the Models page can show what's loaded; fall back to /v1/models.
    if (this.config.kind === 'lmstudio') {
      const lm = await this.lmStudioModels().catch(() => null);
      if (lm) return lm;
    }
    const res = await fetch(`${this.base()}/models`, { headers: this.headers(), signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`listModels ${res.status}: ${extractApiError(await res.text().catch(() => ''))}`);
    const json = (await res.json()) as {
      data?: Array<{
        id: string;
        name?: string;
        context_length?: number;
        top_provider?: { context_length?: number };
        pricing?: { prompt?: string; completion?: string };
        supported_parameters?: string[];
        /** The Nekko engine's extras: where the file lives and its load state. */
        max_context_length?: number;
        path?: string;
        location?: string;
        state?: string;
      }>;
    };
    const openrouter = this.config.kind === 'openrouter';
    return (json.data ?? []).map((m) => {
      const input = Number(m.pricing?.prompt);
      const output = Number(m.pricing?.completion);
      const priced = openrouter && Number.isFinite(input) && Number.isFinite(output);
      const details: Record<string, string> = {
        ...(openrouter && m.supported_parameters?.includes('tools') ? { tools: 'yes' } : {}),
        // The Nekko engine sends the file path and the folder it lives in, so
        // pickers can lead with the name and group by where the model lives.
        ...(typeof m.path === 'string' ? { path: m.path } : {}),
        ...(typeof m.location === 'string' ? { location: m.location } : {}),
      };
      return {
        id: m.id,
        providerId: this.config.id,
        // A display name only from the servers that send a meaningful one:
        // OpenRouter's "OpenAI: GPT-5" and the local engines' friendly model
        // names. OpenAI's own list carries none, so a stray field there stays
        // the id it always was.
        name: serverNamesModels(this.config.kind) && m.name ? m.name : m.id,
        contextLength: m.context_length ?? m.top_provider?.context_length ?? m.max_context_length,
        ...(priced ? { inputPricePerM: input * 1e6, outputPricePerM: output * 1e6 } : {}),
        ...(Object.keys(details).length ? { details } : {}),
        // vLLM serves exactly the model(s) it was launched with — always
        // resident. The engine reports residency per row instead.
        ...(this.config.kind === 'vllm'
          ? { loaded: true }
          : m.state === 'loaded' || m.state === 'not-loaded'
            ? { loaded: m.state === 'loaded' }
            : {}),
      };
    });
  }

  /** LM Studio native model list with load state (`/api/v0/models`). */
  private async lmStudioModels(): Promise<ModelInfo[]> {
    const root = this.base().replace(/\/v1$/, '');
    const res = await fetch(`${root}/api/v0/models`, { headers: this.headers(), signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`lmstudio models ${res.status}`);
    const json = (await res.json()) as {
      data?: Array<{ id: string; state?: string; loaded_context_length?: number; max_context_length?: number }>;
    };
    return (json.data ?? []).map((m) => ({
      id: m.id,
      providerId: this.config.id,
      name: m.id,
      contextLength: m.loaded_context_length ?? m.max_context_length,
      loaded: m.state === 'loaded',
    }));
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      // OpenRouter's /key endpoint answers with the key's label and remaining
      // credits — a real auth check, unlike /models which is public there.
      if (this.config.kind === 'openrouter') {
        if (!this.config.apiKey) return { ok: false, message: 'Paste an API key or sign in with OpenRouter first.' };
        const res = await fetch(`${this.base()}/key`, { headers: this.headers() });
        if (res.status === 401 || res.status === 403) {
          return { ok: false, message: 'OpenRouter rejected this key — check it or regenerate it.' };
        }
        if (!res.ok) return { ok: false, message: `OpenRouter answered HTTP ${res.status}.` };
        const json = (await res.json().catch(() => null)) as {
          data?: { limit_remaining?: number | null; limit?: number | null; usage?: number };
        } | null;
        const d = json?.data;
        const remaining = d?.limit_remaining ?? (d?.limit != null && d?.usage != null ? d.limit - d.usage : null);
        return {
          ok: true,
          message: `Connected${remaining != null ? ` — $${Math.max(0, remaining).toFixed(2)} left` : ' — unlimited'}`,
        };
      }
      const res = await fetch(`${this.base()}/models`, { headers: this.headers() });
      if (res.ok) return { ok: true, message: 'Connected' };
      const detail = extractApiError(await res.text().catch(() => ''));
      return {
        ok: false,
        message: `HTTP ${res.status}${res.status === 401 ? ', check your API key' : ''}${detail ? `: ${detail}` : ''}`,
      };
    } catch (e) {
      return { ok: false, message: friendlyError(e, this.base()) };
    }
  }

  async *chat(req: ChatRequest): AsyncIterable<ProviderChunk> {
    // Reasoning toggle: local servers (LM Studio / vLLM / generic) accept
    // `chat_template_kwargs.enable_thinking` (Qwen3 and friends). Only sent to
    // local kinds — cloud endpoints reject unknown body fields.
    const localKind =
      this.config.kind === 'lmstudio' ||
      this.config.kind === 'vllm' ||
      this.config.kind === 'llamacpp' ||
      this.config.kind === 'openai-compat';
    // OpenAI's reasoning families (o-series, gpt-5 and newer, codex, gpt-oss)
    // refuse `temperature` and `max_tokens` outright, so the request leaves
    // without them rather than retrying after a 400. On OpenRouter the rung
    // rides the normalized `reasoning.effort` field.
    const effortField = effortKnob(this.config.kind, req.model);
    const learned = learnedParams(this.config.id, req.model);
    const buildBody = (): Record<string, unknown> => {
      const body: Record<string, unknown> = {
        model: req.model,
        stream: true,
        stream_options: { include_usage: true },
        ...(this.config.kind === 'llamacpp' && this.config.managedCachePrompt === true ? { cache_prompt: req.promptCaching !== false } : {}),
        // OpenRouter Claude requires an opt-in directive, unlike implicit OpenAI caching.
        ...(this.config.kind === 'openrouter' && /^~?anthropic\/claude-.+/.test(req.model) && req.promptCaching !== false
          ? { cache_control: { type: 'ephemeral' } } : {}),
        ...(effortField ? {} : { temperature: req.temperature ?? 0.7 }),
        // Output cap: without it a looping local model streams until its
        // context window fills. `max_tokens` is honoured by every
        // openai-compat server we target; on the OpenAI API reasoning models
        // take `max_completion_tokens` instead.
        ...(req.maxOutputTokens
          ? { [effortField === 'reasoning_effort' ? 'max_completion_tokens' : 'max_tokens']: req.maxOutputTokens }
          : {}),
        messages: this.toOpenAIMessages(req),
        tools: req.tools?.map(toOpenAITool),
        ...(req.think !== undefined && localKind ? { chat_template_kwargs: { enable_thinking: req.think } } : {}),
      };
      const rung = effortField ? openAiEffort(req) : null;
      if (effortField === 'reasoning_effort' && rung) body.reasoning_effort = rung;
      if (effortField === 'reasoning' && rung) body.reasoning = { effort: rung };
      if (this.config.kind === 'openrouter' && geminiExplicitCacheModel(req.model) && req.promptCaching !== false) geminiCachePrefix(body);
      applyLearned(body, learned);
      return body;
    };

    // A validator that still refuses the shape gets its way: drop or rename
    // the blamed field and send again, once per rejection, then remember it.
    let res: Response | undefined;
    let lastError = '';
    for (let attempt = 0; attempt < 5; attempt++) {
      const body = buildBody();
      try {
        res = await fetch(`${this.base()}/chat/completions`, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(body),
          signal: req.signal,
        });
      } catch (e) {
        throw new Error(friendlyError(e, this.base()));
      }
      if (res.ok) break;
      const text = await res.text().catch(() => '');
      lastError = text;
      const blame = attempt < 4 ? blamedParam(res.status, text, body) : null;
      if (!blame) {
        // OpenAI-style bodies carry { error: { message } } — surface that message
        // instead of raw JSON so 401/402/429 replies read like sentences.
        throw httpError(`Model request failed (HTTP ${res.status})${text ? `: ${extractApiError(text)}` : ''}`, res);
      }
      learned.set(blame.field, blame.renameTo ?? null);
      res = undefined;
    }
    if (!res) {
      throw new Error(`Model request failed (HTTP 400)${lastError ? `: ${extractApiError(lastError)}` : ''}`);
    }

    // Accumulate streamed tool-call fragments by index.
    const toolAcc = new Map<number, { id: string; name: string; args: string }>();
    // Times the decode phase for the tok/s figure. `include_usage` puts the usage
    // chunk after the last content chunk, so the clock covers exactly the span in
    // which the tokens it reports were generated.
    const decode = new DecodeClock();

    for await (const data of parseSSE(res)) {
      let chunk: any;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      if (chunk.error) throw new Error(`Model stream failed: ${extractApiError(JSON.stringify(chunk))}`);
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      // Reasoning models (e.g. Gemma/DeepSeek on LM Studio) stream their chain
      // of thought as `reasoning_content` (or `reasoning`) before the answer.
      const reasoning = delta?.reasoning_content ?? delta?.reasoning;
      if (reasoning) {
        decode.mark();
        yield { type: 'reasoning', delta: reasoning as string };
      }
      if (delta?.content) {
        decode.mark();
        yield { type: 'text', delta: delta.content as string };
      }
      if (delta?.tool_calls) {
        // Tool arguments are generated tokens too, so a response that only calls
        // a tool still has a decode rate to report.
        decode.mark();
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const cur = toolAcc.get(idx) ?? { id: tc.id ?? `call_${idx}`, name: '', args: '' };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          toolAcc.set(idx, cur);
        }
      }
      if (chunk.usage) {
        decode.stop();
        yield {
          type: 'usage',
          ...cacheUsage(chunk.usage, 'prompt_tokens'),
          outputTokens: chunk.usage.completion_tokens ?? 0,
          outputMs: decode.elapsed(),
        };
      }
      if (choice?.finish_reason) {
        for (const acc of toolAcc.values()) {
          const call: ToolCall = {
            id: acc.id,
            name: acc.name,
            input: safeParse(acc.args),
          };
          yield { type: 'tool_call', call };
        }
        toolAcc.clear();
      }
    }
    yield { type: 'done' };
  }

  private toOpenAIMessages(req: ChatRequest) {
    const out: any[] = [];
    if (req.system) out.push({ role: 'system', content: req.system });
    for (const m of withToolImages(req.messages)) {
      if (m.role === 'tool' && m.toolResult) {
        out.push({ role: 'tool', tool_call_id: m.toolResult.toolCallId, content: m.toolResult.output });
      } else if (m.role === 'assistant' && m.toolCalls?.length) {
        out.push({
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.toolCalls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.input) },
          })),
        });
      } else {
        out.push({
          role: m.role,
          content: m.role === 'user' && m.images?.length
            ? [
                { type: 'text', text: m.content },
                ...m.images.map((url) => ({ type: 'image_url', image_url: { url } })),
              ]
            : m.content,
        });
      }
    }
    return out;
  }
}

/** Kinds whose /models rows carry a display name worth showing. */
function serverNamesModels(kind: ProviderConfig['kind']): boolean {
  return (
    kind === 'openrouter' ||
    kind === 'llamacpp' ||
    kind === 'openai-compat' ||
    kind === 'lmstudio' ||
    kind === 'vllm'
  );
}

function toOpenAITool(t: ToolSpec) {
  return { type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } };
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    return {};
  }
}

/** Pull a readable message out of an API error body, or truncate raw text. */
function extractApiError(text: string): string {
  const parsed = safeParse(text);
  const msg = (parsed.error as { message?: unknown } | undefined)?.message;
  return typeof msg === 'string' ? msg : text.slice(0, 200);
}

/** Turn low-level fetch failures into actionable guidance. */
export function friendlyError(e: unknown, url: string): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/abort/i.test(msg)) return 'Request cancelled.';
  if (/ECONNREFUSED|fetch failed|Failed to fetch|ENOTFOUND|ETIMEDOUT|network/i.test(msg)) {
    return `Can't reach the model server at ${url}. Is it running and reachable on the network?`;
  }
  return msg;
}

/**
 * OpenAI's reasoning generation: o-series, gpt-5 and newer, codex, gpt-oss.
 * These ids reject the sampling fields on api.openai.com, and OpenRouter
 * proxies the same rejection for the ids it fronts.
 */
const OPENAI_REASONING_RE = /(?:^|[-_/ .])(?:o\d+|gpt-?(?:[5-9]|\d{2,})|gpt-oss|codex)/i;

/** The body field that carries the effort rung for this provider and model. */
function effortKnob(kind: ProviderConfig['kind'], model: string): 'reasoning_effort' | 'reasoning' | null {
  if (!OPENAI_REASONING_RE.test(model)) return null;
  if (kind === 'openai') return 'reasoning_effort';
  if (kind === 'openrouter') return 'reasoning';
  return null;
}

/** The rung as OpenAI's ladder speaks it; `normal` leaves the model's default. */
function openAiEffort(req: ChatRequest): string | null {
  switch (effectiveEffort(req.effort, req.model)) {
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'normal':
      return null;
    default:
      return 'high';
  }
}

/**
 * Body fields a server has refused, per provider and model: the field to its
 * replacement, or null when it was dropped. A rejection is information: the
 * request goes out again without the blamed field (or carrying the one the
 * server asked for instead), and the adjustment sticks for every later
 * request to that model. The same contract the Anthropic provider keeps for
 * sampling shapes, covering every OpenAI-compatible server whose validator is
 * stricter than the wire format suggests.
 */
const LEARNED_PARAMS = new Map<string, Map<string, string | null>>();

/** Test seam: the golden tests replay cases in order, each starting clean. */
export function resetLearnedParams(): void {
  LEARNED_PARAMS.clear();
}

function learnedParams(providerId: string, model: string): Map<string, string | null> {
  const key = `${providerId}:${model}`;
  let m = LEARNED_PARAMS.get(key);
  if (!m) LEARNED_PARAMS.set(key, (m = new Map()));
  return m;
}

/**
 * Optional body fields a request can survive losing. `model`, `messages` and
 * `stream` are never dropped: a server that refuses those cannot serve the
 * request at all, and its error belongs on screen.
 */
const DROPPABLE = new Set([
  'temperature',
  'top_p',
  'top_k',
  'presence_penalty',
  'frequency_penalty',
  'max_tokens',
  'max_completion_tokens',
  'reasoning_effort',
  'reasoning',
  'stream_options',
  'chat_template_kwargs',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'logit_bias',
  'seed',
  'stop',
  'store',
  'n',
  'logprobs',
  'top_logprobs',
  'response_format',
  'user',
  'metadata',
]);

/** How close a rejection word must sit to a field name to blame it. */
const NEAR = 80;
const REJECT_WORDS = [
  'unsupported',
  'not supported',
  'does not support',
  'unexpected',
  'unknown',
  'unrecogni',
  'extra',
  'is not allowed',
  'deprecated',
];

function isWordChar(c: string | undefined): boolean {
  return c !== undefined && /[a-z0-9_]/.test(c);
}

/**
 * The body field a rejection blames, plus the field it suggests instead. An
 * explicit name (`error.param`) that lands on a required field ends the
 * search: there is nothing to adjust. The looser near-match only ever returns
 * droppable fields, so "for this model" cannot blame `model`.
 */
function blamedParam(
  status: number,
  text: string,
  body: Record<string, unknown>,
): { field: string; renameTo?: string } | null {
  if (status !== 400 && status !== 422) return null;
  const named = namedParam(text, body);
  if (named && !DROPPABLE.has(named)) return null;
  const field = named ?? nearRejection(text, body);
  if (!field) return null;
  const rename = replacementParam(text, field);
  return rename ? { field, renameTo: rename } : { field };
}

/**
 * The field the error body names explicitly: OpenAI's `error.param`, a bare
 * `param`, or a FastAPI `detail[].loc[]` entry ("extra fields not permitted").
 */
function namedParam(text: string, body: Record<string, unknown>): string | null {
  const parsed = safeParse(text);
  for (const v of [(parsed.error as { param?: unknown } | undefined)?.param, parsed.param]) {
    if (typeof v === 'string' && v in body) return v;
  }
  const detail = parsed.detail;
  if (Array.isArray(detail)) {
    for (const d of detail) {
      const loc = (d as { loc?: unknown }).loc;
      if (!Array.isArray(loc)) continue;
      for (const l of loc) {
        if (typeof l === 'string' && l in body) return l;
      }
    }
  }
  return null;
}

/**
 * The sent field whose name appears within `NEAR` chars of a rejection word,
 * in either order ("Unsupported parameter: temperature", "'max_tokens' is not
 * supported"). Word-bounded, so `tool` inside `tool_calls` never counts.
 */
function nearRejection(text: string, body: Record<string, unknown>): string | null {
  const t = text.toLowerCase();
  for (const key of Object.keys(body)) {
    if (!DROPPABLE.has(key)) continue;
    let at = 0;
    for (;;) {
      const i = t.indexOf(key, at);
      if (i < 0) break;
      at = i + 1;
      if (isWordChar(t[i - 1]) || isWordChar(t[i + key.length])) continue;
      const before = t.slice(Math.max(0, i - NEAR), i);
      const after = t.slice(i + key.length, i + key.length + NEAR);
      if (REJECT_WORDS.some((w) => before.includes(w) || after.includes(w))) return key;
    }
  }
  return null;
}

/** The field named in a "use X instead" hint, when it is one we may send. */
function replacementParam(text: string, field: string): string | undefined {
  const t = text.toLowerCase();
  let i = 0;
  for (;;) {
    const at = t.indexOf(' instead', i);
    if (at < 0) return undefined;
    i = at + 8;
    let end = at;
    while (end > 0 && /[\s"'`]/.test(t[end - 1])) end--;
    let start = end;
    while (start > 0 && isWordChar(t[start - 1])) start--;
    const word = t.slice(start, end);
    if (!word) continue;
    let q = start;
    while (q > 0 && /["'`]/.test(t[q - 1])) q--;
    const head = t.slice(0, q).trimEnd();
    if (!head.endsWith('use') || isWordChar(head[head.length - 4])) continue;
    if (word !== field && DROPPABLE.has(word)) return word;
  }
}

/** Apply the remembered adjustments: drop the field, or move its value. */
function applyLearned(body: Record<string, unknown>, learned: Map<string, string | null>): void {
  for (const [field, to] of learned) {
    if (!(field in body)) continue;
    if (to) body[to] = body[field];
    delete body[field];
  }
}
