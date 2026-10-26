import React from 'react';
import type { ContextBundle, ContextItem, EffortLevel, Session } from '@nekko-agent/shared';
import { chatEffort, effectiveEffort, modelDefaultEffort, modelEffortLevels, usesNativeEffort } from '@nekko-agent/shared';
import { useStore } from '../store.js';
import { sourceMeta } from '../contextSources.js';
import { fillTone } from './contextTone.js';

const FREE_COLOR = 'var(--surface-2)';

export const formatContextTokens = (n: number) => n >= 1_000_000
  ? `${Number((n / 1_000_000).toFixed(1))}m`
  : n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${n}`;

/**
 * `n.toLocaleString()`, with the formatter built once. The gauge repaints as a
 * reply streams, and toLocaleString() constructs a new formatter on every call.
 */
let numberFormat: Intl.NumberFormat | undefined;
const num = (n: number) => (numberFormat ??= new Intl.NumberFormat()).format(n);

/**
 * Compact context-window gauge for the composer footer: usage bar + count with
 * a hover/focus breakdown of where the tokens go (mirrors the Context
 * Inspector's color vocabulary). The chat's cost is the usage chip beside it. Keyboard
 * users reach the breakdown by focusing the gauge.
 */
export function ContextGauge({
  bundle,
  skill,
  draftTokens = 0,
  liveTokens = 0,
  contextWindow,
  windowReported = false,
  reported,
}: {
  bundle: ContextBundle | null;
  /** The skill armed in the composer, folded into the token count when present. */
  skill?: { name: string; tokens: number } | null;
  /** Tokens of the unsent draft, so the gauge tracks what you're typing. */
  draftTokens?: number;
  /**
   * Tokens the running turn has produced since the bundle was built. The agent's
   * own replies and tool traffic are replayed in the next request, so they are
   * window usage the moment they exist, not once the turn ends.
   */
  liveTokens?: number;
  /**
   * The picked model's real window, which beats the bundle's id-based guess and
   * updates the instant the model changes rather than on the next reply.
   */
  contextWindow?: number;
  /** True only when the provider catalog reported this exact window. */
  windowReported?: boolean;
  /**
   * A Claude Agent chat's context as Claude Code reported it after its last
   * turn. It replaces the bundle's estimate (which misses Claude Code's own
   * prompt and tools, and its compactions), and its window beats any guess.
   */
  reported?: { used: number; window?: number };
}) {
  const included = reported ? [] : (bundle?.items ?? []).filter((i: ContextItem) => i.included);
  const base = reported ? reported.used : included.reduce((s, i) => s + i.tokens, 0);
  const used = base + (skill?.tokens ?? 0) + draftTokens + liveTokens;
  const windowTokens = reported?.window ?? contextWindow ?? bundle?.contextWindow ?? 0;
  const windowKnown = windowReported || !!reported?.window;
  const pct = windowTokens ? Math.min(100, (used / windowTokens) * 100) : 0;

  const bySource = included.reduce<Record<string, number>>((acc, i) => {
    acc[i.source] = (acc[i.source] ?? 0) + i.tokens;
    return acc;
  }, {});
  if (reported?.used) bySource['claude-code'] = reported.used;
  if (skill?.tokens) bySource.skill = (bySource.skill ?? 0) + skill.tokens;
  if (draftTokens) bySource.draft = (bySource.draft ?? 0) + draftTokens;
  if (liveTokens) bySource.reply = (bySource.reply ?? 0) + liveTokens;

  // Rows for the breakdown, biggest first, each with its share of the window.
  const rows = Object.entries(bySource)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([src, n]) => ({
      src,
      n,
      meta: sourceMeta(src),
      pctWin: windowTokens ? (n / windowTokens) * 100 : 0,
    }));
  const free = windowTokens ? Math.max(0, windowTokens - used) : 0;
  const freePct = windowTokens ? (free / windowTokens) * 100 : 0;

  return (
    <div className="group relative flex min-w-0 shrink-0 items-center text-[11px] text-ink-faint">
      {/* One bar that fills as the window does, with the count written on it.
          `~` marks a window guessed from the model family rather than reported. */}
      <span
        className="context-bar relative flex h-6 min-w-[92px] cursor-default items-center justify-center overflow-hidden rounded-md border border-line px-2 tabular-nums outline-hidden focus-visible:ring-2 focus-visible:ring-(--ring)"
        style={{ background: windowTokens > 0 ? `color-mix(in srgb, ${fillTone(pct)} 12%, var(--surface-2))` : 'var(--surface-2)' }}
        tabIndex={0}
        aria-label={`Context window: ${num(used)}${windowTokens ? ` of ${num(windowTokens)}` : ''} tokens in use`}
      >
        {/* Filled by scaling, not by width: the count moves with every streamed
            token, and a width transition re-laid-out the page on every frame. */}
        <span
          aria-hidden
          className="absolute inset-0 origin-left transition-transform duration-300"
          style={{ transform: `scaleX(${pct / 100})`, background: `color-mix(in srgb, ${fillTone(windowTokens > 0 ? pct : NaN)} 28%, transparent)` }}
        />
        <span className="relative text-ink-soft">
          {formatContextTokens(used)}{windowTokens ? ` / ${!windowKnown ? '~' : ''}${formatContextTokens(windowTokens)}` : ''}
        </span>
      </span>
      {/* Expanded breakdown: segmented bar + per-source rows with %, plus free space. */}
      <div
        className="pointer-events-none absolute bottom-7 left-0 z-40 hidden w-72 rounded-xl border border-line p-3 text-[11px] shadow-lg group-hover:block group-focus-within:block"
        style={{ background: 'var(--surface)' }}
        role="tooltip"
      >
        <div className="mb-2 flex items-baseline justify-between">
          <span className="font-semibold text-ink">Context window</span>
          <span className="text-ink-faint">
            {windowTokens ? `${num(used)} / ${num(windowTokens)}` : num(used)}
            {windowTokens ? <span className="ml-1 text-ink-soft">({Math.round(pct)}%)</span> : null}
          </span>
        </div>
        <p className="mb-2 text-ink-faint">{reported
          ? `Reported by Claude Code after its last model call.${reported.window ? '' : ' Window estimated from model family.'}`
          : windowReported ? 'Window reported by the model catalog. Usage is estimated.' : 'Window estimated from model family; the provider has not reported its exact limit.'}</p>
        {/* Segmented usage bar */}
        {windowTokens > 0 && (
          <div className="mb-2.5 flex h-2 w-full overflow-hidden rounded-full" style={{ background: FREE_COLOR }}>
            {rows.map((r) => (
              <span key={r.src} title={`${r.meta.label}: ${num(r.n)} tok`} style={{ width: `${r.pctWin}%`, background: r.meta.color }} />
            ))}
          </div>
        )}
        {included.length === 0 && !reported?.used && !skill?.tokens && <div className="text-ink-faint">Nothing in context yet.</div>}
        {rows.map((r) => (
          <div key={r.src} className="flex items-center gap-2 py-0.5">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: r.meta.color }} />
            <span className="min-w-0 flex-1 truncate text-ink-soft">{r.meta.label}</span>
            <span className="shrink-0 tabular-nums text-ink-faint">{num(r.n)} tok</span>
            {windowTokens > 0 && <span className="w-9 shrink-0 text-right tabular-nums text-ink-faint">{r.pctWin < 0.1 ? '<0.1' : r.pctWin.toFixed(1)}%</span>}
          </div>
        ))}
        {windowTokens > 0 && (
          <div className="flex items-center gap-2 py-0.5">
            <span className="h-2 w-2 shrink-0 rounded-full border border-line" style={{ background: FREE_COLOR }} />
            <span className="min-w-0 flex-1 truncate text-ink-soft">Free space</span>
            <span className="shrink-0 tabular-nums text-ink-faint">{num(free)} tok</span>
            <span className="w-9 shrink-0 text-right tabular-nums text-ink-faint">{freePct.toFixed(1)}%</span>
          </div>
        )}
        <div className="mt-1.5 flex justify-between border-t border-line pt-1.5 font-medium text-ink">
          <span>Total in use</span>
          <span className="tabular-nums">{num(used)} tok</span>
        </div>
      </div>
    </div>
  );
}

export const EFFORT_LABEL: Record<EffortLevel, string> = {
  low: 'Low',
  medium: 'Medium',
  normal: 'Normal',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

/**
 * The slider's stops for a model, lowest first, and which one the saved
 * setting sits on.
 *
 * The model's default takes its own rung's place rather than a stop of its
 * own at the far left: "Default · Medium" sitting left of Low read as the
 * bottom of the scale, so Opus 5.5 looked like it had no Low at all.
 */
export function effortRungs(saved: EffortLevel, modelId: string | undefined): { options: EffortLevel[]; index: number; shown: string } {
  const levels = modelEffortLevels(modelId);
  const native = usesNativeEffort(modelId);
  const fallback = modelDefaultEffort(modelId);
  // What this model will actually be sent, which is what the slider shows: a
  // saved `xhigh` on a temperature model runs as `high`, and says so.
  const effective = effectiveEffort(saved, modelId);
  const atDefault = native && effective === fallback;
  const options: EffortLevel[] = native ? levels.map((l) => (l === fallback ? 'normal' : l)) : levels;
  const index = Math.max(0, options.indexOf(atDefault ? 'normal' : effective));
  return { options, index, shown: atDefault ? `Default · ${EFFORT_LABEL[fallback]}` : EFFORT_LABEL[effective] };
}

/**
 * Model-specific effort rungs on a compact slider beside the model picker.
 * Given a chat, it shows and sets that chat's effort (`Session.effort`, which
 * falls back to the app-wide setting); without one it sets the app-wide one.
 */
export function EffortSlider({ modelId, onChanged, session, onSessionChange }: {
  modelId?: string;
  onChanged?: () => void;
  session?: Pick<Session, 'id' | 'effort'> | null;
  onSessionChange?: (s: Session) => void;
}) {
  const appEffort = useStore((s) => s.settings?.effort);
  const saved = (session ? chatEffort(session, appEffort) : appEffort) ?? 'normal';
  const pick = (level: EffortLevel) => {
    if (level === saved) return;
    onChanged?.();
    if (session) {
      void window.nekko.setSessionOptions(session.id, { effort: level })
        .then((s) => { if (s) onSessionChange?.(s); })
        .catch((e) => useStore.getState().pushToast('error', String(e)));
    } else {
      void window.nekko.updateSettings({ effort: level }).then(() => useStore.getState().refreshSettings());
    }
  };

  const { options, index, shown } = effortRungs(saved, modelId);
  // 0..1 up the rungs: it drives the glow's size and arms the top rung's
  // speed lines.
  const level = options.length > 1 ? index / (options.length - 1) : 0;
  const atMax = options.length > 1 && index === options.length - 1;
  return (
    <div className="effort-slider flex shrink-0 items-center gap-1 rounded-lg border border-line px-2 py-1 text-[11px]" title={session ? 'Reasoning effort for this chat' : 'Reasoning effort (the app default; a chat can set its own)'}>
      <label htmlFor="composer-effort" className="text-ink-faint">Effort</label>
      <span
        className="effort-track"
        style={{ '--effort-fill': `${level * 100}%`, '--effort-level': level } as React.CSSProperties}
      >
        <input
          id="composer-effort"
          type="range"
          min={0}
          max={options.length - 1}
          step={1}
          value={Math.max(0, index)}
          onChange={(event) => pick(options[Number(event.target.value)])}
          aria-label="Reasoning effort"
          aria-valuetext={shown}
        />
        {atMax && (
          <span className="effort-speed" aria-hidden="true">
            <i /><i /><i />
          </span>
        )}
      </span>
      <span className="min-w-12 text-right text-ink-soft">{shown}</span>
    </div>
  );
}
