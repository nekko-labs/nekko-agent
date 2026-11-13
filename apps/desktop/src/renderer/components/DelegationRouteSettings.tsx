import React from 'react';
import type { AppSettings } from '@nekko-agent/shared';
import { SubagentModelControl } from './SubagentModelControl.js';
import { FusionSettingsControl } from './FusionSettings.js';

/**
 * Settings' copy of the model selector's Subagents row (#2487): Auto (a
 * lighter model than the chat's) by default, its variants, the chat's own
 * model, or one exact model saved as the delegation route.
 */
export function DelegationRouteSettings({ settings, update }: { settings: AppSettings; update: (patch: Partial<AppSettings>) => Promise<void> }) {
  return <div className="min-w-0 space-y-6">
    <FusionSettingsControl settings={settings} update={update} />
    <div>
    <h3 className="text-sm font-medium">Subagent model</h3>
    <p className="mt-(--q-tight) text-xs text-ink-faint">What sub-agents run on when the agent does not name a model. Auto picks a lighter model than the chat's so fanning out costs less. Also in the model selector, under Subagents.</p>
    <div className="mt-(--q-inline)"><SubagentModelControl settingsOverride={settings} update={update} /></div>
    </div>
  </div>;
}
