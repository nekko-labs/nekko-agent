import type { EffortLevel } from './settings.js';
import type { ModelEffort } from './models.js';

/**
 * Live provider metadata owns native effort choices. Context-window estimates,
 * sampling-shape detection, and legacy saved-setting compatibility still use
 * model-id heuristics when live information is unavailable. Those heuristics
 * are not evidence of a provider's supported effort ladder.
 */

interface ClaudeId {
  family: 'opus' | 'sonnet' | 'haiku' | 'fable' | 'mythos';
  major: number;
  minor: number;
}

/** A Claude model id as family + version, or null for anything else. */
/**
 * Bedrock names a model `anthropic.claude-…`, or `us.anthropic.claude-…`
 * through a cross-region inference profile. The part after the provider prefix
 * is the Claude id the version rules read.
 */
export function withoutBedrockPrefix(id: string): string {
  const at = id.indexOf('anthropic.');
  if (at < 0) return id;
  const rest = id.slice(at + 'anthropic.'.length);
  return rest.startsWith('claude-') ? rest : id;
}

export function parseClaudeModel(modelId: string | undefined): ClaudeId | null {
  // Gateways prefix the vendor (`anthropic/claude-opus-5`) and the pattern is
  // anchored, so strip the prefix before reading it. Bedrock's `anthropic.` too.
  const id = withoutBedrockPrefix((modelId ?? '').toLowerCase().trim().replace(/^.*\//, ''));
  const m = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2})(?!\d))?/.exec(id);
  if (!m) return null;
  return { family: m[1] as ClaudeId['family'], major: Number(m[2]), minor: Number(m[3] ?? 0) };
}

/**
 * How a model id reads as a short card line. For a Claude id the family is
 * capitalised and the version is dotted ("Opus 5.5", "Opus 4.7"); other ids
 * come back unchanged. When the picker already carries a vendor label (the
 * ProviderConfig line reads "Claude" on its own), the shared "Claude " prefix
 * is dropped so the two don't repeat each other.
 */
export function shortModelName(id: string, known?: string): string {
  if (known) return known.replace(/^Claude\s+/i, '');
  const c = parseClaudeModel(id);
  if (c) {
    const family = c.family[0].toUpperCase() + c.family.slice(1);
    return `${family} ${c.major}${c.minor ? `.${c.minor}` : ''}`;
  }
  return id;
}

/** True from the 4.6 generation onwards, where the 1M window became standard. */
function atLeast(c: ClaudeId, major: number, minor: number): boolean {
  return c.major > major || (c.major === major && c.minor >= minor);
}

/**
 * A Claude model's context window, or undefined when the id is not Claude.
 *
 * Haiku 4.5 and everything before the 4.6 generation hold 200k; Opus and Sonnet
 * 4.6 onwards, Haiku 5 onwards, and Fable and Mythos, hold 1M.
 */
export function claudeContextWindow(modelId: string | undefined): number | undefined {
  const c = parseClaudeModel(modelId);
  if (!c) return undefined;
  if (c.family === 'fable' || c.family === 'mythos') return 1_000_000;
  if (c.family === 'haiku') return c.major >= 5 ? 1_000_000 : 200_000;
  return atLeast(c, 4, 6) ? 1_000_000 : 200_000;
}

/**
 * How a model is steered: Anthropic's `output_config.effort`, or a sampling
 * temperature. Claude dropped sampling from the 4.7 generation onwards (Fable
 * and Mythos never had it); everything else, Claude or not, still samples.
 */
export function usesNativeEffort(modelId: string | undefined): boolean {
  const c = parseClaudeModel(modelId);
  if (!c) return false;
  if (c.family === 'fable' || c.family === 'mythos') return true;
  return atLeast(c, 4, 7);
}

function isOpenAIReasoning(modelId: string | undefined): boolean {
  return /(?:^|[-_/ .])(?:o[134](?:-|$)|gpt-?(?:[5-9]|\d{2,})(?:[.\-]|$)|gpt-oss|codex)/i.test(modelId ?? '');
}

/**
 * Native effort choices are provider-owned, never guessed from a model id.
 * Missing metadata yields no advertised choices. `normal` remains an internal
 * compatibility sentinel, not a menu option. The id parameter is retained for callers.
 */
export function modelEffortLevels(_modelId: string | undefined, effort?: ModelEffort): EffortLevel[] {
  return effort?.levels.map(level => level.effort) ?? [];
}

/**
 * API default when published, otherwise the legacy `normal` sentinel. Without
 * metadata, retain the historical Claude-id defaults for old saved settings.
 * This compatibility fallback must not be presented as an API-derived default.
 */
export function modelDefaultEffort(modelId: string | undefined, effort?: ModelEffort): EffortLevel {
  if (effort) return effort.default ?? 'normal';
  if (!usesNativeEffort(modelId)) return 'normal';
  const c = parseClaudeModel(modelId);
  if (c?.family === 'opus' && atLeast(c, 5, 5)) return 'medium';
  return 'high';
}

/**
 * Resolve saved settings against live choices when supplied. An unsupported
 * setting uses the published default, or `normal` to leave the API default
 * unspecified. Without metadata, retain legacy sampling compatibility, but
 * never clamp explicit OpenAI native rungs to high.
 */
export function effectiveEffort(setting: EffortLevel | undefined, modelId: string | undefined, effort?: ModelEffort): EffortLevel {
  const level = setting ?? 'normal';
  if (effort) return effort.levels.some(option => option.effort === level) ? level : effort.default ?? 'normal';
  if (usesNativeEffort(modelId)) return level === 'normal' ? modelDefaultEffort(modelId) : level;
  if (isOpenAIReasoning(modelId)) return level;
  if (level === 'medium') return 'normal';
  if (level === 'xhigh' || level === 'max') return 'high';
  return level;
}

/**
 * A model's context window from its id alone (no network call), for anything
 * that has to draw a usage bar before a model list has loaded. Claude is exact;
 * other families are the common sizes, and anything unknown gets a cautious
 * 128k so a bar reads fuller rather than emptier than the truth.
 */
export function guessContextWindow(modelId: string | undefined): number {
  const id = (modelId ?? '').toLowerCase();
  if (!id) return 128_000;
  const claude = claudeContextWindow(id);
  if (claude) return claude;
  // Claude Code's model aliases (a Claude Agent chat's model): each names the
  // newest model of its family, and every current one holds 1M.
  if (id === 'opus' || id === 'sonnet' || id === 'haiku') return 1_000_000;
  if (id.includes('claude')) return 200_000;
  if (id.includes('gemini')) return 1_000_000;
  // Codex subscription generations have a smaller window than the API's
  // GPT-5 family. Live catalog values still take precedence over this guess.
  if (/(?:^|\/)gpt-5\.6-(?:sol|terra|luna)(?:$|[-/])/.test(id)) return 272_000;
  if (/(?:^|\/)gpt-5(?:-(?:mini|nano|codex))?(?:$|-\d{4}-\d{2}-\d{2}$)/.test(id)) return 400_000;
  if (id.includes('gpt-4.1')) return 1_047_576;
  if (/(?:^|\/)o[34](?:$|[-/])/.test(id)) return 200_000;
  return 128_000;
}
