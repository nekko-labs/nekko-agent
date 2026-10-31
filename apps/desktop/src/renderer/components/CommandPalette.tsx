import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore, viewEnabled, type View } from '../store.js';
import { SHORTCUTS } from '../shortcuts.js';
import { Modal } from './primitives/index.js';
import { openFeedback } from './FeedbackSheet.js';
import { Toggle } from './primitives/Toggle.js';
import { matchSettings, matchSettingsPages, openSettingsGroup, saveSettings, SETTINGS_PAGES, type SettingEntry } from '../settingsIndex.js';

interface Command {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

type Item = { id: string; command: Command } | { id: string; setting: SettingEntry };

/**
 * Ctrl/Cmd+K command palette for fast navigation and actions. Typing also
 * lists matching settings: each shows its switch or choice to change right
 * here (Enter flips or steps it), and matching Settings groups to jump to.
 */
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
  }, [setView, newChat, newTerminal, toggleContextPanel, hypergate, hypergateConnected, settings]);

  const q = query.toLowerCase();
  const pages = matchSettingsPages(query).map((p): Command => ({ id: `settings-${p.group}`, label: `Settings: ${p.label}`, hint: 'Settings', run: () => openSettingsGroup(p.group) }));
  const filtered: Item[] = [
    ...commands.filter((c) => c.label.toLowerCase().includes(q)).map((command) => ({ id: command.id, command })),
    ...pages.map((command) => ({ id: command.id, command })),
    ...(settings ? matchSettings(query) : []).map((setting) => ({ id: `setting-${setting.id}`, setting })),
  ];

  useEffect(() => {
    if (paletteOpen) {
      setQuery('');
      setActive(0);
    }
  }, [paletteOpen]);

  if (!paletteOpen) return null;

  /** Commands run and close; a setting changes in place and the palette stays. */
  const choose = (item?: Item, back = false) => {
    if (!item) return;
    if ('command' in item) {
      item.command.run();
      setPaletteOpen(false);
      return;
    }
    const { control } = item.setting;
    if (!settings) return;
    if (control.kind === 'toggle') { void saveSettings(control.set(!control.get(settings), settings)); return; }
    const at = control.options.findIndex((o) => o.value === control.get(settings));
    const next = control.options[(at + (back ? -1 : 1) + control.options.length) % control.options.length];
    void saveSettings(control.set(next.value, settings));
  };

  return (
    <Modal
      title="Command palette"
      description="Search commands and settings. Enter runs the highlighted command, or flips or steps the highlighted setting."
      onClose={() => setPaletteOpen(false)}
      align="top"
      initialFocus={inputRef}
      className="card fade-in w-[520px] overflow-hidden p-0 shadow-(--shadow-float)"
    >
      <input
        ref={inputRef}
        className="w-full border-b border-line bg-transparent px-4 py-3 text-sm outline-hidden"
        placeholder="Type a command or setting…"
        role="combobox"
        aria-expanded
        aria-controls={listId}
        aria-activedescendant={filtered[active] ? `${listId}-${filtered[active].id}` : undefined}
        aria-label="Type a command or setting"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setActive((a) => Math.min(a + 1, filtered.length - 1));
          else if (e.key === 'ArrowUp') setActive((a) => Math.max(a - 1, 0));
          else if (e.key === 'Enter') { e.preventDefault(); choose(filtered[active], e.shiftKey); }
        }}
      />
      <div id={listId} role="listbox" aria-label="Commands" className="max-h-80 overflow-y-auto py-1">
        {filtered.length === 0 && <div className="px-4 py-3 text-sm text-ink-faint">No matching commands or settings.</div>}
        {filtered.map((item, i) => {
          const row = `flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-sm ${i === active ? 'bg-surface-2' : ''}`;
          if ('command' in item) {
            const c = item.command;
            return (
              <button key={item.id} id={`${listId}-${item.id}`} role="option" aria-selected={i === active} className={row} onMouseEnter={() => setActive(i)} onClick={() => choose(item)}>
                <span>{c.label}</span>
                {c.hint && <span className="text-2xs text-ink-faint">{c.hint}</span>}
              </button>
            );
          }
          const e = item.setting;
          const control = e.control;
          const where = SETTINGS_PAGES.find((p) => p.group === e.group)?.label;
          return (
            <div key={item.id} id={`${listId}-${item.id}`} role="option" aria-selected={i === active} className={`${row} py-2`} onMouseEnter={() => setActive(i)} data-palette-setting={e.id}>
              <span className="min-w-0 truncate">{e.label}<span className="ml-2 text-2xs text-ink-faint">Settings: {where}</span></span>
              {settings && (control.kind === 'toggle'
                ? <Toggle label={e.label} value={control.get(settings)} onChange={(v) => void saveSettings(control.set(v, settings))} />
                : <select className="input max-w-[180px] shrink-0 py-1 text-xs" aria-label={e.label} value={control.get(settings)}
                    onChange={(ev) => void saveSettings(control.set(ev.target.value, settings))}>
                    {control.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>)}
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
