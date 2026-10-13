import React, { useEffect, useMemo, useRef, useState } from 'react';
import { isArchived } from '@nekko-agent/shared';
import { useStore } from '../store.js';
import { AUTO_MODEL_ID } from '@nekko-agent/shared';
import { ModelPicker } from './agent-console/ModelPicker.js';
import { EffortSlider } from './ChatMetrics.js';
import { CheckIcon, ChevronIcon } from '../icons.js';
import './AgentWindowPicker.css';

/** No refId means create; refId means open an existing session or terminal. */
export type AgentWindowSelection = {
  kind: 'chat' | 'terminal';
  refId?: string;
  chatType?: 'multimodal' | 'image';
  providerId?: string;
  modelId?: string;
  /** Folders for a new chat: the first is its primary working folder, the rest supporting. */
  workspaceIds?: string[];
};

export interface AgentWindowPickerProps {
  onAdd: (selection: AgentWindowSelection) => Promise<void>;
  onClose: () => void;
}

type Category = 'chat' | 'media' | 'terminal';

/** The saved default folders that still exist, in their saved order (the first is primary). */
export function defaultFolderIds(saved: string[] | undefined, folders: { id: string }[]): string[] {
  return (saved ?? []).filter((id, i, all) => all.indexOf(id) === i && folders.some((f) => f.id === id));
}

function CatIcon({ kind }: { kind: Category }) {
  return (
    <svg className="agent-window-picker__cat" viewBox="0 0 80 80" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 43V17l17 10a35 35 0 0 1 16 0l17-10v26c0 16-11 24-25 24S15 59 15 43Z" fill="var(--surface-2)" />
      <path d="M27 40v3m26-3v3M36 49l4 3 4-3m-4 3v5m-18-9-10-2m10 8-10 2m46-8 10-2m-10 8 10 2" />
      {kind === 'chat' && <><path d="M48 58h25v13H61l-7 5v-5h-6Z" fill="var(--surface)" /><path d="M54 64h13" /></>}
      {kind === 'media' && <><rect x="47" y="56" width="27" height="20" rx="3" fill="var(--surface)" /><circle cx="66" cy="62" r="2" /><path d="m50 73 8-9 6 6 4-4 4 7" /></>}
      {kind === 'terminal' && <><rect x="46" y="56" width="29" height="20" rx="3" fill="var(--surface)" /><path d="m52 62 4 4-4 4m9 0h7" /></>}
    </svg>
  );
}

