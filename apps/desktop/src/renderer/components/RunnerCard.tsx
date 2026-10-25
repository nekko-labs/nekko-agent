import React, { useState } from 'react';
import {
  STATE_LABELS,
  auditText,
  formatMinutes,
  reasonText,
  runnerSubtitle,
  runnerTitle,
  slotLines,
  type RunnerState,
  type RunnerView,
} from '@nekko-agent/shared';
import { Badge, StatusDot, Toggle } from './primitives/index.js';
import type { StatusTone } from '../tokens.js';
import { GearIcon } from '../icons.js';

const TONE: Record<RunnerState, StatusTone> = {
  off: 'neutral', waiting: 'warning', ready: 'success', running: 'running', draining: 'warning', cleaning: 'info', error: 'danger',
};

const hhmm = (ts: number) => {
  const d = new Date(ts * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** One connected runner (mockup 3): state, slots, the Mac's facts and recent jobs. */
export function RunnerCard({ view, now, onSettings, onChanged }: { view: RunnerView; now: number; onSettings(): void; onChanged(v: RunnerView): void }) {
  const [busy, setBusy] = useState(false);
  const { config, state, host, today } = view;
  const sampled = host.ramMb > 0;
  const power = host.onBattery === null ? 'Unknown' : host.onBattery ? `On battery, ${host.batteryPct ?? 0}%` : 'On AC';
  const network = host.networkId === null ? 'Unknown' : host.networkTrusted ? 'Trusted' : 'Not trusted';

  const setEnabled = async (enabled: boolean) => {
    setBusy(true);
    try {
      onChanged(await window.nekko.setRunnerEnabled(config.id, enabled));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3.5 rounded-xl border px-4 py-3.5" style={{ borderColor: 'var(--line)', background: 'var(--surface)' }} data-runner-card={config.id}>
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <StatusDot tone={TONE[state] ?? 'neutral'} pulse={state === 'running'} />
          <div className="min-w-0">
            <p className="text-[14.5px] font-semibold">{runnerTitle(view)}</p>
            <p className="text-[12.5px] text-ink-faint">{runnerSubtitle(view)}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={TONE[state] ?? 'neutral'}>{STATE_LABELS[state] ?? state}</Badge>
          <Toggle value={config.settings.enabled} disabled={busy} onChange={(v) => void setEnabled(v)} label="Runner on" />
          <button className="btn btn-outline px-2! py-1!" aria-label="Runner settings" title="Runner settings" onClick={onSettings}>
            <GearIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {state === 'error' && view.error && (
        <p
          role="alert"
          className="mt-3 rounded-xl border px-3 py-2 text-[12.5px]"
          style={{ borderColor: 'var(--danger)', background: 'color-mix(in srgb, var(--danger) 10%, transparent)' }}
        >
          {view.error}
        </p>
      )}

      {(state === 'waiting' || state === 'draining') && view.reasons.length > 0 && (
        <ul className="mt-3 space-y-0.5 text-[12.5px] text-ink-soft">
          {view.reasons.map((r) => <li key={r}>{reasonText(r).sentence}</li>)}
        </ul>
      )}

      <div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-2.5">
        {slotLines(view, now).map((s) => (
          <div key={s.title} className={`rounded-xl border px-3 py-2.5 ${s.dim ? 'opacity-50' : ''}`} style={{ borderColor: 'var(--line)', background: 'var(--paper)' }}>
            <p className="font-mono text-[11px] uppercase tracking-wide text-ink-faint">{s.title}</p>
            <p className={`mt-0.5 text-[13px] ${s.progress > 0 ? '' : 'text-ink-faint'}`}>{s.text}</p>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full" style={{ background: 'var(--surface-2)' }}>
              <div className="h-full rounded-full" style={{ width: `${s.progress * 100}%`, background: 'var(--accent)' }} />
            </div>
          </div>
        ))}
      </div>

      <div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2 text-[12.5px] text-ink-soft">
        <div>
          <b className="block text-[13px] text-ink">
            {sampled ? `${Math.round(config.settings.memoryPerVmMb / 1024)} GB · ${host.cpusPerVm} cores` : 'VM support unavailable'}
          </b>
          per VM
        </div>
        <div><b className="block text-[13px] text-ink">Power</b>{power}</div>
        <div><b className="block text-[13px] text-ink">Network</b>{network}</div>
        <div><b className="block text-[13px] text-ink">Today</b>{`${today.jobs} jobs · ${formatMinutes(today.seconds)}`}</div>
      </div>

      {view.recent.length > 0 && (
        <ul className="mt-3 space-y-1 border-t pt-2.5 text-[12px] text-ink-soft" style={{ borderColor: 'var(--line)' }}>
          {view.recent.map((l, i) => (
            <li key={`${l.ts}-${i}`} className="flex items-center gap-2">
              <StatusDot tone={l.result === 'finished' ? 'success' : 'warning'} size={6} />
              <code className="font-mono text-[11px] text-ink-faint">{hhmm(l.ts)}</code>
              <span className="min-w-0 truncate">{auditText(l, config.settings.rerunLostJobs)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
