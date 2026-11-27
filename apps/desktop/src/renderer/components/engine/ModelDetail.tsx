import { ModelDownloadButton } from './ModelDownloadButton.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CatalogModelDetail, CatalogQuant, EngineMemory, LocalModel, ModelLoadCheck } from '@nekko-agent/shared';
import { downloadFitVerdict, modelModality } from '@nekko-agent/shared';
import { DiffusionInstallCard } from './DiffusionInstallCard.js';
import { loadCatalogDetail } from './catalogDetails.js';
import { downloadRefusal, openBuild } from './buildChecks.js';
import { useStore } from '../../store.js';
import { Badge, Group } from '../primitives/index.js';
import { CheckIcon, ChevronIcon, ExternalIcon, HelpIcon } from '../../icons.js';
import { HoverTip } from '../HoverTip.js';
import { formatBytes, formatCount } from '../runtimes/verdict.js';
import { gpuGuidance, type LibraryModel } from './modelFamilies.js';

/**
 * One model's own page.
 *
 * The list can only answer "which of these", in a row's worth of space. This
 * answers "should I run this one", which needs the things a row has no room for:
 * what the publisher says it is, how many people pull it, when it last changed,
 * what it was converted from, and the full ladder of builds with the size of
 * each. So it takes the whole surface rather than expanding a row into a drawer
 * nobody can read.
 *
 * The card is the publisher's own README. It is rendered as a light markdown
 * subset rather than as raw text, because a wall of `##` and `|---|` is worse
 * than no card at all, and rather than with a full renderer, because a model
 * card is untrusted text from a stranger's repository and this way nothing in it
 * can become markup.
 */

