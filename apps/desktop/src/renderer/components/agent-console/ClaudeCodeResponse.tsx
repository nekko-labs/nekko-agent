import { CLAUDE_CODE_PROVIDER_KIND } from '@nekko-agent/shared';
import type { ComputerCatalog, ProviderConfig, TurnStats } from '@nekko-agent/shared';
import { useStore } from '../../store.js';

/**
 * Whether a settled reply came from a Claude Agent provider (`claude-code`),
 * read per message from the provider its turn ran on, so a chat that switched
 * providers (or routed a turn to a local model) marks only Claude Code's
 * replies. This computer's providers first, then a connected computer's, for a
 * chat that runs there. An unknown provider (since deleted) is not marked.
 */
export function isClaudeCodeReply(
  stats: Pick<TurnStats, 'providerId'> | undefined,
  providers: ProviderConfig[],
  catalogs: Record<string, ComputerCatalog> = {},
): boolean {
  if (!stats?.providerId) return false;
  const own = providers.find((p) => p.id === stats.providerId);
  if (own) return own.kind === CLAUDE_CODE_PROVIDER_KIND;
  return Object.values(catalogs).some((c) => c.providers.some((p) => p.id === stats.providerId && p.kind === CLAUDE_CODE_PROVIDER_KIND));
}

export function useClaudeCodeReply(stats: TurnStats | undefined): boolean {
  return useStore((s) => isClaudeCodeReply(stats, s.providers, s.computerCatalogs));
}

export const CLAUDE_CODE_RESPONSE_LABEL = "Claude Code's response";

/**
 * The quiet mark at the end of a Claude Agent reply: the text above is Claude
 * Code's own output, which Nekko ran on the user's computer and shows as it came.
 */
export function ClaudeCodeResponseMark() {
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-full border border-line px-1.5 py-px text-2xs text-ink-faint"
      title="Written by your own Claude Code, which Nekko Agent runs on your computer. The reply is shown as Claude Code wrote it."
      data-claude-code-response
    >
      {CLAUDE_CODE_RESPONSE_LABEL}
    </span>
  );
}
