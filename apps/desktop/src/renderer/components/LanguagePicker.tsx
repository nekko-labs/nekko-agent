import React, { useRef, useState } from 'react';
import { CheckIcon, GlobeIcon } from '../icons.js';
import { LANGUAGES, languagePatch, supportedLanguage, useT, type Language } from '../i18n.js';
import { useStore } from '../store.js';
import { saveSettings } from '../settingsIndex.js';

/** Always looks like a language control, even in an unfamiliar locale. */
export function LanguagePicker({ id, describedBy }: { id: string; describedBy?: string }) {
  const t = useT();
  const setting = useStore(s => s.settings?.language);
  const selected = setting ? LANGUAGES.find(l => l.code === supportedLanguage(setting)) : undefined;
  const system = t('settings.systemDefault');
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const saving = useRef(false);
  const [open, setOpen] = useState(false);
  const optionsId = `${id}-options`;
  const choose = async (code: Language | '') => {
    if (saving.current) return;
    panel.current?.hidePopover();
    trigger.current?.focus();
    if (code === (selected?.code ?? '')) return;
    saving.current = true;
    try { await saveSettings(languagePatch(code)); }
    finally { saving.current = false; }
  };
  const place = () => {
    const anchor = trigger.current?.getBoundingClientRect();
    const menu = panel.current;
    if (!anchor || !menu) return;
    const width = Math.min(224, window.innerWidth - 16);
    const above = anchor.top - 12;
    const below = window.innerHeight - anchor.bottom - 12;
    const up = below < 300 && above > below;
    Object.assign(menu.style, {
      width: `${width}px`,
      left: `${Math.max(8, Math.min(window.innerWidth - width - 8, anchor.right - width))}px`,
      maxHeight: `${Math.max(0, up ? above : below)}px`,
      top: up ? 'auto' : `${anchor.bottom + 4}px`,
      bottom: up ? `${window.innerHeight - anchor.top + 4}px` : 'auto',
    });
  };
  const key = (e: React.KeyboardEvent) => {
    // Wizard arrow/Escape shortcuts must not navigate while using the picker.
    e.stopPropagation();
    if (e.key === 'Escape' && panel.current?.matches(':popover-open')) {
      e.preventDefault();
      panel.current.hidePopover();
      trigger.current?.focus();
    } else if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      if (!panel.current?.matches(':popover-open')) { panel.current?.showPopover(); return; }
      const items = Array.from(panel.current.querySelectorAll('button'));
      const i = items.indexOf(document.activeElement as HTMLButtonElement);
      items[e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (i + (e.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length]?.focus();
    }
  };
  return (
    <div onKeyDown={key}>
      <button ref={trigger} id={id} type="button" className="btn btn-outline gap-2 py-1.5 text-xs" popoverTarget={optionsId}
        aria-expanded={open} aria-controls={optionsId} aria-describedby={describedBy}
        aria-label={`${t('settings.language')}: ${selected?.label ?? system}`}>
        <GlobeIcon className="h-4 w-4 shrink-0" aria-hidden />
        <span lang={selected?.code}>{selected?.label ?? system}</span>
        <span aria-hidden="true" className="h-1.5 w-1.5 -translate-y-0.5 rotate-45 border-r border-b" />
      </button>
      <div ref={panel} id={optionsId} popover="auto" role="group" aria-label={t('settings.language')}
        onBeforeToggle={place} onToggle={e => setOpen(e.newState === 'open')}
        className="fixed m-0 overflow-auto rounded-xl border border-line bg-surface p-1 text-ink shadow-xl">
        {[{ code: '', label: system, badge: '' } as const, ...LANGUAGES].map(({ code, label, badge }) => {
          const active = code === (selected?.code ?? '');
          return (
            <button key={code} type="button" data-language={code} aria-pressed={active} autoFocus={active}
              className={`quiet-row gap-2 px-2 py-1.5 text-left text-sm ${active ? 'text-accent' : ''}`} onClick={() => void choose(code)}>
              <span className="grid h-6 w-7 shrink-0 place-items-center rounded border border-line font-mono text-2xs text-ink-soft" aria-hidden="true">
                {badge || <GlobeIcon className="h-3.5 w-3.5" />}
              </span>
              <span lang={code || undefined} className="flex-1">{label}</span>
              {active && <CheckIcon className="h-4 w-4 shrink-0" aria-hidden />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
