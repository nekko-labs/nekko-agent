import { isLocalProvider, type ProviderConfig } from '@nekko-agent/shared';
import type { ChatRequest, ProviderChunk } from '@nekko-agent/core';
import { recordUsage } from './usage.js';
import { createHostProvider as createProvider, hostProviderConfig, promptCachingForHost } from './prompt-caching.js';
import { daemonCall } from './engine/daemon.js';
import { daemonOwns } from './daemon-caps.js';

/** The request a one-shot completion sends: no tools, no signal, no hooks. */
export type CompleteRequest = Pick<ChatRequest, 'model' | 'messages' | 'temperature' | 'maxOutputTokens' | 'think' | 'purpose' | 'promptCaching'>;

/**
 * Run one short completion beside a turn (a title, suggested replies, a
 * prompt part) and return its text. The engine daemon makes the call on its
 * Rust providers when it can (`provider:complete`, crates/nekkod/src/sideband.rs),
 * so the stream never shares this event loop with a running turn; otherwise
 * it runs here. `provider` must already be resolved (subscription token fresh).
 * Throws on a model or network failure, or once `timeoutMs` passes.
 */
export async function completeText(provider: ProviderConfig, request: CompleteRequest, timeoutMs = 30_000, sessionId = ''): Promise<string> {
  provider = hostProviderConfig(provider);
  request = { ...request, promptCaching: promptCachingForHost() };
  // This function owns sideband accounting. Callers must not record it again.
  // Preserve observed usage even when the completion fails or times out.
  const persist = (usage: Array<Extract<ProviderChunk, { type: 'usage' }>>) => {
    for (const item of usage) recordUsage({
      ts: Date.now(), providerId: provider.id, modelId: request.model, sessionId,
      inputTokens: item.inputTokens, outputTokens: item.outputTokens,
      cacheReadTokens: item.cacheReadTokens, cacheWriteTokens: item.cacheWriteTokens,
      auth: provider.auth, local: isLocalProvider(provider.kind),
    });
  };
  const daemon = process.env.NEKKO_AGENT_LOOP === 'ts' ? undefined : daemonCall();
  if (daemon && (await daemonOwns(daemon, 'provider:complete')) &&
      (await daemonOwns(daemon, 'provider:prompt-caching'))) {
    const out = await daemon<{ text?: string; usage?: Array<Extract<ProviderChunk, { type: 'usage' }>>; error?: string }>('provider:complete', { provider, request, timeoutMs, usageOnFailure: true });
    persist(out?.usage ?? []);
    if (out?.error !== undefined) throw new Error(out.error);
    return out?.text ?? '';
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const usage: Array<Extract<ProviderChunk, { type: 'usage' }>> = [];
  try {
    let out = '';
    for await (const chunk of createProvider(provider).chat({ ...request, signal: controller.signal })) {
      if (chunk.type === 'text') out += chunk.delta;
      if (chunk.type === 'usage') usage.push(chunk);
      if (chunk.type === 'done') break;
    }
    if (controller.signal.aborted) throw new Error('The model took too long to answer.');
    return out;
  } finally {
    clearTimeout(timeout);
    persist(usage);
  }
}
