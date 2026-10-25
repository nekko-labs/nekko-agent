import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../store.js';

/**
 * The close: confirm setup is done and offer the three most useful first
 * moves. Each card finishes the wizard and jumps straight to the thing.
 */
export function DoneStep({ onFinish }: { onFinish: (after?: () => void) => void }) {
  const { newChat, setView } = useStore(useShallow((s) => ({ newChat: s.newChat, setView: s.setView })));

  const items: Array<{ title: string; desc: string; action: () => void }> = [
    {
      title: 'Start your first chat',
      desc: 'Open a new agent session in the Agent tab.',
      action: () => void newChat(),
    },
    {
      title: 'Connect a model provider',
      desc: 'Bring a subscription, an API key, or a local server in Models.',
      action: () => setView('models'),
    },
    {
      title: 'Wire up your apps',
      desc: 'Link GitHub, Slack, and more in Connectors.',
      action: () => setView('connectors'),
    },
  ];

  return (
    <div className="w-full">
      <h1 className="text-center text-2xl font-semibold tracking-tight">You're set</h1>
      <p className="mx-auto mt-2 max-w-md text-center text-[14px] leading-relaxed text-ink-soft">
        Here are three things to try first. Pick one to jump right in, or hit Finish.
      </p>
      <div className="mt-6 grid gap-2">
        {items.map((item) => (
          <button
            key={item.title}
            className="card flex items-center justify-between gap-3 p-4 text-left transition-colors hover:bg-surface-2"
            onClick={() => onFinish(item.action)}
          >
            <span className="min-w-0">
              <span className="block text-[13px] font-medium">{item.title}</span>
              <span className="mt-0.5 block text-[12px] text-ink-faint">{item.desc}</span>
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
