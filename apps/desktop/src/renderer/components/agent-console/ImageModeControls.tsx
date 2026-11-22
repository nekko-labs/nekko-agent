import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  DEFAULT_IMAGE_CHAT_PARAMS,
  type ImageChatParams,
  type ImageCompanionStatus,
  type LocalModel,
  type Session,
} from '@nekko-agent/shared';
import { useStore } from '../../store.js';
import { useModelCatalogVersion } from '../../modelCatalog.js';
import { CheckIcon } from '../../icons.js';
import { formatBytes } from '../runtimes/verdict.js';
import { ensureRecommendedOffload } from './imageOffload.js';
import { pickerPlacement } from './pickerPlacement.js';
import './photoStart.css';

export const IMAGE_SIZES = ['512x512', '768x768', '1024x1024', '576x1024', '768x1024', '1024x768', '1024x576', '1344x768', '768x1344'];
export function imageSizeLabel(size: string): string {
  const [w, h] = size.split('x').map(Number);
  if (!(w > 0 && h > 0)) return size;
  const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
  const d = gcd(w, h);
  return `${w / d}:${h / d} · ${w}×${h}`;
}
/** Shapes named for where the picture goes, most used first (the introduction's "Designed for your destination"). */
export const PHOTO_SHAPES = [
  { size: '1024x1024', label: 'Square', uses: 'Icons, profile pictures, posts' },
  { size: '1024x576', label: 'Wide', uses: 'YouTube thumbnails, backgrounds' },
  { size: '576x1024', label: 'Tall', uses: 'Phone wallpapers, stories' },
  { size: '1024x768', label: 'Landscape', uses: 'Photos, slides' },
  { size: '768x1024', label: 'Portrait', uses: 'Posters, prints' },
];
const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;
const ratioOf = (size: string) => imageSizeLabel(size).split(' · ')[0];

/** The shape itself, drawn at its ratio inside a 16px box. */
export function ShapeGlyph({ size }: { size: string }) {
  const [w, h] = size.split('x').map(Number);
  const scale = 14 / Math.max(w || 1, h || 1);
  return (
    <span className="photo-shape-glyph" aria-hidden="true">
      <span style={{ width: Math.max(6, Math.round((w || 1) * scale)), height: Math.max(6, Math.round((h || 1) * scale)) }} />
    </span>
  );
}

/**
 * A trigger in the composer row and the one floating surface it opens,
 * portalled out of the composer's clipping and placed like the model picker.
 * Escape and a press outside close it and hand focus back to the trigger.
 */
