#!/usr/bin/env node
// Read-only local analysis. Quota deltas are observations, never per-chat billing.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

export function readRows(path) {
  try {
    return readFileSync(path, 'utf8').split('\n').flatMap((line) => {
      try { return line.trim() ? [JSON.parse(line)] : []; } catch { return []; }
    });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export function compareQuota(replies, snapshots) {
  const sorted = snapshots.slice().sort((a, b) => a.timestamp - b.timestamp);
  return replies.map((reply) => {
    const start = Number.isFinite(reply.startedAt) ? reply.startedAt
      : Number.isFinite(reply.wallMs) ? reply.ts - reply.wallMs : undefined;
    const observations = sorted.filter((s) => s.providerId === reply.providerId);
    const before = start === undefined ? undefined : observations.filter((s) => s.timestamp <= start).at(-1);
    const after = observations.find((s) => s.timestamp >= reply.ts);
    const knownInput = Number.isFinite(reply.inputTokens);
    const totalInput = knownInput ? reply.inputTokens + (reply.cacheReadTokens ?? 0) + (reply.cacheWriteTokens ?? 0) : undefined;
    const overlaps = before && after ? replies.filter((r) => r !== reply && r.providerId === reply.providerId
      && (r.startedAt ?? (Number.isFinite(r.wallMs) ? r.ts - r.wallMs : r.ts)) <= after.timestamp
      && r.ts >= before.timestamp).length : undefined;
    const windows = before && after ? before.windows.map((a) => {
      const b = after.windows.find((w) => w.id === a.id);
      const reset = !b || a.resetsAt !== b.resetsAt || a.resetsAt <= after.timestamp || b.usedPercent < a.usedPercent;
      return { id: a.id, status: reset ? 'reset-or-window-changed' : 'observed',
        ...(reset ? {} : { usedPercentagePointChange: b.usedPercent - a.usedPercent }) };
    }) : [];
    return { sessionId: reply.sessionId, providerId: reply.providerId, modelId: reply.modelId,
      endedAt: reply.ts, startedAt: start, steps: reply.steps, effort: reply.effort,
      inputTokens: reply.inputTokens, cacheReadTokens: reply.cacheReadTokens, cacheWriteTokens: reply.cacheWriteTokens,
      totalInputTokens: totalInput, outputTokens: reply.outputTokens,
      cacheHitPercent: totalInput > 0 && Number.isFinite(reply.cacheReadTokens) ? 100 * reply.cacheReadTokens / totalInput : undefined,
      quota: { status: before && after ? 'correlation-only' : 'missing-bracketing-snapshots',
        beforeAt: before?.timestamp, afterAt: after?.timestamp,
        beforeGapMs: before && start !== undefined ? start - before.timestamp : undefined,
        afterGapMs: after ? after.timestamp - reply.ts : undefined,
        otherRecordedRepliesInInterval: overlaps, windows,
        caveat: 'Account-wide observations may include other clients, incognito activity, and delayed provider accounting. Missing counters are unknown, not zero.' } };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2] ?? process.env.NEKKO_DATA_DIR ?? join(homedir(), '.nekko', 'nekko-agent');
  console.log(JSON.stringify(compareQuota(readRows(join(dir, 'replies.jsonl')), readRows(join(dir, 'quota-history.jsonl'))), null, 2));
}
