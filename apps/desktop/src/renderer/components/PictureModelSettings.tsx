import React, { useEffect, useState } from 'react';
import type { AppSettings, ImageCompanionStatus, LocalModel } from '@nekko-agent/shared';

/** A picture model an agent can use now: `create`, `edit`, never a video model. */
export interface PictureModelChoice {
  id: string;
  name: string;
  edits: boolean;
}

/**
 * The daemon's rule (`Server::ready_media_models`): an image model whose
 * companion files are all on disk, or that needs none; video models are left out.
 */
export function readyPictureModels(models: LocalModel[], statuses: Record<string, ImageCompanionStatus | null>): PictureModelChoice[] {
  return models.filter((m) => m.modality === 'image').flatMap((m) => {
    const status = statuses[m.id];
    if (status && !status.ready) return [];
    const can = status ? status.capabilities ?? [] : ['create'];
    if (can.includes('video')) return [];
    return [{ id: m.id, name: m.name || m.id, edits: can.includes('edit') }];
  });
}

/**
 * Settings → Agents: the picture model a chat's agent uses when neither it
 * nor the chat names one (media tools for chat agents, decision 1). Automatic
 * leaves the daemon's own choice.
 */
export function PictureModelControl({ value, choices, onChange }: { value: string | undefined; choices: PictureModelChoice[] | null; onChange: (id: string | undefined) => void }) {
  if (choices === null) return <p className="text-xs text-ink-faint">Looking for picture models…</p>;
  if (!choices.length) return <p className="text-xs text-ink-faint">No picture model is ready on this computer. Get one from a Photo chat; agents can then make pictures.</p>;
  const missing = value && !choices.some((c) => c.id === value);
  return <label className="flex flex-wrap items-center gap-2 text-xs">
    <span className="flex-1 text-ink-soft">Picture model</span>
    <select aria-label="Picture model for agents" className="quiet-field w-auto max-w-[55%] shrink-0 text-xs" value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
      <option value="">Automatic</option>
      {choices.map((c) => <option key={c.id} value={c.id}>{c.edits ? `${c.name} · edits too` : c.name}</option>)}
      {missing && <option value={value}>{value} (not ready)</option>}
    </select>
    <span className="w-full text-2xs text-ink-faint">{missing ? 'This model is not ready on this computer, so agents use Automatic until it is.' : 'Used when the agent and the chat name none. Automatic: the chat’s Photo model, else the first ready one.'}</span>
  </label>;
}

/**
 * Settings' word on vector pictures (SVG, #2973): what an agent gets when it
 * asks for one here, and the better option when there is one to add.
 */
export function vectorLine(hasOpenRouter: boolean, hasLocal: boolean): { lead: string; detail: string } {
  if (hasOpenRouter) {
    return { lead: 'Recraft through OpenRouter · recommended', detail: 'Clean, editable SVG for logos and icons, about $0.08 a picture on your OpenRouter account, asked first.' };
  }
  if (hasLocal) {
    return { lead: 'Traced from this computer’s pictures · free', detail: 'Fine for flat art, cruder than a real vector. Add OpenRouter as a model provider for clean SVG from Recraft.' };
  }
  return { lead: 'Not available yet', detail: 'Get a picture model from a Photo chat to trace pictures locally, or add OpenRouter as a model provider for Recraft.' };
}

export function VectorGraphicsLine({ hasOpenRouter, hasLocal }: { hasOpenRouter: boolean; hasLocal: boolean }) {
  const { lead, detail } = vectorLine(hasOpenRouter, hasLocal);
  return <div className="mt-3 flex flex-wrap items-baseline gap-x-2 text-xs" data-vector-graphics>
    <span className="flex-1 text-ink-soft">Vector graphics (SVG)</span>
    <span className="text-ink">{lead}</span>
    <span className="w-full text-2xs text-ink-faint">{detail}</span>
  </div>;
}

export function PictureModelSettings({ settings, update }: { settings: AppSettings; update: (patch: Partial<AppSettings>) => Promise<void> }) {
  const [choices, setChoices] = useState<PictureModelChoice[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    void (async () => {
      const models = (await window.nekko.engineModels().catch(() => [] as LocalModel[])).filter((m) => m.modality === 'image');
      const statuses: Record<string, ImageCompanionStatus | null> = {};
      await Promise.all(models.map(async (m) => { statuses[m.id] = await window.nekko.engineImageCompanions(m.id).catch(() => null); }));
      if (live) setChoices(readyPictureModels(models, statuses));
    })();
    return () => { live = false; };
  }, []);
  const save = (id: string | undefined) => { setError(''); void update({ agentPictureModel: id }).catch((e) => setError(String(e))); };
  return <div className="min-w-0">
    <PictureModelControl value={settings.agentPictureModel} choices={choices} onChange={save} />
    {choices !== null && <VectorGraphicsLine
      hasOpenRouter={settings.providers.some((p) => p.kind === 'openrouter' && p.enabled !== false)}
      hasLocal={choices.length > 0} />}
    {error && <p role="alert" className="mt-2 text-xs text-danger-text">{error}</p>}
  </div>;
}
