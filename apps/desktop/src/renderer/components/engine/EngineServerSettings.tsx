import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { withBind } from './lanKey.js';
import { SettingsAutosave } from './settingsAutosave.js';
import type { EngineInstall, EngineSettings } from '@nekko-agent/shared';
import { ENGINE_BACKEND_LABELS, ENGINE_PORT_DEFAULT, engineBaseUrl } from '@nekko-agent/shared';
import { useStore } from '../../store.js';
import { Toggle } from '../primitives/index.js';

/**
 * The server tab: what every other local model server puts in its own app.
 *
 * Two of these settings can expose the machine, so they are written as decisions
 * rather than as toggles with clever labels. Binding to the network says plainly
 * that anything on it can then use the models, and the key field says what it is
 * for. The defaults are the safe ones and stay that way unless someone changes
 * them deliberately.
 */

export function EngineServerSettings({
  settings,
  install,
  running,
  onChanged,
}: {
  settings: EngineSettings;
  install: EngineInstall;
  running: boolean;
  onChanged: () => void;
}) {
  const pushToast = useStore((s) => s.pushToast);
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const [autosave] = useState(() => new SettingsAutosave(settings, patch => window.nekko.engineSettingsSave(patch), () => changed.current()));
  const { draft, status: saveStatus, error } = useSyncExternalStore(autosave.subscribe, autosave.getSnapshot);
  const setDraft = (next: EngineSettings) => autosave.edit(next);
  useEffect(() => { autosave.reconcile(settings); }, [autosave, settings]);
  useEffect(() => () => autosave.dispose(), [autosave]);

  const removeEngine = async () => {
    if (!window.confirm('Remove the downloaded engine? Your models are not touched.')) return;
    const res = await window.nekko.engineUninstall();
    pushToast(res.ok ? 'success' : 'error', res.message);
    onChanged();
  };

  return (
    <div className="space-y-4" onBlurCapture={() => { void autosave.flush(); }}>
      {/* The endpoint, always legible: running or not, this is what apps point
          at — the server simply is not listening until a model loads. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border px-3 py-2" style={{ borderColor: 'var(--line)', background: 'var(--surface-2)' }}>
        <span
          className="h-2 w-2 rounded-full"
          style={{ background: running ? 'var(--success)' : 'var(--ink-faint)' }}
          title={running ? 'Listening' : 'Not listening'}
        />
        <code className="font-mono text-[12px]">{engineBaseUrl(draft)}</code>
        <span className="text-[11px] text-ink-faint">
          {running ? 'listening now' : 'not listening — starts when a model loads'}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3">
        <Field label="Port" hint={`Default ${ENGINE_PORT_DEFAULT}. The address other apps point at.`}>
          <input
            type="number"
            className="input w-28 py-1 text-[12px]"
            min={1024}
            max={65535}
            value={draft.port}
            onChange={(e) => setDraft({ ...draft, port: Number(e.target.value) })}
          />
        </Field>

        <Field
          label="Reachable from"
          hint={
            draft.bind === 'lan'
              ? 'Anything on your network with the key below can use these models. The engine will not listen without one.'
              : 'Only this computer. The safe default.'
          }
        >
          <select
            className="input w-64 py-1 text-[12px]"
            value={draft.bind}
            onChange={(e) => setDraft(withBind(draft, e.target.value as EngineSettings['bind']))}
          >
            <option value="local">This computer only</option>
            <option value="lan">This computer and my network</option>
          </select>
        </Field>

        <Field label="API key" hint="Required as a Bearer token when set. Leave empty on a loopback-only server; one is generated when you pick your network.">
          <input
            type="password"
            className="input w-64 py-1 font-mono text-[12px]"
            value={draft.apiKey ?? ''}
            placeholder="none"
            onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
          />
        </Field>

        <Field label="Browser origins (CORS)" hint="Comma-separated origins allowed to call it from a web page. Empty blocks browsers.">
          <input
            className="input w-64 py-1 font-mono text-[12px]"
            value={draft.corsOrigins ?? ''}
            placeholder="none"
            onChange={(e) => setDraft({ ...draft, corsOrigins: e.target.value })}
          />
        </Field>

        <Field label="Models resident at once" hint="Loading past this evicts whichever model was used least recently.">
          <input
            type="number"
            className="input w-20 py-1 text-[12px]"
            min={1}
            max={8}
            value={draft.maxLoaded}
            onChange={(e) => setDraft({ ...draft, maxLoaded: Number(e.target.value) })}
          />
        </Field>

        <Field label="Unload when idle" hint="Seconds without a request before a model is evicted. 0 keeps models loaded.">
          <input
            type="number"
            className="input w-24 py-1 text-[12px]"
            min={0}
            max={86_400}
            step={60}
            value={draft.idleTtlSeconds}
            onChange={(e) => setDraft({ ...draft, idleTtlSeconds: Number(e.target.value) })}
          />
        </Field>

        <Field label="Load on demand" hint="A request for a model that is not loaded loads it, the way LM Studio does.">
          <Toggle value={draft.jitLoad} onChange={(v) => setDraft({ ...draft, jitLoad: v })} />
        </Field>
      </div>

      <p className="text-[11px] text-ink-faint">
        {(settings.autoload?.length ?? 0) > 0
          ? `${settings.autoload!.length} model${settings.autoload!.length === 1 ? '' : 's'} marked "on start" load with the engine.`
          : 'No models are marked "on start"; mark them in the Models tab.'}
      </p>

      <div>
        <label className="text-[12px]">Where downloads are kept</label>
        <input
          className="input mt-1 w-full font-mono text-[12px]"
          value={draft.modelsDir ?? ''}
          placeholder="~/.nekko-agent/models/{type}"
          spellCheck={false}
          onChange={(e) => setDraft({ ...draft, modelsDir: e.target.value })}
        />
        <p className="mt-0.5 text-[11px] text-ink-faint">
          The one folder Nekko Agent writes to. To read models out of folders another app fills — Ollama, LM Studio,
          a Hugging Face cache — use <strong>Folders</strong>. Files are never moved.
        </p>
      </div>

      <p role="status" className="text-[11px] text-ink-faint">
        {error ?? (saveStatus === 'saving' ? 'Saving…' : saveStatus === 'pending' ? 'Changes save automatically.' : 'All changes saved.')}
        {saveStatus === 'error' && <button className="ml-2 underline" onClick={() => void autosave.flush()}>Retry</button>}
      </p>

      <div className="border-t pt-3" style={{ borderColor: 'var(--line)' }}>
        <p className="text-[11.5px] text-ink-faint">
          Engine: {install.version ?? 'unknown build'}
          {install.backend ? ` · ${ENGINE_BACKEND_LABELS[install.backend]}` : ''}
          {install.source === 'external' ? ' · yours, not managed by Nekko Agent' : ''}
        </p>
        {install.binPath && <p className="mt-0.5 truncate font-mono text-[10.5px] text-ink-faint">{install.binPath}</p>}
        {install.source === 'managed' && (
          <button className="mt-2 text-[11.5px] text-ink-faint hover:text-ink" onClick={removeEngine}>
            Remove the downloaded engine
          </button>
        )}
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <label className="text-[12px]">{label}</label>
        {children}
      </div>
      <p className="mt-0.5 text-[11px] text-ink-faint">{hint}</p>
    </div>
  );
}
