import React, { useState } from 'react';
import {
  NO_IMAGE_ERROR,
  STATE_LABELS,
  auditText,
  imageBusy,
  imageFraction,
  imageLine,
  networkText,
  reasonText,
  runnerSubtitle,
  runnerTitle,
  scopeName,
  slotLines,
  todayText,
  type ImageView,
  type RunnerState,
  type RunnerView,
} from '@nekko-agent/shared';
import { Badge, StatusDot, Toggle } from './primitives/index.js';
import type { StatusTone } from '../tokens.js';
import { connectToWorkflow } from './RunnerReady.js';
import { GearIcon } from '../icons.js';
import { useStore } from '../store.js';

const TONE: Record<RunnerState, StatusTone> = {
  off: 'neutral', waiting: 'warning', ready: 'success', running: 'running', draining: 'warning', cleaning: 'info', error: 'danger',
};

const hhmm = (ts: number) => {
  const d = new Date(ts * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** Where the image stands: the same stage and bar as the setup sheet, so the sheet is optional. */
function ImageRow({ image, onSetup }: { image: ImageView; onSetup?(): void }) {
  const fraction = imageFraction(image);
  const busy = imageBusy(image);
  const action = busy ? 'Details' : image.canResume ? 'Resume setup' : 'Set up this Mac';
  return (
    <div className="mt-3 rounded-xl border px-3 py-2" style={{ borderColor: 'var(--line)', background: 'var(--paper)' }}>
      <div className="flex items-center gap-3">
        <p role={image.state === 'failed' ? 'alert' : undefined} className="min-w-0 flex-1 text-xs text-ink-soft">
          {busy ? imageLine(image) : image.canResume ? 'Setup paused. Finished stages are kept.' : 'One click, then it builds your job VM by itself.'}
        </p>
        <button className={`btn py-1! text-xs ${busy ? 'btn-outline' : 'btn-primary'}`} onClick={onSetup}>{action}</button>
      </div>
      {fraction !== null && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full" style={{ background: 'var(--surface-2)' }}>
          <div className="h-full rounded-full" style={{ width: `${fraction * 100}%`, background: 'var(--accent)' }} />
        </div>
      )}
    </div>
  );
}

/** One connected runner (mockup 3): state, slots, the Mac's facts and recent jobs. */
/**
 * `beginReply` is called as a request starts and returns where its answer goes,
 * so the section can drop an answer a newer push has already overtaken.
 */
export function RunnerCard({ view: given, now, image = null, onSettings, onSetup, beginReply }: { view: RunnerView; now: number; image?: ImageView | null; onSettings(): void; onSetup?(): void; beginReply(): (v: RunnerView) => void }) {
  const [busy, setBusy] = useState(false);
  const pushToast = useStore((s) => s.pushToast);
  const settingUp = image !== null && (image.state !== 'ready' || image.canResume);
  // Setup is the answer to "No VM image yet", so the runner is waiting for it, not failing.
  const view: RunnerView = settingUp && given.error === NO_IMAGE_ERROR ? { ...given, state: 'waiting', error: null } : given;
  const { config, state, host, today } = view;
  const sampled = host.ramMb > 0;
  const power = host.onBattery === null ? 'Unknown' : host.onBattery ? `On battery, ${Math.round(host.batteryPct ?? 0)}%` : 'On AC';
  const network = networkText(host);

  const setEnabled = async (enabled: boolean) => {
    setBusy(true);
    try {
      const reply = beginReply();
      reply(await window.nekko.setRunnerEnabled(config.id, enabled));
    } catch (e) {
      pushToast('error', `Couldn't turn the runner ${enabled ? 'on' : 'off'}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 rounded-xl border px-4 py-3" style={{ borderColor: 'var(--line)', background: 'var(--surface)' }} data-runner-card={config.id}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <StatusDot tone={TONE[state] ?? 'neutral'} pulse={state === 'running'} />
          <div className="min-w-0">
            <p className="text-sm font-semibold">{runnerTitle(view)}</p>
            <p className="text-xs text-ink-faint">{runnerSubtitle(view)}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={TONE[state] ?? 'neutral'}>{STATE_LABELS[state] ?? state}</Badge>
          <Toggle value={config.settings.enabled} disabled={busy} onChange={(v) => void setEnabled(v)} label={`Runner on for ${scopeName(config.scope)}`} />
          <button className="btn btn-outline px-2! py-1!" aria-label={`Runner settings for ${scopeName(config.scope)}`} title="Runner settings" onClick={onSettings}>
            <GearIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Any state: an Off runner on a Mac without VM support still carries why. */}
      {view.error && (
        <p
          role="alert"
          className="mt-3 rounded-xl border px-3 py-2 text-xs"
          style={{ borderColor: 'var(--danger)', background: 'color-mix(in srgb, var(--danger) 10%, transparent)' }}
        >
          {view.error}
        </p>
      )}
      {image && settingUp && <ImageRow image={image} onSetup={onSetup} />}

      {(state === 'waiting' || state === 'draining') && view.reasons.length > 0 && (
        <ul className="mt-3 space-y-0.5 text-xs text-ink-soft">
          {view.reasons.map((r) => <li key={r}>{reasonText(r).sentence}</li>)}
        </ul>
      )}

      <div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
        {slotLines(view, now).map((s) => (
          <div key={s.title} className={`rounded-xl border px-3 py-2 ${s.dim ? 'opacity-50' : ''}`} style={{ borderColor: 'var(--line)', background: 'var(--paper)' }}>
            <p className="text-xs text-ink-soft">{s.title}</p>
            <p className={`mt-0.5 text-sm ${s.progress > 0 ? '' : 'text-ink-faint'}`}>{s.text}</p>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full" style={{ background: 'var(--surface-2)' }}>
              <div className="h-full rounded-full" style={{ width: `${s.progress * 100}%`, background: 'var(--accent)' }} />
            </div>
          </div>
        ))}
      </div>

      <div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2 text-xs text-ink-soft">
        <div>
          <b className="block text-sm text-ink">
            {sampled ? `${Math.round(config.settings.memoryPerVmMb / 1024)} GB · ${host.cpusPerVm} cores` : view.error ? 'Unavailable' : 'Not known yet'}
          </b>
          per VM
        </div>
        <div><b className="block text-sm text-ink">Power</b>{power}</div>
        <div><b className="block text-sm text-ink">Network</b>{network}</div>
        <div><b className="block text-sm text-ink">Today</b>{todayText(today)}</div>
      </div>

      {view.recent.length > 0 && (
        <ul className="mt-3 space-y-1 border-t pt-2 text-xs text-ink-soft" style={{ borderColor: 'var(--line)' }}>
          {view.recent.map((l, i) => (
            <li key={`${l.ts}-${i}`} className="flex items-center gap-2">
              <StatusDot tone={l.result === 'finished' ? 'success' : 'warning'} size={6} />
              <code className="font-mono text-2xs text-ink-faint">{hhmm(l.ts)}</code>
              <span className="min-w-0 truncate">{auditText(l, config.settings.rerunLostJobs)}</span>
            </li>
          ))}
        </ul>
      )}

      {image !== null && !settingUp && (
        <div className="mt-3 flex justify-end">
          <button className="btn btn-outline py-1! text-xs" onClick={() => void connectToWorkflow(view)}>Connect to a workflow</button>
        </div>
      )}
    </div>
  );
}
