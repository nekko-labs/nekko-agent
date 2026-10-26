import React, { useState } from 'react';
import {
  KEEP_AWAKE_LABELS,
  MAX_JOB_CHOICES,
  PRIORITY_LABELS,
  VPN_DIRECT_LABEL,
  formatMinutes,
  settingsPatch,
  recommendationText,
  slotLimitText,
  type HostView,
  type KeepAwake,
  type Priority,
  type RunnerSettings,
  type RunnerView,
} from '@nekko-agent/shared';
import { Badge, Modal, Toggle } from './primitives/index.js';
import { confirmDeletion } from './DeleteConfirmation.js';
import { useStore } from '../store.js';

const MAX_TRUSTED_NETWORKS = 32;
const GB = 1024;

/** Appends the network this Mac is on, unless it is unknown, listed, or the list is full. */
export function trustNetwork(draft: RunnerSettings, host: HostView): RunnerSettings {
  const id = host.networkId;
  if (id === null || draft.trustedNetworks.includes(id) || draft.trustedNetworks.length >= MAX_TRUSTED_NETWORKS) return draft;
  return { ...draft, trustedNetworks: [...draft.trustedNetworks, id] };
}

/**
 * Save sends only the keys the owner changed (never `enabled`, which is the
 * switch's), so a change the daemon made meanwhile is not reverted; the result
 * is what the daemon kept after clamping.
 */
