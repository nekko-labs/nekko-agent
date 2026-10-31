import React, { useId, useState } from 'react';
import type { AutomationRunPolicy, NewTask, TaskKind, KeepAlive } from '@nekko-agent/shared';
import { offlineProviderAllowed } from '@nekko-agent/shared';
import { useStore } from '../store.js';
import { CloseIcon } from '../icons.js';
import { Modal } from './primitives/index.js';
import { ClaudeReasonLine, useClaudeCapability } from './claude/ClaudeAgent.js';
import { RunPolicyField } from './RunPolicyField.js';

/**
 * Create an automation task from a chat: a one-shot **scheduled** run, a
 * **recurring** run, or a long-running **background** agent (alive forever, or
 * until a condition the agent judges met). Pre-fills the chat's project/model
 * and current draft.
 */
export function ScheduleTaskModal({
  workspaceId, providerId, modelId, initialPrompt, onClose,
}: {
  workspaceId?: string; providerId?: string; modelId?: string; initialPrompt?: string; onClose: () => void;
}) {
  const pushToast = useStore((s) => s.pushToast);
  const titleId = useId();
  // A Claude Agent on a Claude plan cannot run unattended yet (claude-policy.ts).
  const unattended = useClaudeCapability(providerId, 'unattended_runs');
  const blocked = unattended?.claude === true && unattended.state !== 'enabled' ? unattended.message ?? 'Not available for this provider.' : null;
  const [kind, setKind] = useState<TaskKind>('scheduled');
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState(initialPrompt ?? '');
  // scheduled
  const [runAt, setRunAt] = useState('');
  // recurring
  const [every, setEvery] = useState(30);
  const [unit, setUnit] = useState<'min' | 'hour' | 'day'>('min');
  // background
  const [keepAlive, setKeepAlive] = useState<KeepAlive>('forever');
  const [condition, setCondition] = useState('');
  const [runPolicy, setRunPolicy] = useState<AutomationRunPolicy | undefined>(undefined);
  const settings = useStore((s) => s.settings);
  const provider = settings?.providers?.find((p) => p.id === (providerId ?? settings?.defaultProviderId));
  const local = !!provider && offlineProviderAllowed(provider);

  const unitMs = { min: 60_000, hour: 3_600_000, day: 86_400_000 };
  const intervalMs = Math.max(1, every) * unitMs[unit];

  const valid = !blocked && prompt.trim().length > 0 && (kind !== 'scheduled' || !!runAt) && (kind !== 'background' || keepAlive === 'forever' || condition.trim().length > 0);

  const create = async () => {
    if (!valid) return;
    const task: NewTask = {
      title: title.trim() || prompt.trim().slice(0, 40) || 'Task',
      kind,
      prompt: prompt.trim(),
      workspaceId,
      providerId,
      modelId,
      ...(kind === 'scheduled' ? { runAt: new Date(runAt).getTime() } : {}),
      ...(kind === 'recurring' ? { intervalMs } : {}),
      ...(kind === 'background' ? { keepAlive, intervalMs, ...(keepAlive === 'until' ? { condition: condition.trim() } : {}) } : {}),
      ...(runPolicy ? { runPolicy } : {}),
    };
    await window.nekko.createTask(task);
    pushToast('success', `${kind === 'scheduled' ? 'Scheduled' : kind === 'recurring' ? 'Recurring' : 'Background'} task created.`);
    onClose();
  };

  const KIND_OPTS: Array<{ k: TaskKind; icon: string; label: string; sub: string }> = [
    { k: 'scheduled', icon: '⏰', label: 'Scheduled', sub: 'Run once at a time' },
    { k: 'recurring', icon: '🔁', label: 'Recurring', sub: 'Run every interval' },
    { k: 'background', icon: '♾️', label: 'Background', sub: 'Keep an agent alive' },
  ];

  return (
    <Modal
      title="Automate this agent"
      labelledBy={titleId}
      onClose={onClose}
      overlayClassName="p-4"
      className="card w-full max-w-md p-4"
    >
      <div className="flex items-center justify-between">
        <h2 id={titleId} className="text-base font-semibold">⚡ Automate this agent</h2>
        <button className="rounded-sm p-1 text-ink-faint hover:text-ink" onClick={onClose} aria-label="Close"><CloseIcon className="h-4 w-4" /></button>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2">
        {KIND_OPTS.map((o) => (
          <button
            key={o.k}
            className={`rounded-xl border p-2.5 text-left text-xs transition-colors ${kind === o.k ? 'border-accent bg-accent-soft' : 'border-line hover:bg-surface-2'}`}
            onClick={() => setKind(o.k)}
          >
            <div className="text-base">{o.icon}</div>
            <div className="mt-0.5 font-semibold">{o.label}</div>
            <div className="text-2xs text-ink-faint">{o.sub}</div>
          </button>
        ))}
      </div>

      <label className="mt-3 block text-2xs font-medium text-ink-faint">Title</label>
      <input className="input mt-1 text-xs" placeholder="e.g. Nightly test run" value={title} onChange={(e) => setTitle(e.target.value)} />

      <label className="mt-3 block text-2xs font-medium text-ink-faint">What should the agent do each time?</label>
      <textarea className="input mt-1 min-h-[64px] resize-none text-xs" placeholder="Run the test suite and summarize any failures." value={prompt} onChange={(e) => setPrompt(e.target.value)} />

      {kind === 'scheduled' && (
        <div className="mt-3">
          <label className="block text-2xs font-medium text-ink-faint">Run at</label>
          <input type="datetime-local" className="input mt-1 text-xs" value={runAt} onChange={(e) => setRunAt(e.target.value)} />
        </div>
      )}

      {kind === 'recurring' && (
        <div className="mt-3">
          <label className="block text-2xs font-medium text-ink-faint">Run every</label>
          <div className="mt-1 flex gap-2">
            <input type="number" min={1} className="input w-24 text-xs" value={every} onChange={(e) => setEvery(Number(e.target.value))} />
            <select className="input flex-1 text-xs" value={unit} onChange={(e) => setUnit(e.target.value as typeof unit)}>
              <option value="min">minutes</option>
              <option value="hour">hours</option>
              <option value="day">days</option>
            </select>
          </div>
        </div>
      )}

      {kind === 'background' && (
        <div className="mt-3">
          <label className="block text-2xs font-medium text-ink-faint">Keep alive</label>
          <div className="mt-1 flex gap-2">
            <button className={`flex-1 rounded-lg border py-1.5 text-xs ${keepAlive === 'forever' ? 'border-accent bg-accent-soft' : 'border-line'}`} onClick={() => setKeepAlive('forever')}>Forever</button>
            <button className={`flex-1 rounded-lg border py-1.5 text-xs ${keepAlive === 'until' ? 'border-accent bg-accent-soft' : 'border-line'}`} onClick={() => setKeepAlive('until')}>Until a condition</button>
          </div>
          {keepAlive === 'until' && (
            <input className="input mt-2 text-xs" placeholder="Stop when… (e.g. all tests pass)" value={condition} onChange={(e) => setCondition(e.target.value)} />
          )}
          <div className="mt-2 flex items-center gap-2 text-2xs text-ink-faint">
            <span>Nudge every</span>
            <input type="number" min={1} className="input w-20 py-1 text-xs" value={every} onChange={(e) => setEvery(Number(e.target.value))} />
            <select className="input py-1 text-xs" value={unit} onChange={(e) => setUnit(e.target.value as typeof unit)}>
              <option value="min">minutes</option>
              <option value="hour">hours</option>
              <option value="day">days</option>
            </select>
          </div>
        </div>
      )}

      <div className="mt-3">
        <RunPolicyField value={runPolicy} local={local} note="Run now never waits." compact onChange={setRunPolicy} />
      </div>

      {blocked && <div className="mt-3"><ClaudeReasonLine message={blocked} /></div>}
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn btn-ghost py-1.5 text-xs" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary py-1.5 text-xs" disabled={!valid} onClick={create}>Create task</button>
      </div>
    </Modal>
  );
}
