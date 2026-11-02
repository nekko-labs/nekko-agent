import { useCallback, useEffect, useState } from 'react';
import type { ModelFolder, ModelFolderReport, ModelFolderStatus, ModelFolderSuggestion } from '@nekko-agent/shared';
import { MODEL_FOLDER_PROVIDERS } from '@nekko-agent/shared';
import { useStore } from '../../store.js';
import { Badge } from '../primitives/index.js';
import { CheckIcon, PlusIcon, TrashIcon } from '../../icons.js';
import { formatBytes } from '../runtimes/verdict.js';

/**
 * Where the library looks for models.
 *
 * The premise is that a GGUF is a GGUF whoever downloaded it. A machine that has
 * already pulled Qwen through Ollama or LM Studio has the weights; making
 * someone download them again to run them here would be a worse product for a
 * simpler implementation.
 *
 * So the list starts populated. Every known layout on this machine that has
 * models in it is already a row, showing its real path and what it contributes,
 * and every row is editable: retype the path, switch it off, delete it, or add
 * one nobody guessed. The folder downloads land in is pinned at the top and has
 * no delete, because a download has to have somewhere to go.
 */

export function ModelFolders({ onChanged }: { onChanged: () => void }) {
  const pushToast = useStore((s) => s.pushToast);
  const [report, setReport] = useState<ModelFolderReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newPath, setNewPath] = useState('');

  const refresh = useCallback(async () => {
    setReport(await window.nekko.engineFolders().catch(() => null));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /** Persist the list, then reconcile both this panel and the library above it. */
  const save = async (folders: ModelFolder[]) => {
    setBusy(true);
    const next = await window.nekko
      .engineFoldersSave(folders)
      .catch((e: Error) => {
        pushToast('error', e.message);
        return null;
      });
    setBusy(false);
    if (next) setReport(next);
    onChanged();
  };

  if (!report) return <p className="text-xs text-ink-faint">Reading folders…</p>;

  const extra = report.folders.filter((f) => !f.primary);
  const asFolders = (list: ModelFolderStatus[]): ModelFolder[] =>
    list.map(({ id, path, provider, enabled, custom }) => ({ id, path, provider, enabled, custom }));

  const patch = (id: string, change: Partial<ModelFolder>) =>
    save(asFolders(extra).map((f) => (f.id === id ? { ...f, ...change } : f)));

  const add = (folder: ModelFolder) => save([...asFolders(extra), folder]);

  const addTyped = () => {
    const path = newPath.trim();
    if (!path) return;
    if (extra.some((f) => f.path.toLowerCase() === path.toLowerCase())) {
      pushToast('info', 'That folder is already in the list.');
      return;
    }
    void add({ id: `dir-${Date.now().toString(36)}`, path, enabled: true, custom: true });
    setNewPath('');
    setAdding(false);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-ink-faint">
          Every folder here is scanned for GGUF files. Models found outside Nekko Agent's own folder can be run and
          loaded, but never deleted from here.
        </p>
        <button className="btn btn-outline py-1 text-xs" onClick={() => setAdding((v) => !v)} disabled={busy}>
          <PlusIcon className="h-3.5 w-3.5" /> Add a folder
        </button>
      </div>

      {adding && (
        <div className="flex gap-2">
          <input
            className="input flex-1 font-mono text-xs"
            placeholder="D:\\models"
            value={newPath}
            spellCheck={false}
            autoFocus
            onChange={(e) => setNewPath(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addTyped()}
          />
          <button className="btn btn-outline py-1 text-xs" onClick={addTyped} disabled={!newPath.trim()}>
            Add
          </button>
        </div>
      )}

      <div className="space-y-1">
        {report.folders.map((folder) => (
          <FolderRow
            key={folder.id}
            folder={folder}
            busy={busy}
            onToggle={(enabled) => patch(folder.id, { enabled })}
            onPath={(path) => patch(folder.id, { path })}
            onRemove={() => save(asFolders(extra).filter((f) => f.id !== folder.id))}
          />
        ))}
      </div>

      {report.suggestions.length > 0 && (
        <div className="border-t pt-3" style={{ borderColor: 'var(--line)' }}>
          <p className="text-xs font-medium text-ink-soft">Also on this machine</p>
          <p className="mt-0.5 text-2xs text-ink-faint">
            Folders we recognise that have models in them, and that this list does not cover yet.
          </p>
          <div className="mt-2 space-y-1">
            {report.suggestions.map((s) => (
              <SuggestionRow key={s.path} suggestion={s} busy={busy} onAdd={() => add(folderFor(s))} />
            ))}
          </div>
        </div>
      )}

      <div className="border-t pt-3" style={{ borderColor: 'var(--line)' }}>
        <p className="text-2xs text-ink-faint">
          Looked for in the usual places for Ollama, LM Studio, Jan, GPT4All, llama.cpp, KoboldCpp, LocalAI, Bionic,
          text-generation-webui and the Hugging Face cache that vLLM serves from. A folder somewhere else just needs
          adding by hand.
        </p>
      </div>
    </div>
  );
}

/** A suggestion, as the row the list would gain if it were accepted. */
function folderFor(s: ModelFolderSuggestion): ModelFolder {
  return { id: s.provider, path: s.path, provider: s.provider, enabled: true };
}

function FolderRow({
  folder,
  busy,
  onToggle,
  onPath,
  onRemove,
}: {
  folder: ModelFolderStatus;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onPath: (path: string) => void;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState(folder.path);
  useEffect(() => setDraft(folder.path), [folder.path]);

  const meta = folder.provider ? MODEL_FOLDER_PROVIDERS[folder.provider] : undefined;
  const label = folder.primary ? 'Nekko Agent' : (meta?.label ?? 'Custom folder');
  const off = !folder.enabled;

  return (
    <div
      className="rounded-xl px-3 py-2"
      style={{ background: 'var(--surface-2)', opacity: off ? 0.62 : 1 }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium">{label}</span>
        {folder.primary && (
          <Badge tone="info" variant="soft" title="New downloads land here">
            downloads here
          </Badge>
        )}
        {!folder.primary && <span className="chip">read only</span>}
        {!folder.exists && (
          <span className="text-2xs" style={{ color: 'var(--warning)' }}>
            not on disk
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2 text-2xs text-ink-faint">
          {folder.exists && (
            <span>
              {folder.modelCount} model{folder.modelCount === 1 ? '' : 's'}
              {folder.sizeBytes > 0 ? ` · ${formatBytes(folder.sizeBytes)}` : ''}
            </span>
          )}
          {!folder.primary && (
            <>
              <button
                className="rounded-full border px-2 py-0.5 text-2xs hover:border-[var(--accent)]"
                style={{ borderColor: off ? 'var(--line)' : 'var(--accent)', color: off ? undefined : 'var(--accent)' }}
                disabled={busy}
                onClick={() => onToggle(off)}
                title={off ? 'Scan this folder again' : 'Keep the row, stop scanning it'}
              >
                {off ? 'off' : (
                  <>
                    <CheckIcon className="mr-1 inline h-2.5 w-2.5" />
                    on
                  </>
                )}
              </button>
              <button
                className="btn btn-ghost px-2 py-1"
                title="Remove this folder from the list"
                disabled={busy}
                onClick={onRemove}
              >
                <TrashIcon className="h-3.5 w-3.5" />
              </button>
            </>
          )}
        </span>
      </div>

      <input
        className="input mt-1 w-full py-1 font-mono text-xs"
        value={draft}
        spellCheck={false}
        disabled={folder.primary || busy}
        title={folder.primary ? "Change this under Settings, where the models folder lives" : folder.path}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft.trim() !== folder.path && onPath(draft.trim())}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      {meta && <p className="mt-0.5 text-2xs text-ink-faint">{meta.hint}</p>}
    </div>
  );
}

function SuggestionRow({
  suggestion,
  busy,
  onAdd,
}: {
  suggestion: ModelFolderSuggestion;
  busy: boolean;
  onAdd: () => void;
}) {
  const meta = MODEL_FOLDER_PROVIDERS[suggestion.provider];
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2" style={{ borderColor: 'var(--line)' }}>
      <div className="min-w-0 flex-1">
        <span className="text-xs font-medium">{meta.label}</span>
        <p className="truncate font-mono text-2xs text-ink-faint" title={suggestion.path}>
          {suggestion.path}
        </p>
      </div>
      <span className="shrink-0 text-2xs text-ink-faint">
        {suggestion.modelCount} model{suggestion.modelCount === 1 ? '' : 's'}
        {suggestion.sizeBytes > 0 ? ` · ${formatBytes(suggestion.sizeBytes)}` : ''}
      </span>
      <button className="btn btn-outline shrink-0 py-1 text-xs" onClick={onAdd} disabled={busy}>
        Add
      </button>
    </div>
  );
}
