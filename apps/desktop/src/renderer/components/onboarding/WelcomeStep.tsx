import React from 'react';
import { NekkoAvatar } from '../Mascot.js';

/** The wizard's hello: Aphelion, the name, and the promise in one breath. */
export function WelcomeStep() {
  return (
    <div className="flex flex-col items-center text-center">
      <NekkoAvatar size={84} title="Nekko" />
      <h1 className="mt-6 text-2xl font-semibold tracking-tight">Welcome to Nekko Agent</h1>
      <p className="mt-3 max-w-md text-sm leading-relaxed text-ink-soft">
        Your local agent, backed by frontier intelligence. Three quick steps, a theme, a model provider,
        and your tools, and you're set. Every step is skippable and reachable later in Settings.
      </p>
    </div>
  );
}
