import { useEffect, useState } from 'react';
import type { CatalogModel, EngineMemory } from '@nekko-agent/shared';
import { downloadFitVerdict } from '@nekko-agent/shared';
import { CheckIcon, ChevronIcon } from '../../icons.js';
import { formatBytes } from '../runtimes/verdict.js';

/**
 * Finding a model to run.
 *
 * Opens on a short curated list rather than an empty search box, because the
 * question a new user has is "what should I run", not "what exists". The search
 * field lives one level up, shared with the installed list, so "do I have it"
 * and "can I get it" are answered by the same box.
 *
 * A row is a decision about which model, so it carries what separates one model
 * from another — the parameter count in plain terms, the smallest download,
 * whether this machine can hold it — and nothing else. Choosing a build,
 * reading the card, checking when it was last touched: that is a different
 * question, and it gets the model's own page rather than a drawer unfolding
 * inside a list.
 */

const FIT_CHIP: Record<string, { label: string; color: string } | undefined> = {
  fits: { label: 'fits here', color: 'var(--success)' },
  tight: { label: 'tight fit', color: 'var(--warning, #d1a054)' },
  'wont-load': { label: 'needs more memory', color: 'var(--danger)' },
};

export function CatalogBrowser({
  onOpen,
  query,
  onQuery,
  hideSearch = false,
  memory,
  mlx = false,
}: {
  onOpen: (id: string) => void;
  /** Controlled search text; the Models surface shares one box for both lists. */
  query?: string;
  onQuery?: (q: string) => void;
  /** Hide the input when the parent already draws it. */
  hideSearch?: boolean;
  /** This machine's memory pool, for the "will it run here" chips. */
  memory?: EngineMemory;
  /** An Apple Silicon Mac: offer MLX checkpoints beside GGUF. */
  mlx?: boolean;
}) {
  const [format, setFormat] = useState<'gguf' | 'mlx'>('gguf');
  const [inner, setInner] = useState('');
  const [models, setModels] = useState<CatalogModel[] | null>(null);
  const [loading, setLoading] = useState(true);
  const value = query ?? inner;
  const setValue = (q: string) => {
    setInner(q);
    onQuery?.(q);
  };

  useEffect(() => {
    let live = true;
    setLoading(true);
    // Debounced so typing a model name does not fire a request per keystroke.
    const t = setTimeout(async () => {
      const res = await window.nekko.engineCatalog(value.trim() || undefined, format).catch(() => []);
      if (!live) return;
      setModels(res);
      setLoading(false);
    }, value ? 350 : 0);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [value, format]);

  return (
    <div>
      {!hideSearch && (
        <input
          className="input w-full text-xs"
          placeholder="Search Hugging Face for a model, e.g. qwen coder"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          spellCheck={false}
        />
      )}
      {mlx && (
        <div role="radiogroup" aria-label="Model format" className="mt-1 inline-flex rounded-lg border border-line p-0.5">
          {(['gguf', 'mlx'] as const).map((f) => (
            <button
              key={f}
              role="radio"
              aria-checked={format === f}
              onClick={() => setFormat(f)}
              title={f === 'gguf' ? 'llama.cpp models' : 'MLX checkpoints, fastest on Apple Silicon'}
              className={`rounded-md px-2 py-0.5 text-2xs font-medium ${format === f ? 'bg-surface-2 text-ink' : 'text-ink-faint hover:text-ink'}`}
            >
              {f === 'gguf' ? 'GGUF' : 'MLX'}
            </button>
          ))}
        </div>
      )}
      <p className="mt-1 text-2xs text-ink-faint">
        {format === 'mlx'
          ? `${value ? 'Searching' : 'The most downloaded'} MLX checkpoints on Hugging Face (mostly mlx-community conversions). Each one is a folder, downloaded whole.`
          : value
          ? 'Searching GGUF repositories on Hugging Face.'
          : 'A short starter list — the search above finds anything else. Open a model for its card, its builds and its sizes.'}
      </p>

      {loading && <p className="mt-3 text-xs text-ink-faint">Looking…</p>}

      {!loading && models?.length === 0 && (
        <p className="mt-3 text-xs text-ink-faint">
          Nothing matched. Try a shorter search, or the publisher's name.
        </p>
      )}

      <div className="mt-2 space-y-1">
        {(models ?? []).map((m) => {
          const fit = fitFor(m, memory);
          const chip = fit ? FIT_CHIP[fit] : undefined;
          return (
            <button
              key={m.id}
              className="catalog-row flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left"
              style={{ background: 'var(--surface-2)' }}
              onClick={() => onOpen(m.id)}
              title={`Open ${m.name}`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-xs font-medium">{m.name}</span>
                  {m.parameterSize && (
                    <span className="chip" title={`${m.parameterSize} parameters — bigger knows more, but needs more memory`}>
                      {m.parameterSize}
                    </span>
                  )}
                  {m.recommended && (
                    <span
                      className="inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-2xs"
                      style={{ background: 'color-mix(in srgb, var(--accent) 16%, transparent)', color: 'var(--accent)' }}
                      title="Our pick for most people"
                    >
                      <CheckIcon className="h-2.5 w-2.5" /> recommended
                    </span>
                  )}
                  {chip && (
                    <span
                      className="rounded-full px-2 py-0.5 text-2xs"
                      style={{ background: `color-mix(in srgb, ${chip.color} 16%, transparent)`, color: chip.color }}
                      title="Whether the smallest build fits in this machine's memory"
                    >
                      {chip.label}
                    </span>
                  )}
                  {m.tags.slice(0, 3).map((t) => (
                    <span key={t} className="text-2xs text-ink-faint">
                      {t}
                    </span>
                  ))}
                  {m.gated && (
                    <span className="text-2xs" style={{ color: 'var(--warning, #d1a054)' }} title="This repository needs accepted terms or a token">
                      gated
                    </span>
                  )}
                </div>
                <p className="truncate text-2xs text-ink-faint">
                  {m.summary ??
                    [
                      m.owner,
                      m.downloads ? `${compact(m.downloads)} downloads` : null,
                      `${m.quants.length} build${m.quants.length === 1 ? '' : 's'}`,
                      smallest(m),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                </p>
              </div>
              <ChevronIcon className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Whether the lightest build of this model can run on this machine. */
function fitFor(m: CatalogModel, memory: EngineMemory | undefined): string | undefined {
  if (!memory) return undefined;
  const sizes = m.quants.map((q) => q.sizeBytes ?? 0).filter((n) => n > 0);
  if (!sizes.length) return undefined;
  const v = downloadFitVerdict(Math.min(...sizes), memory.budgetBytes);
  return v === 'unknown' ? undefined : v;
}

/** "from 4.4 GB": the smallest build, which is what decides whether it fits. */
function smallest(m: CatalogModel): string | null {
  const sizes = m.quants.map((q) => q.sizeBytes ?? 0).filter((n) => n > 0);
  return sizes.length ? `from ${formatBytes(Math.min(...sizes))}` : null;
}

function compact(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}
