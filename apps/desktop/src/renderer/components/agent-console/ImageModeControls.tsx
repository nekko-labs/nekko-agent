import { useEffect, useState } from 'react';
import {
  DEFAULT_IMAGE_CHAT_PARAMS,
  type ImageChatParams,
  type ImageCompanionStatus,
  type LocalModel,
  type Session,
} from '@nekko-agent/shared';
import { useStore } from '../../store.js';

const SIZES = ['512x512', '768x768', '1024x1024', '1024x768', '768x1024', '1344x768', '768x1344'];
const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

/**
 * The image chat's brain row: which image model, and how it samples. Each
 * change is saved on the chat, so it survives switching tabs and is what the
 * next prompt runs with. Picking a model adopts its family's tuned steps and
 * CFG (FLUX.2 klein wants 4 and 1, SD3.5 28 and 4.5).
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
    window.nekko.setSessionOptions(session.id, { imageParams: { ...params, ...patch } }).then((s) => { if (s) onChange(s); }).catch(() => {});

  const choose = async (modelId: string) => {
    const c = await window.nekko.engineImageCompanions(modelId).catch(() => null);
    setCompanions(c);
    await save({ modelId, ...(c ? { steps: c.defaults.steps, cfgScale: c.defaults.cfgScale } : {}) });
  };

  useEffect(() => {
    window.nekko.engineModels().then((ms) => setModels(ms.filter((m) => m.modality === 'image'))).catch(() => setModels([]));
    window.nekko.engineStatus().then((s) => setRuntime(!!s.diffusionInstall?.binPath)).catch(() => {});
  }, []);
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
      <span className="min-w-0 truncate text-[11px] text-ink-faint">
        No image models yet.{' '}
        <button className="underline hover:text-ink" onClick={() => setView('modelserver')}>Get one in Model Server</button>
      </span>
    );
  }
  const size = `${params.width}x${params.height}`;
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
      <label className="ctl-menu min-w-[10rem] flex-1" title="Image model">
        <span className="ctl-menu-label">Model</span>
        <select
          aria-label="Image model"
          className="w-full min-w-0 truncate bg-transparent text-ink outline-hidden"
          value={params.modelId ?? ''}
          disabled={busy || !models}
          onChange={(e) => void choose(e.target.value)}
        >
          {(models ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}{m.quantization && !m.name.includes(m.quantization) ? ` · ${m.quantization}` : ''}</option>)}
        </select>
      </label>
      <label className="ctl-menu shrink-0" title="Image size">
        <span className="ctl-menu-label">Size</span>
        <select
          aria-label="Image size"
          className="bg-transparent text-ink outline-hidden"
          value={size}
          disabled={busy}
          onChange={(e) => { const [width, height] = e.target.value.split('x').map(Number); void save({ width, height }); }}
        >
          {(SIZES.includes(size) ? SIZES : [size, ...SIZES]).map((s) => <option key={s} value={s}>{s.replace('x', '×')}</option>)}
        </select>
      </label>
      {num('Steps', params.steps, (steps) => ({ steps }), { min: 1, max: 100, width: 'w-9' })}
      {num('CFG', params.cfgScale, (cfgScale) => ({ cfgScale }), { min: 0, max: 30, step: 0.5, width: 'w-10' })}
      {num('Seed', params.seed, (seed) => ({ seed }), { min: -1, max: 2 ** 31 - 1, width: 'w-20' })}
      {params.seed >= 0 && (
        <button className="ctl-toggle shrink-0" disabled={busy} onClick={() => void save({ seed: -1 })} title="Use a new random seed for each image">
          Random
        </button>
      )}
      {!runtime ? (
        <button className="ctl-toggle ml-auto shrink-0 whitespace-nowrap text-[var(--warning,#d1a054)]" onClick={() => setView('modelserver')} title="Image models run in stable-diffusion.cpp">
          Install the image generation runtime
        </button>
      ) : companions && !companions.ready ? (
        <button
          className="ctl-toggle ml-auto shrink-0 whitespace-nowrap text-[var(--warning,#d1a054)]"
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
  const valid = (t: string) => { const n = Number(t); return t.trim() !== '' && Number.isFinite(n) && n >= min && n <= max ? n : null; };
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