function PhotoMenu({ trigger, label, role = 'listbox', width = 320, disabled, triggerProps, className = 'ctl-menu', children }: {
  trigger: React.ReactNode;
  label: string;
  role?: 'listbox' | 'dialog';
  width?: number;
  disabled?: boolean;
  triggerProps?: Record<string, unknown>;
  className?: string;
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<React.CSSProperties>({});
  const button = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const close = (focus = true) => { setOpen(false); if (focus) button.current?.focus(); };

  useLayoutEffect(() => {
    if (!open) return;
    const position = () => { if (button.current) setPlace(pickerPlacement(button.current.getBoundingClientRect(), window.innerWidth, window.innerHeight, width)); };
    position();
    window.addEventListener('resize', position);
    document.addEventListener('scroll', position, true);
    return () => { window.removeEventListener('resize', position); document.removeEventListener('scroll', position, true); };
  }, [open, width]);

  useEffect(() => {
    if (!open) return;
    // The chosen row (or the first) takes focus, so arrows and Enter work at once.
    (pop.current?.querySelector<HTMLElement>('[aria-selected="true"], input, [role="option"]'))?.focus();
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!button.current?.contains(t) && !pop.current?.contains(t)) close(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey, true); };
  }, [open]);

  const onListKey = (e: React.KeyboardEvent) => {
    if (role !== 'listbox' || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    const rows = [...(pop.current?.querySelectorAll<HTMLElement>('[role="option"]:not(:disabled)') ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    rows[(at + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length]?.focus();
    e.preventDefault();
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        className={`${className} max-w-full`}
        aria-haspopup={role}
        aria-expanded={open}
        aria-label={label}
        title={label}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        {...triggerProps}
      >
        {trigger}
      </button>
      {open && createPortal(
        <div ref={pop} role={role} aria-label={label} className="photo-menu quiet-popover fixed z-50 flex flex-col overflow-y-auto p-2" style={place} onKeyDown={onListKey}>
          {children(() => close())}
        </div>,
        document.body,
      )}
    </>
  );
}

function OptionRow({ selected, onPick, children, ...rest }: { selected: boolean; onPick: () => void; children: React.ReactNode } & Record<string, unknown>) {
  return (
    <button type="button" role="option" aria-selected={selected} className="photo-menu-row quiet-row" onClick={onPick} {...rest}>
      {children}
      {selected && <CheckIcon className="ml-auto h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />}
    </button>
  );
}

/**
 * The image chat's brain row: which image model, the picture's shape, and
 * behind Advanced how it samples. Each change is saved on the chat, so it
 * survives switching tabs and is what the next prompt runs with. Picking a
 * model adopts its family's tuned steps and CFG (FLUX.2 klein wants 4 and 1,
 * SD3.5 28 and 4.5).
 */
export function ImageModeControls({ session, onChange, busy }: { session: Session; onChange: (s: Session) => void; busy: boolean }) {
  const pushToast = useStore((s) => s.pushToast);
  const setView = useStore((s) => s.setView);
  const params: ImageChatParams = { ...DEFAULT_IMAGE_CHAT_PARAMS, ...session.imageParams };
  const [models, setModels] = useState<LocalModel[] | null>(null);
  const [runtime, setRuntime] = useState(true);
  const [companions, setCompanions] = useState<ImageCompanionStatus | null>(null);
  const [fetching, setFetching] = useState(false);

  const save = (patch: Partial<ImageChatParams>) =>
    window.nekko.setSessionOptions(session.id, { imageParams: { ...params, ...patch } }).then((s) => {
      if (!s) throw new Error('This photo chat could not be saved.');
      onChange(s);
    }).catch((e: Error) => pushToast('error', e.message));

  const choose = async (modelId: string) => {
    // A model that only fits with CPU offload gets it before its first load.
    const model = models?.find((m) => m.id === modelId);
    if (model) await ensureRecommendedOffload(model).catch(() => false);
    const c = await window.nekko.engineImageCompanions(modelId).catch(() => null);
    setCompanions(c);
    await save({ modelId, ...(c ? { steps: c.defaults.steps, cfgScale: c.defaults.cfgScale } : {}) });
  };

  // Read again when a download lands or a model is deleted, so an open chat lists a new model.
  const catalog = useModelCatalogVersion();
  useEffect(() => {
    let live = true;
    window.nekko.engineModels().then((ms) => { if (live) setModels(ms.filter((m) => m.modality === 'image')); }).catch(() => { if (live) setModels((cur) => cur ?? []); });
    window.nekko.engineStatus().then((s) => { if (live) setRuntime(!!s.diffusionInstall?.binPath); }).catch(() => {});
    if (catalog && params.modelId) window.nekko.engineImageCompanions(params.modelId).then((c) => { if (live) setCompanions(c); }).catch(() => {});
    return () => { live = false; };
  }, [catalog]);
  // A new image chat starts on the first image model rather than on nothing.
  useEffect(() => {
    if (models?.length && (!params.modelId || !models.some((m) => m.id === params.modelId))) void choose(models[0].id);
  }, [models]);
  useEffect(() => {
    setFetching(false);
    setCompanions(null);
    if (!params.modelId) return;
    window.nekko.engineImageCompanions(params.modelId).then(setCompanions).catch(() => setCompanions(null));
  }, [params.modelId]);
  useEffect(() => {
    if (!fetching || !params.modelId) return;
    const t = setInterval(() => {
      void window.nekko.engineImageCompanions(params.modelId as string).then((c) => {
        setCompanions(c);
        if (c?.ready) setFetching(false);
        else void window.nekko.engineDownloads().then((jobs) => {
          const relevant = jobs.filter((job) => job.target === params.modelId && job.id.startsWith('image-companions:'));
          if (relevant.length && !relevant.some((job) => ['queued', 'downloading', 'verifying'].includes(job.state))) {
            setFetching(false);
            pushToast('error', 'Image setup did not finish. Open Model Server > Downloads for details, then retry.');
          }
        }).catch(() => setFetching(false));
      }).catch(() => setFetching(false));
    }, 3000);
    return () => clearInterval(t);
  }, [fetching, params.modelId]);

  if (models && !models.length) {
    return (
      <span className="min-w-0 truncate text-2xs text-ink-faint">
        No image models yet.{' '}
        <button className="underline hover:text-ink" onClick={() => setView('modelserver')}>Get one in Model Server</button>
      </span>
    );
  }
  const size = `${params.width}x${params.height}`;
  const shape = PHOTO_SHAPES.find((s) => s.size === size);
  const current = models?.find((m) => m.id === params.modelId);
  const fetchCompanions = async () => {
    if (!params.modelId) return;
    const res = await window.nekko.engineDownloadImageCompanions(params.modelId).catch((e: Error) => ({ ok: false, message: e.message }));
    pushToast(res.ok ? 'info' : 'error', res.message);
    if (res.ok) setFetching(true);
  };
  const num = (label: string, value: number, patch: (n: number) => Partial<ImageChatParams>, opts: { min: number; max: number; step?: number; width: string }) => (
    <NumField label={label} value={value} disabled={busy} {...opts} onCommit={(n) => void save(patch(n))} />
  );

  return (
    <>
      <PhotoMenu
        label="Image model"
        disabled={busy || !models}
        width={340}
        triggerProps={{ 'data-photo-model-trigger': true }}
        trigger={<><span className="ctl-menu-label">Model</span><span className="min-w-0 truncate">{current?.name ?? (models ? 'Choose a model' : 'Loading…')}</span><span className="ctl-caret shrink-0">▾</span></>}
      >
        {(close) => <>
          {(models ?? []).map((m) => (
            <OptionRow key={m.id} selected={m.id === params.modelId} onPick={() => { close(); if (m.id !== params.modelId) void choose(m.id); }} data-photo-model-option={m.id}>
              <span className="flex min-w-0 flex-col items-start">
                <span className="truncate text-xs font-medium">{m.name}</span>
                <span className="text-2xs text-ink-faint">{[formatBytes(m.sizeBytes), m.quantization && !m.name.includes(m.quantization) ? m.quantization : ''].filter(Boolean).join(' · ')}</span>
              </span>
            </OptionRow>
          ))}
          <button type="button" className="photo-menu-link" onClick={() => { close(); setView('modelserver'); }}>More picture models</button>
        </>}
      </PhotoMenu>
      <PhotoMenu
        label="Image size"
        disabled={busy}
        width={300}
        triggerProps={{ 'data-photo-shape-trigger': true, 'data-size': size }}
        trigger={<><ShapeGlyph size={size} /><span className="whitespace-nowrap">{shape ? shape.label : `Custom · ${size.replace('x', '×')}`}</span><span className="ctl-menu-label whitespace-nowrap">{ratioOf(size)}</span><span className="ctl-caret shrink-0">▾</span></>}
      >
        {(close) => <>
          {!shape && (
            <OptionRow selected onPick={close} data-photo-shape-option={size}>
              <ShapeGlyph size={size} />
              <span className="flex min-w-0 flex-col items-start"><span className="text-xs font-medium">Custom · {size.replace('x', '×')}</span><span className="text-2xs text-ink-faint">{ratioOf(size)}, kept from before</span></span>
            </OptionRow>
          )}
          {PHOTO_SHAPES.map((s) => (
            <OptionRow key={s.size} selected={s.size === size} onPick={() => { close(); const [width, height] = s.size.split('x').map(Number); if (s.size !== size) void save({ width, height }); }} data-photo-shape-option={s.size}>
              <ShapeGlyph size={s.size} />
              <span className="flex min-w-0 flex-col items-start">
                <span className="text-xs font-medium">{s.label} <span className="font-normal text-ink-faint">{ratioOf(s.size)}</span></span>
                <span className="text-2xs text-ink-faint">{s.uses}</span>
              </span>
            </OptionRow>
          ))}
        </>}
      </PhotoMenu>
      <PhotoMenu
        label="Advanced"
        role="dialog"
        disabled={busy}
        width={320}
        className="ctl-toggle"
        triggerProps={{ 'data-photo-advanced-trigger': true }}
        trigger="Advanced"
      >
        {() => <div className="flex flex-col gap-2 p-2">
          <p className="text-2xs text-ink-faint">More steps take longer; prompt guidance sets how closely it follows your words. Seed −1 gives a fresh variation.</p>
          <div className="flex flex-wrap gap-2">
            {num('Steps', params.steps, (steps) => ({ steps }), { min: 1, max: 100, width: 'w-12' })}
            {num('Prompt guidance (CFG)', params.cfgScale, (cfgScale) => ({ cfgScale }), { min: 0, max: 30, step: 0.5, width: 'w-12' })}
            {num('Seed', params.seed, (seed) => ({ seed }), { min: -1, max: 2 ** 31 - 1, width: 'w-24' })}
          </div>
          <div className="flex flex-wrap gap-2">
            {params.seed >= 0 && <button className="ctl-toggle" disabled={busy} onClick={() => void save({ seed: -1 })}>New variation each time</button>}
            {companions && <button className="ctl-toggle" disabled={busy} onClick={() => void save({ ...companions.defaults, seed: -1 })}>Restore model defaults</button>}
          </div>
        </div>}
      </PhotoMenu>
      {!runtime ? (
        <button className="ctl-toggle ml-auto shrink-0 whitespace-nowrap text-[var(--warning)]" onClick={() => setView('modelserver')} title="Image models run in stable-diffusion.cpp">
          Finish photo setup in Models
        </button>
      ) : companions && !companions.ready ? (
        <button
          className="ctl-toggle ml-auto shrink-0 whitespace-nowrap text-[var(--warning)]"
          disabled={fetching}
          onClick={() => void fetchCompanions()}
          title={`${companions.label} needs ${companions.files.filter((f) => !f.path).map((f) => f.role).join(', ')}`}
        >
          {fetching ? 'Downloading setup files…' : `Finish image setup · Download ${gb(companions.missingBytes)}`}
        </button>
      ) : null}
    </>
  );
}

/** A number the user types freely; only a valid value is saved, and a bad one snaps back on blur. */
function NumField({ label, value, min, max, step = 1, width, disabled, onCommit }: { label: string; value: number; min: number; max: number; step?: number; width: string; disabled: boolean; onCommit: (n: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const valid = (t: string) => { const n = Number(t); return t.trim() !== '' && Number.isFinite(n) && n >= min && n <= max && (step !== 1 || Number.isInteger(n)) ? n : null; };
  return (
    <label className="ctl-menu shrink-0" title={label}>
      <span className="ctl-menu-label">{label}</span>
      <input
        type="number"
        aria-label={label}
        className={`${width} bg-transparent text-ink outline-hidden`}
        min={min}
        max={max}
        step={step}
        value={text}
        disabled={disabled}
        onChange={(e) => { setText(e.target.value); const n = valid(e.target.value); if (n !== null && n !== value) onCommit(n); }}
        onBlur={() => { if (valid(text) === null) setText(String(value)); }}
      />
    </label>
  );
}
