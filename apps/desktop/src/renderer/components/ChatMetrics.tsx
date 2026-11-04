import React from 'react';
import { createPortal } from 'react-dom';
import type { ContextBundle, ContextItem, EffortLevel, ModelInfo, Session } from '@nekko-agent/shared';
import { chatEffort, effectiveEffort, modelEffortLevels } from '@nekko-agent/shared';
import { useStore } from '../store.js';
import { sourceMeta } from '../contextSources.js';
import { fillTone } from './contextTone.js';
import { EffortDial, usePopover } from './ModeViews.js';

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
  ringOnly = false,
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
  /** Simple: the ring alone, at the row's right end; the numbers wait in its tooltip. */
  ringOnly?: boolean;
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
    <div className="group relative flex min-w-0 shrink-0 items-center text-2xs text-ink-faint">
      {/* A ring that fills as the window does, and the count beside it, as on
          the phone. `~` marks a window guessed from the model family rather
          than reported. */}
      <span
        className="context-bar flex h-6 cursor-default items-center gap-2 rounded-md px-2 tabular-nums outline-hidden focus-visible:ring-2 focus-visible:ring-(--ring)"
        tabIndex={0}
        aria-label={`Context window: ${num(used)}${windowTokens ? ` of ${num(windowTokens)}` : ''} tokens in use`}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" className="shrink-0 -rotate-90">
          <circle cx="8" cy="8" r="6.5" fill="none" stroke="var(--surface-2)" strokeWidth="3" />
          {windowTokens > 0 && <circle cx="8" cy="8" r="6.5" fill="none" stroke={fillTone(pct)} strokeWidth="3" strokeLinecap="round" pathLength={100} strokeDasharray={`${pct} 100`} className="transition-[stroke-dasharray] duration-300" />}
        </svg>
        {!ringOnly && <span className="text-ink-soft" style={pct >= 60 ? { color: fillTone(pct) } : undefined}>
          {formatContextTokens(used)}{windowTokens ? ` / ${!windowKnown ? '~' : ''}${formatContextTokens(windowTokens)}` : ''}
        </span>}
      </span>
      {/* Expanded breakdown: segmented bar + per-source rows with %, plus free space. */}
      <div
        className={`pointer-events-none absolute bottom-7 ${ringOnly ? 'right-0' : 'left-0'} z-40 hidden w-72 rounded-xl border border-line p-3 text-2xs shadow-(--shadow-float) group-hover:block group-focus-within:block`}
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
          <div className="mb-2 flex h-2 w-full overflow-hidden rounded-full" style={{ background: FREE_COLOR }}>
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
        <div className="mt-1 flex justify-between border-t border-line pt-1 font-medium text-ink">
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

export const effortLabel = (level: EffortLevel): string => EFFORT_LABEL[level] ?? level;

/** Only provider-advertised stops. An unspecified default is not a synthetic rung. */
export function effortRungs(saved: EffortLevel, modelId: string | undefined, metadata?: ModelInfo['effort']): { options: EffortLevel[]; index: number; shown: string } {
  const options = modelEffortLevels(modelId, metadata);
  const effective = effectiveEffort(saved, modelId, metadata);
  const index = options.indexOf(effective);
  return { options, index, shown: !options.length ? 'Unavailable' : index < 0 ? 'Provider default' : effortLabel(effective) };
}

type EffortProps = {
  modelId?: string;
  metadata?: ModelInfo['effort'];
  onChanged?: () => void;
  session?: Pick<Session, 'id' | 'effort'> | null;
  onSessionChange?: (s: Session) => void;
};

/** The chat's effort (or the app-wide one without a chat), and setting it. */
function useEffort({ modelId, metadata, onChanged, session, onSessionChange }: EffortProps) {
  const appEffort = useStore((s) => s.settings?.effort);
  const saved = (session ? chatEffort(session, appEffort) : appEffort) ?? 'normal';
  const pick = (level: EffortLevel) => {
    if (level === saved) return;
    onChanged?.();
    if (session) {
      void window.nekko.setSessionOptions(session.id, { effort: level })
        .then(async (s) => {
          if (!s) return;
          onSessionChange?.(s);
          await window.nekko.updateSettings({ effort: level });
          await useStore.getState().refreshSettings();
        })
        .catch((e) => useStore.getState().pushToast('error', String(e)));
    } else {
      void window.nekko.updateSettings({ effort: level }).then(() => useStore.getState().refreshSettings());
    }
  };

  return { pick, ...effortRungs(saved, modelId, metadata) };
}

