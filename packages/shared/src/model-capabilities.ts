import type { EffortLevel } from './settings.js';

/**
 * What a model can do, read off its id.
 *
 * Two facts the app kept guessing in different places, and getting wrong in
 * both: how much context a Claude model holds (every current one holds 1M, but
 * the catalog said 200k, so the gauge read "4.45k / 200k" against a window five
 * times that size), and which effort levels it takes (the menu offered three
 * generic ones, while Opus takes five and Opus 5.5 defaults to a different one
 * than Opus 5). Both are decided here, once, so the catalog, the gauge, the
 * effort menu and the request agree.
 *
 * Parsed by family and version rather than by a list of ids, so a model released
 * after this build still lands on the right side of each rule.
 */

interface ClaudeId {
  family: 'opus' | 'sonnet' | 'haiku' | 'fable' | 'mythos';
  major: number;
  minor: number;
}

/** A Claude model id as family + version, or null for anything else. */
export function parseClaudeModel(modelId: string | undefined): ClaudeId | null {
  // Gateways prefix the vendor (`anthropic/claude-opus-5`) and the pattern is
  // anchored, so strip the prefix before reading it.
  const id = (modelId ?? '').toLowerCase().trim().replace(/^.*\//, '');
  const m = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2})(?!\d))?/.exec(id);
  if (!m) return null;
  return { family: m[1] as ClaudeId['family'], major: Number(m[2]), minor: Number(m[3] ?? 0) };
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

/** The generic scale for models steered by temperature. */
const TEMPERATURE_LEVELS: EffortLevel[] = ['low', 'normal', 'high'];
/** Anthropic's full ladder, as the 4.7 generation onwards takes it. */
const CLAUDE_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
/** OpenAI reasoning rungs supported by the request adapters; normal omits the rung. */
const OPENAI_LEVELS: EffortLevel[] = ['low', 'medium', 'normal', 'high'];

function isOpenAIReasoning(modelId: string | undefined): boolean {
  return /(?:^|[-_/ .])(?:o[134](?:-|$)|gpt-?(?:[5-9]|\d{2,})(?:[.\-]|$)|gpt-oss|codex)/i.test(modelId ?? '');
}

/**
 * The effort levels worth offering for a model, lowest first.
 *
 * `normal` is not in the Claude ladder: it means "the model's own default",
 * which the menu offers separately so the user can see which rung that is.
 */
export function modelEffortLevels(modelId: string | undefined): EffortLevel[] {
  if (usesNativeEffort(modelId)) return CLAUDE_LEVELS;
  return isOpenAIReasoning(modelId) ? OPENAI_LEVELS : TEMPERATURE_LEVELS;
}

/**
 * The rung a model runs at when no effort is sent. Anthropic's default is
 * `high`, except Opus 5.5, which defaults to `medium`.
 */
export function modelDefaultEffort(modelId: string | undefined): EffortLevel {
  if (!usesNativeEffort(modelId)) return 'normal';
  const c = parseClaudeModel(modelId);
  if (c?.family === 'opus' && atLeast(c, 5, 5)) return 'medium';
  return 'high';
}

/**
 * The saved effort setting, as this model can actually honour it.
 *
 * The setting is global and a chat can switch models, so the saved level is not
 * always one the model has: `xhigh` on a model steered by temperature, or the
 * old three-level `normal` on Opus. Each maps to the nearest rung the model does
 * have, so the menu shows what will be sent rather than what was once picked.
 */
export function effectiveEffort(setting: EffortLevel | undefined, modelId: string | undefined): EffortLevel {
  const level = setting ?? 'normal';
  if (usesNativeEffort(modelId)) return level === 'normal' ? modelDefaultEffort(modelId) : level;
  if (isOpenAIReasoning(modelId)) return level === 'xhigh' || level === 'max' ? 'high' : level;
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

/**
 * The most output tokens one reply from a Claude model may hold, by family and
 * generation. Anthropic's endpoint requires `max_tokens` on every request, so a
 * cloud chat that has no cap of its own is sent the model's own ceiling and
 * runs to it rather than to the local-model safeguard. Anything that is not a
 * recognisable Claude id (a gateway's own naming) gets a generous middle value;
 * a model that turns out to hold less says so in a 400 and the provider learns
 * the real figure from it.
 */
export function claudeMaxOutputTokens(modelId: string | undefined): number {
  const c = parseClaudeModel(modelId);
  if (!c) return 32_000;
  if (c.family === 'fable' || c.family === 'mythos') return 64_000;
  if (c.family === 'haiku' && c.major >= 5) return 128_000;
  if (c.major >= 5) return 64_000;
  if (c.family === 'haiku') return c.major >= 4 ? 64_000 : c.minor >= 5 ? 8_192 : 4_096;
  if (c.family === 'sonnet') return c.major >= 4 || atLeast(c, 3, 7) ? 64_000 : 8_192;
  // Opus: 3 held 4k, 4 and 4.1 hold 32k, 4.5 onwards 64k.
  if (c.major < 4) return 4_096;
  return atLeast(c, 4, 5) ? 64_000 : 32_000;
}
