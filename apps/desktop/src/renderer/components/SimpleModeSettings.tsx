import React, { useState } from 'react';
import { SIMPLE_ITEMS, simpleAreas, simpleOptions, simpleShown, simpleVisibility, type SimpleChoices, type SimpleItem, type SimpleVisibility } from '@nekko-agent/shared';
import { useExpertMode, useSimpleChoices } from '../simpleMode.js';
import { ChatIcon, CodeIcon, FolderIcon, GlobeIcon, PlusIcon } from '../icons.js';

/*
 * Settings > Simple mode: per control, Show (both modes, when it applies),
 * Detailed only, or Hide; a monitor offers When running (its default), Always or
 * Hide. Each area is drawn beside its switches, and a control the previewed
 * mode leaves out keeps a dashed outline where it would be.
 */

/** What each choice says for this item: Show pins a monitor on, so it reads Always there. */
function choiceLabel(item: SimpleItem, v: SimpleVisibility): string {
  if (v === 'auto') return 'When running';
  if (v === 'show') return item.default === 'auto' ? 'Always' : 'Show';
  return v === 'expert' ? 'Detailed only' : 'Hide';
}

/** The drawings show a chat that has changes and a pull request, with no local model running. */
const PREVIEW_CONTEXT = { changes: true, pr: true };

type Ctx = { expert: boolean; choices: SimpleChoices; hot: string | null };
const PreviewCtx = React.createContext<Ctx>({ expert: false, choices: {}, hot: null });

/** One control in a drawing: as on screen, or dashed where the previewed mode leaves it out. */
function M({ id, children, wide }: { id?: string; children: React.ReactNode; wide?: boolean }) {
  const { expert, choices, hot } = React.useContext(PreviewCtx);
  const shown = !id || simpleShown(id, expert, choices, PREVIEW_CONTEXT);
  return (
    <span
      className={`sm-mock ${wide ? 'sm-mock-wide' : ''} ${id ? '' : 'sm-mock-fixed'}`}
      data-shown={shown}
      data-hot={id !== undefined && hot === id ? true : undefined}
      data-mock-item={id}
      aria-hidden="true"
    >
      {children}
    </span>
  );
}

/** A drawing of each area, built from the controls that live there. */
const PREVIEWS: Record<string, () => React.JSX.Element> = {
  'Chat · header': () => (
    <div className="sm-frame">
      <div className="sm-row"><b className="sm-title">Fix the login bug</b><M id="worktree">main · worktree</M><span className="flex-1" /><M id="agent-monitor">Agent Monitor</M><M id="changes">3 files changed</M><M>Files</M><M id="logs">Logs</M></div>
      <div className="sm-row"><M id="hardware" wide>CPU 32% · Memory 61% · GPU 12% · 1 model loaded</M></div>
    </div>
  ),
  'Chat · message box': () => (
    <div className="sm-frame sm-composer">
      <div className="sm-placeholder">Ask a follow-up</div>
      <div className="sm-row"><M><PlusIcon className="h-3 w-3" /></M><M id="mode">Mode · Guardrails</M><M id="privacy">Privacy Shield</M><span className="flex-1" /><M id="suggest">Suggestions</M><M>Send</M></div>
      <div className="sm-row sm-details"><M><FolderIcon className="h-3 w-3" /> nekko-agent</M><M id="model">Claude Opus 5.5</M><M id="effort">Effort · Medium</M><M id="asks">Asks first</M><M id="cost">$0.42</M><span className="flex-1" /><M id="tools">Tools</M><M id="tools">MCP</M><M id="internet"><GlobeIcon className="h-3 w-3" /></M><M id="context">Ring</M></div>
    </div>
  ),
  'Chat · conversation': () => (
    <div className="sm-frame">
      <div className="sm-row justify-end"><span className="sm-bubble">Summarize these three PDFs</span></div>
      <div className="sm-row"><M id="thinking">Thought for 12s</M><M wide>▸ Read 3 files</M></div>
      <div className="sm-lines"><i /><i /><i style={{ width: '60%' }} /></div>
      <div className="sm-row"><M id="stats">Opus 5.5 · 2.1k in · 640 out · 48 tok/s</M></div>
      <div className="sm-row"><M id="pr-status" wide>Pull request #482 · Checks passing</M></div>
    </div>
  ),
  'Agents wall': () => (
    <div className="sm-frame">
      <div className="sm-row"><span className="sm-window"><b>Research agent</b><M id="cardmeta">Opus 5.5 · 48k context tokens</M></span><span className="sm-window"><b>New window</b><M>Chat</M><M id="terminal">Terminal</M></span></div>    </div>
  ),
  Workflows: () => (
    <div className="sm-frame"><div className="sm-row"><M>Workflows</M><M id="ci">CI runners</M></div><div className="sm-lines"><i /><i style={{ width: '70%' }} /></div></div>
  ),
  Models: () => (
    <div className="sm-frame"><div className="sm-row"><M>Qwen3 8B · Load</M><M id="engine">Detailed load flags</M></div><div className="sm-row"><M id="engine" wide>Model server settings</M></div></div>
  ),
  Settings: () => (
    <div className="sm-frame"><div className="sm-row"><M>General</M><M>Style</M><M>Agents</M><M>Safety</M><M id="set-tools">Tools</M></div></div>
  ),
};