/**
 * Model-specific effort rungs on a compact slider beside the model picker.
 * Given a chat, it shows and sets that chat's effort (`Session.effort`, which
 * falls back to the app-wide setting); without one it sets the app-wide one.
 */
export function EffortSlider(props: EffortProps) {
  const { pick, options, index, shown } = useEffort(props);
  const { metadata, session } = props;
  const available = options.length > 0;
  const description = index >= 0 ? metadata?.levels.find((level) => level.effort === options[index])?.description : undefined;
  const pop = usePopover(380);
  const step = (by: number) => {
    const next = options[Math.max(0, Math.min(options.length - 1, index + by))];
    if (next) pick(next);
  };
  // The chat follows the app-wide setting when it has no choice of its own,
  // so the sheet footer says so instead of flattening to the same copy.
  const following = session ? session.effort == null : false;
  // A borderless gauge opens the phone-style slider. Arrow keys also step
  // through the advertised choices without opening the popover.
  return (
    <div className="effort-slider flex shrink-0 items-center" title={session ? 'Reasoning effort for this chat' : 'Reasoning effort, remembered for new chats on this computer'}>
      <button
        ref={pop.anchor}
        type="button"
        className="flex h-7 items-center justify-center gap-1.5 rounded-lg px-1 text-2xs text-ink-soft hover:bg-surface-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
        disabled={!available}
        title={!available ? metadata ? 'Effort unavailable: this provider reports no selectable effort choices for this model.' : 'Effort unavailable: this provider has not reported effort choices for this model.' : `Reasoning effort: ${shown}`}
        onClick={() => pop.setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); step(1); }
          if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); step(-1); }
        }}
        aria-haspopup="dialog"
        aria-expanded={pop.open}
        aria-label={`Reasoning effort: ${shown}`}
        data-effort-index={index}
        data-effort-count={options.length}
      >
        <EffortDial index={Math.max(0, index)} count={options.length} size={18} />
        <span>Effort</span>
      </button>
      {pop.open && available && createPortal(
        <div ref={pop.pop} style={pop.style} className="card fixed z-[100] p-4 shadow-(--shadow-float)" role="dialog" aria-label="Reasoning effort" data-effort-popover>
          <div className="flex flex-col items-center gap-3">
            <EffortDial index={Math.max(0, index)} count={options.length} size={96} />
            <span className="text-sm font-semibold text-ink">{shown}</span>
            {description && <p className="text-center text-xs text-ink-soft">{description}</p>}
            <input
              type="range"
              min={0}
              max={options.length - 1}
              step={1}
              value={Math.max(0, index)}
              disabled={options.length === 1}
              aria-label="Reasoning effort"
              aria-valuetext={shown}
              className="w-full accent-(--accent)"
              onChange={(e) => { const level = options[Number(e.currentTarget.value)]; if (level) pick(level); }}
            />
            <div className="flex w-full justify-between gap-1 text-2xs text-ink-faint" aria-hidden="true">
              {options.map((o) => <span key={o} className="min-w-0 break-words text-center" title={metadata?.levels.find((level) => level.effort === o)?.description}>{effortLabel(o)}</span>)}
            </div>
            {index < 0 && <button type="button" className="text-xs text-accent" onClick={() => pick(options[0])}>Use {effortLabel(options[0])}</button>}
            {metadata?.default && options.includes(metadata.default) && <p className="text-2xs text-ink-soft">Provider default: {effortLabel(metadata.default)}</p>}
            <p className="text-center text-2xs leading-snug text-ink-faint">
              {following ? "Following this computer's effort setting. " : ''}Higher effort thinks longer and spends more tokens.
            </p>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
