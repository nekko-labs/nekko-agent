import { anthropicCachePrefix, tokenCount } from './prompt-caching.js';
import { withToolImages } from './tool-images.js';
import type { ModelAvailability, ModelInfo, ProviderConfig, ToolCall } from '@nekko-agent/shared';
import { claudeContextWindow, claudeMaxOutputTokens, effectiveEffort, modelEffortLevels, parseClaudeModel } from '@nekko-agent/shared';
import type { Provider, ChatRequest, ProviderChunk } from './types.js';
import { parseSSE } from './sse.js';
import { httpError } from './errors.js';
import { DecodeClock } from './decode-clock.js';

/**
 * Known Claude models, served when `GET /v1/models` can't be reached.
 *
 * The whole catalog ships, including the previous generation, because a chat
 * pinned to `claude-opus-4-8` still needs a name for it and because "Opus 5 or
 * Opus 4.8?" is a choice worth offering rather than one to make silently. An
 * entry carries `availability` only when the catalog already knows the model
 * can't be served; live plan limits are layered on in the UI.
 */
const CLAUDE_MODELS: Array<{ id: string; name: string; availability?: ModelAvailability }> = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
  { id: 'claude-opus-5', name: 'Claude Opus 5' },
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1' },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
];

/**
 * Picker order by family, as the shipped list has it. The API lists newest
 * release first, which would put a new Haiku above Opus; the sort is stable,
 * so newest-first holds within each family. Ids that aren't a known family go
 * last.
 */
const FAMILY_ORDER = ['opus', 'sonnet', 'fable', 'mythos', 'haiku'];

/**
 * How long the catalog may take, body included, before the shipped list is
 * served instead. Opening a chat waits on this list, so a stalled connection
 * must not hold it for the transport's minutes-long idle limit.
 */
const CATALOG_TIMEOUT_MS = 5_000;

function familyRank(id: string): number {
  const family = parseClaudeModel(id)?.family;
  return family ? FAMILY_ORDER.indexOf(family) : FAMILY_ORDER.length;
}

/**
 * Subscription (OAuth) requests ride the Claude Code public client. The
 * endpoint requires this beta flag and validates that the first system block
 * is the Claude Code identity line, per the token's terms of use.
 */
const OAUTH_BETA = 'oauth-2025-04-20';
const CLAUDE_CODE_SYSTEM_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";

/**
 * Does this model reject the sampling parameters?
 *
 * Anthropic removed `temperature` / `top_p` / `top_k` from the 4.7 generation
 * onwards — sending one to Opus 5 fails the whole request with a 400 rather
 * than being ignored — and replaced them with the coarse `output_config.effort`
 * knob. The split is by version, not by a list of ids, so a model released
 * after this build still lands on the right side of it: 4.6 and older sample,
 * 4.7 and newer take an effort level. Fable and Mythos never sampled at all.
 *
 * Anything that doesn't parse as a Claude family model (a proxy's own naming, a
 * custom deployment id) keeps the old behaviour and gets a temperature.
 */
export function rejectsSampling(model: string): boolean {
  const id = normalizeModelId(model);
  // What the API itself told us, which outranks any guess we could make from
  // the name. See `learnSamplingShape`.
  const learned = LEARNED_SHAPE.get(id);
  if (learned !== undefined) return learned !== 'temperature';

  const m = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?/.exec(id);
  if (!m) return false;
  const [, family, majorRaw, minorRaw] = m;
  if (family === 'fable' || family === 'mythos') return true;
  const major = Number(majorRaw);
  const minor = Number(minorRaw ?? 0);
  return major > 4 || (major === 4 && minor >= 7);
}

/**
 * A model id as the version rule can read it.
 *
 * Gateways and proxies prefix the vendor (`anthropic/claude-opus-5`), and the
 * regex is anchored, so an unprefixed match would silently send a temperature to
 * a model that rejects it. Stripping the prefix costs nothing and closes the
 * most common way the rule gets fooled.
 */