/** The Simple mode settings: every listed control, grouped by where it sits. */
export function SimpleModeSettings() {
  const [expert] = useExpertMode();
  const [choices, setChoice] = useSimpleChoices();
  const [previewExpert, setPreviewExpert] = useState(expert);
  const [hot, setHot] = useState<string | null>(null);
  const areas = simpleAreas('desktop');
  const desktop = SIMPLE_ITEMS.filter((i) => i.platforms.includes('desktop'));
  const hiddenInSimple = desktop.filter((i) => !simpleShown(i.id, false, choices, PREVIEW_CONTEXT)).length;
  const changed = Object.keys(choices).length > 0;
  return (
    <section className="card mt-6 p-5" data-simple-mode-settings>
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold">What Simple shows</h3>
          <p className="mt-1 max-w-prose text-xs text-ink-soft">
            Simple is a cleaner, more focused view, and details show only when they matter. Everything still works.{' '}
            <b>Show</b> puts a control in both modes whenever it applies, <b>Detailed only</b> keeps it for Detailed, and <b>Hide</b> puts it away in both.{' '}
            The hardware gauges wait for a local model to run: choose <b>Always</b> to pin them on. The Monitors panel's own Configure menu picks its monitors for both modes.
          </p>
          <p className="mt-1 text-xs text-ink-faint">{hiddenInSimple} of {desktop.length} controls are out of sight in Simple. Kept on this computer.</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-2xs text-ink-faint">Preview</span>
          <div className="mode-seg" role="radiogroup" aria-label="Preview mode">
            {([false, true] as const).map((on) => (
              <button key={String(on)} type="button" role="radio" aria-checked={previewExpert === on} className={previewExpert === on ? 'on' : ''} onClick={() => setPreviewExpert(on)} aria-label={on ? 'Preview Detailed' : 'Preview Simple'} title={on ? 'Preview Detailed' : 'Preview Simple'}>
                {on ? <CodeIcon className="h-3.5 w-3.5" /> : <ChatIcon className="h-3.5 w-3.5" />}
              </button>
            ))}
          </div>
          <button type="button" className="btn btn-ghost px-2 py-1 text-xs" disabled={!changed} onClick={() => { for (const id of Object.keys(choices)) setChoice(id, null); }}>Reset to defaults</button>
        </div>
      </div>
      <PreviewCtx.Provider value={{ expert: previewExpert, choices, hot }}>
        {areas.map(({ area, items }) => {
          const Preview = PREVIEWS[area];
          return (
            <div key={area} className="sm-area" data-simple-area={area}>
              <div className="min-w-0">
                <h4 className="sm-area-title">{area}</h4>
                {Preview && <Preview />}
                <p className="mt-1.5 text-2xs text-ink-faint">{previewExpert ? 'In Detailed.' : 'In Simple.'} Dashed controls are out of sight.</p>
              </div>
              <ul className="min-w-0" onMouseLeave={() => setHot(null)}>
                {items.map((item) => {
                  const v = simpleVisibility(item.id, choices);
                  return (
                    <li key={item.id} className="sm-item" onMouseEnter={() => setHot(item.id)} onFocus={() => setHot(item.id)} data-simple-item={item.id}>
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-medium">{item.label}{item.default === v ? '' : <span className="ml-1.5 text-2xs font-normal text-accent">changed</span>}</div>
                        <div className="text-2xs text-ink-faint">{item.hint}</div>
                      </div>
                      <div className="sm-choice" role="radiogroup" aria-label={item.label}>
                        {simpleOptions(item).map((c) => (
                          <button key={c} type="button" role="radio" aria-checked={v === c} className={v === c ? 'on' : ''} onClick={() => setChoice(item.id, c === item.default ? null : c)}>
                            {choiceLabel(item, c)}
                          </button>
                        ))}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </PreviewCtx.Provider>
    </section>
  );
}
