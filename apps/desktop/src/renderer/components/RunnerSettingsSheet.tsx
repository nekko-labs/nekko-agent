import React, { useEffect, useRef, useState } from 'react';
import {
  KEEP_AWAKE_LABELS,
  LINUX_SLOT_CHOICES,
  MAX_JOB_CHOICES,
  PRIORITIES,
  PRIORITY_LABELS,
  READY_VM_CHOICES,
  readyVms,
  VPN_DIRECT_LABEL,
  formatMinutes,
  settingsPatch,
  recommendationText,
  slotLimitText,
  suggestedSizeRow,
  type ImageView,
  type KeepAwake,
  type LinuxImageView,
  type RunnerSettings,
  type RunnerView,
} from '@nekko-agent/shared';
import { Badge, Modal, Toggle } from './primitives/index.js';
import { confirmDeletion } from './DeleteConfirmation.js';
import { useStore } from '../store.js';

const MAX_TRUSTED_NETWORKS = 32;
const GB = 1024;

/**
 * Save sends only the keys the owner changed against `base`, the settings as
 * they were when editing began (never `enabled`, which is the switch's), so a
 * push during the edit is not reverted; the result is what the daemon kept
 * after clamping.
 */
export async function saveSettings(
  view: RunnerView,
  base: RunnerSettings,
  draft: RunnerSettings,
  deps: {
    updateRunner(id: string, settings: Partial<RunnerSettings>): Promise<RunnerView>;
    approveRunnerNetwork?(id: string, settings: Partial<RunnerSettings>, networkId: string): Promise<RunnerView>;
    pushToast(kind: 'error', message: string): void;
  },
  pendingNetwork: string | null = null,
): Promise<{ view: RunnerView; draft: RunnerSettings } | null> {
  try {
    const { enabled: _switch, ...patch } = settingsPatch(base, draft);
    let kept: RunnerView;
    if (pendingNetwork !== null) {
      if (pendingNetwork !== view.host.networkId) throw new Error('The network changed. Choose the current network or undo the pending approval.');
      if (!deps.approveRunnerNetwork) throw new Error('Update Nekko to approve a network.');
      kept = await deps.approveRunnerNetwork(view.config.id, patch, pendingNetwork);
    } else {
      kept = await deps.updateRunner(view.config.id, patch);
    }
    return { view: kept, draft: kept.config.settings };
  } catch (e) {
    deps.pushToast('error', `Could not save runner settings: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** Segmented buttons, styled like the Workflows rail's Group by. */
function Seg<T extends string | number>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: { value: T; label: string; disabled?: boolean }[];
  onChange(v: T): void;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1">
      {options.map((o) => (
        <button
          key={`${o.value}-${o.label}`}
          type="button"
          aria-pressed={o.value === value && !o.disabled}
          disabled={o.disabled}
          className={`rounded-lg border px-2 py-1 text-xs transition disabled:opacity-40 ${o.value === value && !o.disabled ? 'border-transparent' : 'border-line text-ink-faint'}`}
          style={o.value === value && !o.disabled ? { background: 'var(--accent-soft)', color: 'var(--accent)' } : undefined}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const Row = ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) => (
  <div className="grid gap-x-3 gap-y-1 sm:grid-cols-[200px_1fr] sm:items-center">
    <p className="text-sm font-medium text-ink">
      {label}
      {hint && <span className="block text-xs font-normal text-ink-faint">{hint}</span>}
    </p>
    <div className="min-w-0">{children}</div>
  </div>
);

const Check = ({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange(v: boolean): void; disabled?: boolean }) => (
  <label className="flex items-center gap-2 text-sm text-ink">
    <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    {label}
  </label>
);

const UNSAMPLED = "Waiting for this Mac's first reading.";
/** A Mac without VM support is never sampled: its error says why, where waiting would never end. */
const Unsampled = ({ error }: { error: string | null }) => <span className="text-xs text-ink-faint">{error ?? UNSAMPLED}</span>;

const Val = ({ children }: { children: React.ReactNode }) => <span className="ml-3 whitespace-nowrap font-mono text-xs text-ink-soft">{children}</span>;

const KEEP_AWAKE: KeepAwake[] = ['systemDefault', 'whileActive', 'always'];

const LINUX_STAGES: Record<NonNullable<LinuxImageView['stage']>, string> = {
  download: 'Downloading', assemble: 'Unpacking', provision: 'Installing', test: 'Test boot', finish: 'Finishing',
};

/** The Linux image: set it up, watch it build, rebuild it. About 10 minutes, no Xcode. */
export function LinuxImageRow({ image, onAction }: { image: LinuxImageView; onAction?(action: 'build' | 'cancel'): void }) {
  const about = image.proof ? [image.proof.distro, image.proof.runner && `runner ${image.proof.runner}`, image.proof.docker && `Docker ${image.proof.docker}`].filter(Boolean).join(' · ') : null;
  return (
    <Row label="Linux image" hint="Ubuntu 24.04, built on this Mac">
      {image.state === 'building' ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs text-ink-soft">
            {`${image.stage ? LINUX_STAGES[image.stage] : 'Working'}: ${image.message ?? ''}${image.progress !== null ? ` ${Math.round(image.progress * 100)}%` : ''}`}
          </span>
          {onAction && <button type="button" className="btn btn-outline py-1! text-xs" onClick={() => onAction('cancel')}>Cancel</button>}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          {onAction && (
            <button type="button" className="btn btn-outline py-1! text-xs" onClick={() => onAction('build')}>
              {image.state === 'ready' ? 'Rebuild Linux image' : 'Set up Linux image'}
            </button>
          )}
          {image.state === 'ready' && about && <span className="text-xs text-ink-faint">{about}</span>}
          {image.state === 'none' && <span className="text-xs text-ink-faint">Downloads about 600 MB and takes about 10 minutes.</span>}
        </div>
      )}
      {image.state === 'failed' && image.message && <p className="mt-1 text-xs text-danger">{image.message}</p>}
    </Row>
  );
}

export const CLOUD_PICKER_LABEL = 'Let the Nekko Cloud picker send jobs here';

/** The settings form (mockup 4); pure so tests render it statically. */
export function SettingsBody({ view, image = null, linuxImage = null, onLinuxImage, draft, onDraft, onEnabled, onSave, onApplySize, onRemove, onCancel, onRebuild, onRefresh, saving, saveError = null, toggling = false, pendingNetwork = null, onPendingNetwork }: {
  view: RunnerView;
  image?: ImageView | null;
  /** `null` while unknown, or where the daemon builds no Linux image. */
  linuxImage?: LinuxImageView | null;
  onLinuxImage?(action: 'build' | 'cancel'): void;
  draft: RunnerSettings;
  onDraft(d: RunnerSettings): void;
  pendingNetwork?: string | null;
  onPendingNetwork?(id: string | null): void;
  onEnabled(v: boolean): void;
  onSave(): void;
  /** Saves the suggested size at once, apart from Save. */
  onApplySize?(patch: Pick<RunnerSettings, 'cpusPerVm' | 'memoryPerVmMb'>): void;
  onRemove(): void;
  onCancel?(): void;
  onRebuild?(): void;
  onRefresh?(): void;
  saving: boolean;
  saveError?: string | null;
  toggling?: boolean;
}) {
  const { host } = view;
  const set = <K extends keyof RunnerSettings>(k: K, v: RunnerSettings[K]) => onDraft({ ...draft, [k]: v });
  const enabled = view.config.settings.enabled;
  const sampled = host.ramMb > 0;
  const currentNetwork = host.networkId;
  const networkSaved = currentNetwork !== null && draft.trustedNetworks.includes(currentNetwork);
  const removingCurrent = currentNetwork !== null && !networkSaved && view.config.settings.trustedNetworks.includes(currentNetwork);
  const networkPending = currentNetwork !== null && pendingNetwork === currentNetwork;
  const networksFull = draft.trustedNetworks.length >= MAX_TRUSTED_NETWORKS;
  const capGb = Math.max(4, Math.floor((0.75 * host.ramMb) / GB));
  const maxCpus = Math.max(2, host.cores - 2);
  const recommendation = recommendationText(host);
  const suggested = suggestedSizeRow(view);
  const jobChoices = MAX_JOB_CHOICES.includes(draft.maxJobMinutes) ? MAX_JOB_CHOICES : [...MAX_JOB_CHOICES, draft.maxJobMinutes];

  return (
    <div className="flex flex-col gap-4 p-5" aria-busy={saving}>
      <h2 className="text-base font-semibold text-ink">Runner settings · This Mac</h2>

      <fieldset disabled={saving} className="flex min-w-0 flex-col gap-4">
      <Row label="Runner">
        <div className="flex items-center gap-3">
          <Toggle value={enabled} disabled={toggling} onChange={onEnabled} label="Runner on" />
          <span className="text-xs text-ink-faint">{enabled ? 'On. Turning off stops and deletes any running VM.' : 'Off.'}</span>
        </div>
      </Row>
      <Row label="Priority">
        <Seg label="Priority" value={draft.priority} options={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABELS[p] }))} onChange={(v) => set('priority', v)} />
      </Row>
      <Row label="Keep awake" hint="sleep normally, or stay up for jobs">
        <Seg label="Keep awake" value={draft.keepAwake} options={KEEP_AWAKE.map((k) => ({ value: k, label: KEEP_AWAKE_LABELS[k] }))} onChange={(v) => set('keepAwake', v)} />
      </Row>
      <Row label="VMs kept ready" hint="booted, so a job starts at once">
        <Seg
          label="VMs kept ready"
          value={readyVms(draft)}
          options={READY_VM_CHOICES.map((n) => ({ value: n, label: String(n), disabled: n > draft.macosSlots }))}
          onChange={(v) => set('readyVms', v)}
        />
      </Row>
      <Row label="macOS slots" hint="Apple allows 2 per Mac">
        <Seg
          label="macOS slots"
          value={draft.macosSlots}
          options={[...[0, 1, 2].map((n) => ({ value: n, label: String(n) })), { value: 3, label: '3 not allowed', disabled: true }]}
          onChange={(v) => set('macosSlots', v)}
        />
        {view.limit && <p className="mt-1 text-xs text-ink-faint">{slotLimitText(view.limit)}</p>}
      </Row>
      <Row label="Linux slots" hint="ARM64 Ubuntu with Docker; no Apple limit">
        <Seg
          label="Linux slots"
          value={Math.min(draft.linuxSlots, LINUX_SLOT_CHOICES[LINUX_SLOT_CHOICES.length - 1])}
          options={LINUX_SLOT_CHOICES.map((n) => ({ value: n, label: String(n) }))}
          onChange={(v) => set('linuxSlots', v)}
        />
        <p className="mt-1 text-xs text-ink-faint">
          {`Jobs with runs-on [self-hosted, Linux, ARM64] or ${view.config.label}-linux boot one when queued. They share the runner memory, after the macOS slots.`}
        </p>
      </Row>
      {(draft.linuxSlots > 0 || (linuxImage && linuxImage.state !== 'none')) && linuxImage && (
        <LinuxImageRow image={linuxImage} onAction={onLinuxImage} />
      )}
      {suggested && (
        <Row label="Suggested size" hint="from what your jobs used">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-ink">{suggested.line}</span>
            {suggested.apply && onApplySize && (
              <button type="button" className="btn btn-outline py-1! text-xs" disabled={saving} onClick={() => suggested.apply && onApplySize(suggested.apply)}>Apply</button>
            )}
          </div>
          {suggested.reasons.length > 0 && <p className="mt-1 text-xs text-ink-faint">{suggested.reasons.join(' ')}</p>}
        </Row>
      )}
      <Row label="Memory per VM" hint={sampled ? `${Math.round(host.ramMb / GB)} GB Mac, runner cap ${Math.round(host.runnerMemoryMb / GB)} GB` : undefined}>
        {sampled ? (
          <div className="flex items-center">
            <input
              type="range" className="flex-1" min={4} max={64} step={1} aria-label="Memory per VM in GB"
              value={Math.round(draft.memoryPerVmMb / GB)} onChange={(e) => set('memoryPerVmMb', Number(e.target.value) * GB)}
            />
            <Val>{`${Math.round(draft.memoryPerVmMb / GB)} GB`}</Val>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-mono text-xs text-ink-soft">{`${Math.round(draft.memoryPerVmMb / GB)} GB per VM`}</span>
            <Unsampled error={view.error} />
          </div>
        )}
      </Row>
      <Row label="Total runner memory">
        <div role="radiogroup" aria-label="Total runner memory" className="flex flex-wrap items-center gap-3 text-sm text-ink">
          <label className="flex items-center gap-2">
            <input type="radio" name="runner-memory" disabled={!sampled} checked={draft.runnerMemoryMb === null} onChange={() => set('runnerMemoryMb', null)} />
            Use the recommendation
          </label>
          {sampled ? (
            <label className="flex items-center gap-2">
              <input type="radio" name="runner-memory" checked={draft.runnerMemoryMb !== null} onChange={() => set('runnerMemoryMb', host.recommendedMemoryMb || 4 * GB)} />
              <input
                type="number" className="input w-20" min={4} max={capGb} aria-label="Total runner memory in GB" disabled={draft.runnerMemoryMb === null}
                value={Math.round((draft.runnerMemoryMb ?? host.recommendedMemoryMb) / GB) || ''} onChange={(e) => set('runnerMemoryMb', Number(e.target.value) * GB)}
              />
              GB
            </label>
          ) : (
            <label className="flex items-center gap-2">
              <input type="radio" name="runner-memory" disabled checked={draft.runnerMemoryMb !== null} onChange={() => {}} />
              {draft.runnerMemoryMb !== null && `${Math.round(draft.runnerMemoryMb / GB)} GB`}
            </label>
          )}
          {!sampled && <Unsampled error={view.error} />}
        </div>
        {recommendation && <p className="mt-1 text-xs text-ink-faint">{recommendation}</p>}
      </Row>
      <Row label="CPU per VM">
        <div className="flex flex-wrap items-center gap-3">
          <Check
            label="Mode default" disabled={!sampled} checked={draft.cpusPerVm === null}
            onChange={(v) => set('cpusPerVm', v ? null : Math.min(maxCpus, Math.max(2, host.cpusPerVm)))}
          />
          {sampled ? (
            <div className="flex min-w-40 flex-1 items-center">
              <input
                type="range" className="flex-1" min={2} max={maxCpus} step={1} aria-label="CPU per VM" disabled={draft.cpusPerVm === null}
                value={draft.cpusPerVm ?? host.cpusPerVm} onChange={(e) => set('cpusPerVm', Number(e.target.value))}
              />
              <Val>{`${draft.cpusPerVm ?? host.cpusPerVm} of ${host.cores}`}</Val>
            </div>
          ) : (
            <>
              {draft.cpusPerVm !== null && <Val>{`${draft.cpusPerVm} per VM`}</Val>}
              <Unsampled error={view.error} />
            </>
          )}
        </div>
      </Row>
      <Row label="Disk" hint="images and clones">
        <div className="flex flex-wrap items-center gap-3 text-sm text-ink">
          <label className="flex items-center gap-2">
            Image budget
            <input type="number" className="input w-24" min={50} max={4000} value={draft.diskBudgetGb} onChange={(e) => set('diskBudgetGb', Number(e.target.value))} />
            GB
          </label>
          <label className="flex items-center gap-2">
            Keep free
            <input type="number" className="input w-20" min={10} max={1000} value={draft.diskFloorGb} onChange={(e) => set('diskFloorGb', Number(e.target.value))} />
            GB
          </label>
        </div>
      </Row>
      <Row label="Only when">
        <div className="flex flex-col gap-2">
          <Check label="On power" checked={draft.onlyOnPower} onChange={(v) => set('onlyOnPower', v)} />
          <Check label="Trusted networks" checked={draft.trustedNetworksOnly} onChange={(v) => set('trustedNetworksOnly', v)} />
          <Check label="Never on hotspots" checked={draft.neverOnHotspot} onChange={(v) => set('neverOnHotspot', v)} />
          <Check label={VPN_DIRECT_LABEL} checked={draft.allowDirectWithVpn} onChange={(v) => set('allowDirectWithVpn', v)} />
        </div>
      </Row>
      <Row label="Trusted networks" hint="recognised by the router's hardware address">
        <div className="flex flex-col gap-2">
          {currentNetwork === null ? (
            <div role="status">
              <p className="text-sm text-ink">No network detected</p>
              <p className="text-xs text-ink-faint">This Mac couldn’t identify its router. Reconnect to Wi-Fi or Ethernet and wait for detection before approving.</p>
            </div>
          ) : (
            <div role="status" className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-ink">Current network</span>
              <code className="font-mono text-xs text-ink-soft">{currentNetwork}</code>
              {networkSaved ? <Badge tone="success">Trusted</Badge> : <Badge tone="neutral">{removingCurrent ? 'Will be removed after Save' : 'Not trusted'}</Badge>}
            </div>
          )}
          {pendingNetwork !== null && (
            <div className="flex flex-wrap items-center gap-2">
              <p role="status" className="text-xs text-ink-soft">{networkPending ? 'Will be trusted after Save.' : 'Network changed. Choose the current network or undo this approval.'}</p>
              <button type="button" className="btn btn-outline px-2! py-0.5! text-xs" onClick={() => onPendingNetwork?.(null)}>Undo approval</button>
            </div>
          )}
          {currentNetwork !== null && !networkSaved && !networkPending && (
            networksFull ? <p className="text-xs text-ink-faint">Remove a saved network before adding another (32 maximum).</p> :
              <button type="button" className="btn btn-outline self-start py-1! text-xs" onClick={() => onPendingNetwork?.(currentNetwork)}>Trust this network</button>
          )}
          {draft.trustedNetworks.length > 0 && (
            <ul className="flex flex-col gap-1" aria-label="Saved networks">
              {draft.trustedNetworks.map((id) => (
                <li key={id} className="flex items-center gap-2 text-xs">
                  <code className="font-mono text-xs text-ink-soft">{id}</code>
                  {id === currentNetwork && <Badge tone="success">This network</Badge>}
                  <button type="button" aria-label={`Remove ${id}`} className="btn btn-outline ml-auto px-2! py-0.5! text-xs" onClick={() => set('trustedNetworks', draft.trustedNetworks.filter((x) => x !== id))}>Remove</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Row>
      <Row label="Safety">
        <Check label="Re-run jobs lost to sleep" checked={draft.rerunLostJobs} onChange={(v) => set('rerunLostJobs', v)} />
      </Row>
      {!view.config.id.startsWith('gl-') && (
        <Row label="Nekko Cloud" hint="Pro or Enterprise; GitHub only">
          <Check label={CLOUD_PICKER_LABEL} checked={draft.cloudPicker} onChange={(v) => set('cloudPicker', v)} />
          <p className="mt-1 text-xs text-ink-faint">Shares this runner's label, its repos and how many VMs are free with Nekko Cloud, so a workflow's picker job can send jobs here and use a hosted runner when none is free.</p>
          {view.cloudPickerError && draft.cloudPicker && <p role="alert" className="mt-1 text-xs text-danger" data-testid="runner-cloud-picker-error">{view.cloudPickerError}</p>}
        </Row>
      )}
      <Row label="Max job time">
        <Seg label="Max job time" value={draft.maxJobMinutes} options={jobChoices.map((m) => ({ value: m, label: formatMinutes(m * 60) }))} onChange={(v) => set('maxJobMinutes', v)} />
      </Row>
      {image?.state === 'ready' && (
        <Row label="VM image" hint="how macOS, Xcode and runner updates arrive">
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className="btn btn-outline py-1! text-xs" onClick={onRebuild}>Rebuild image</button>
            {onRefresh && <button type="button" className="btn btn-outline py-1! text-xs" onClick={onRefresh}>Update scripts</button>}
            {image.info && <span className="text-xs text-ink-faint">{`macOS ${image.info.macos}${image.info.xcode ? ` · Xcode ${image.info.xcode}` : ''}`}</span>}
          </div>
          {onRefresh && <p className="mt-1 text-xs text-ink-faint">Update scripts puts this version of Nekko's scripts into the image in a few minutes. A new macOS or Xcode needs Rebuild image.</p>}
        </Row>
      )}

      </fieldset>

      {/* Sticky: the sheet is taller than a laptop window, and Save must stay in reach. */}
      <div className="sticky bottom-0 -mx-5 -mb-5 flex flex-wrap items-center gap-2 border-t bg-surface px-5 pt-3 pb-5" style={{ borderColor: 'var(--line)' }}>
        {saving && <p role="status" className="w-full text-sm text-ink-soft">Saving runner settings…</p>}
        {saveError && <p role="alert" className="w-full text-sm text-danger">{saveError}</p>}
        <button type="button" className="btn btn-outline text-[var(--danger)]" disabled={saving} onClick={onRemove}>Remove runner</button>
        <button type="button" className="btn btn-outline ml-auto" disabled={saving} onClick={onCancel}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={saving} onClick={onSave}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  );
}

/**
 * What the form shows: the owner's edits once there are any, otherwise the
 * runner's settings as last pushed, so a push while the sheet is open is not
 * overwritten by Save.
 */
export const shownSettings = (view: RunnerView, edits: RunnerSettings | null): RunnerSettings => edits ?? view.config.settings;

export interface Edits { base: RunnerSettings; draft: RunnerSettings }
/** The first edit snapshots the settings it started from; later edits keep that base. */
export const editDraft = (edits: Edits | null, view: RunnerView, draft: RunnerSettings): Edits => ({ base: edits?.base ?? view.config.settings, draft });

/** Runner settings for one runner. Save closes only after the daemon confirms persistence. */
export function RunnerSettingsSheet({ view, image = null, onClose, onRebuild, onRefresh, beginReply }: { view: RunnerView; image?: ImageView | null; onClose(): void; onRebuild?(): void; onRefresh?(): Promise<void>; beginReply(): (v: RunnerView) => void }) {
  const pushToast = useStore((s) => s.pushToast);
  const [edits, setEdits] = useState<Edits | null>(null);
  const draft = shownSettings(view, edits?.draft ?? null);
  const [pendingNetwork, setPendingNetwork] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const close = () => { if (!inFlight.current) onClose(); };

  const [linuxImage, setLinuxImage] = useState<LinuxImageView | null>(null);
  useEffect(() => {
    let live = true;
    // An older daemon has no Linux image channels: the row stays hidden.
    window.nekko.linuxImageStatus().then((v) => { if (live) setLinuxImage(v); }, () => {});
    const off = window.nekko.onLinuxImageChanged((v) => setLinuxImage(v));
    return () => { live = false; off(); };
  }, []);
  const linuxAction = async (action: 'build' | 'cancel') => {
    try {
      setLinuxImage(await (action === 'build' ? window.nekko.buildLinuxImage() : window.nekko.cancelLinuxImage()));
    } catch (e) {
      pushToast('error', `Couldn't ${action === 'build' ? 'set up' : 'cancel'} the Linux image: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const [toggling, setToggling] = useState(false);
  const setEnabled = async (enabled: boolean) => {
    if (toggling) return;
    setToggling(true);
    try {
      const reply = beginReply();
      reply(await window.nekko.setRunnerEnabled(view.config.id, enabled));
    } catch (e) {
      pushToast('error', `Couldn't turn the runner ${enabled ? 'on' : 'off'}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setToggling(false);
    }
  };
  const save = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      const reply = beginReply();
      const res = await saveSettings(view, edits?.base ?? view.config.settings, draft, {
        updateRunner: window.nekko.updateRunner,
        approveRunnerNetwork: window.nekko.approveRunnerNetwork,
        pushToast: (_kind, message) => setSaveError(message),
      }, pendingNetwork);
      if (!res) return;
      reply(res.view);
      pushToast('success', 'Runner settings saved.');
      onClose();
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };
  // Apply saves the two sizes now and keeps any other edits in the form.
  const applySize = async (patch: Pick<RunnerSettings, 'cpusPerVm' | 'memoryPerVmMb'>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaveError(null);
    setSaving(true);
    try {
      const reply = beginReply();
      reply(await window.nekko.updateRunner(view.config.id, patch));
      setEdits((e) => e && { base: { ...e.base, ...patch }, draft: { ...e.draft, ...patch } });
    } catch (e) {
      setSaveError(`Could not apply the suggested size: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };
  const refresh = async () => {
    try {
      await onRefresh?.();
    } catch (e) {
      pushToast('error', `Couldn't update the image's scripts: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const remove = async () => {
    if (!(await confirmDeletion('Remove this runner? Its VMs stop and its GitHub registration is removed.'))) return;
    try {
      await window.nekko.removeRunner(view.config.id);
      onClose();
    } catch (e) {
      pushToast('error', `Could not remove the runner: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <Modal title="Runner settings · This Mac" onClose={close} overlayClassName="p-4" className="card w-[720px] max-w-[94vw] max-h-[90vh] overflow-y-auto shadow-(--shadow-float)">
      <SettingsBody
        view={view}
        image={image}
        linuxImage={linuxImage}
        onLinuxImage={(a) => void linuxAction(a)}
        draft={draft}
        onDraft={(d) => setEdits((e) => editDraft(e, view, d))}
        pendingNetwork={pendingNetwork}
        onPendingNetwork={(id) => { setPendingNetwork(id); setSaveError(null); }}
        onEnabled={(v) => void setEnabled(v)}
        onSave={() => void save()}
        onApplySize={(p) => void applySize(p)}
        onRemove={() => void remove()}
        onCancel={close}
        onRebuild={onRebuild}
        onRefresh={onRefresh && (() => void refresh())}
        saving={saving}
        saveError={saveError}
        toggling={toggling}
      />
    </Modal>
  );
}