export async function saveSettings(
  view: RunnerView,
  draft: RunnerSettings,
  deps: { updateRunner(id: string, s: Partial<RunnerSettings>): Promise<RunnerView>; pushToast(kind: 'error', message: string): void },
): Promise<{ view: RunnerView; draft: RunnerSettings } | null> {
  try {
    const { enabled: _switch, ...patch } = settingsPatch(view.config.settings, draft);
    const kept = await deps.updateRunner(view.config.id, patch);
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
          className={`rounded-lg border px-2 py-1 text-[11.5px] transition disabled:opacity-40 ${o.value === value && !o.disabled ? 'border-transparent' : 'border-line text-ink-faint'}`}
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
    <p className="text-[13px] font-medium text-ink">
      {label}
      {hint && <span className="block text-[11.5px] font-normal text-ink-faint">{hint}</span>}
    </p>
    <div className="min-w-0">{children}</div>
  </div>
);

const Check = ({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange(v: boolean): void; disabled?: boolean }) => (
  <label className="flex items-center gap-2 text-[13px] text-ink">
    <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    {label}
  </label>
);

const UNSAMPLED = "Waiting for this Mac's first reading.";
/** A Mac without VM support is never sampled: its error says why, where waiting would never end. */
const Unsampled = ({ error }: { error: string | null }) => <span className="text-[12px] text-ink-faint">{error ?? UNSAMPLED}</span>;

const Val = ({ children }: { children: React.ReactNode }) => <span className="ml-2.5 whitespace-nowrap font-mono text-[12px] text-ink-soft">{children}</span>;

const PRIORITIES: Priority[] = ['doNotDisturb', 'balanced', 'runnerFirst'];
const KEEP_AWAKE: KeepAwake[] = ['systemDefault', 'whileActive', 'always'];

/** The settings form (mockup 4); pure so tests render it statically. */
export function SettingsBody({ view, draft, onDraft, onEnabled, onSave, onRemove, onCancel, saving, toggling = false }: {
  view: RunnerView;
  draft: RunnerSettings;
  onDraft(d: RunnerSettings): void;
  onEnabled(v: boolean): void;
  onSave(): void;
  onRemove(): void;
  onCancel?(): void;
  saving: boolean;
  toggling?: boolean;
}) {
  const { host } = view;
  const set = <K extends keyof RunnerSettings>(k: K, v: RunnerSettings[K]) => onDraft({ ...draft, [k]: v });
  const enabled = view.config.settings.enabled;
  const sampled = host.ramMb > 0;
  const capGb = Math.max(4, Math.floor((0.75 * host.ramMb) / GB));
  const maxCpus = Math.max(2, host.cores - 2);
  const recommendation = recommendationText(host);
  const jobChoices = MAX_JOB_CHOICES.includes(draft.maxJobMinutes) ? MAX_JOB_CHOICES : [...MAX_JOB_CHOICES, draft.maxJobMinutes];

  return (
    <div className="flex flex-col gap-3.5 p-5">
      <h2 className="text-[17px] font-semibold text-ink">Runner settings · This Mac</h2>

      <Row label="Runner">
        <div className="flex items-center gap-2.5">
          <Toggle value={enabled} disabled={toggling} onChange={onEnabled} label="Runner on" />
          <span className="text-[12.5px] text-ink-faint">{enabled ? 'On. Turning off stops and deletes any running VM.' : 'Off.'}</span>
        </div>
      </Row>
      <Row label="Priority">
        <Seg label="Priority" value={draft.priority} options={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABELS[p] }))} onChange={(v) => set('priority', v)} />
      </Row>
      <Row label="Keep awake" hint="sleep normally, or stay up for jobs">
        <Seg label="Keep awake" value={draft.keepAwake} options={KEEP_AWAKE.map((k) => ({ value: k, label: KEEP_AWAKE_LABELS[k] }))} onChange={(v) => set('keepAwake', v)} />
      </Row>
      <Row label="macOS slots" hint="Apple allows 2 per Mac">
        <Seg
          label="macOS slots"
          value={draft.macosSlots}
          options={[...[0, 1, 2].map((n) => ({ value: n, label: String(n) })), { value: 3, label: '3 not allowed', disabled: true }]}
          onChange={(v) => set('macosSlots', v)}
        />
        {view.limit && <p className="mt-1 text-[11.5px] text-ink-faint">{slotLimitText(view.limit)}</p>}
      </Row>
      <Row label="Memory per VM" hint={sampled ? `${Math.round(host.ramMb / GB)} GB Mac, runner cap ${Math.round(host.runnerMemoryMb / GB)} GB` : undefined}>
        <div className="flex items-center">
          <input
            type="range" className="flex-1" min={4} max={64} step={1} aria-label="Memory per VM in GB"
            value={Math.round(draft.memoryPerVmMb / GB)} onChange={(e) => set('memoryPerVmMb', Number(e.target.value) * GB)}
          />
          <Val>{`${Math.round(draft.memoryPerVmMb / GB)} GB`}</Val>
        </div>
      </Row>
      <Row label="Total runner memory">
        <div role="radiogroup" aria-label="Total runner memory" className="flex flex-wrap items-center gap-3 text-[13px] text-ink">
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
        {recommendation && <p className="mt-1 text-[11.5px] text-ink-faint">{recommendation}</p>}
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
        <div className="flex flex-wrap items-center gap-3 text-[13px] text-ink">
          <label className="flex items-center gap-1.5">
            Image budget
            <input type="number" className="input w-24" min={50} max={4000} value={draft.diskBudgetGb} onChange={(e) => set('diskBudgetGb', Number(e.target.value))} />
            GB
          </label>
          <label className="flex items-center gap-1.5">
            Keep free
            <input type="number" className="input w-20" min={10} max={1000} value={draft.diskFloorGb} onChange={(e) => set('diskFloorGb', Number(e.target.value))} />
            GB
          </label>
        </div>
      </Row>
      <Row label="Only when">
        <div className="flex flex-col gap-1.5">
          <Check label="On power" checked={draft.onlyOnPower} onChange={(v) => set('onlyOnPower', v)} />
          <Check label="Trusted networks" checked={draft.trustedNetworksOnly} onChange={(v) => set('trustedNetworksOnly', v)} />
          <Check label="Never on hotspots" checked={draft.neverOnHotspot} onChange={(v) => set('neverOnHotspot', v)} />
          <Check label={VPN_DIRECT_LABEL} checked={draft.allowDirectWithVpn} onChange={(v) => set('allowDirectWithVpn', v)} />
        </div>
      </Row>
      <Row label="Trusted networks" hint="recognised by the router's hardware address">
        <ul className="flex flex-col gap-1">
          {draft.trustedNetworks.map((id) => (
            <li key={id} className="flex items-center gap-2 text-[12.5px]">
              <code className="font-mono text-[11.5px] text-ink-soft">{id}</code>
              {id === host.networkId && <Badge tone="success">This network</Badge>}
              <button type="button" className="btn btn-outline ml-auto px-2! py-0.5! text-[11.5px]" onClick={() => set('trustedNetworks', draft.trustedNetworks.filter((x) => x !== id))}>Remove</button>
            </li>
          ))}
        </ul>
        {trustNetwork(draft, host) !== draft && (
          <button type="button" className="btn btn-outline mt-1.5 py-1! text-[12px]" onClick={() => onDraft(trustNetwork(draft, host))}>Trust this network</button>
        )}
      </Row>
      <Row label="Safety">
        <Check label="Re-run jobs lost to sleep" checked={draft.rerunLostJobs} onChange={(v) => set('rerunLostJobs', v)} />
      </Row>
      <Row label="Max job time">
        <Seg label="Max job time" value={draft.maxJobMinutes} options={jobChoices.map((m) => ({ value: m, label: formatMinutes(m * 60) }))} onChange={(v) => set('maxJobMinutes', v)} />
      </Row>

      {/* Sticky: the sheet is taller than a laptop window, and Save must stay in reach. */}
      <div className="sticky bottom-0 -mx-5 -mb-5 flex flex-wrap items-center gap-2 border-t bg-surface px-5 pt-3.5 pb-5" style={{ borderColor: 'var(--line)' }}>
        <button type="button" className="btn btn-outline text-[var(--danger)]" disabled={saving} onClick={onRemove}>Remove runner</button>
        <button type="button" className="btn btn-outline ml-auto" onClick={onCancel}>Cancel</button>
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

/** Runner settings for one runner. After Save, the form shows what the daemon kept. */
export function RunnerSettingsSheet({ view, onClose, beginReply }: { view: RunnerView; onClose(): void; beginReply(): (v: RunnerView) => void }) {
  const pushToast = useStore((s) => s.pushToast);
  const [edits, setEdits] = useState<RunnerSettings | null>(null);
  const draft = shownSettings(view, edits);
  const [saving, setSaving] = useState(false);

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
    setSaving(true);
    const reply = beginReply();
    const res = await saveSettings(view, draft, { updateRunner: window.nekko.updateRunner, pushToast });
    setSaving(false);
    if (!res) return;
    setEdits(null); // the view now carries what the daemon kept
    reply(res.view);
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
    <Modal title="Runner settings · This Mac" onClose={onClose} overlayClassName="p-4" className="card w-[720px] max-w-[94vw] max-h-[90vh] overflow-y-auto shadow-xl">
      <SettingsBody
        view={view}
        draft={draft}
        onDraft={setEdits}
        onEnabled={(v) => void setEnabled(v)}
        onSave={() => void save()}
        onRemove={() => void remove()}
        onCancel={onClose}
        saving={saving}
        toggling={toggling}
      />
    </Modal>
  );
}
