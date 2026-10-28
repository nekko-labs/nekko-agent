import type { TurnStats } from '@nekko-agent/shared';
import { formatRate, turnTokensPerSecond } from '@nekko-agent/shared';
import { fmtTok } from './transcript.js';
import { useShown } from '../../simpleMode.js';
import { CheckIcon } from '../../icons.js';

const EFFORT_LABEL: Record<NonNullable<TurnStats['effort']>, string> = {
  low: 'Low', medium: 'Medium', normal: 'Normal', high: 'High', xhigh: 'Extra high', max: 'Max',
};

/** Display names the transcript knows, so the line can name models rather than ids. */
export interface TurnStatsNames {
  provider?: (providerId: string) => string | undefined;
  model?: (providerId: string, modelId: string) => string | undefined;
}

/** The parts of the line, shared by the component and its tests. */
export function turnStatsParts(stats: TurnStats, names: TurnStatsNames = {}): string[] {
  const model = names.model?.(stats.providerId, stats.modelId) ?? stats.modelId;
  const provider = names.provider?.(stats.providerId);
  const tps = turnTokensPerSecond(stats);
  const parts = [provider ? `${model} · ${provider}` : model];
  if (stats.effort) parts.push(`${EFFORT_LABEL[stats.effort]} effort`);
  parts.push(`${fmtTok(stats.inputTokens + (stats.cacheReadTokens ?? 0) + (stats.cacheWriteTokens ?? 0))} in`);
  parts.push(`${fmtTok(stats.outputTokens)} out`);
  if (tps > 0) parts.push(`${formatRate(tps)} tok/s`);
  parts.push(`${Math.max(1, Math.round(stats.wallMs / 1000))}s`);
  const saved = codeModeSaved(stats);
  if (saved) parts.push(saved);
  return parts;
}

/** "≈12k saved by code mode", when a code-mode reply came out ahead. */
export function codeModeSaved(stats: TurnStats): string | null {
  const c = stats.codeMode;
  return c && c.tokensSaved > 0 ? `≈${fmtTok(c.tokensSaved)} saved by code mode` : null;
}

/** Where a code-mode reply's estimate comes from, for the hover title. */
function codeModeTitle(stats: TurnStats): string | null {
  const c = stats.codeMode;
  if (!c) return null;
  const n = (v: number) => Math.round(v).toLocaleString();
  return [
    `Code mode (estimated, ~4 characters a token): ${c.tokensSaved >= 0 ? `${n(c.tokensSaved)} saved` : `${n(-c.tokensSaved)} more than a tool list`}`,
    `  Tool definitions not sent: ${n(c.schemaTokensSaved)} (${n(c.schemaTokensPerCall)} a call for ${c.toolsWrapped} tools, ${stats.calls} call${stats.calls === 1 ? '' : 's'})`,
    `  Results kept out of context: ${n(c.resultTokensSaved)} (${c.toolCalls} tool call${c.toolCalls === 1 ? '' : 's'} in ${c.runs} run${c.runs === 1 ? '' : 's'})`,
    `  Tool lookups: −${n(c.searchTokens)}`,
  ].join('\n');
}

/** Exact counts for the hover title. */
export function turnStatsTitle(stats: TurnStats): string {
  const cache = (stats.cacheReadTokens ?? 0) + (stats.cacheWriteTokens ?? 0);
  return [
    `Model: ${stats.modelId} (${stats.providerId})`,
    stats.effort ? `Effort: ${stats.effort}` : null,
    `Input: ${stats.inputTokens.toLocaleString()} new${cache ? ` + ${(stats.cacheReadTokens ?? 0).toLocaleString()} cache read + ${(stats.cacheWriteTokens ?? 0).toLocaleString()} cache write` : ''}`,
    `Output: ${stats.outputTokens.toLocaleString()}`,
    `${stats.calls} model call${stats.calls === 1 ? '' : 's'}${stats.steps ? `, ${stats.steps} tool step${stats.steps === 1 ? '' : 's'}` : ''}`,
    codeModeTitle(stats),
  ].filter(Boolean).join('\n');
}

/**
 * A finished reply's closing row: "Done." on the left and its measurements
 * right-aligned on the same line. At least 30px always separates the two, and
 * when the row is too narrow the measurements wrap onto the next line (still
 * right-aligned). Without a Done the stats keep their own line.
 */
export function DoneRow({ done, stats, names }: { done: boolean; stats?: TurnStats; names?: TurnStatsNames }) {
  if (!done) return stats ? <TurnStatsLine stats={stats} names={names} /> : null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-[30px] gap-y-0.5 text-[11px] text-ink-faint" data-done-row>
      <span className="flex shrink-0 items-center gap-1"><CheckIcon className="h-3 w-3" />Done.</span>
      {stats && <TurnStatsLine stats={stats} names={names} inline />}
    </div>
  );
}

/**
 * A finished reply's measurements, kept in the transcript under the reply:
 * which model and effort produced it, what it read and wrote, how fast. Lets a
 * long chat show where the tokens went, and which stretch ran on which model.
 */
export function TurnStatsLine({ stats, names, inline = false }: { stats: TurnStats; names?: TurnStatsNames; inline?: boolean }) {
  if (!useShown('stats')) return null;
  return (
    // `inline`: sits right-aligned in the reply's Done row (see DoneRow).
    <div className={`${inline ? 'ml-auto justify-end' : 'mt-1'} flex min-w-0 flex-wrap items-center gap-x-1.5 text-[11px] text-ink-faint`} data-turn-stats title={turnStatsTitle(stats)}>
      {turnStatsParts(stats, names).map((p, i) => <span key={i}>{i > 0 && '· '}{p}</span>)}
    </div>
  );
}