export function ModelDetail({
  modelId,
  installed,
  memory,
  onBack,
  onQueued,
  embedded = false,
}: {
  modelId: string;
  /** Library rows that came from this repo, so the page can say "you have this". */
  installed: LocalModel[];
  /** This machine's memory pool, for per-build "will it run here" chips. */
  memory?: EngineMemory;
  onBack: () => void;
  onQueued: () => void;
  embedded?: boolean;
}) {
  const pushToast = useStore((s) => s.pushToast);
  const [model, setModel] = useState<CatalogModelDetail | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing'>('loading');
  const preparing = useRef(false);
  const [imageInstall, setImageInstall] = useState<import('@nekko-agent/shared').EngineInstall>();
  const [recommendRuntime, setRecommendRuntime] = useState(false);
  const refreshImageRuntime = () => window.nekko.engineStatus().then(s => { setImageInstall(s.diffusionInstall); return s.diffusionInstall; }).catch(() => undefined);

  useEffect(() => {
    let live = true;
    setState('loading');
    setModel(null);
    // Shared with a blocked row's offer of a build that runs (one trip per repo, not two).
    loadCatalogDetail(modelId)
      .then((m) => {
        if (!live) return;
        setModel(m);
        setState(m ? 'ready' : 'missing');
      })
      .catch(() => live && setState('missing'));
    return () => {
      live = false;
    };
  }, [modelId]);

  // What the engine in use makes of each build, as the library rows say it of files on
  // disk: a fork's format it cannot run, or a file that needs a newer engine. Opening the
  // page reads no header: it shows what is already known, and until a build has been read
  // the size-based fit stands. A build is read when it is opened (a click on its row) or
  // when Download is pressed, once ever per file content.
  const [checks, setChecks] = useState<Record<string, ModelLoadCheck>>({});
  const asked = useRef(new Set<string>());
  useEffect(() => {
    let live = true;
    setChecks({});
    asked.current = new Set();
    if (state !== 'ready') return;
    window.nekko.engineCatalogChecks?.(modelId).then((c) => live && setChecks(c ?? {})).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [modelId, state]);
  const checksRef = useRef(checks);
  checksRef.current = checks;
  const readBuild = async (file: string) => {
    const next = await openBuild(modelId, file, checksRef.current, asked.current);
    checksRef.current = next;
    setChecks(next);
    return next[file];
  };

  const picks = useMemo(() => (model ? recommendedBuilds(model.quants, memory, checks) : { balanced: null, best: null }), [model, memory, checks]);

  const prepareDownload = async (quant: CatalogQuant) => {
    if (preparing.current) return false;
    preparing.current = true;
    try {
      // Read this build's header first: a build the engine in use cannot run is not downloaded.
      const refusal = downloadRefusal(await readBuild(quant.file));
      if (refusal) { pushToast('error', refusal); return false; }
      if (!recommendRuntime && modelModality({ name: `${model?.name} ${modelId} ${model?.pipelineTag ?? ''} ${quant.file}` }) === 'image') {
        const current = await refreshImageRuntime();
        if (!current?.binPath) { setRecommendRuntime(true); return false; }
      }
      return true;
    } finally { preparing.current = false; }
  };

  return (
    <div className={embedded ? 'min-w-0 pt-2' : 'mx-auto max-w-4xl px-8 py-8'}>
      {!embedded && <button className="text-xs text-ink-faint hover:text-ink" onClick={onBack}>
        <ChevronIcon className="mr-1 inline h-3 w-3 rotate-180" />
        Back to models
      </button>}

      {state === 'loading' && <p className="mt-6 text-sm text-ink-faint">Reading the model page…</p>}

      {state === 'missing' && (
        <div className="card mt-4 p-5">
          <h1 className="text-xl font-semibold">{modelId}</h1>
          <p className="mt-1 text-sm text-ink-faint">
            Hugging Face has nothing to show for this repository. It may have been renamed or made private, or the
            search that found it may be out of date.
          </p>
        </div>
      )}

      {recommendRuntime && <div className="mt-4 border-b border-line pb-4"><p className="text-sm">This is an image model. Install the optional image generation runtime to generate here, or press Download again to get only the model.</p><DiffusionInstallCard install={imageInstall} onChanged={() => void refreshImageRuntime()} /></div>}

      {model && (
        <>
          <header className="mt-4">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold">{model.name}</h1>
              {model.parameterSize && <span className="chip">{model.parameterSize}</span>}
              {installed.length > 0 && (
                <Badge tone="success" variant="soft" title="Already in your library">
                  <CheckIcon className="h-3 w-3" /> downloaded
                </Badge>
              )}
              {model.gated && (
                <Badge tone="warning" variant="soft" title="This repository needs accepted terms or a token">
                  gated
                </Badge>
              )}
            </div>
            <p className="mt-1 font-mono text-xs text-ink-faint">{model.id}</p>
            {model.summary && <p className="mt-2 max-w-2xl text-sm text-ink-soft">{model.summary}</p>}

            <div className="mt-3 flex flex-wrap gap-2">
              {model.tags.map((t) => (
                <span key={t} className="chip">
                  {t}
                </span>
              ))}
            </div>
          </header>

          <section className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Downloads" value={model.downloads === undefined ? '—' : compact(model.downloads)} hint="Last 30 days, from Hugging Face" />
            <Stat label="Likes" value={model.likes === undefined ? '—' : compact(model.likes)} hint="Hearts on the Hub" />
            <Stat label="Builds" value={String(model.quants.length)} hint="Quantizations published in this repo" />
            <Stat label="Updated" value={model.updatedAt ? ago(model.updatedAt) : '—'} hint="Last commit to the repository" />
          </section>

          <section className="mt-5">
            <h2 className="text-base font-semibold">Variants</h2>
            <p className="mt-0.5 text-xs text-ink-faint">
              Same model, compressed differently. Lower numbers are smaller files that need less memory and answer a
              little worse; higher numbers keep more of the model and cost disk and RAM.{' '}
              {picks.balanced && picks.best && picks.balanced !== picks.best
                ? <>Two are marked below: <strong>{quantOf(picks.balanced)}</strong>, balanced for speed, and <strong>{quantOf(picks.best)}</strong>, the best quality this machine holds.</>
                : picks.best
                  ? <><strong>{quantOf(picks.best)}</strong> is our pick for this machine, marked below.</>
                  : <><strong>Q4_K_M</strong> is the usual choice{picks.balanced ? ', marked below' : ''}.</>}
            </p>
            {releasesOf(model.quants).map(({ variant, quants }) => (
            <Group
              key={variant ?? ''}
              as="div"
              className="mt-2"
              title={variant === undefined ? undefined : variant || 'Original'}
              meta={variant === undefined ? undefined : `${quants.length} build${quants.length === 1 ? '' : 's'}`}
            >
              {quants.map((q) => {
                const have = installed.find((m) => isInstalledBuild(m, q, variant !== undefined));
                const fit = memory ? downloadFitVerdict(q.sizeBytes, memory.budgetBytes) : 'unknown';
                const check = checks[q.file];
                const pick = picks.best && picks.balanced !== picks.best
                  ? (q === picks.balanced ? 'balanced' : q === picks.best ? 'best quality' : null)
                  : q === picks.balanced ? 'our pick' : null;
                return (
                  <div key={q.label} className="flex flex-wrap items-center gap-2 py-2 text-xs" onClick={() => { if (!have) void readBuild(q.file); }} title={have ? undefined : 'Click to check that this build runs on your engine'}>
                    <span className="w-24 shrink-0 font-mono font-medium" title={q.file}>{quantOf(q)}</span>
                    <span className="w-20 shrink-0 tabular-nums text-ink-faint">
                      {q.sizeBytes ? formatBytes(q.sizeBytes) : 'size unknown'}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs text-ink-faint">{q.note ?? ''}</span>
                    {pick && (
                      <span className="inline-flex shrink-0 items-center gap-1">
                        <PickChip label={pick} />
                        {pick !== 'best quality' && <HoverTip label={PICK_TIP} multiline side="top">
                          <span role="button" tabIndex={0} className="mode-info" aria-label="How speed and quality trade off" onClick={(e) => e.stopPropagation()}><HelpIcon /></span>
                        </HoverTip>}
                      </span>
                    )}
                    {check && !have && (
                      <span
                        className="shrink-0 rounded-full px-2 py-0.5 text-2xs"
                        style={{ background: 'color-mix(in srgb, var(--warning) 16%, transparent)', color: 'var(--warning)' }}
                        title={check.reason}
                        data-build-check={check.level}
                      >
                        {buildCheckLabel(check, q.sizeBytes, memory)}
                      </span>
                    )}
                    {!check && fit !== 'unknown' && !have && (
                      <span
                        className="shrink-0 rounded-full px-2 py-0.5 text-2xs"
                        style={{
                          background: `color-mix(in srgb, ${fit === 'fits' ? 'var(--success)' : fit === 'tight' ? 'var(--warning)' : 'var(--danger)'} 16%, transparent)`,
                          color: fit === 'fits' ? 'var(--success)' : fit === 'tight' ? 'var(--warning)' : 'var(--danger)',
                        }}
                        title={
                          fit === 'fits'
                            ? 'Room to spare in this machine\'s memory'
                            : fit === 'tight'
                              ? 'Runs, but close to this machine\'s limit'
                              : 'Bigger than this machine can hold'
                        }
                      >
                        {gpuGuidance(q.sizeBytes, memory)}{memory?.kind !== 'ram' ? ' (estimated)' : ''}
                      </span>
                    )}
                    {have ? (
                      <Badge tone="success" variant="soft" title={have.path}>
                        <CheckIcon className="h-3 w-3" /> in your library
                      </Badge>
                    ) : (
                      <ModelDownloadButton modelId={modelId} quant={q.label} prepare={() => prepareDownload(q)} onResult={(res) => {
                        pushToast(res.ok ? 'info' : 'error', res.message);
                        if (res.ok) onQueued();
                      }} />
                    )}
                  </div>
                );
              })}
            </Group>
            ))}
          </section>

          <section className="mt-5">
            <h2 className="text-base font-semibold">Details</h2>
            <dl className="card mt-2 grid grid-cols-1 gap-x-6 gap-y-2 p-4 text-xs sm:grid-cols-2">
              <Row label="Published by" value={model.owner} />
              <Row label="License" value={model.license ?? 'not declared'} />
              <Row label="Task" value={model.pipelineTag ?? '—'} />
              <Row label="Converted from" value={model.baseModel ?? '—'} mono />
              <Row label="First published" value={model.createdAt ? new Date(model.createdAt).toLocaleDateString() : '—'} />
              <Row
                label="Last updated"
                value={model.updatedAt ? new Date(model.updatedAt).toLocaleDateString() : '—'}
              />
            </dl>
            {(model.hfTags?.length ?? 0) > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {model.hfTags!.slice(0, 24).map((t) => (
                  <span key={t} className="rounded-md px-2 py-0.5 font-mono text-2xs text-ink-faint" style={{ background: 'var(--surface-2)' }}>
                    {t}
                  </span>
                ))}
              </div>
            )}
            <a
              className="mt-2 inline-flex items-center gap-2 text-xs text-ink-faint hover:text-ink"
              href={`https://huggingface.co/${model.id}`}
              target="_blank"
              rel="noreferrer noopener"
            >
              Open on Hugging Face <ExternalIcon className="h-3 w-3" />
            </a>
          </section>

          <section className="mt-5">
            <h2 className="text-base font-semibold">Model card</h2>
            <p className="mt-0.5 text-xs text-ink-faint">Written by the publisher, shown as they wrote it.</p>
            <div className="card mt-2 p-5">
              {model.readmeError ? (
                <p className="text-xs" style={{ color: 'var(--warning)' }}>
                  {model.readmeError}
                </p>
              ) : model.readme ? (
                <Markdown source={model.readme} />
              ) : (
                <p className="text-xs text-ink-faint">This repository has no model card.</p>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-xl px-3 py-2" style={{ background: 'var(--surface-2)' }} title={hint}>
      <p className="text-xs text-ink-soft">{label}</p>
      <p className="mt-0.5 text-base font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-ink-faint">{label}</dt>
      <dd className={`min-w-0 truncate text-right ${mono ? 'font-mono text-xs' : ''}`} title={value}>
        {value}
      </dd>
    </div>
  );
}

/**
 * The model card, as much markdown as a card actually uses.
 *
 * Headings, paragraphs, lists, tables, fenced code, inline code, emphasis and
 * links. Never through `innerHTML`: this is prose from a stranger's repository,
 * and it is parsed into elements we construct ourselves so nothing in it can
 * become markup. Any HTML the publisher wrote is reduced to its text, because a
 * card full of literal `<a href=…>` reads worse than one without the link.
 *
 * Images are dropped rather than rendered. Cards open with rows of badges served
 * from third-party hosts, and fetching them would tell each of those hosts that
 * this machine opened this model.
 */
function Markdown({ source }: { source: string }) {
  const blocks = useMemo(() => parseBlocks(source), [source]);
  return (
    <div className="space-y-2 text-sm leading-relaxed text-ink-soft">
      {blocks.map((b, i) => {
        if (b.kind === 'code') {
          return (
            <pre
              key={i}
              className="max-h-80 overflow-auto rounded-lg p-3 font-mono text-xs leading-relaxed"
              style={{ background: 'var(--surface-2)' }}
            >
              {b.text}
            </pre>
          );
        }
        if (b.kind === 'heading') {
          const size = b.level <= 1 ? 'text-base' : b.level === 2 ? 'text-base' : 'text-sm';
          return (
            <p key={i} className={`${size} pt-1 font-semibold text-ink`}>
              <Inline text={b.text} />
            </p>
          );
        }
        if (b.kind === 'list') {
          return (
            <ul key={i} className="list-disc space-y-1 pl-5">
              {b.items.map((item, n) => (
                <li key={n}>
                  <Inline text={item} />
                </li>
              ))}
            </ul>
          );
        }
        if (b.kind === 'table') {
          return (
            <div key={i} className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr>
                    {b.head.map((cell, n) => (
                      <th key={n} className="border-b px-2 py-1 text-left font-medium text-ink" style={{ borderColor: 'var(--line)' }}>
                        <Inline text={cell} />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {b.rows.map((row, n) => (
                    <tr key={n}>
                      {row.map((cell, c) => (
                        <td key={c} className="border-b px-2 py-1 align-top" style={{ borderColor: 'var(--line)' }}>
                          <Inline text={cell} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        return (
          <p key={i}>
            <Inline text={b.text} />
          </p>
        );
      })}
    </div>
  );
}

type Block =
  | { kind: 'para' | 'code'; text: string }
  | { kind: 'heading'; text: string; level: number }
  | { kind: 'list'; items: string[] }
  | { kind: 'table'; head: string[]; rows: string[][] };

/** `| a | b |` -> `['a', 'b']`, with the outer pipes dropped. */
function tableCells(line: string): string[] {
  return line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
}

/** The `|---|:--:|` line under a table's header, and nothing else. */
const TABLE_RULE = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;

function parseBlocks(source: string): Block[] {
  const out: Block[] = [];
  const lines = stripHtml(source).split(/\r?\n/);
  let para: string[] = [];
  let list: string[] = [];

  const flush = () => {
    if (para.length) out.push({ kind: 'para', text: para.join(' ').trim() });
    para = [];
    if (list.length) out.push({ kind: 'list', items: list });
    list = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trimStart().startsWith('```')) {
      flush();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        body.push(lines[i]);
        i += 1;
      }
      out.push({ kind: 'code', text: body.join('\n') });
      continue;
    }
    // A table is a header row, a rule, then rows: cards use them for the very
    // thing this page is about, so they are worth laying out rather than
    // spilling as pipes.
    if (line.includes('|') && lines[i + 1] !== undefined && TABLE_RULE.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      flush();
      const head = tableCells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(tableCells(lines[i]).slice(0, head.length));
        i += 1;
      }
      i -= 1;
      out.push({ kind: 'table', head, rows: rows.slice(0, 40) });
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flush();
      out.push({ kind: 'heading', text: heading[2].trim(), level: heading[1].length });
      continue;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    if (bullet) {
      if (para.length) {
        out.push({ kind: 'para', text: para.join(' ').trim() });
        para = [];
      }
      list.push(bullet[1]);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    if (list.length) flush();
    para.push(line.trim());
  }
  flush();
  // Cards run long; past this it is reference material nobody reads in a panel.
  return out.slice(0, 140);
}

/**
 * HTML in a model card, reduced to its text.
 *
 * Cards are markdown by convention and HTML in practice: `<a>`, `<img>`,
 * `<details>`, `<br>`. None of it can be rendered as markup here, and leaving the
 * tags in makes the prose unreadable, so the tags go and their contents stay.
 */
function stripHtml(markdown: string): string {
  return markdown
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?[a-z][^>]*>/gi, '');
}

/** Inline code, emphasis and links. Everything else stays literal text. */
function Inline({ text }: { text: string }) {
  // Images first: `![alt](url)` would otherwise match the link rule and render
  // as a link to a badge nobody asked for.
  const clean = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  const parts = clean.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)\s]+\))/g).filter(Boolean);
  return (
    <>
      {parts.map((p, i) => {
        if (p.startsWith('`') && p.endsWith('`') && p.length > 2) {
          return (
            <code key={i} className="rounded px-1 py-0.5 font-mono text-xs" style={{ background: 'var(--surface-2)' }}>
              {p.slice(1, -1)}
            </code>
          );
        }
        if (p.startsWith('**') && p.endsWith('**') && p.length > 4) {
          return (
            <strong key={i} className="font-semibold text-ink">
              {p.slice(2, -2)}
            </strong>
          );
        }
        const link = p.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
        if (link) {
          // Only the two schemes a card has any business linking to. Anything
          // else keeps its label and loses its href.
          const href = /^https?:\/\//i.test(link[2]) ? link[2] : null;
          return href ? (
            <a key={i} href={href} target="_blank" rel="noreferrer noopener" className="text-accent hover:underline">
              {link[1]}
            </a>
          ) : (
            <span key={i}>{link[1]}</span>
          );
        }
        return <span key={i}>{p}</span>;
      })}
    </>
  );
}

const compact = formatCount;

/** "3 months ago", for the is-this-maintained question. */
function ago(ms: number): string {
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 18) return `${months}mo ago`;
  return `${Math.round(days / 365)}y ago`;
}

/** The quantization alone (`Q8_0`), without the release a label may carry. */
function quantOf(q: CatalogQuant): string {
  return q.quant ?? q.label;
}

/**
 * A repo's builds by release, in catalog order (newest release first). A repo
 * with one release is one unnamed group (`variant` undefined); the release
 * without a marker in its file names is `''`.
 */
export function releasesOf(quants: CatalogQuant[]): { variant?: string; quants: CatalogQuant[] }[] {
  if (!quants.some((q) => q.variant)) return [{ quants }];
  const groups = new Map<string, CatalogQuant[]>();
  for (const q of quants) {
    const key = q.variant ?? '';
    groups.set(key, [...(groups.get(key) ?? []), q]);
  }
  return [...groups].map(([variant, qs]) => ({ variant, quants: qs }));
}

/**
 * Whether a library model is this build. In a repo of several releases the
 * builds share quantizations, so they are told apart by file name.
 */
export function isInstalledBuild(m: LocalModel, q: CatalogQuant, releases: boolean): boolean {
  if (releases) {
    const file = q.file.split('/').pop() ?? q.file;
    return m.path === file || m.path.endsWith(`/${file}`) || m.path.endsWith(`\\${file}`);
  }
  return m.quantization?.toUpperCase() === q.label.toUpperCase();
}

const PICK_TIP = 'Bigger builds answer a little better, but load and reply more slowly and take more memory. '
  + 'Balanced (usually Q4_K_M) keeps most of the quality at a fraction of the size, so replies come fast. '
  + 'Best quality is the largest build this machine holds with room to spare: the best answers, a bit slower.';

function PickChip({ label }: { label: string }) {
  return (
    <span className="rounded-full px-2 py-0.5 text-2xs" style={{ background: 'color-mix(in srgb, var(--accent) 16%, transparent)', color: 'var(--accent)' }}>
      {label}
    </span>
  );
}

/**
 * The builds to point at when the question is "which of these", from the newest
 * release (releases come newest first). `best` is the largest build this machine
 * holds with room to spare; unquantized builds (F16, BF16, F32) rank last, since
 * Q8_0 gives effectively the same answers at half the size. `balanced` is Q4_K_M
 * when it fits (or nothing does, or memory is unknown), otherwise `best`; without
 * a Q4_K_M it is `best`, or the lightest build when memory is unknown. They are the
 * same build when nothing bigger fits. A build whose format the engine cannot run
 * (`checks`) is never a pick; one that only needs a newer engine still is, since
 * Update fixes that.
 */
export function recommendedBuilds(quants: CatalogQuant[], memory: EngineMemory | undefined, checks: Record<string, ModelLoadCheck>): { balanced: CatalogQuant | null; best: CatalogQuant | null } {
  const allowed = quants.filter((q) => !(checks[q.file]?.level === 'blocked' && checks[q.file]?.cause !== 'engineAge'));
  const runnable = allowed.filter((q) => q.variant === allowed[0]?.variant);
  const fits = (q: CatalogQuant) => !!memory && downloadFitVerdict(q.sizeBytes, memory.budgetBytes) === 'fits';
  const full = (q: CatalogQuant) => /^(BF16|FP?16|FP?32)/.test(quantOf(q).toUpperCase());
  const best = runnable.filter(fits).sort((a, b) => Number(full(a)) - Number(full(b)) || (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0))[0] ?? null;
  const q4 = runnable.find((q) => quantOf(q).toUpperCase().startsWith('Q4_K_M'));
  const lightest = runnable.filter((q) => q.sizeBytes).sort((a, b) => (a.sizeBytes ?? 0) - (b.sizeBytes ?? 0))[0] ?? null;
  const balanced = q4 && (!best || fits(q4)) ? q4 : best ?? (memory ? null : lightest);
  return { balanced, best };
}

/** A build's chip when the engine has a word about it, in the library rows' own words. */
export function buildCheckLabel(check: ModelLoadCheck, sizeBytes: number | undefined, memory: EngineMemory | undefined): string {
  return check.level === 'blocked' ? gpuGuidance(sizeBytes, memory, { loadCheck: check } as LibraryModel) : 'May not run here';
}
