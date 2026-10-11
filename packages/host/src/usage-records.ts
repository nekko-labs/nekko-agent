import type { AgentEvent, ProviderConfig, ReplyRecord, SendOptions, TurnStats, UsageRecord } from '@nekko-agent/shared';
import { isLocalProvider } from '@nekko-agent/shared';

/**
 * The usage and reply log lines a chat turn writes, as pure functions: chat.ts
 * appends them on the in-process route, and the engine daemon writes the same
 * lines itself for the turns it drives (crates/nekko-usage `records`, held to
 * these by `usage.golden.test.ts`).
 */

/** Usage of one model call, for the usage log. */
export function turnUsageRecord(
  opts: Pick<SendOptions, 'sessionId' | 'providerId' | 'modelId'>,
  provider: Pick<ProviderConfig, 'auth' | 'kind'>,
  event: Extract<AgentEvent, { type: 'usage' }>,
  ts: number,
): UsageRecord {
  return {
    ts,
    providerId: opts.providerId,
    modelId: opts.modelId,
    inputTokens: event.inputTokens,
    cacheReadTokens: event.cacheReadTokens,
    cacheWriteTokens: event.cacheWriteTokens,
    outputTokens: event.outputTokens,
    sessionId: opts.sessionId,
    auth: provider.auth,
    local: isLocalProvider(provider.kind),
  };
}

/** One usage item of a side call (the chat title) a daemon-driven turn made, for the usage log. */
export function sideUsageRecord(
  provider: { id?: string; kind?: string; auth?: string },
  modelId: string | undefined,
  sessionId: string | undefined,
  item: Record<string, number | undefined>,
  ts: number,
): UsageRecord {
  return {
    ts, providerId: provider.id ?? '', modelId: modelId ?? '', sessionId: sessionId ?? '',
    inputTokens: item.inputTokens ?? 0, outputTokens: item.outputTokens ?? 0,
    cacheReadTokens: item.cacheReadTokens, cacheWriteTokens: item.cacheWriteTokens,
    auth: provider.auth as ProviderConfig['auth'], local: isLocalProvider((provider.kind ?? '') as ProviderConfig['kind']),
  };
}

/** How a finished reply ended, for the reply log; undefined when nothing is logged (no stop, or incognito). */
export function turnReplyRecord(
  opts: Pick<SendOptions, 'sessionId' | 'providerId' | 'modelId'>,
  incognito: boolean,
  startedAt: number,
  event: Extract<AgentEvent, { type: 'done' }>,
  finished: TurnStats | undefined,
  ts: number,
): ReplyRecord | undefined {
  if (!event.stop || incognito) return undefined;
  return {
    ts,
    startedAt,
    sessionId: opts.sessionId,
    providerId: opts.providerId,
    modelId: opts.modelId,
    steps: event.steps ?? 0,
    stop: event.stop,
    ...(finished ? {
      effort: finished.effort,
      inputTokens: finished.inputTokens,
      outputTokens: finished.outputTokens,
      cacheReadTokens: finished.cacheReadTokens,
      cacheWriteTokens: finished.cacheWriteTokens,
      outputMs: finished.outputMs,
      wallMs: finished.wallMs,
    } : {}),
  };
}
