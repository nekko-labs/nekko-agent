import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_FIT_REQUEST,
  type FitPlan,
  type FitRequest,
  type ModelFacts,
  type RuntimeCapabilities,
  type RuntimeKind,
} from '@nekko-agent/shared';
import { FitBar } from './FitBar.js';
import { AdvancedControls } from './AdvancedControls.js';
import { formatTokens, verdictColor, verdictLabel, verdictNotes, verdictSentence } from './verdict.js';

/**
 * One model's fit, with the simple control on top and the expert ones behind a
 * disclosure.
 *
 * The context slider is the whole simple layer: drag it and watch the bar fill,
 * turn amber, then run past the device edge. Knowing a 64k context will not fit
 * *before* waiting through a load is the entire point of the feature.
 */

const CONTEXT_STOPS = [512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144, 524288];
/** Long enough to stop replanning on every pixel, short enough to feel live. */
const PLAN_DEBOUNCE_MS = 150;

export function FitDrawer({
  providerId,
  facts,
  kind,
  capabilities,
  onLoaded,
  onClose,
}: {
  providerId: string;
  facts: ModelFacts;
  kind: RuntimeKind;
  capabilities: RuntimeCapabilities;
  onLoaded: (message?: string) => void;
  onClose: () => void;
}) {
  const stops = useMemo(() => {
    const max = facts.maxContext ?? 131072;
    const usable = CONTEXT_STOPS.filter((s) => s <= max);
    // Always offer the model's own maximum, even when it is not a power of two.
    if (usable.at(-1) !== max) usable.push(max);
    return usable;
  }, [facts.maxContext]);

  const [request, setRequest] = useState<FitRequest>(() => ({
    ...DEFAULT_FIT_REQUEST,
    contextTokens: facts.loadedContext ?? nearestStop(stops, DEFAULT_FIT_REQUEST.contextTokens),
  }));
  const [plan, setPlan] = useState<FitPlan | null>(null);
  const [planning, setPlanning] = useState(true);
  const [loading, setLoading] = useState(false);
  const latest = useRef(0);

  useEffect(() => {
    const seq = ++latest.current;
    setPlanning(true);
    const t = setTimeout(async () => {
      const next = await window.nekko.runtimePlan(providerId, facts.id, request).catch(() => null);
      // A slower earlier request must not overwrite a newer answer.
      if (seq !== latest.current) return;
      setPlan(next);
      setPlanning(false);
    }, PLAN_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [providerId, facts.id, request]);

  const patch = (p: Partial<FitRequest>) => setRequest((r) => ({ ...r, ...p }));

  const load = async () => {
    setLoading(true);
    const res = await window.nekko
      .runtimeLoad(providerId, facts.id, {
        contextTokens: request.contextTokens,
        gpuLayers:
          plan?.totalLayers && request.gpuLayerFraction < 1
            ? Math.round(plan.totalLayers * request.gpuLayerFraction)
            : undefined,
        kvCacheDtype: request.kvCacheDtype,
      })
      .catch((e: Error) => ({ ok: false, message: e.message }));
    setLoading(false);
    onLoaded(res.ok ? undefined : res.message);
    if (res.ok) onClose();
  };

  const idx = Math.max(0, stops.indexOf(nearestStop(stops, request.contextTokens)));

  return (
    <div className="mt-2 rounded-xl border p-3" style={{ borderColor: 'var(--line)' }}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm">{facts.id}</p>
          <p className="text-2xs text-ink-faint">
            {[facts.parameterSize, facts.quantization].filter(Boolean).join(' · ') || 'Fit projection'}
          </p>
        </div>
        {plan && (
          <span
            className="shrink-0 rounded-full px-2 py-0.5 text-2xs"
            style={{
              color: verdictColor(plan.verdict),
              border: `1px solid color-mix(in srgb, ${verdictColor(plan.verdict)} 40%, transparent)`,
            }}
          >
            {verdictLabel(plan.verdict)}
          </span>
        )}
      </div>

      <div className="mt-3">
        <div className="flex items-center justify-between text-xs">
          <label htmlFor={`ctx-${facts.id}`}>Context length</label>
          <span className="font-mono text-2xs text-ink-faint">{formatTokens(request.contextTokens)}</span>
        </div>
        <input
          id={`ctx-${facts.id}`}
          type="range"
          className="mt-1 w-full"
          min={0}
          max={stops.length - 1}
          step={1}
          value={idx}
          onChange={(e) => patch({ contextTokens: stops[Number(e.target.value)] })}
        />
      </div>

      {plan ? <FitBar plan={plan} /> : <div className="mt-2 h-6 animate-pulse rounded-md bg-[color-mix(in_srgb,var(--ink-faint)_10%,transparent)]" />}

      <p className="mt-2 text-xs" style={{ opacity: planning ? 0.6 : 1 }}>
        {plan ? verdictSentence(plan) : 'Working out what this needs…'}
      </p>
      {plan &&
        verdictNotes(plan).map((n) => (
          <p key={n} className="mt-1 text-2xs text-ink-faint">
            {n}
          </p>
        ))}

      {plan && plan.suggestions.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {plan.suggestions.map((s) => (
            <button
              key={s.label}
              className="rounded-full border px-2 py-1 text-2xs hover:border-[var(--accent)]"
              style={{ borderColor: 'var(--line)' }}
              onClick={() => s.apply && patch(s.apply)}
              disabled={!s.apply}
              title={s.apply ? 'Apply this change' : `Load ${s.alternateModelId} instead`}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}

      <AdvancedControls
        kind={kind}
        capabilities={capabilities}
        facts={facts}
        request={request}
        onChange={patch}
      />

      <div className="mt-3 flex items-center gap-2">
        {capabilities.canLoad && (
          <button className="btn btn-primary py-1 text-xs" onClick={load} disabled={loading}>
            {loading ? 'Loading…' : facts.loaded ? 'Reload with these settings' : 'Load model'}
          </button>
        )}
        <button className="btn btn-ghost py-1 text-xs" onClick={onClose}>
          Close
        </button>
        {plan?.verdict === 'wont-load' && capabilities.canLoad && (
          // Never block the load. Our estimate can be wrong and it is their machine.
          <span className="text-2xs text-ink-faint">Loading anyway is allowed; it may fail or be very slow.</span>
        )}
      </div>
    </div>
  );
}

function nearestStop(stops: number[], value: number): number {
  return stops.reduce((best, s) => (Math.abs(s - value) < Math.abs(best - value) ? s : best), stops[0]);
}
