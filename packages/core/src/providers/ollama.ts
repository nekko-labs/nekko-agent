import { withToolImages } from './tool-images.js';
import type { ModelInfo, ProviderConfig, ToolCall } from '@nekko-agent/shared';
import { httpError } from './errors.js';
import { readWithIdle } from './sse.js';
import type { Provider, ChatRequest, ProviderChunk } from './types.js';
import { DecodeClock } from './decode-clock.js';

/**
 * Native Ollama client. Ollama also exposes an OpenAI-compatible endpoint, but
 * its native API gives us model management (list/pull/ps/load) which powers the
 * Models page. Streaming uses newline-delimited JSON, not SSE.
 */
export class OllamaProvider implements Provider {
  constructor(public readonly config: ProviderConfig) {}

  private base() {
    // Strip a trailing /v1 if a user pasted the OpenAI-compat URL.
    return this.config.baseUrl.replace(/\/v1\/?$/, '');
  }

  async listModels(): Promise<ModelInfo[]> {
    const [tags, ps] = await Promise.all([
      fetch(`${this.base()}/api/tags`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json() as Promise<any>).catch(() => ({ models: [] as any[] })),
      fetch(`${this.base()}/api/ps`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json() as Promise<any>).catch(() => ({ models: [] as any[] })),
    ]);
    const vramByName = new Map<string, number>((ps.models ?? []).map((m: any) => [m.name, m.size_vram ?? 0]));
    return (tags.models ?? []).map((m: any) => ({
      id: m.name,
      providerId: this.config.id,
      name: m.name,
      loaded: vramByName.has(m.name),
      sizeBytes: m.size,
      vramBytes: vramByName.get(m.name) || undefined,
      details: m.details ? { family: m.details.family, quant: m.details.quantization_level } : undefined,
    }));
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      const r = await fetch(`${this.base()}/api/tags`);
      return r.ok ? { ok: true, message: 'Connected' } : { ok: false, message: `HTTP ${r.status}` };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }

  /** Pull a model, streaming progress lines (consumed by the caller's log). */
  async pull(model: string, onProgress?: (status: string) => void): Promise<void> {
    const res = await fetch(`${this.base()}/api/pull`, {
      method: 'POST',
      body: JSON.stringify({ name: model, stream: true }),
    });
    if (!res.ok || !res.body) throw new Error(`pull ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await readWithIdle(reader);
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) {
          try {
            onProgress?.(JSON.parse(line).status ?? '');
          } catch {
            /* ignore */
          }
        }
      }
    }
  }

  /** Load (or unload, with keep_alive 0) a model into memory. */
  async setLoaded(model: string, loaded: boolean): Promise<{ ok: boolean; message?: string }> {
    const res = await fetch(`${this.base()}/api/generate`, {
      method: 'POST',
      body: JSON.stringify({ model, keep_alive: loaded ? '30m' : 0, prompt: '' }),
    }).catch(() => null);
    if (res?.ok) return { ok: true };
    return {
      ok: false,
      message: res ? `Ollama refused (HTTP ${res.status}).` : 'Ollama did not respond.',
    };
  }

  async *chat(req: ChatRequest): AsyncIterable<ProviderChunk> {
    const body = {
      model: req.model,
      stream: true,
      // `num_predict` is Ollama's output cap; without it a looping model runs
      // until it fills its context window.
      options: {
        temperature: req.temperature ?? 0.7,
        ...(req.maxOutputTokens ? { num_predict: req.maxOutputTokens } : {}),
      },
      // Ollama's native reasoning toggle (thinking models only). Left off the
      // body when undefined so non-reasoning models are unaffected.
      ...(req.think !== undefined ? { think: req.think } : {}),
      messages: this.toOllamaMessages(req),
      tools: req.tools?.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
    };
    const res = await fetch(`${this.base()}/api/chat`, {
      method: 'POST',
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok || !res.body) throw httpError(`chat ${res.status}`, res);

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    // Fallback decode timer, used only if the server omits `eval_duration`.
    const decode = new DecodeClock();
    while (true) {
      const { done, value } = await readWithIdle(reader);
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.error) throw new Error(`Ollama stream failed: ${String(msg.error)}`);
        if (msg.message?.thinking) {
          decode.mark();
          yield { type: 'reasoning', delta: msg.message.thinking as string };
        }
        if (msg.message?.content) {
          decode.mark();
          yield { type: 'text', delta: msg.message.content };
        }
        if (msg.message?.tool_calls) {
          decode.mark();
          for (const tc of msg.message.tool_calls) {
            const call: ToolCall = {
              id: `call_${Math.abs(hash(JSON.stringify(tc)))}`,
              name: tc.function?.name ?? '',
              input: tc.function?.arguments ?? {},
            };
            yield { type: 'tool_call', call };
          }
        }
        if (msg.done) {
          decode.stop();
          // Ollama times its own decode phase and reports it in nanoseconds. That
          // beats anything we can measure out here (it excludes transport as well
          // as prompt processing) and is the figure `ollama run --verbose` prints,
          // so prefer it and fall back to our clock only if it's absent.
          const evalNs = Number(msg.eval_duration);
          yield {
            type: 'usage',
            inputTokens: msg.prompt_eval_count ?? 0,
            outputTokens: msg.eval_count ?? 0,
            outputMs: evalNs > 0 ? Math.max(1, Math.round(evalNs / 1e6)) : decode.elapsed(),
          };
          yield { type: 'done' };
          return;
        }
      }
    }
    yield { type: 'done' };
  }

  private toOllamaMessages(req: ChatRequest) {
    const out: any[] = [];
    if (req.system) out.push({ role: 'system', content: req.system });
    for (const m of withToolImages(req.messages)) {
      if (m.role === 'tool' && m.toolResult) {
        out.push({ role: 'tool', content: m.toolResult.output });
      } else if (m.role === 'assistant' && m.toolCalls?.length) {
        out.push({
          role: 'assistant',
          content: m.content,
          tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.input } })),
        });
      } else {
        out.push({
          role: m.role,
          content: m.content,
          ...(m.role === 'user' && m.images?.length
            ? { images: m.images.map((image) => image.replace(/^data:[^;]+;base64,/, '')) }
            : {}),
        });
      }
    }
    return out;
  }
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}
