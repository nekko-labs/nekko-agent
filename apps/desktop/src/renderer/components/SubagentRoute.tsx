import type { SessionSummary } from '@nekko-agent/shared';
import { useStore } from '../store.js';
import { shortModelName } from './agent-console/SubagentCue.js';

/** Persisted child identity, not a guessed route from the parent's settings. */
export function SubagentRoute({ child, className = '', modelFirst = false }: { child: Pick<SessionSummary, 'providerId' | 'modelId'>; className?: string; modelFirst?: boolean }) {
  const provider = useStore(s => s.providers?.find(p => p.id === child.providerId)?.label) || child.providerId;
  const full = [provider, child.modelId].filter(Boolean).join(' · ');
  if (!full) return null;
  const model = child.modelId ? shortModelName(child.modelId) : '';
  const label = (modelFirst ? [model, provider] : [provider, model]).filter(Boolean).join(' · ');
  return <span className={`block min-w-0 truncate text-2xs font-normal text-ink-faint ${className}`} data-subagent-route title={full}>
    {label}
  </span>;
}