/** Inline surface: the host owns placement, data loading, creation and dismissal. */
export function AgentWindowPicker({ onAdd, onClose }: AgentWindowPickerProps) {
  const sessions = useStore((s) => s.sessions);
  const terminals = useStore((s) => s.terminals);
  const providers = useStore((s) => s.providers);
  const models = useStore((s) => s.models);
  const activeProviderId = useStore((s) => s.activeProviderId);
  const activeModelId = useStore((s) => s.activeModelId);
  const settings = useStore((s) => s.settings);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const [category, setCategory] = useState<Category | null>(null);
  const [choice, setChoice] = useState<{ providerId: string; modelId: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The model list is closed once a model is chosen; the chosen model reads
  // back in the row above it, so the pick is visible rather than buried.
  const [modelListOpen, setModelListOpen] = useState(false);
  const [pickedFolders, setPickedFolders] = useState<string[] | null>(null);
  const adding = useRef(false);
  const surface = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    surface.current?.querySelector<HTMLButtonElement>('.agent-window-picker__option')?.focus({ preventScroll: true });
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  const enabledProviders = useMemo(() => providers.filter((p) => p.enabled), [providers]);
  const availableSessions = sessions.filter((s) => !isArchived(s));
  const folders = settings?.workspaces ?? [];

  // Defaults, so a new chat is one click: the saved default model, else the
  // model already active, else the active provider's first; and the current
  // project folder, else the first folder.
  const activeProviderEnabled = enabledProviders.some((p) => p.id === activeProviderId);
  const activeProviderModel = activeModelId ?? models.find((m) => m.providerId === activeProviderId)?.id;
  const defaultModel = settings?.defaultProviderId && settings.defaultModelId && enabledProviders.some((p) => p.id === settings.defaultProviderId)
    ? { providerId: settings.defaultProviderId, modelId: settings.defaultModelId }
    : activeProviderEnabled && activeProviderModel
      ? { providerId: activeProviderId, modelId: activeProviderModel }
      : null;
  const model = choice ?? defaultModel;
  const modelName = model?.modelId === AUTO_MODEL_ID ? 'Auto' : models.find((m) => m.id === model?.modelId && m.providerId === model?.providerId)?.name ?? model?.modelId;
  const providerLabel = providers.find((p) => p.id === model?.providerId)?.label;
  const savedDefaults = defaultFolderIds(settings?.defaultWorkspaceIds, folders);
  const fallbackFolder = folders.find((f) => f.id === activeProjectId) ?? folders[0];
  const initialFolders = savedDefaults.length ? savedDefaults : fallbackFolder ? [fallbackFolder.id] : [];
  const chosenFolders = (pickedFolders ?? initialFolders).filter((id) => folders.some((f) => f.id === id));
  const toggleFolder = (id: string) => setPickedFolders(chosenFolders.includes(id) ? chosenFolders.filter((x) => x !== id) : [...chosenFolders, id]);
  const isDefaultSelection = savedDefaults.length > 0 && savedDefaults.join('\n') === chosenFolders.join('\n');
  const saveDefaultFolders = (ids: string[]) => {
    void window.nekko.updateSettings({ defaultWorkspaceIds: ids })
      .then(() => useStore.getState().refreshSettings())
      .catch((e) => useStore.getState().pushToast('error', String(e)));
  };
  const start = () => {
    if (!model) return;
    void add({ kind: 'chat', chatType: 'multimodal', ...(model.providerId ? { providerId: model.providerId } : {}), modelId: model.modelId, workspaceIds: chosenFolders });
  };

  const add = async (selection: AgentWindowSelection) => {
    if (adding.current) return;
    adding.current = true;
    setPending(true);
    setError(null);
    try {
      await onAdd(selection);
      // The host decides whether successful addition dismisses this surface.
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      adding.current = false;
      setPending(false);
    }
  };

  return (
    <section ref={surface} className="agent-window-picker" aria-label="Add agent window" aria-busy={pending} onKeyDown={(event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (!adding.current) onClose();
      }
    }}>
      <header className="agent-window-picker__header">
        <div>
          <h2>{category ? { chat: 'Chat', media: 'Media', terminal: 'Terminal' }[category] : 'Add a window'}</h2>
          <p>{category ? 'Create something new or pick up where you left off.' : 'Choose how you want to work.'}</p>
        </div>
        <button type="button" onClick={onClose} disabled={pending} aria-label="Close window picker">Close</button>
      </header>
      {category && <button type="button" className="agent-window-picker__back" disabled={pending} onClick={() => { setCategory(null); setError(null); }}>← All window types</button>}
      {!category && (
        <div className="agent-window-picker__options">
          {(['chat', 'media', 'terminal'] as const).map((kind) => (
            <button type="button" className="agent-window-picker__option" key={kind} onClick={() => setCategory(kind)}>
              <CatIcon kind={kind} />
              <strong>{{ chat: 'Chat', media: 'Media', terminal: 'Terminal' }[kind]}</strong>
              <span>{{ chat: 'Choose a model or open a conversation', media: 'Generate images · video planned', terminal: 'Start a shell or open a terminal' }[kind]}</span>
            </button>
          ))}
        </div>
      )}
      {category === 'chat' && (
        <div className="agent-window-picker__steps">
          <section className="agent-window-picker__step" aria-labelledby="awp-step-model">
            <h3 id="awp-step-model"><span className="agent-window-picker__step-num">1</span>Model and effort</h3>
            <button type="button" className="agent-window-picker__summary" disabled={pending} aria-expanded={modelListOpen} aria-controls="awp-model-list" onClick={() => setModelListOpen((o) => !o)}>
              <span className="agent-window-picker__summary-text">
                <strong>{modelName ?? 'Choose a model'}</strong>
                {providerLabel && <span>{providerLabel}</span>}
              </span>
              <span className="agent-window-picker__summary-action">{modelListOpen ? 'Done' : 'Change'}<ChevronIcon className={`h-3.5 w-3.5 ${modelListOpen ? 'rotate-90' : ''}`} /></span>
            </button>
            {modelListOpen && (
              <fieldset id="awp-model-list" className="agent-window-picker__models" disabled={pending}>
                <legend className="agent-window-picker__sr-only">Choose a chat model</legend>
                <ModelPicker expanded readOnly open providers={enabledProviders} providerId={model?.providerId ?? activeProviderId} models={!model || model.providerId === activeProviderId ? models : []} modelId={model?.modelId ?? null} needsChoice={!model} onOpenChange={() => {}} onProvider={() => {}} onModel={(providerId, modelId) => { setChoice({ providerId, modelId }); setModelListOpen(false); }} />
              </fieldset>
            )}
            <EffortSlider modelId={model?.modelId} />
          </section>
          <section className="agent-window-picker__step" aria-labelledby="awp-step-folders">
            <h3 id="awp-step-folders"><span className="agent-window-picker__step-num">2</span>Folders</h3>
            {folders.length === 0 ? <p>No folders yet. The chat starts without a working folder; add one later from the composer.</p> : (
              <div className="agent-window-picker__folders" role="group" aria-label="Folders this chat can use">
                {folders.map((folder) => {
                  const on = chosenFolders.includes(folder.id);
                  return (
                    <button type="button" key={folder.id} role="checkbox" aria-checked={on} disabled={pending} title={folder.path} onClick={() => toggleFolder(folder.id)}>
                      <span className="agent-window-picker__check" data-on={on || undefined}>{on && <CheckIcon className="h-3 w-3" />}</span>
                      <span className="agent-window-picker__folder-text"><strong>{folder.name}</strong><span>{folder.path}</span></span>
                      {chosenFolders[0] === folder.id && <span className="agent-window-picker__badge">Primary</span>}
                      {savedDefaults.includes(folder.id) && <span className="agent-window-picker__badge agent-window-picker__badge--default">Default</span>}
                    </button>
                  );
                })}
              </div>
            )}
            {folders.length > 0 && (
              <div className="agent-window-picker__default-row">
                {isDefaultSelection
                  ? <span className="agent-window-picker__default-note"><CheckIcon className="h-3 w-3" />{savedDefaults.length === 1 ? 'Your default folder' : 'Your default folders'}</span>
                  : chosenFolders.length > 0 && <button type="button" className="agent-window-picker__link" disabled={pending} onClick={() => saveDefaultFolders(chosenFolders)} title="New agents start with these folders checked">
                      {chosenFolders.length === 1 ? 'Set this folder as default' : `Set these ${chosenFolders.length} folders as default`}
                    </button>}
                {savedDefaults.length > 0 && <button type="button" className="agent-window-picker__link agent-window-picker__link--quiet" disabled={pending} onClick={() => saveDefaultFolders([])} title="Go back to starting with the current project's folder">Clear default</button>}
              </div>
            )}
          </section>
          <details className="agent-window-picker__step agent-window-picker__existing">
            <summary><span className="agent-window-picker__step-num">3</span>Open an existing chat instead <span className="agent-window-picker__optional">Optional</span></summary>
            <div className="agent-window-picker__list">
              {availableSessions.length === 0 && <p>No existing chats.</p>}
              {availableSessions.map((session) => <button type="button" key={session.id} disabled={pending} onClick={() => void add({ kind: 'chat', refId: session.id, chatType: session.chatType ?? 'multimodal' })}><strong>{session.title || 'Untitled chat'}</strong><span>{session.chatType === 'image' ? 'Image session' : 'Chat'}</span></button>)}
            </div>
          </details>
          <button type="button" className="agent-window-picker__primary" disabled={pending || !model} onClick={start}>Start</button>
        </div>
      )}
      {category === 'media' && (
        <div className="agent-window-picker__options">
          <button type="button" className="agent-window-picker__option" disabled={pending} onClick={() => void add({ kind: 'chat', chatType: 'image' })}><CatIcon kind="media" /><strong>Create image session</strong><span>Generate images in a new conversation.</span></button>
          <button type="button" className="agent-window-picker__option" disabled><CatIcon kind="media" /><strong>Video · Planned</strong><span>Unavailable — video creation is not implemented.</span></button>
        </div>
      )}
      {category === 'terminal' && (
        <div className="agent-window-picker__columns">
          <section className="agent-window-picker__column"><h3>New terminal</h3><p>Start a new shell session.</p><button type="button" className="agent-window-picker__primary" disabled={pending} onClick={() => void add({ kind: 'terminal' })}>Create terminal</button></section>
          <section className="agent-window-picker__column" aria-label="Existing terminals"><h3>Existing terminals</h3><div className="agent-window-picker__list">
            {terminals.length === 0 && <p>No existing terminals.</p>}
            {terminals.map((terminal) => <button type="button" key={terminal.id} disabled={pending} onClick={() => void add({ kind: 'terminal', refId: terminal.id })}><strong>{terminal.title || 'Untitled terminal'}</strong><span>{terminal.running ? 'Running' : 'Exited'} · {terminal.cwd}</span></button>)}
          </div></section>
        </div>
      )}
      {pending && <p role="status">Adding window…</p>}
      {error !== null && <p className="agent-window-picker__error" role="alert">Could not add window: {error || 'Unknown error'}</p>}
    </section>
  );
}
