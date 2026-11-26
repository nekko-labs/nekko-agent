import { useOnboardingT } from '../../onboardingMessages.js';
import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../store.js';
import { SetupNekko } from './AboutYouSteps.js';

/**
 * The close: confirm setup is done and offer the three most useful first
 * moves. Each card finishes the wizard and jumps straight to the thing.
 */
export function DoneStep({ onFinish }: { onFinish: (after?: () => void) => void }) {
  const t = useOnboardingT();
  const { newChat, setView, name } = useStore(useShallow((s) => ({ newChat: s.newChat, setView: s.setView, name: s.settings?.userName?.trim() })));

  const items: Array<{ title: string; desc: string; action: () => void }> = [
    {
      title: t('doneChat'),
      desc: t('doneChatHint'),
      action: () => void newChat(),
    },
    {
      title: t('doneProvider'),
      desc: t('doneProviderHint'),
      action: () => setView('models'),
    },
    {
      title: t('doneApps'),
      desc: t('doneAppsHint'),
      action: () => setView('connectors'),
    },
  ];

  return (
    <div className="w-full">
      <div className="flex justify-center"><SetupNekko size={72} happy /></div>
      <h1 className="mt-4 text-center text-2xl font-semibold tracking-tight">{name ? t('doneNamed', { name }) : t('done')}</h1>
      <p className="mx-auto mt-2 max-w-md text-center text-sm leading-relaxed text-ink-soft">
        {t('doneHint')}
      </p>
      <div className="mt-6 grid gap-2">
        {items.map((item) => (
          <button
            key={item.title}
            className="card flex items-center justify-between gap-3 p-4 text-left transition-colors hover:bg-surface-2"
            onClick={() => onFinish(item.action)}
          >
            <span className="min-w-0">
              <span className="block text-sm font-medium">{item.title}</span>
              <span className="mt-0.5 block text-xs text-ink-faint">{item.desc}</span>
            </span>
            <span className="shrink-0 text-accent" aria-hidden="true">
              →
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
