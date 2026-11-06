import { ModelDownloadButton } from './ModelDownloadButton.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CatalogModelDetail, CatalogQuant, EngineMemory, LocalModel } from '@nekko-agent/shared';
import { downloadFitVerdict, modelModality } from '@nekko-agent/shared';
import { DiffusionInstallCard } from './DiffusionInstallCard.js';
import { useStore } from '../../store.js';
import { Badge } from '../primitives/index.js';
import { CheckIcon, ChevronIcon, ExternalIcon } from '../../icons.js';
import { formatBytes, formatCount } from '../runtimes/verdict.js';
import { gpuGuidance } from './modelFamilies.js';

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
    window.nekko
      .engineCatalogDetail(modelId)
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

  // The one build to point at when the question is "which of these": Q4_K_M
  // when the repo publishes it, otherwise the lightest build this machine can
  // hold, otherwise the lightest build at all.
  const recommended = useMemo(() => {
    if (!model) return null;
    const q4 = model.quants.find((q) => q.label.toUpperCase().startsWith('Q4_K_M'));
    if (q4) return q4;
    const fitting = memory
      ? model.quants.filter((q) => downloadFitVerdict(q.sizeBytes, memory.budgetBytes) === 'fits')
      : model.quants;
    return (
      fitting
        .filter((q) => q.sizeBytes)
        .sort((a, b) => (a.sizeBytes ?? 0) - (b.sizeBytes ?? 0))[0] ?? null
    );
  }, [model, memory]);

  const prepareDownload = async (quant: CatalogQuant) => {
    if (preparing.current) return false;
    preparing.current = true;
    try {
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
              little worse; higher numbers keep more of the model and cost disk and RAM. <strong>Q4_K_M</strong> is the
              usual choice{recommended ? ', marked below' : ''}.
            </p>
            <div className="card mt-2 divide-y" style={{ borderColor: 'var(--line)' }}>
              {model.quants.map((q) => {
                const have = installed.find((m) => m.quantization?.toUpperCase() === q.label.toUpperCase());
                const fit = memory ? downloadFitVerdict(q.sizeBytes, memory.budgetBytes) : 'unknown';
                const isPick = recommended?.label === q.label;
                return (
                  <div key={q.label} className="flex flex-wrap items-center gap-2 px-4 py-2 text-xs">
                    <span className="w-24 shrink-0 font-mono font-medium">{q.label}</span>
                    <span className="w-20 shrink-0 tabular-nums text-ink-faint">
                      {q.sizeBytes ? formatBytes(q.sizeBytes) : 'size unknown'}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs text-ink-faint">{q.note ?? ''}</span>
                    {isPick && (
                      <span
                        className="shrink-0 rounded-full px-2 py-0.5 text-2xs"
                        style={{ background: 'color-mix(in srgb, var(--accent) 16%, transparent)', color: 'var(--accent)' }}
                        title="The build we suggest for most people"
                      >
                        our pick
                      </span>
                    )}
                    {fit !== 'unknown' && !have && (
                      <span
                        className="shrink-0 rounded-full px-2 py-0.5 text-2xs"
                        style={{
                          background: `color-mix(in srgb, ${fit === 'fits' ? 'var(--success)' : fit === 'tight' ? 'var(--warning, #d1a054)' : 'var(--danger)'} 16%, transparent)`,
                          color: fit === 'fits' ? 'var(--success)' : fit === 'tight' ? 'var(--warning, #d1a054)' : 'var(--danger)',
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
            </div>
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
