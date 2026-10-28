import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore, viewEnabled, type View } from '../store.js';
import { SHORTCUTS } from '../shortcuts.js';
import { Modal } from './primitives/index.js';
import { openFeedback } from './FeedbackSheet.js';
import { SIMPLE_ITEMS, simpleShown, simpleVisibility } from '@nekko-agent/shared';
import { useExpertMode, useLocalModelLoaded, useSimpleChoices } from '../simpleMode.js';

interface Command {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

/** Settings, scrolled to the Simple mode group. */
function openSimpleSettings() {
  useStore.getState().setView('settings');
  requestAnimationFrame(() => document.getElementById('settings-simple')?.scrollIntoView({ block: 'start' }));
}

/** Ctrl/Cmd+K command palette for fast navigation and actions. */
export function CommandPalette() {
  const { paletteOpen, setPaletteOpen, setView, newChat, newTerminal, toggleContextPanel, settings } = useStore(
    useShallow((s) => ({
      paletteOpen: s.paletteOpen,
      setPaletteOpen: s.setPaletteOpen,
      setView: s.setView,
      newChat: s.newChat,
      newTerminal: s.newTerminal,
      toggleContextPanel: s.toggleContextPanel,
      settings: s.settings,
    })),
  );
  const hypergate = useStore((s) => s.hypergate);
  const hypergateConnected = useStore((s) => (s.settings?.mcpServers ?? []).some((m) => m.id === 'hypergate'));
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [expert, setExpert] = useExpertMode();
  const [choices] = useSimpleChoices();
  const localLoaded = useLocalModelLoaded();

  const commands = useMemo<Command[]>(() => {
    const go = (v: View, label: string): Command => ({ id: `go-${v}`, label, hint: 'Navigate', run: () => setView(v) });
    return [
      { id: 'new-chat', label: 'New agent', hint: SHORTCUTS.newAgent.label, run: () => newChat() },
      { id: 'new-terminal', label: 'New terminal', hint: SHORTCUTS.newTerminal.label, run: () => newTerminal() },
      go('artifacts', 'Go to Artifacts'),
      go('skills', 'Go to Skills'),
      go('models', 'Go to Models'),
      go('modelserver', 'Go to Model Server'),
      go('connectors', 'Go to Connectors'),
      // Experimental destinations stay out of the palette while their flag is off.
      ...(viewEnabled('memory', settings) ? [go('memory', 'Go to Memory')] : []),
      go('settings', 'Go to Settings'),
      { id: 'toggle-context', label: 'Toggle context panel', run: () => toggleContextPanel() },
      { id: 'feedback', label: 'Send feedback', hint: 'Help', run: openFeedback },
      { id: 'mode', label: expert ? 'Switch to Simple' : 'Switch to Expert', hint: expert ? 'Everyday controls' : 'Every control', run: () => setExpert(!expert) },
      { id: 'simple-settings', label: 'Choose what Simple shows', hint: 'Settings', run: openSimpleSettings },
      // Controls out of sight in this mode stay findable: Expert-only ones
      // switch to Expert, hidden ones open the setting that hides them.
      ...SIMPLE_ITEMS.filter((i) => i.platforms.includes('desktop') && !simpleShown(i.id, expert, choices, localLoaded)).map((i): Command => (
        simpleVisibility(i.id, choices) === 'hide'
          ? { id: `simple-${i.id}`, label: i.label, hint: 'Hidden in Settings', run: openSimpleSettings }
          : { id: `simple-${i.id}`, label: i.label, hint: 'Shown in Expert', run: () => setExpert(true) })),
      // Only when there is a daemon to reach: an entry that can only fail is
      // worse than no entry. Connected, it is the way back to the tab.
      ...(hypergate
        ? [{
            id: 'hypergate',
            label: hypergateConnected ? 'Open Hypergate' : 'Connect Hypergate',
            hint: `Port ${hypergate.port}`,
            run: () => {
              const s = useStore.getState();
              if (hypergateConnected) s.openHypergatePane();
              else void s.connectHypergate(hypergate.port);
            },
          }]
        : []),
    ];
  }, [setView, newChat, newTerminal, toggleContextPanel, hypergate, hypergateConnected, settings, expert, choices, localLoaded]);

  const filtered = commands.filter((c) => c.label.toLowerCase().includes(query.toLowerCase()));

  useEffect(() => {
    if (paletteOpen) {
      setQuery('');
      setActive(0);
    }
  }, [paletteOpen]);

  if (!paletteOpen) return null;

  const choose = (c?: Command) => {
    if (!c) return;
    c.run();
    setPaletteOpen(false);
  };

  return (
    <Modal
      title="Command palette"
      description="Search commands, then press Enter to run the highlighted one."
      onClose={() => setPaletteOpen(false)}
      align="top"
      initialFocus={inputRef}
      className="card fade-in w-[520px] overflow-hidden p-0 shadow-2xl"
    >
      <input
        ref={inputRef}
        className="w-full border-b border-line bg-transparent px-4 py-3 text-[14px] outline-hidden"
        placeholder="Type a command…"
        role="combobox"
        aria-expanded
        aria-controls={listId}
        aria-activedescendant={filtered[active] ? `${listId}-${filtered[active].id}` : undefined}
        aria-label="Type a command"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setActive((a) => Math.min(a + 1, filtered.length - 1));
          else if (e.key === 'ArrowUp') setActive((a) => Math.max(a - 1, 0));
          else if (e.key === 'Enter') choose(filtered[active]);
        }}
      />
      <div id={listId} role="listbox" aria-label="Commands" className="max-h-80 overflow-y-auto py-1">
        {filtered.length === 0 && <div className="px-4 py-3 text-[13px] text-ink-faint">No matching commands.</div>}
        {filtered.map((c, i) => (
          <button
            key={c.id}
            id={`${listId}-${c.id}`}
            role="option"
            aria-selected={i === active}
            className={`flex w-full items-center justify-between px-4 py-2.5 text-left text-[13px] ${i === active ? 'bg-surface-2' : ''}`}
            onMouseEnter={() => setActive(i)}
            onClick={() => choose(c)}
          >
            <span>{c.label}</span>
            {c.hint && <span className="text-[11px] text-ink-faint">{c.hint}</span>}
          </button>
        ))}
      </div>
    </Modal>
  );
}