function normalizeModelId(model: string): string {
  return model.toLowerCase().trim().replace(/^.*\//, '');
}

/**
 * Which knob a request carries. `neither` sends no sampling parameter at all
 * and lets the API pick, which is the only shape left when a model turns out to
 * reject both of the named ones.
 */
export type SamplingShape = 'temperature' | 'effort' | 'neither';

/**
 * What the API has told us about a model's sampling support, by id.
 *
 * The version rule above is a guess, and a guess about a model released after
 * this build is a guess that can be wrong. When it is wrong Anthropic answers
 * 400 and the user loses their turn, which is too high a price for a naming
 * heuristic. So a rejection is treated as information: the request is retried
 * the other way and the shape that *worked* is remembered, and every later
 * request for that model is right the first time.
 */
const LEARNED_SHAPE = new Map<string, SamplingShape>();

/** Remember the shape a request actually succeeded with. */
export function learnSamplingShape(model: string, shape: SamplingShape): void {
  LEARNED_SHAPE.set(normalizeModelId(model), shape);
}

export function learnSamplingSupport(model: string, rejects: boolean): void {
  learnSamplingShape(model, rejects ? 'effort' : 'temperature');
}

/** The shape to open with: what we learned, else what the version rule guesses. */
export function firstSamplingShape(model: string): SamplingShape {
  return LEARNED_SHAPE.get(normalizeModelId(model)) ?? (rejectsSampling(model) ? 'effort' : 'temperature');
}

/**
 * The next shape to try after `shape` was rejected, or null when every one has
 * been. `neither` is always last: it is the fallback that cannot be wrong, but
 * it also gives up the effort setting, so it is only reached once both named
 * knobs have actually failed.
 */
export function nextSamplingShape(shape: SamplingShape, tried: ReadonlySet<SamplingShape>): SamplingShape | null {
  const order: SamplingShape[] = shape === 'temperature' ? ['effort', 'neither'] : ['temperature', 'neither'];
  return order.find((s) => s !== shape && !tried.has(s)) ?? null;
}

/** Test seam: forget everything learned from the API. */
export function resetLearnedSampling(): void {
  LEARNED_SHAPE.clear();
  LEARNED_OUTPUT_LIMIT.clear();
}

/**
 * The output ceiling the API reported for a model, when our table was too
 * generous. `max_tokens` is required on every request, so a cloud chat with no
 * cap of its own is sent the model's known maximum; a model that holds less
 * answers 400 with the real figure, and that figure is kept for the rest of
 * the process so the next request is right the first time.
 */
const LEARNED_OUTPUT_LIMIT = new Map<string, number>();

export function learnOutputLimit(model: string, limit: number): void {
  LEARNED_OUTPUT_LIMIT.set(normalizeModelId(model), limit);
}

/**
 * The `max_tokens` to send: the request's own cap when it has one (local-model
 * safeguards never reach this provider, so that is a sideband call's explicit
 * budget), else the model's ceiling, never above what the API has told us.
 */
export function outputCapFor(model: string, requested: number | undefined): number {
  const ceiling = LEARNED_OUTPUT_LIMIT.get(normalizeModelId(model)) ?? claudeMaxOutputTokens(model);
  return requested && requested > 0 ? Math.min(requested, ceiling) : ceiling;
}

/**
 * The ceiling a 400 about `max_tokens` names, e.g. "max_tokens: 64000 > 32000,
 * which is the maximum allowed number of output tokens for claude-opus-4-1".
 * Null for any other error, including a `max_tokens` complaint with no figure.
 */
export function outputLimitError(status: number, body: string): number | null {
  if (status !== 400) return null;
  const m = /max_tokens[^.]*?>\s*(\d[\d,_]*)/i.exec(body);
  if (!m) return null;
  const limit = Number(m[1].replace(/[,_]/g, ''));
  return Number.isFinite(limit) && limit > 0 ? limit : null;
}

/**
 * Is this 400 about the sampling parameter we chose?
 *
 * Matched on the parameter name rather than on a fixed sentence, because the
 * wording is Anthropic's to change and the parameter names are the contract.
 * Anything else (a bad key, a too-long prompt) is a real failure and must not
 * be retried into a second identical error.
 */
export function isSamplingParamError(status: number, body: string): 'temperature' | 'effort' | null {
  if (status !== 400) return null;
  const text = body.toLowerCase();
  if (/`?(temperature|top_p|top_k)`?[^.]*\b(deprecat|unsupported|not supported|unexpected|remov)/.test(text)) {
    return 'temperature';
  }
  if (/`?(output_config|effort)`?[^.]*\b(unsupported|not supported|unexpected|invalid|unrecognized)/.test(text)) {
    return 'effort';
  }
  return null;
}

/**
 * The effort rung to send. The setting already speaks Anthropic's ladder;
 * `normal` resolves to the model's own default (`medium` on Opus 5.5, `high`
 * elsewhere), and a rung the model does not have is never sent: a model that
 * reached the effort shape only by retry (a 4.6 that rejected its temperature)
 * falls back to `high` rather than to a 400 on `xhigh`.
 */
function anthropicEffort(model: string, setting: ChatRequest['effort']): string {
  const level = effectiveEffort(setting, model);
  const ladder = modelEffortLevels(model);
  if (ladder.includes(level) && level !== 'normal') return level;
  return level === 'low' ? 'low' : 'high';
}

/** Client for the Anthropic Messages API (native, with SSE streaming). */
export class AnthropicProvider implements Provider {
  constructor(public readonly config: ProviderConfig) {}

  private headers(): Record<string, string> {
    // Subscription mode: the host injects a fresh OAuth access token into
    // config.apiKey, which goes out as a Bearer token, not an x-api-key.
    if (this.config.auth === 'subscription') {
      return {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey ?? ''}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': OAUTH_BETA,
      };
    }
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.config.apiKey ?? '',
      'anthropic-version': '2023-06-01',
    };
  }

  /**
   * Subscription tokens are only valid for requests that identify as Claude
   * Code, so the system prompt goes out as a block array with the required
   * prefix first; the app's real system prompt follows as a second block.
   */
  private systemParam(system: string | undefined) {
    if (this.config.auth !== 'subscription') return system;
    const blocks: Array<{ type: 'text'; text: string }> = [{ type: 'text', text: CLAUDE_CODE_SYSTEM_PREFIX }];
    if (system) blocks.push({ type: 'text', text: system });
    return blocks;
  }

  /**
   * The live catalog: `GET {base}/v1/models`, every model this key or
   * subscription can call, including ones released after this build. One page
   * of up to 1000 holds the whole list. Returns null on any failure, or after
   * CATALOG_TIMEOUT_MS, so the caller can fall back to the shipped list.
   */
  private async fetchCatalog(): Promise<ModelInfo[] | null> {
    if (!this.config.apiKey) return null;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), CATALOG_TIMEOUT_MS);
    let json: any;
    try {
      const res = await fetch(`${this.config.baseUrl}/v1/models?limit=1000`, { headers: this.headers(), signal: abort.signal });
      if (!res.ok) return null;
      json = await res.json().catch(() => null);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }

    const rows: any[] = Array.isArray(json?.data) ? json.data : [];
    const models = rows.flatMap((m): ModelInfo[] => {
      const id = typeof m?.id === 'string' ? m.id : '';
      if (!id) return [];
      const name = typeof m.display_name === 'string' && m.display_name ? m.display_name : id;
      const apiWindow = typeof m.max_input_tokens === 'number' && m.max_input_tokens > 0 ? m.max_input_tokens : undefined;
      return [{ id, providerId: this.config.id, name, contextLength: apiWindow ?? claudeContextWindow(id) ?? 200_000 }];
    });
    models.sort((a, b) => familyRank(a.id) - familyRank(b.id));
    return models.length ? models : null;
  }

  async listModels(): Promise<ModelInfo[]> {
    return (
      (await this.fetchCatalog()) ??
      CLAUDE_MODELS.map((m) => ({
        id: m.id,
        providerId: this.config.id,
        name: m.name,
        // 1M on everything current, 200k on Haiku 4.5: see model-capabilities.ts.
        contextLength: claudeContextWindow(m.id) ?? 200_000,
        ...(m.availability ? { availability: m.availability } : {}),
      }))
    );
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    if (this.config.auth === 'subscription') {
      return this.config.apiKey
        ? { ok: true, message: 'Signed in with a Claude subscription' }
        : { ok: false, message: 'Not signed in. Sign in with Claude in the provider settings.' };
    }
    if (!this.config.apiKey) return { ok: false, message: 'Missing API key' };
    return { ok: true, message: 'API key set' };
  }

  async *chat(req: ChatRequest): AsyncIterable<ProviderChunk> {
    const effort = anthropicEffort(req.model, req.effort);
    const knob = (shape: SamplingShape) =>
      shape === 'effort'
        ? { output_config: { effort } }
        : shape === 'temperature'
          ? { temperature: req.temperature ?? 0.7 }
          : {};
    const send = (shape: SamplingShape) =>
      fetch(`${this.config.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(anthropicCachePrefix({
          model: req.model,
          // Required here, so a chat with no cap of its own runs to the
          // model's ceiling (see outputCapFor); a 400 naming a lower one is
          // learned below and the request goes again.
          max_tokens: outputCapFor(req.model, req.maxOutputTokens),
          stream: true,
          ...knob(shape),
          system: this.systemParam(req.system),
          messages: this.toAnthropicMessages(req),
          tools: req.tools?.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
        }, req.promptCaching)),
        signal: req.signal,
      });

    // A 400 about the sampling parameter means our guess about this model was
    // wrong, not that the turn should fail. Work through the shapes until one
    // is accepted, then remember the one that worked.
    //
    // Both named knobs are tried before giving up, and a model that rejects
    // both still gets its turn with no sampling parameter at all. That last
    // rung is the difference between a model we have never seen answering and
    // the user reading "`temperature` is deprecated for this model" — which is
    // exactly what a single flip produced whenever the fallback was rejected
    // too.
    let shape = firstSamplingShape(req.model);
    const tried = new Set<SamplingShape>();
    let res: Response;
    for (;;) {
      tried.add(shape);
      res = await send(shape);
      if (res.ok) break;

      const text = await res.text().catch(() => '');
      // Our ceiling for this model was too high: the API names the real one.
      // Keep it and go again with the same shape.
      const limit = outputLimitError(res.status, text);
      if (limit && limit < outputCapFor(req.model, req.maxOutputTokens)) {
        learnOutputLimit(req.model, limit);
        continue;
      }
      const next = isSamplingParamError(res.status, text) ? nextSamplingShape(shape, tried) : null;
      if (!next) throw httpError(`anthropic ${res.status}: ${text.slice(0, 200)}`, res);
      shape = next;
    }
    learnSamplingShape(req.model, shape);
    req.onHeaders?.(res.headers);

    let curTool: { id: string; name: string; json: string } | null = null;
    let inputTokens = 0;
    let cacheReadTokens: number | undefined;
    let cacheWriteTokens: number | undefined;
    // Times the decode phase for the tok/s figure: from the first generated
    // token to the `message_delta` that reports the output count.
    const decode = new DecodeClock();

    for await (const data of parseSSE(res)) {
      let ev: any;
      try {
        ev = JSON.parse(data);
      } catch {
        continue;
      }
      switch (ev.type) {
        // A stream that has already been accepted can still fail, and it says so
        // in-band. Without this the turn simply stopped, mid-sentence, with no
        // reason given anywhere.
        case 'error':
          throw new Error(`anthropic stream error: ${ev.error?.message ?? 'unknown error'}`);
        case 'message_start':
          inputTokens = ev.message?.usage?.input_tokens ?? 0;
          cacheReadTokens = tokenCount(ev.message?.usage?.cache_read_input_tokens);
          cacheWriteTokens = tokenCount(ev.message?.usage?.cache_creation_input_tokens);
          break;
        case 'content_block_start':
          if (ev.content_block?.type === 'tool_use') {
            curTool = { id: ev.content_block.id, name: ev.content_block.name, json: '' };
          }
          break;
        case 'content_block_delta':
          // Tool arguments are generated tokens too, so they start the clock even
          // though they surface as one `tool_call` at the end of the block.
          decode.mark();
          if (ev.delta?.type === 'text_delta') {
            yield { type: 'text', delta: ev.delta.text as string };
          } else if (ev.delta?.type === 'input_json_delta' && curTool) {
            curTool.json += ev.delta.partial_json;
          }
          break;
        case 'content_block_stop':
          if (curTool) {
            const call: ToolCall = { id: curTool.id, name: curTool.name, input: safeParse(curTool.json) };
            yield { type: 'tool_call', call };
            curTool = null;
          }
          break;
        case 'message_delta':
          if (ev.usage?.output_tokens != null) {
            decode.stop();
            yield {
              type: 'usage',
              inputTokens,
              ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
              ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
              outputTokens: ev.usage.output_tokens,
              outputMs: decode.elapsed(),
            };
          }
          break;
        case 'message_stop':
          yield { type: 'done' };
          return;
      }
    }
    yield { type: 'done' };
  }

  private toAnthropicMessages(req: ChatRequest) {
    const out: any[] = [];
    // Two user turns in a row (tool results, then a message the user sent
    // while the tools ran) are one turn to the API.
    const push = (msg: any) => {
      const last = out[out.length - 1];
      if (last && last.role === 'user' && msg.role === 'user') {
        const blocks = (v: any) => (typeof v === 'string' ? [{ type: 'text', text: v }] : v);
        last.content = [...blocks(last.content), ...blocks(msg.content)];
        return;
      }
      out.push(msg);
    };
    for (const m of withToolImages(req.messages)) {
      if (m.role === 'tool' && m.toolResult) {
        push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: m.toolResult.toolCallId, content: m.toolResult.output }],
        });
      } else if (m.role === 'assistant' && m.toolCalls?.length) {
        const content: any[] = [];
        if (m.content) content.push({ type: 'text', text: m.content });
        for (const c of m.toolCalls) {
          content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input });
        }
        push({ role: 'assistant', content });
      } else if (m.role === 'user' || m.role === 'assistant') {
        push({
          role: m.role,
          content: m.role === 'user' && m.images?.length
            ? [
                { type: 'text', text: m.content },
                ...m.images.map((url) => {
                  const match = url.match(/^data:([^;]+);base64,(.+)$/);
                  return {
                    type: 'image',
                    source: {
                      type: 'base64',
                      media_type: match?.[1] ?? 'application/octet-stream',
                      data: match?.[2] ?? url,
                    },
                  };
                }),
              ]
            : m.content,
        });
      }
    }
    return out;
  }
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    return {};
  }
}
